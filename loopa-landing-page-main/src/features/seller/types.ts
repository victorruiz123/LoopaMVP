// Shared contracts for the consumer seller product (loopa.nu/). Used by both
// the frontend seller flow and the Cloudflare Pages Functions under
// functions/api/seller/. One source of truth, same pattern as
// src/features/generator/schema.ts for the professional generator.

// ─── Image review (ImageReviewEngine) ───────────────────────────────────────

/**
 * Result of asking the AI "is this photo good enough for its purpose?".
 * Deliberately small and UI-agnostic — the frontend never inspects a raw
 * Gemini response shape, only this. Swap the engine implementation later
 * without touching a single UI component.
 *
 * Kept intentionally tiny — matches the fast review model's minimal wire
 * response ({status:"accept"} or {status:"reject",reason,suggestion}) so
 * nothing forces extra output tokens (and therefore latency) out of the model.
 */
export interface ImageReviewResult {
  accepted: boolean
  /** Short, plain-language reason — only set when rejected. Never technical ("blur score 0.4"). */
  reason: string | null
  /** Short, actionable instruction — only set when rejected. */
  suggestion: string | null
}

// ─── Adaptive shot plan (ShotPlanEngine) ────────────────────────────────────

export interface ShotPlanShot {
  id: string
  /** Short seller-facing label, e.g. "Tre kvarts vinkel". */
  title: string
  /** Short seller-facing instruction, e.g. "Vinkla lite åt sidan så vi ser djupet." */
  instruction: string
  /** Internal — why this shot matters (identification, condition, trust). Not necessarily shown verbatim. */
  purpose: string
  required: boolean
}

/**
 * The frontal shot is always requested first and is a fixed, hardcoded step
 * (see seller/fixedShots.ts) — never AI-planned. A ShotPlan supplies only the
 * shots AFTER it; combined with the frontal shot, total shots is always 5-8.
 */
export interface ShotPlan {
  /** Best-effort product guess (e.g. "soffa", "skjorta") — informational, used to adapt copy; never shown as a claim of certainty. */
  productHint: string | null
  additionalShots: ShotPlanShot[]
}

// ─── Product candidate resolution ───────────────────────────────────────────

/**
 * Internal plausibility ranking for an identification candidate. Never shown
 * to the seller as a score/percentage — it only drives the auto-continue rule
 * (see functions/api/_shared/seller-candidates.ts) and candidate ordering.
 */
export type SellerCandidateConfidence = 'strong' | 'likely' | 'possible'

/**
 * One plausible real product the identification stage found for the seller's
 * photos. A candidate is always a REAL model name seen in grounded search
 * results — ambiguity between several real products is handed to the seller
 * to resolve (human disambiguation is cheap; model latency is expensive),
 * never resolved by extra AI calls and never filled with invented names.
 */
export interface SellerProductCandidate {
  brand: string
  model: string
  variant: string | null
  productType: string | null
  confidence: SellerCandidateConfidence
  /** Short seller-facing hint that tells the candidates apart (e.g. "hög rygg, teakstomme"). */
  distinguishingDetail: string | null
  /**
   * Product page the model claims to have seen for THIS candidate, or null.
   *
   * Never trusted as fact — this file's own history is a model that populated `sourceUrl` fields with
   * URLs it had never seen. The caller fetches it and checks the page title names the model before
   * using anything from it, so an invented address yields nothing rather than a wrong picture.
   */
  sourceUrl?: string | null
}

/** Hard product cap on how many candidates the seller is ever shown. */
export const MAX_SELLER_CANDIDATES = 4

/**
 * How the product identity was resolved before final generation. Sent by the
 * frontend on the second /api/seller/generate request after the candidate
 * step paused the flow. Absent on the first request.
 *
 * - `seller_selected` — the seller tapped one of the shown candidates. This is
 *   STRONG identity evidence: research must target exactly this product and
 *   must not re-litigate identification.
 * - `manual` — the seller chose "Ingen av dessa" and typed a model name.
 *   Seller-typed values are truth (same rule as brand) and drive research.
 * - `unknown` — the seller doesn't know the model. Generation continues with a
 *   product-type listing; unverifiable specs stay missing, never invented.
 */
export type SellerResolution =
  | { kind: 'seller_selected'; selected: SellerProductCandidate }
  | { kind: 'manual'; manualModel: string }
  | { kind: 'unknown' }

// ─── Seller session state machine ───────────────────────────────────────────

/**
 * Full future state space (documented for forward-compatibility with
 * Tradera publishing, shipping, etc. — see docs/SELLER_MVP_ARCHITECTURE.md).
 * Only 'draft' through 'ready_for_marketplace' are implemented tonight.
 */
export type SellerSessionState =
  | 'draft'
  | 'brand_entered'
  | 'capturing'
  | 'reviewing_photo'
  | 'analyzing'
  | 'selecting_model'
  | 'review'
  | 'approved'
  | 'ready_for_marketplace'
  | 'publishing'
  | 'live'
  | 'sold'
  | 'shipping'
  | 'completed'

export interface AcceptedPhoto {
  previewUrl: string
  review: ImageReviewResult
  shotTitle: string
  uploadedImage: { mimeType: string; dataBase64: string }
}

// ─── Marketplace-facing listing (forward contract) ──────────────────────────

/**
 * What a future marketplace publisher (Tradera, Loopa's own marketplace,
 * etc. — see the roadmap in docs/SELLER_MVP_ARCHITECTURE.md) will consume.
 * Deliberately thin today: `fromGeneratedListing` below maps the shared
 * generate-listing result into this shape, so a publisher integration is
 * written against a stable, marketplace-specific contract instead of the
 * full internal AI-pipeline result type.
 */
export interface MarketplaceListing {
  title: string
  description: string
  priceSek: number | null
  conditionLabel: string | null
  images: string[]
  attributes: { label: string; value: string }[]
}

