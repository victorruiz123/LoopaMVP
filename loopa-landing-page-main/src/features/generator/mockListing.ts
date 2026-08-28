import type { GeneratedListing } from './types'
import { LISTING_FACTS, LISTING_THUMBS } from '../../data/listing'

// Static mock data only, used to exercise the GeneratedListing shape ahead
// of a real generator. No network calls, no model orchestration.

export const MOCK_FURNITURE_LISTING: GeneratedListing = {
  category: 'furniture',
  images: { photos: LISTING_THUMBS },
  identity: {
    brand: LISTING_FACTS.brand,
    model: LISTING_FACTS.model,
    productType: LISTING_FACTS.productType,
  },
  attributes: [
    { label: { sv: 'Konfiguration', en: 'Configuration' }, value: LISTING_FACTS.configuration },
    { label: { sv: 'Mått', en: 'Dimensions' }, value: { sv: LISTING_FACTS.dimensions, en: LISTING_FACTS.dimensions } },
    { label: { sv: 'Material', en: 'Material' }, value: LISTING_FACTS.material },
    { label: { sv: 'Färg', en: 'Colour' }, value: LISTING_FACTS.color },
  ],
  condition: {
    grade: 'A-',
    label: LISTING_FACTS.condition,
    detail: LISTING_FACTS.conditionDetail,
  },
  pricing: { fixedPrice: true, suggestedPriceSek: LISTING_FACTS.priceSek },
  generatedTitle: {
    sv: `${LISTING_FACTS.brand} ${LISTING_FACTS.model} ${LISTING_FACTS.productType.sv}`,
    en: `${LISTING_FACTS.brand} ${LISTING_FACTS.model} ${LISTING_FACTS.productType.en}`,
  },
  generatedDescription: { sv: LISTING_FACTS.condition.sv, en: LISTING_FACTS.condition.en },
  confidence: 0.94,
}

export const MOCK_FASHION_LISTING: GeneratedListing = {
  category: 'fashion',
  images: {
    photos: ['/assets/fashion-demo/overshirt-front.webp', '/assets/fashion-demo/overshirt-detail.webp'],
  },
  identity: {
    brand: 'North Thread',
    productType: { sv: 'Overshirt', en: 'Overshirt' },
  },
  attributes: [
    { label: { sv: 'Färg', en: 'Colour' }, value: { sv: 'Marinblå', en: 'Navy' } },
    { label: { sv: 'Storlek', en: 'Size' }, value: { sv: 'M', en: 'M' } },
    { label: { sv: 'Material', en: 'Material' }, value: { sv: 'Ekologisk bomull, tvillväv', en: 'Organic cotton, twill' } },
  ],
  condition: {
    grade: 'B+',
    label: { sv: 'Mycket bra', en: 'Very good' },
    detail: {
      sv: 'Lätt använd, inga fläckar eller hål.',
      en: 'Lightly worn, no stains or holes.',
    },
  },
  pricing: { suggestedCreditSek: 500, estimatedRangeSek: [400, 500] },
  generatedTitle: { sv: 'Overshirt, marinblå, M', en: 'Overshirt, navy, M' },
  generatedDescription: {
    sv: 'Overshirt i marinblå bomullstvill med klassisk skjortkrage och två bröstfickor. Lätt använd, i mycket bra skick.',
    en: 'Navy cotton-twill overshirt with a classic shirt collar and two chest pockets. Lightly worn, in very good condition.',
  },
  confidence: 0.88,
  missingInfo: [{ sv: 'Exakt modellnamn okänt', en: 'Exact model name unknown' }],
}
