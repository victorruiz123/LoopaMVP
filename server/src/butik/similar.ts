/**
 * "Liknande möbler" — det en såld möbels sida visar i stället för köpknappen.
 *
 * VARFÖR DEN FINNS. Ett Facebook-inlägg eller en Marketplace-annons lever kvar efter att möbeln sålts;
 * V1 städar inte bort dem. Den som klickar sig hit från ett gammalt inlägg ska mötas av ett tydligt
 * "såld" och sedan av det vi faktiskt har — annars är trafiken bortkastad.
 *
 * INTE ÖVERARBETAT MED FLIT. Tre uppgifter vi redan har på varje vara — kategori, märke, pris — och en
 * deterministisk ordning. Ingen personalisering, ingen modell. Rangordningen är:
 *
 *   samma kategori  +50      samma möbeltyp  +20 (finare än kategorin, när den går att avläsa)
 *   samma märke     +30      nära pris       upp till +20, linjärt med avståndet
 *
 * och RESERVEN är alltid resten av lagret: räcker inte de lika möblerna fylls listan med det som ligger
 * uppe, nyast först. En såld möbel ska aldrig visa en tom hylla.
 */

import { fold, resolveTypeSlug } from "./catalog.js";
import { allProducts, productById } from "./inventory.js";
import { BROWSABLE_STATES, type Product } from "./types.js";

export const SIMILAR_WEIGHTS = { category: 50, brand: 30, type: 20, price: 20 } as const;

/** Hur långt ifrån i pris en möbel får vara och ändå få full prispoäng. Utöver det faller poängen linjärt till noll vid dubbla avståndet. */
const PRICE_TOLERANCE = 0.25;

export function similarityScore(target: Product, candidate: Product): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (candidate.categorySlug === target.categorySlug) {
    score += SIMILAR_WEIGHTS.category;
    reasons.push("samma kategori");
  }
  if (target.brand && candidate.brand && fold(target.brand) === fold(candidate.brand)) {
    score += SIMILAR_WEIGHTS.brand;
    reasons.push("samma märke");
  }
  const targetType = resolveTypeSlug(target);
  if (targetType && targetType === resolveTypeSlug(candidate)) {
    score += SIMILAR_WEIGHTS.type;
    reasons.push("samma möbeltyp");
  }
  if (target.priceSek && candidate.priceSek) {
    const rel = Math.abs(candidate.priceSek - target.priceSek) / Math.max(candidate.priceSek, target.priceSek);
    const pricePoints = rel <= PRICE_TOLERANCE ? SIMILAR_WEIGHTS.price : Math.max(0, SIMILAR_WEIGHTS.price * (1 - (rel - PRICE_TOLERANCE) / PRICE_TOLERANCE));
    if (pricePoints > 0) {
      score += Math.round(pricePoints);
      reasons.push("liknande pris");
    }
  }
  return { score, reasons };
}

/**
 * Liknande, tillgängliga Loopa-möbler. Deterministisk: samma lager ger samma lista.
 *
 * Bara det som går att köpa (`BROWSABLE_STATES`) och bara Loopas egna — en såld möbels sida ska peka
 * på vad VI har, inte på någon annans Tradera-annons. Den sålda möbeln själv är aldrig med.
 */
export function similarProducts(target: Product, pool: Product[], limit = 8): Product[] {
  const candidates = pool.filter((p) => p.id !== target.id && p.source === "loopa" && BROWSABLE_STATES.includes(p.state));
  return candidates
    .map((p) => ({ p, s: similarityScore(target, p).score }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      // Reserven: nyast först, därefter id — så att två lika möbler alltid står i samma ordning.
      if (a.p.listedAt !== b.p.listedAt) return a.p.listedAt < b.p.listedAt ? 1 : -1;
      return a.p.id.localeCompare(b.p.id);
    })
    .slice(0, Math.max(0, limit))
    .map((x) => x.p);
}

/** Liknande möbler för en vara i lagret. Null när varan inte finns. */
export async function similarFor(id: string, limit = 8): Promise<Product[] | null> {
  const target = await productById(id);
  if (!target) return null;
  return similarProducts(target, await allProducts(), limit);
}
