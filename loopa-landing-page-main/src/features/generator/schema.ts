// Shared contract for the real Gemini-backed listing generator. Used by both
// the Cloudflare Pages Function (functions/api/generate-listing.ts) and the
// frontend client/UI — one source of truth for the request/response shape.
//
// Attributes are a flexible array, not a fixed set of named fields: the
// model returns whatever it can reliably establish (any number of fields),
// and the UI renders whatever comes back generically. This is a deliberate
// architectural choice — a fixed allowlist here would silently drop valid
// data the same way a prior bug did in a different part of the system.

/**
 * 'seller' is the consumer seller-product mode (loopa.nu/): brand is the ONLY
 * required field, no category/model is ever asked, category is inferred by
 * the model itself from brand + images + an optional free-text note. It
 * shares the exact same grounded-research → structured-JSON core as
 * furniture/fashion (see generate-listing.ts) — deliberately NOT a fork —
 * but skips SEO entirely (LISTING_RESPONSE_SCHEMA_SELLER, no seo/website
 * adaptation) since the consumer product has no use for it and it would
 * otherwise cost output tokens for nothing.
 */
export type GenerationMode = 'furniture' | 'fashion' | 'seller'

export interface UploadedImage {
  mimeType: string
  dataBase64: string
}

export interface GenerateListingRequest {
  mode: GenerationMode
  brand?: string
  model?: string
  /** Fashion only, optional: style code / article number — the strongest single identifier for garments. */
  styleCode?: string
  /** Fashion only, optional: seller-stated size. Seller-typed values always win over weaker AI guesses. */
  size?: string
  /** Seller mode only, optional: whatever the seller freely typed ("Något mer du vill berätta?") — model, size, color, anything. Treated as evidence, never required. */
  sellerNote?: string
  images: UploadedImage[]
  /** Optional. When set, the listing's structure/attributes/SEO are adapted to this site's product-page conventions. Professional modes only — never sent in seller mode. */
  websiteUrl?: string
}

export interface ProductAttribute {
  key: string
  label: string
  value: string
  /** Optional per-field source attribution: an https URL cited in the grounded research for this value. Validated server-side; null when the research didn't cite one. */
  sourceUrl?: string | null
  /**
   * True when the value is an ESTIMATE, not a fact about this product.
   *
   * Set only server-side, only for dimensions, and only when no source gave any: either the research
   * call's own "LIKNANDE:" rows (the closest comparable model) or the typical-measurement table in
   * functions/api/_shared/seller-typical-dimensions.ts. An estimate never counts as verified — it is
   * left out of `missingFields`, written with "ca", and replaced by the first real measurement.
   */
  estimated?: boolean
}

export interface ProductIdentity {
  brand: string | null
  exactProduct: string | null
  variant: string | null
  category: string | null
  /** Model's self-reported certainty in brand+exactProduct+variant taken together. */
  confidence: 'high' | 'medium' | 'low'
  /** True when the photos don't clearly corroborate the claimed identity (furniture: seller-typed brand/model; fashion: visible label). Never resolved by offering alternatives — see uncertaintyNote. */
  uncertain: boolean
  uncertaintyNote: string | null
}

export interface ConditionAssessment {
  grade: string | null
  label: string | null
  defects: string[]
  reasoning: string
  uncertain: boolean
  uncertaintyNote: string | null
}

/**
 * Where the recommended price actually came from. Seller mode always sets it;
 * the professional modes leave it undefined. Never cosmetic — "estimate" means
 * no price research backed this number, and the UI must not present it as if
 * comparables existed.
 */
export type PricingBasis =
  /** Observed secondhand comparables found by grounded search. */
  | 'comparables'
  /** A verified original/new price plus condition-aware resale reasoning. */
  | 'retail'
  /** Model heuristic from brand + product type + visible condition only. */
  | 'estimate'
  /** No defensible basis at all — `available` is false. */
  | 'none'

export interface PricingAssessment {
  available: boolean
  retailPriceSek: number | null
  suggestedPriceSek: number | null
  priceRangeMinSek: number | null
  priceRangeMaxSek: number | null
  rationale: string | null
  /** Seller mode only. Undefined on the professional /secondhand modes. */
  basis?: PricingBasis
}

export interface ListingCopy {
  title: string
  description: string
  conditionText: string
}

export interface SeoCopy {
  metaTitle: string
  metaDescription: string
  imageAlt: string
}

export interface SourceRef {
  title: string
  url: string
  /** Derived server-side from the URL's domain, never model-generated. 1 = manufacturer/official brand site, 2 = known retailer, 3 = other/unclassified. */
  qualityTier: 1 | 2 | 3
}

/** Present only when a websiteUrl was supplied AND the site lookup succeeded — never fabricated, never shown on failure. */
export interface WebsiteAdaptation {
  /** Bare hostname, e.g. "rekomo.se" — derived deterministically from the input URL, not generated by Gemini. */
  domain: string
  adapted: true
}

/**
 * Degradation level of a seller-mode result. A seller submission that reached
 * generation ALWAYS produces one of these — never an error screen.
 *
 * - `full`     — grounded research landed and the important specs came back.
 * - `partial`  — grounded research landed but some important specs could not
 *                be verified (see `missingFields`).
 * - `fallback` — no grounded research was usable; identity/specs are limited
 *                to what the photos and the seller's own input support
 *                (`researchUnavailable` is true).
 */
export type SellerResultStatus = 'full' | 'partial' | 'fallback'

