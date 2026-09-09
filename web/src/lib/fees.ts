/**
 * Vad Loopa tar.
 *
 * Andelen står på ETT ställe i flödet: raden sist på startsidan, under de sparade annonserna, innan
 * man börjar. Diagrammet och rutan "Vad tar Loopa?" i säljbekräftelsen är borta — samma sak sagd
 * tre gånger blev tre texter som var för sig kunde ändras. Talet bor ändå här och inte inskrivet i
 * raden, så uträkningarna nedan och det säljaren läser aldrig kan glida isär.
 *
 * Andelen räknas på vad MÖBELN säljs för, aldrig på hemleveransen: de kronorna går vidare till
 * budfirman och är ingen del av affären mellan säljaren och Loopa. Därför tar funktionerna nedan
 * `itemPrice` och inte annonspriset — det senare innehåller frakten.
 *
 * Ingen server räknar ännu ut någon utbetalning; det här är vad säljaren blir lovad, inte vad ett
 * bokföringssystem gör. Kommer den uträkningen ska den läsa samma tal som den här filen.
 */
export const LOOPA_FEE_PCT = 0.2;

/**
 * TAKET. Andelen slutar växa här.
 *
 * En procentsats utan tak betyder att en soffa för 20 000 kr kostar 4 000 kr att sälja, och det är
 * mer än arbetet är värt för oss och betydligt mer än det känns värt för säljaren — det är på de
 * dyra möblerna en säljare börjar räkna på att göra det själv. Taket gör avgiften förutsägbar i
 * precis det läget: som mest tusen kronor, oavsett vad möbeln går för.
 */
export const LOOPA_FEE_CAP_SEK = 1000;

/**
 * Möbelpriset där taket tar över — 5 000 kr, med dagens tal.
 *
 * HÄRLETT OCH INTE SKRIVET. Det är samma gräns som `LOOPA_FEE_CAP_SEK / LOOPA_FEE_PCT`, och två tal
 * som måste hänga ihop ska inte kunna skrivas isär: ändras andelen eller taket flyttar sig gränsen
 * av sig själv, i varje text som nämner den.
 */
export const LOOPA_FEE_CAP_FROM_SEK = Math.round(LOOPA_FEE_CAP_SEK / LOOPA_FEE_PCT);

/** Hela procenttal för texten — 20 och 80. Utskrivet en gång, inte avrundat på varje visningsställe. */
export const LOOPA_PERCENT = Math.round(LOOPA_FEE_PCT * 100);
export const SELLER_PERCENT = 100 - LOOPA_PERCENT;

/** Loopas andel av ett möbelpris, i hela kronor — aldrig mer än taket. */
export function loopaFee(itemPrice: number): number {
  return Math.min(Math.round(itemPrice * LOOPA_FEE_PCT), LOOPA_FEE_CAP_SEK);
}

/** Sant när taket slagit till, alltså när avgiften är lägre än andelen skulle ha gett. */
export function feeIsCapped(itemPrice: number): boolean {
  return Math.round(itemPrice * LOOPA_FEE_PCT) > LOOPA_FEE_CAP_SEK;
}

/**
 * Vad säljaren får ut.
 *
 * Räknas som resten efter avgiften, inte som `pris × 0,8`. Två separata avrundningar kan tillsammans
 * bli en krona ifrån priset, och en tabell vars två rader inte summerar till det som står ovanför
 * dem är sämre än ingen tabell alls.
 */
export function sellerPayout(itemPrice: number): number {
  return itemPrice - loopaFee(itemPrice);
}
