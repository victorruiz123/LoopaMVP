// Real, named, sourced example products for /brands — see
// public/assets/brand-examples/SOURCE.md for full provenance (image
// licenses, spec sources, fetch dates). Not stock photography, not
// invented specs.
//
// Fully bilingual (sv/en) — every user-facing field is duplicated per
// language; proper nouns (brand, product name, designer) are shared since
// they don't translate.

import type { Language } from '../../i18n/LanguageContext'

export type Category = 'fashion' | 'furniture' | 'interior'
export type CategoryFilter = Category | 'all'

export interface Spec {
  label: string
  value: string
}

export interface RichExample {
  brand: string
  productName: string
  designer: string | null
  variantLabel: string
  variantValue: string
  material: string
  specs: Spec[]
  conditionGrade: string
  conditionLabel: string
  conditionReasoning: string
  defects: string[]
  originalPrice: string
  resalePrice: string
  description: string
  image: string
  imageAlt: string
  imageCredit: string | null
  imageNote: string | null
}

const CATEGORY_LABEL: Record<Language, Record<Category, string>> = {
  sv: { fashion: 'Mode', furniture: 'Möbler', interior: 'Inredning' },
  en: { fashion: 'Fashion', furniture: 'Furniture', interior: 'Interior' },
}

export function getCategoryLabel(language: Language): Record<Category, string> {
  return CATEGORY_LABEL[language]
}

const CATEGORY_EXAMPLE_WORDS: Record<Language, Record<Category, string[]>> = {
  sv: {
    fashion: ['Jacka', 'Tröja', 'Byxor'],
    furniture: ['Stol', 'Soffa', 'Bord'],
    interior: ['Lampa', 'Vas', 'Heminredning'],
  },
  en: {
    fashion: ['Jacket', 'Sweater', 'Trousers'],
    furniture: ['Chair', 'Sofa', 'Table'],
    interior: ['Lamp', 'Vase', 'Home decor'],
  },
}

export function getCategoryExampleWords(language: Language): Record<Category, string[]> {
  return CATEGORY_EXAMPLE_WORDS[language]
}

// Real product, real specs (verified against asket.com), real photo (Asket's
// own product photography, already licensed for this project — see
// scripts/fetch-fashion-demo-assets.mjs).
const FASHION_EXAMPLE_SV: RichExample = {
  brand: 'Asket',
  productName: 'The Overshirt',
  designer: null,
  variantLabel: 'Storlek',
  variantValue: 'M · Mörkblå',
  material: '100% ekologisk bomull, 308 g/m² tvillväv (3/1)',
  specs: [
    { label: 'Passform', value: 'Rak, klassisk' },
    { label: 'Artikelkod', value: 'OVS-MA-DKN' },
    { label: 'Tillverkad', value: 'Vävd i Italien, sydd i Portugal' },
  ],
  conditionGrade: 'B+',
  conditionLabel: 'Mycket gott skick',
  conditionReasoning: 'Lätt nopprighet vid vänster manschett. Inga fläckar, hål eller skador på tyget.',
  defects: ['Lätt nopprighet vid vänster manschett'],
  originalPrice: 'ca 3 150 kr',
  resalePrice: '1 450 kr',
  description:
    'Overshirt i kraftig bomullstvill med korozoknappar, bröstfickor och rak passform — vävd i Italien, sydd i Portugal.',
  image: '/assets/fashion-demo/overshirt-packshot.webp',
  imageAlt: 'Asket The Overshirt, mörkblå',
  imageCredit: null,
  imageNote: null,
}

const FASHION_EXAMPLE_EN: RichExample = {
  brand: 'Asket',
  productName: 'The Overshirt',
  designer: null,
  variantLabel: 'Size',
  variantValue: 'M · Dark navy',
  material: '100% organic cotton, 308 g/m² twill (3/1)',
  specs: [
    { label: 'Fit', value: 'Straight, classic' },
    { label: 'Style code', value: 'OVS-MA-DKN' },
    { label: 'Made in', value: 'Woven in Italy, sewn in Portugal' },
  ],
  conditionGrade: 'B+',
  conditionLabel: 'Very good condition',
  conditionReasoning: 'Slight pilling at the left cuff. No stains, holes, or damage to the fabric.',
  defects: ['Slight pilling at the left cuff'],
  originalPrice: 'ca 3,150 SEK',
  resalePrice: '1,450 SEK',
  description:
    'An overshirt in heavyweight cotton twill with corozo buttons, chest pockets, and a straight fit — woven in Italy, sewn in Portugal.',
  image: '/assets/fashion-demo/overshirt-packshot.webp',
  imageAlt: 'Asket The Overshirt, dark navy',
  imageCredit: null,
  imageNote: null,
}

