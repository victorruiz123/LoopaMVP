export interface StorefrontListing {
  id: string
  image: string
  name: string
  variant: { sv: string; en: string }
  priceSek: number
  originalPriceSek: number
  location: string
  condition: { sv: string; en: string }
}

export const STOREFRONT_LISTINGS: StorefrontListing[] = [
  {
    id: 'catania-95',
    image: '/assets/listings/catania-95-soffbord-ek.webp',
    name: 'CATANIA 95',
    variant: { sv: 'Soffbord, ek', en: 'Coffee table, oak' },
    priceSek: 2400,
    originalPriceSek: 4995,
    location: 'Södermalm',
    condition: { sv: 'Mycket bra skick', en: 'Very good condition' },
  },
  {
    id: 'manhattan',
    image: '/assets/listings/manhattan-divnasoffa-hoger-ljusgra.webp',
    name: 'MANHATTAN',
    variant: { sv: 'Divansoffa höger, ljusgrå', en: 'Chaise sofa right, light grey' },
    priceSek: 6800,
    originalPriceSek: 16995,
    location: 'Vasastan',
    condition: { sv: 'Bra skick', en: 'Good condition' },
  },
  {
    id: 'alex',
    image: '/assets/listings/alex-sangbord-svart.webp',
    name: 'ALEX',
    variant: { sv: 'Sängbord, svart', en: 'Bedside table, black' },
    priceSek: 1100,
    originalPriceSek: 3195,
    location: 'Bromma',
    condition: { sv: 'Mycket bra skick', en: 'Very good condition' },
  },
  {
    id: 'portino',
    image: '/assets/listings/portino-2-sitssoffa-beige.webp',
    name: 'PORTINO',
    variant: { sv: '2-sitssoffa, beige', en: '2-seat sofa, beige' },
    priceSek: 3700,
    originalPriceSek: 8495,
    location: 'Solna',
    condition: { sv: 'Bra skick', en: 'Good condition' },
  },
  {
    id: 'stockholm',
    image: '/assets/listings/stockholm-3-sitssoffa-morkbla.webp',
    name: 'STOCKHOLM',
    variant: { sv: '3-sitssoffa, mörkblå', en: '3-seat sofa, dark blue' },
    priceSek: 5100,
    originalPriceSek: 12495,
    location: 'Kungsholmen',
    condition: { sv: 'Bra skick', en: 'Good condition' },
  },
  {
    id: 'maxime',
    image: '/assets/listings/maxime-divansoffa-vanster-vit.webp',
    name: 'MAXIME',
    variant: { sv: 'Divansoffa vänster, vit', en: 'Chaise sofa left, white' },
    priceSek: 8000,
    originalPriceSek: 19995,
    location: 'Täby',
    condition: { sv: 'Mycket bra skick', en: 'Very good condition' },
  },
]

export function discountPercent(price: number, original: number) {
  return Math.round(100 - (price / original) * 100)
}
