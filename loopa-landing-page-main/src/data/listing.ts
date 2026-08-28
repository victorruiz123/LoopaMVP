// Central structured data for the IKEA SÖDERHAMN demo listing.
// Used by the listing demo card, the Ask Loopa chat (both server + local
// fallback), and the buy-now flow. Keeping one source of truth means the
// chat can never "invent" facts that aren't shown on the listing card.

export const LISTING_IMAGES = [
  '/assets/ikea/img-8304.webp',
  '/assets/ikea/img-8305.webp',
  '/assets/ikea/img-8306.webp',
  '/assets/ikea/img-8307.webp',
  '/assets/ikea/img-8308.webp',
]

export const LISTING_THUMBS = [
  '/assets/ikea/thumb-img-8304.webp',
  '/assets/ikea/thumb-img-8305.webp',
  '/assets/ikea/thumb-img-8306.webp',
  '/assets/ikea/thumb-img-8307.webp',
  '/assets/ikea/thumb-img-8308.webp',
]

export const LISTING_PRICE_SEK = 3500

export interface ListingFacts {
  brand: string
  model: string
  productType: { sv: string; en: string }
  configuration: { sv: string; en: string }
  dimensions: string
  material: { sv: string; en: string }
  color: { sv: string; en: string }
  condition: { sv: string; en: string }
  conditionDetail: { sv: string; en: string }
  coverRemovable: boolean
  washable: { sv: string; en: string }
  estimatedValueSek: string
  priceSek: number
  priceFixed: true
  location: { sv: string; en: string }
  delivery: { sv: string; en: string }
  authenticity: { sv: string; en: string }
}

export const LISTING_FACTS: ListingFacts = {
  brand: 'IKEA',
  model: 'SÖDERHAMN',
  productType: { sv: '3-sitssoffa', en: '3-seat sofa' },
  configuration: { sv: '3-sits, utan armstöd', en: '3-seat, no armrests' },
  dimensions: '198 x 99 x 83 cm',
  material: { sv: 'Klädsel i bomull/polyester', en: 'Cover in cotton/polyester' },
  color: { sv: 'Vit (Blekinge)', en: 'White (Blekinge)' },
  condition: { sv: 'Mycket bra', en: 'Very good' },
  conditionDetail: {
    sv: 'Inga fläckar, revor eller rökdoft. Ram och ryggdynor i mycket bra skick med bara minimalt slitage från normal användning.',
    en: 'No stains, tears or smoke smell. Frame and back cushions in very good condition with only minimal wear from normal use.',
  },
  coverRemovable: true,
  washable: {
    sv: 'Ja, klädseln är avtagbar och maskintvättbar.',
    en: 'Yes, the cover is removable and machine washable.',
  },
  estimatedValueSek: '3 200-3 800 kr',
  priceSek: LISTING_PRICE_SEK,
  priceFixed: true,
  location: { sv: 'Stockholm', en: 'Stockholm' },
  delivery: {
    sv: 'Leverans sker via Tiptapp. Köparen väljer tre möjliga tider och säljaren bekräftar en av dem.',
    en: 'Delivery is handled via Tiptapp. The buyer chooses three possible times and the seller confirms one of them.',
  },
  authenticity: {
    sv: 'Ja, Loopa har identifierat produkten som en IKEA SÖDERHAMN utifrån säljarens foton, konstruktion och proportioner.',
    en: "Yes, Loopa identified the product as an IKEA SÖDERHAMN based on the seller's photos, construction and proportions.",
  },
}