// Real product, real specs (Yngve Ekström, 1956 — utsedd till 1900-talets
// svenska möbeldesign av Sköna Hem 1999; mått/tillverkningsort verifierade
// mot swedese.se och återförsäljare). Photo: Wikimedia Commons, CC BY-SA.
const FURNITURE_EXAMPLE_SV: RichExample = {
  brand: 'Swedese',
  productName: 'Lamino',
  designer: 'Yngve Ekström, 1956',
  variantLabel: 'Konfiguration',
  variantValue: 'Fåtölj · Fårskinn',
  material: 'Skiktlimmad böjträ i ek + fårskinn',
  specs: [
    { label: 'Bredd', value: '70 cm' },
    { label: 'Djup', value: '78 cm' },
    { label: 'Höjd', value: '101 cm' },
    { label: 'Sitthöjd', value: '41 cm' },
    { label: 'Tillverkas i', value: 'Vaggeryd, Småland' },
  ],
  conditionGrade: 'A-',
  conditionLabel: 'Mycket gott skick',
  conditionReasoning: 'Enstaka mikrorepor i träramen. Skinnet är mjukt och osprucket, inga fläckar.',
  defects: ['Enstaka mikrorepor i träramen'],
  originalPrice: '12 500–23 500 kr',
  resalePrice: '9 900 kr',
  description:
    'Utsedd till 1900-talets svenska möbeldesign av Sköna Hem. Tillverkas fortfarande för hand i Swedeses fabrik i Vaggeryd.',
  image: '/assets/brand-examples/lamino.webp',
  imageAlt: 'Swedese Lamino, formgiven av Yngve Ekström',
  imageCredit: 'Foto: Wikimedia Commons (CC BY-SA)',
  imageNote: null,
}

const FURNITURE_EXAMPLE_EN: RichExample = {
  brand: 'Swedese',
  productName: 'Lamino',
  designer: 'Yngve Ekström, 1956',
  variantLabel: 'Configuration',
  variantValue: 'Armchair · Sheepskin',
  material: 'Laminated bent oak + sheepskin',
  specs: [
    { label: 'Width', value: '70 cm' },
    { label: 'Depth', value: '78 cm' },
    { label: 'Height', value: '101 cm' },
    { label: 'Seat height', value: '41 cm' },
    { label: 'Made in', value: 'Vaggeryd, Sweden' },
  ],
  conditionGrade: 'A-',
  conditionLabel: 'Very good condition',
  conditionReasoning: 'A few micro-scratches in the wood frame. The leather is soft and uncracked, no stains.',
  defects: ['A few micro-scratches in the wood frame'],
  originalPrice: '12,500–23,500 SEK',
  resalePrice: '9,900 SEK',
  description:
    "Named Swedish furniture design of the 20th century by Sköna Hem. Still made by hand at Swedese's factory in Vaggeryd.",
  image: '/assets/brand-examples/lamino.webp',
  imageAlt: 'Swedese Lamino, designed by Yngve Ekström',
  imageCredit: 'Photo: Wikimedia Commons (CC BY-SA)',
  imageNote: null,
}

// Real product, real specs (Alvar Aalto, 1936, "Savoy-vasen"; munblåst glas,
// Iittala glasbruk Finland; pris klar 1 889 kr på iittala.com/sv-se). No
// studio photo of the vase is used — its design remains under copyright
// independent of any photo's own license (Wikimedia Commons has actively
// deleted images of it for exactly this reason). Shown instead with an
// honest "seller's own photo" style image, which is also more faithful to
// what a real secondhand seller actually uploads.
const INTERIOR_EXAMPLE_SV: RichExample = {
  brand: 'Iittala',
  productName: 'Alvar Aalto-vas, 160 mm',
  designer: 'Alvar Aalto, 1936',
  variantLabel: 'Färg',
  variantValue: 'Klar',
  material: 'Munblåst glas',
  specs: [
    { label: 'Höjd', value: '160 mm' },
    { label: 'Tillverkas i', value: 'Iittala glasbruk, Finland' },
    { label: 'Även kallad', value: 'Savoy-vasen' },
  ],
  conditionGrade: 'A',
  conditionLabel: 'Nyskick',
  conditionReasoning: 'Inga synliga repor eller nagg i glaset.',
  defects: [],
  originalPrice: 'ca 1 890 kr',
  resalePrice: '890 kr',
  description:
    'En av världens mest kända glasdesigner — munblåst för hand, inspirerad av vattnets vågrörelser ("aalto" betyder våg på finska).',
  image: '/assets/ikea/img-8306.webp',
  imageAlt: 'Exempelbild, hemmiljö',
  imageCredit: null,
  imageNote: 'Illustrativ bild — inte en officiell produktbild',
}

