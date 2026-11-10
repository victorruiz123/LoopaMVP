/**
 * Det verifierade faktaminnet: vad forskningen redan belagt om en modell, så att nästa säljare av
 * samma modell slipper vänta på en ny sökning.
 *
 * VAD DET ÄR OCH INTE ÄR. Det är ett minne av ett slutfört forskningssvar, nyckelat på märke + modell,
 * med bevisen kvar (källor, belägg per rad). Det är INGEN produktkatalog och ingen identifieringsväg:
 * modellen väljs fortfarande ur säljarens bilder, och minnet läses först efter att modellen är vald.
 * Det innehåller heller aldrig något som hör till en enskild säljare (bilder, anteckningar, id).
 *
 * VARFÖR DET ÄR VÄRT ETT ANDRA ANROP. En specsökning tar 50–100 s och kostar 0,15–0,45 USD. Måtten för
 * IKEA INGEMAR ändras inte mellan två säljare. Minnet gäller alla varianter (ProductFacts bär dem alla),
 * så ett variantval filtrerar ur det i stället för att söka om.
 *
 * SKYDD MOT ETT DÅLIGT SVAR SOM STÅR KVAR. Bara svar som bär riktigt belägg sparas (se `worthCaching`):
 * ett tomt eller huvudsakligen obekräftat svar sparas inte, och inget sparas när bilderna inte stämde
 * med produkten. Posten förfaller efter 14 dagar. LOOPA_FACTS_CACHE=0 stänger av det.
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { slugKey } from "./normalize.js";
import type { ProductFacts } from "./types.js";

const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const dir = (): string => process.env.LOOPA_FACTS_CACHE_DIR || path.resolve(import.meta.dirname, "..", "..", "data", "cache", "product-facts");
export const factsCacheEnabled = (): boolean => process.env.LOOPA_FACTS_CACHE !== "0";

export const factsKey = (brand: string, model: string): string => slugKey(`${brand} ${model}`);

/**
 * Bär svaret tillräckligt belägg för att ett senare jobb ska få lita på det utan egen sökning?
 *   - minst två mått, och
 *   - minst ett bekräftat mot sidan, eller minst tre mått med en känd källa (cited), och
 *   - bilderna stämde med produkten (eller var inte jämförbara).
 */
export function worthCaching(facts: ProductFacts): boolean {
  if (facts.identity.matchesPhotos === false) return false;
  const dims = facts.dimensions;
  if (dims.length < 2) return false;
  const confirmed = dims.filter((d) => d.verification === "page_confirmed").length;
  const cited = dims.filter((d) => d.verification === "cited").length;
  return confirmed >= 1 || cited >= 3;
}

export async function loadFacts(brand: string, model: string, now = Date.now()): Promise<ProductFacts | null> {
  if (!factsCacheEnabled()) return null;
  try {
    const raw = await readFile(path.join(dir(), `${factsKey(brand, model)}.json`), "utf-8");
    const facts = JSON.parse(raw) as ProductFacts;
    if (facts?.version !== 1 || !Array.isArray(facts.dimensions) || !Array.isArray(facts.materials)) return null;
    if (now - facts.researchedAt > TTL_MS) return null;
    return facts;
  } catch {
    return null;
  }
}

export async function saveFacts(brand: string, model: string, facts: ProductFacts): Promise<boolean> {
  if (!factsCacheEnabled() || !worthCaching(facts)) return false;
  try {
    await mkdir(dir(), { recursive: true });
    const file = path.join(dir(), `${factsKey(brand, model)}.json`);
    // Unikt namn per skrivning: två jobb för samma modell kan spara samtidigt, och en delad tillfällig fil
    // gjorde att den ena bytte namn på en fil den andra redan flyttat.
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(facts), "utf-8");
    await rename(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[facts-cache] kunde inte spara ${brand} ${model}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
