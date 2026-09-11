/**
 * Märkena som möter blicken först i rutnätet, i den ordningen.
 *
 * EN SKYLTNING, inte en rangordning. IKEA och Mio står först för att de är de två märken flest
 * säljare faktiskt har hemma — den som öppnar sidan ska se sitt eget vardagsrum i de första två
 * rutorna. Efter dem kommer soffhandeln, och därefter de hus som visar vad rutnätet ÄR: string
 * svart, artek rött, Svenskt Tenn grönt med guld — olika hus med olika ordbilder. Vore hela listan
 * volymhandel mötte man bara snarlika röda och blå rutor och missade att brickorna bär märkenas
 * egen identitet.
 *
 * SoffaDirekt och Sofacompany har egna husfärger i brandLook, avlästa ur deras respektive
 * gränssnitt — sand och bläck, respektive svart på varmvitt i Poppins.
 *
 * Ingen av dem är svårare att hitta för det: sökningen går igenom hela korpusen, och ordningen här
 * gäller bara den tomma rutan.
 */
export const VITRIN: string[] = [
  "IKEA",
  "Mio",
  "SoffaDirekt",
  "Sofacompany",
  "Swedese",
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
  /** Står inte i prismotorns korpus, men i skyltningen — utan raden här faller den tyst ur rutnätet. */
  "SoffaDirekt",
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