const INTERIOR_EXAMPLE_EN: RichExample = {
  brand: 'Iittala',
  productName: 'Alvar Aalto vase, 160 mm',
  designer: 'Alvar Aalto, 1936',
  variantLabel: 'Colour',
  variantValue: 'Clear',
  material: 'Mouth-blown glass',
  specs: [
    { label: 'Height', value: '160 mm' },
    { label: 'Made in', value: 'Iittala glassworks, Finland' },
    { label: 'Also known as', value: 'The Savoy vase' },
  ],
  conditionGrade: 'A',
  conditionLabel: 'Like new',
  conditionReasoning: 'No visible scratches or chips in the glass.',
  defects: [],
  originalPrice: 'ca 1,890 SEK',
  resalePrice: '890 SEK',
  description:
    'One of the world\'s most recognised glass designs — mouth-blown by hand, inspired by the rippling motion of water ("aalto" means wave in Finnish).',
  image: '/assets/ikea/img-8306.webp',
  imageAlt: 'Example photo, home setting',
  imageCredit: null,
  imageNote: 'Illustrative photo — not an official product image',
}

const RICH_EXAMPLES: Record<Language, Record<Category, RichExample>> = {
  sv: { fashion: FASHION_EXAMPLE_SV, furniture: FURNITURE_EXAMPLE_SV, interior: INTERIOR_EXAMPLE_SV },
  en: { fashion: FASHION_EXAMPLE_EN, furniture: FURNITURE_EXAMPLE_EN, interior: INTERIOR_EXAMPLE_EN },
}

export function getRichExamples(language: Language): Record<Category, RichExample> {
  return RICH_EXAMPLES[language]
}

// ─── Rotating demo product (the /brands static example) ──────────────────
//
// Every STATIC illustrative product surface on /brands (hero image, idle
// storefront card, product-page integration mock, condition proof card)
// renders ONE shared demo product that ambiently alternates between the two
// main Loopa use cases: fashion (Asket) and furniture (IKEA SÖDERHAMN).
// Image, brand, name, prices, and condition copy always travel together —
// never mix fields from different entries. The live personalized preview is
// unaffected: real fetched products always take precedence over this.
//
// The sofa facts (dimensions, Blekinge white cover, cotton/polyester,
// 3 500 kr demo price) reuse the project's established SÖDERHAMN demo
// listing (src/data/listing.ts) and its existing seller-style photo — same
// provenance rules as everything else in this file, nothing invented.

const SOFA_DEMO_SV: RichExample = {
  brand: 'IKEA',
  productName: 'SÖDERHAMN 3-sitssoffa',
  designer: null,
  variantLabel: 'Konfiguration',
  variantValue: '3-sits · Vit (Blekinge)',
  material: 'Klädsel i bomull/polyester, avtagbar och tvättbar',
  specs: [
    { label: 'Bredd', value: '198 cm' },
    { label: 'Djup', value: '99 cm' },
    { label: 'Höjd', value: '83 cm' },
  ],
  conditionGrade: 'B+',
  conditionLabel: 'Mycket gott skick',
  conditionReasoning: 'Klädseln är hel, nytvättad och utan fläckar. Lätt sittmärke i vänster sits — ram och dynor utan skador.',
  defects: ['Lätt sittmärke i vänster sits'],
  originalPrice: 'ca 8 995 kr',
  resalePrice: '3 500 kr',
  description: '3-sitssoffa med djup, låg sits och avtagbar, maskintvättbar klädsel.',
  image: '/assets/ikea/img-8304.webp',
  imageAlt: 'IKEA SÖDERHAMN 3-sitssoffa, vit',
  imageCredit: null,
  imageNote: null,
}

const SOFA_DEMO_EN: RichExample = {
  brand: 'IKEA',
  productName: 'SÖDERHAMN 3-seat sofa',
  designer: null,
  variantLabel: 'Configuration',
  variantValue: '3-seat · White (Blekinge)',
  material: 'Cotton/polyester cover, removable and washable',
  specs: [
    { label: 'Width', value: '198 cm' },
    { label: 'Depth', value: '99 cm' },
    { label: 'Height', value: '83 cm' },
  ],
  conditionGrade: 'B+',
  conditionLabel: 'Very good condition',
  conditionReasoning: 'The cover is intact, freshly washed, and free of stains. Slight seat impression on the left cushion — frame and cushions undamaged.',
  defects: ['Slight seat impression on the left cushion'],
  originalPrice: 'ca 8,995 SEK',
  resalePrice: '3,500 SEK',
  description: 'A 3-seat sofa with a deep, low seat and a removable, machine-washable cover.',
  image: '/assets/ikea/img-8304.webp',
  imageAlt: 'IKEA SÖDERHAMN 3-seat sofa, white',
  imageCredit: null,
  imageNote: null,
}

