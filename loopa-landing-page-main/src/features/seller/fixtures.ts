// Deterministic fixtures for UI development/testing without spending real
// Gemini calls. Used during component build-out; not imported by production
// code paths (SellerFlow always calls the real clients).

import type { GeneratedListingResult } from '../generator/schema'
import type { ImageReviewResult, SellerProductCandidate, ShotPlan } from './types'

/** Three plausible candidates — exercises the ModelSelectScreen (ambiguous identification) deterministically in mock mode (?mock=2). */
export const FIXTURE_CANDIDATES: SellerProductCandidate[] = [
  { brand: 'Swedese', model: 'Lamino', variant: 'björk', productType: 'fåtölj', confidence: 'likely', distinguishingDetail: 'böjträ, lammskinn' },
  { brand: 'Swedese', model: 'Laminett', variant: null, productType: 'fåtölj', confidence: 'likely', distinguishingDetail: 'lägre rygg än Lamino' },
  { brand: 'Swedese', model: 'Primo', variant: null, productType: 'fåtölj', confidence: 'possible', distinguishingDetail: 'rakare armstöd' },
]

export const FIXTURE_REVIEW_ACCEPTED: ImageReviewResult = {
  accepted: true,
  reason: null,
  suggestion: null,
}

export const FIXTURE_REVIEW_REJECTED: ImageReviewResult = {
  accepted: false,
  reason: 'Hela soffan syns inte.',
  suggestion: 'Backa lite och försök igen.',
}

export const FIXTURE_SHOT_PLAN: ShotPlan = {
  productHint: 'soffa',
  additionalShots: [
    { id: 'angle_side', title: 'Sidovinkel', instruction: 'Ta en bild snett från sidan.', purpose: 'depth', required: true },
    { id: 'angle_back', title: 'Baksida', instruction: 'Ta en bild bakifrån.', purpose: 'coverage', required: true },
    { id: 'seat', title: 'Sittyta', instruction: 'Fotografera sittytan uppifrån.', purpose: 'wear', required: true },
    { id: 'legs', title: 'Ben/stomme', instruction: 'Fotografera benen eller stommen.', purpose: 'material', required: true },
  ],
}

export const FIXTURE_RESULT_CONFIDENT: GeneratedListingResult = {
  mode: 'seller',
  identity: {
    brand: 'Swedese',
    exactProduct: 'Lamino',
    variant: 'med fotpall, björk',
    category: 'Fåtölj',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
  },
  attributes: [
    { key: 'designer', label: 'Formgivare', value: 'Yngve Ekström', sourceUrl: null },
    { key: 'year', label: 'Lanseringsår', value: '1956', sourceUrl: null },
    { key: 'material', label: 'Material', value: 'Björk, lammskinn', sourceUrl: null },
  ],
  condition: {
    grade: 'B+',
    label: 'Mycket bra skick',
    defects: ['Lätt patina på träet'],
    reasoning: 'Träet har en fin, jämn patina. Skinnet är helt utan sprickor eller större slitage.',
    uncertain: false,
    uncertaintyNote: null,
  },
  pricing: {
    available: true,
    retailPriceSek: 12995,
    suggestedPriceSek: 6500,
    priceRangeMinSek: 5500,
    priceRangeMaxSek: 7500,
    rationale: 'Baserat på observerade andrahandspriser för samma modell i liknande skick.',
    basis: 'comparables',
  },
  listing: {
    title: 'Swedese Lamino fåtölj i björk med fotpall',
    description: 'Klassisk Lamino-fåtölj designad av Yngve Ekström för Swedese. Björkstomme med lammskinnsklädsel, i mycket bra skick med fin patina.',
    conditionText: 'Mycket bra skick med lätt, fin patina på träet.',
  },
  seo: { metaTitle: '', metaDescription: '', imageAlt: '' },
  sources: [
    { title: 'swedese.se', url: 'https://swedese.se/lamino', qualityTier: 1 },
    { title: 'svenssons.se', url: 'https://svenssons.se/lamino', qualityTier: 2 },
  ],
  missingNotes: [],
  status: 'full',
  missingFields: [],
  warnings: [],
  researchUnavailable: false,
  slug: 'swedese-lamino-fatolj',
  jsonLd: null,
  websiteAdaptation: null,
}

/** The degraded shape: research produced nothing usable, so identity/specs are photo-based only and the price is an honest estimate. Exercises the quiet missing-fields treatment in ResultScreen. */
export const FIXTURE_RESULT_UNCERTAIN: GeneratedListingResult = {
  ...FIXTURE_RESULT_CONFIDENT,
  identity: {
    brand: null,
    exactProduct: null,
    variant: null,
    category: 'Fåtölj',
    confidence: 'low',
    uncertain: true,
    uncertaintyNote: 'Ingen tydlig etikett eller märkning syns på bilderna, så exakt modell kunde inte bekräftas.',
  },
  attributes: [],
  pricing: {
    available: true,
    retailPriceSek: null,
    suggestedPriceSek: 2500,
    priceRangeMinSek: 2000,
    priceRangeMaxSek: 3200,
    rationale: 'Uppskattning utifrån produkttyp och synligt skick.',
    basis: 'estimate',
  },
  sources: [],
  status: 'fallback',
  missingFields: ['dimensions', 'material', 'newPrice', 'model', 'variant'],
  warnings: ['research_failed'],
  researchUnavailable: true,
}
