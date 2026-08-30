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
 * bokföringssystem gör. Kommer den uträkningen ska den läsa samma tal som den här filen. Just nu är
 * `LOOPA_PERCENT` det enda vyerna använder — resten står kvar för den uträkningen, oanropad.
 */
export const LOOPA_FEE_PCT = 0.2;

/** Hela procenttal för texten — 20 och 80. Utskrivet en gång, inte avrundat på varje visningsställe. */
export const LOOPA_PERCENT = Math.round(LOOPA_FEE_PCT * 100);
export const SELLER_PERCENT = 100 - LOOPA_PERCENT;

/** Loopas andel av ett möbelpris, i hela kronor. */
export function loopaFee(itemPrice: number): number {
  return Math.round(itemPrice * LOOPA_FEE_PCT);
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