const DEMO_EXAMPLES: Record<Language, RichExample[]> = {
  sv: [FASHION_EXAMPLE_SV, SOFA_DEMO_SV],
  en: [FASHION_EXAMPLE_EN, SOFA_DEMO_EN],
}

/** The alternating /brands demo products, in rotation order: [fashion (Asket), furniture (SÖDERHAMN)]. The fashion entry IS the existing rich example — one source of truth, not a copy. */
export function getDemoExamples(language: Language): RichExample[] {
  return DEMO_EXAMPLES[language]
}

/** Best-effort illustrative resale value when only a real retail price is known (e.g. a live-fetched brand product) — never invented, just a transparent percentage of the one real number we do have. */
export function estimateResaleValue(originalPriceSek: number): number {
  return Math.round((originalPriceSek * 0.45) / 10) * 10
}

/** Extracts a plain number of SEK from strings like "1 495 kr", "6 499,00 kr", "12 500–23 500 kr" (range — takes the lower bound) or "1495" — returns null if nothing parseable. Only reads digits from the FIRST number token (space-grouped, stopping at a comma or dash) so a decimal öre part or a second number in a range never gets concatenated into the krona amount. */
export function parseSekAmount(input: string | null): number | null {
  if (!input) return null
  const match = input.match(/\d[\d\s]*\d|\d/)
  if (!match) return null
  const digits = match[0].replace(/\s/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) && n > 0 ? n : null
}

export type RouteKey = 'seller-held' | 'buyback' | 'managed'

export interface RouteInfo {
  headline: string
  tag: string
  body: (buybackLabel: string) => string
  supportsVerification: boolean
}

const ROUTES: Record<Language, Record<RouteKey, RouteInfo>> = {
  sv: {
    'seller-held': {
      headline: 'Ingen lagerhantering',
      tag: 'Sälj utan lager',
      body: () =>
        'Säljaren behåller produkten tills den är såld. Bäst för produkter där ni vill erbjuda resale utan att ta in lager själva.',
      supportsVerification: false,
    },
    buyback: {
      headline: 'Ta bara tillbaka rätt produkter',
      tag: 'Selektivt',
      body: (buybackLabel) =>
        `${buybackLabel} där ekonomin och efterfrågan är rätt — som store credit, utbetalning eller inbyte. Loopa kan bedöma värde och skick innan den fysiska produkten kommer in.`,
      supportsVerification: true,
    },
    managed: {
      headline: 'Outsourca den fysiska hanteringen',
      tag: 'Via partner',
      body: () => 'Den fysiska hanteringen kan skötas via en extern logistik-/resalepartner. Ni slipper bygga ett eget secondhandlager.',
      supportsVerification: true,
    },
  },
  en: {
    'seller-held': {
      headline: 'No inventory handling',
      tag: 'Sell without stock',
      body: () =>
        'The seller keeps the product until it sells. Best for products where you want to offer resale without taking on inventory yourselves.',
      supportsVerification: false,
    },
    buyback: {
      headline: 'Only take back the right products',
      tag: 'Selective',
      body: (buybackLabel) =>
        `${buybackLabel} where the economics and demand are right — as store credit, payout, or trade-in. Loopa can assess value and condition before the physical product arrives.`,
      supportsVerification: true,
    },
    managed: {
      headline: 'Outsource the physical handling',
      tag: 'Via partner',
      body: () => 'The physical handling can be managed via an external logistics/resale partner. You skip building your own secondhand warehouse.',
      supportsVerification: true,
    },
  },
}

export function getRoutes(language: Language): Record<RouteKey, RouteInfo> {
  return ROUTES[language]
}

export const ROUTE_ORDER: RouteKey[] = ['seller-held', 'buyback', 'managed']

const BUYBACK_LABEL: Record<Language, Record<Category, string>> = {
  sv: {
    furniture: 'Inbyte / Trade-in',
    fashion: 'Buyback / Inbyte',
    interior: 'Inbyte / Trade-in',
  },
  en: {
    furniture: 'Trade-in / Buyback',
    fashion: 'Buyback / Trade-in',
    interior: 'Trade-in / Buyback',
  },
}

export function buybackLabelFor(category: Category, language: Language): string {
  return BUYBACK_LABEL[language][category]
}

/** Fallback path fragment used to build an illustrative storefront URL preview when no live resaleTermStyle was found — a URL slug, not translated UI copy. */
export function resaleAreaLabel(category: Category): 'secondhand' | 'pre-owned' {
  return category === 'interior' ? 'pre-owned' : 'secondhand'
}
