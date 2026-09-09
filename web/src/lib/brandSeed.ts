/**
 * Märkena som möter blicken först i rutnätet, i den ordningen.
 *
 * EN SKYLTNING, inte en rangordning. De åtta är valda för att de tillsammans visar vad rutnätet ÄR:
 * IKEA blått med gult, string svart, artek rött, Svenskt Tenn grönt med guld — åtta olika hus med
 * åtta olika ordbilder. Öppnade listan i stället med volymhandeln, som råkar ligga först i listan
 * nedan, mötte man fem snarlika röda och blå rutor och missade att brickorna bär märkenas egen
 * identitet.
 *
 * Ingen av dem är svårare att hitta för det: sökningen går igenom hela korpusen, och ordningen här
 * gäller bara den tomma rutan.
 */
export const VITRIN: string[] = [
  "IKEA",
  "HAY",
  "String Furniture",
  "Fritz Hansen",
  "Artek",
  "Svenskt Tenn",
  "Carl Hansen & Søn",
  "Muuto",
];

/**
 * Märkena som ligger först i rutnätet efter skyltningen ovan.
 *
 * Handplockad och avsiktligt kort. Söker man däremot något söks HELA `brands.ts` (204 märken mätta
 * mot prismotorns korpus) igenom, så listan här är en genväg och inte en gräns. Hittas märket ändå
 * inte finns manuell inmatning längst ned.
 */
export const POPULAR_BRANDS: string[] = [
  "IKEA",
  "Mio",
  "EM Home",
  "Jysk",
  "Skeidar",
  "Chilli",
  "Furniturebox",
  "Trademax",
  "Svenskt Tenn",
  "String Furniture",
  "Källemo",
  "DUX",
  "Norell Möbel",
  "HAY",
  "Bolia",
  "Artek",
  "Fritz Hansen",
  /**
   * Står i brandLook men saknades här, och föll därför tyst ur skyltningen — en bricka som är
   * formgiven men aldrig ritad. Att välja den fungerar som vilket annat märke som helst: namnet går
   * vidare i flödet precis som ett handskrivet gör.
   */
  "Carl Hansen & Søn",
  "Muuto",
  "&Tradition",
  "Ferm Living",
  "Stressless",
  "Vitra",
  "Herman Miller",
  "West Elm",
];
