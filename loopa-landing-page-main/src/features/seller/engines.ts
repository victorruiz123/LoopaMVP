// Condition/pricing engine seams — defined now so the seller UI is written
// against these interfaces from day one and will not need to change when
// Isac's dedicated condition/pricing engines replace today's interim
// implementation.
//
// Tonight, condition and pricing are NOT separate AI calls — they're already
// produced as part of the single shared generate-listing structuring call
// (see functions/api/generate-listing.ts). Rebuilding them as standalone
// calls tonight would only multiply Gemini calls for output the pipeline
// already produces. Instead, `conditionResultFromGeneratedListing` /
// `pricingResultFromGeneratedListing` below adapt that existing result into
// the engine's output shape. When Isac's real engines land, they implement
// ConditionEngine/PricingEngine directly (likely calling their own service),
// and SellerFlow swaps the adapter call for a real engine call — the
// ConditionResult/PricingResult consumed by the UI does not change either way.

import type { ConditionAssessment, GeneratedListingResult, PricingAssessment, PricingBasis } from '../generator/schema'
import type { MarketplaceListing } from './types'

export interface ConditionResult {
  grade: string | null
  summary: string
  observations: string[]
  defects: string[]
  confidence: 'high' | 'medium' | 'low'
  uncertain: boolean
  uncertaintyNote: string | null
}

export interface ConditionEngineInput {
  images: { mimeType: string; dataBase64: string }[]
  brand: string
  sellerNote: string
}

export interface ConditionEngine {
  assess(input: ConditionEngineInput): Promise<ConditionResult>
}

export interface PricingResult {
  recommendedPriceSek: number | null
  priceRangeMinSek: number | null
  priceRangeMaxSek: number | null
  rationale: string | null
  available: boolean
  /**
   * How the number was actually arrived at. Part of the engine contract, not a
   * rendering detail: a price derived from a heuristic must never be presented
   * as if it came from observed comparables. A real PricingEngine implementation
   * is expected to report this honestly too.
   */
  basis: PricingBasis
}

export interface PricingEngineInput {
  brand: string
  identity: { exactProduct: string | null; category: string | null }
  condition: ConditionResult
}

export interface PricingEngine {
  evaluate(input: PricingEngineInput): Promise<PricingResult>
}

/** Today's interim adapter: reads condition straight out of the combined generate-listing result. Replace with a real ConditionEngine call behind the same return type when available. */
export function conditionResultFromGeneratedListing(result: GeneratedListingResult): ConditionResult {
  const c: ConditionAssessment = result.condition
  return {
    grade: c.grade,
    summary: c.label ?? '',
    observations: c.reasoning ? [c.reasoning] : [],
    defects: c.defects,
    confidence: c.uncertain ? 'low' : 'high',
    uncertain: c.uncertain,
    uncertaintyNote: c.uncertaintyNote,
  }
}

/** Today's interim adapter: reads pricing straight out of the combined generate-listing result. Replace with a real PricingEngine call behind the same return type when available. */
export function pricingResultFromGeneratedListing(result: GeneratedListingResult): PricingResult {
  const p: PricingAssessment = result.pricing
  return {
    recommendedPriceSek: p.suggestedPriceSek,
    priceRangeMinSek: p.priceRangeMinSek,
    priceRangeMaxSek: p.priceRangeMaxSek,
    rationale: p.rationale,
    available: p.available,
    basis: p.basis ?? (p.available ? 'estimate' : 'none'),
  }
}

/** Maps the internal AI-pipeline result to the thin marketplace-facing contract a future publisher (Tradera, Loopa's own marketplace) would consume. `imageUrls` are the seller's own accepted-photo preview URLs, in capture order. */
export function marketplaceListingFromGeneratedListing(result: GeneratedListingResult, imageUrls: string[]): MarketplaceListing {
  return {
    title: result.listing.title,
    description: result.listing.description,
    priceSek: result.pricing.available ? result.pricing.suggestedPriceSek : null,
    conditionLabel: result.condition.label,
    images: imageUrls,
    attributes: result.attributes.map((a) => ({ label: a.label, value: a.value })),
  }
}