/**
 * Machine-readable list of important product facts that could NOT be
 * established. Explicitly enumerated (rather than inferred in the UI) so the
 * frontend can show a quiet "not everything could be verified" hint without
 * guessing, and so nothing is ever invented to fill a gap.
 */
export type SellerMissingField = 'dimensions' | 'material' | 'newPrice' | 'model' | 'variant' | 'price' | 'condition'

export interface GeneratedListingResult {
  mode: GenerationMode
  identity: ProductIdentity
  attributes: ProductAttribute[]
  condition: ConditionAssessment
  pricing: PricingAssessment
  listing: ListingCopy
  seo: SeoCopy
  sources: SourceRef[]
  missingNotes: string[]
  /** Seller mode only — see SellerResultStatus. Undefined for professional modes. */
  status?: SellerResultStatus
  /** Seller mode only. Important facts that could not be verified; never filled with invented values. */
  missingFields?: SellerMissingField[]
  /** Seller mode only. Short, honest notes about degraded stages (e.g. research timed out). Not a user-facing error. */
  warnings?: string[]
  /** Seller mode only. True when NO grounded research contributed to this result — the listing is photo/seller-input based only. */
  researchUnavailable?: boolean
  /** Derived server-side from the structured result, not generated by Gemini. */
  slug: string
  /** Derived server-side; null when there isn't enough factual data for a meaningful Product entity. */
  jsonLd: Record<string, unknown> | null
  /** null when no websiteUrl was given, or the site lookup failed — generation always still succeeds either way. */
  websiteAdaptation: WebsiteAdaptation | null
}

export interface GenerateListingSuccess {
  ok: true
  result: GeneratedListingResult
}

export interface GenerateListingFailure {
  ok: false
  error: string
}

export type GenerateListingResponse = GenerateListingSuccess | GenerateListingFailure

/**
 * Gemini REST responseSchema (OpenAPI-subset format expected by
 * generationConfig.responseSchema) for the structured stage of generation.
 * Deliberately excludes `sources` (attached server-side from grounding
 * metadata, never model-transcribed) and `mode`/`slug`/`jsonLd` (derived,
 * not generated).
 */
export const LISTING_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    identity: {
      type: 'OBJECT',
      properties: {
        brand: { type: 'STRING', nullable: true },
        exactProduct: { type: 'STRING', nullable: true },
        variant: { type: 'STRING', nullable: true },
        category: { type: 'STRING', nullable: true },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        uncertain: { type: 'BOOLEAN' },
        uncertaintyNote: { type: 'STRING', nullable: true },
      },
      required: ['brand', 'exactProduct', 'variant', 'category', 'confidence', 'uncertain', 'uncertaintyNote'],
    },
    attributes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING' },
          label: { type: 'STRING' },
          value: { type: 'STRING' },
          sourceUrl: { type: 'STRING', nullable: true },
        },
        required: ['key', 'label', 'value', 'sourceUrl'],
      },
    },
    condition: {
      type: 'OBJECT',
      properties: {
        grade: { type: 'STRING', nullable: true },
        label: { type: 'STRING', nullable: true },
        defects: { type: 'ARRAY', items: { type: 'STRING' } },
        reasoning: { type: 'STRING' },
        uncertain: { type: 'BOOLEAN' },
        uncertaintyNote: { type: 'STRING', nullable: true },
      },
      required: ['grade', 'label', 'defects', 'reasoning', 'uncertain', 'uncertaintyNote'],
    },
    pricing: {
      type: 'OBJECT',
      properties: {
        available: { type: 'BOOLEAN' },
        retailPriceSek: { type: 'NUMBER', nullable: true },
        suggestedPriceSek: { type: 'NUMBER', nullable: true },
        priceRangeMinSek: { type: 'NUMBER', nullable: true },
        priceRangeMaxSek: { type: 'NUMBER', nullable: true },
        rationale: { type: 'STRING', nullable: true },
      },
      required: ['available', 'retailPriceSek', 'suggestedPriceSek', 'priceRangeMinSek', 'priceRangeMaxSek', 'rationale'],
    },
    listing: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        description: { type: 'STRING' },
        conditionText: { type: 'STRING' },
      },
      required: ['title', 'description', 'conditionText'],
    },
    seo: {
      type: 'OBJECT',
      properties: {
        metaTitle: { type: 'STRING' },
        metaDescription: { type: 'STRING' },
        imageAlt: { type: 'STRING' },
      },
      required: ['metaTitle', 'metaDescription', 'imageAlt'],
    },
    missingNotes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['identity', 'attributes', 'condition', 'pricing', 'listing', 'seo', 'missingNotes'],
} as const

/**
 * Seller-mode variant: identical to LISTING_RESPONSE_SCHEMA but with `seo`
 * removed entirely. The consumer seller product never shows or uses SEO
 * fields, so this avoids spending output tokens generating them at all
 * (rather than generating and then hiding them in the UI).
 */
export const LISTING_RESPONSE_SCHEMA_SELLER = {
  type: 'OBJECT',
  properties: {
    identity: LISTING_RESPONSE_SCHEMA.properties.identity,
    attributes: LISTING_RESPONSE_SCHEMA.properties.attributes,
    condition: LISTING_RESPONSE_SCHEMA.properties.condition,
    pricing: LISTING_RESPONSE_SCHEMA.properties.pricing,
    listing: LISTING_RESPONSE_SCHEMA.properties.listing,
    missingNotes: LISTING_RESPONSE_SCHEMA.properties.missingNotes,
  },
  required: ['identity', 'attributes', 'condition', 'pricing', 'listing', 'missingNotes'],
} as const
