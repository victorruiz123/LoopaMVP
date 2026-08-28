// Frontend architecture for a future "Generate a listing with Loopa" feature.
//
// This is intentionally a types + mock-data boundary only: no upload
// backend, no model calls, no scraping. It exists so a real generator
// (furniture: photos -> identify -> data -> condition -> listing; fashion:
// garment + label photo -> identify -> data -> condition -> listing) can be
// connected later behind GeneratorPreview without restructuring the page.

export type ProductCategory = 'furniture' | 'fashion'

export interface Localized {
  sv: string
  en: string
}

export interface ProductImages {
  photos: string[]
}

export interface LabelImages {
  photos: string[]
}

export interface ProductIdentity {
  brand: string
  model?: string
  productType: Localized
}

export interface ListingAttribute {
  label: Localized
  value: Localized
}

export interface ConditionAssessment {
  grade: string
  label: Localized
  detail: Localized
}

export interface PricingValue {
  estimatedRangeSek?: [number, number]
  suggestedPriceSek?: number
  suggestedCreditSek?: number
  fixedPrice?: boolean
}

export interface GeneratedListing {
  category: ProductCategory
  images: ProductImages
  labelImages?: LabelImages
  identity: ProductIdentity
  attributes: ListingAttribute[]
  condition: ConditionAssessment
  pricing: PricingValue
  generatedTitle: Localized
  generatedDescription: Localized
  /** 0-1. Illustrative only, not a live model confidence score. */
  confidence: number
  missingInfo?: Localized[]
}
