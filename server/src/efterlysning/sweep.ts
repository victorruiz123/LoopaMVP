/**
 * Direktsvepet: det köparen ser i samma sekund som efterlysningen skapas.
 *
 * ALDRIG NOLL ÄR ETT PRODUKTKRAV, inte en ambition. Den som just beskrivit sin soffa och möts av
 * "inga träffar" har fått veta att tjänsten inte fungerar, och kommer inte tillbaka för att se om
 * den gör det nästa vecka. Första intrycket ska vara "de hittade ju saker direkt" — precisionen tar
 * över först i notiserna, som är strikta.
 *
 * GENERÖST BETYDER INTE OÄRLIGT. Varje nära-träff bär en mening om vad som inte stämmer, byggd i kod
 * ur samma jämförelse som släppte igenom den. Och generositeten gäller bara stil, färg och märke:
 * kategori, pris och mått bryts aldrig, inte ens här. En kompromiss man inte kan ha hemma är inte
 * en kompromiss.
 *
 * ORDNINGEN ÄR VÄRDEORDNING: våra egna granskade varor först, sedan de som är på väg in, sedan
 * Tradera. Se SOURCE_RANK.
 */

import { allProducts } from "../butik/inventory.js";
import { brandFacets } from "../butik/inventory.js";

import type { Candidate } from "./match.js";
import { evaluateAll } from "./match.js";
import * as store from "./store.js";
import type { Efterlysning } from "./types.js";

/** Så många kandidater ett svep lämnar tillbaka. Tre till sex enligt briefen; sex när de finns. */
const SWEEP_LIMIT = Number(process.env.EFTERLYSNING_SWEEP_LIMIT ?? 6);

export interface SweepResult {
  candidates: Candidate[];
  /** Hur många objekt vi läste igenom. Loggas per efterlysning — pulsens siffra. */
  scanned: number;
  /** Tradera svarade inte. Rutan säger det i stället för att låtsas att lagret är tomt. */
  traderaDegraded: boolean;
  /** "Soffor i din prisklass matchas oftast inom 6 dagar", eller null när vi inte vet. */
  forecast: string | null;
}

export async function sweep(e: Efterlysning, opts: { generous?: boolean } = {}): Promise<SweepResult> {
  const generous = opts.generous ?? true;
  const brands = (await brandFacets()).map((b) => b.brand);
  let scanned = 0;
  const candidates: Candidate[] = [];

  /**
   * Våra egna, i två högar.
   *
   * `allProducts()` bygger ur jobben och bär BÅDE publicerade och utkast — ett jobb utan post i
   * butikslagret räknas som `draft`. Utkasten är möbler som är besiktigade men ännu inte utlagda,
   * och det är precis förturens hög: en köpare som efterlyst något ska få se det innan det går ut
   * publikt (se fortur.ts). Att hämta dem ur samma lista är billigare än ett andra varv över
   * lagret, och de kan inte glida isär.
   */
  const ours = (await allProducts()).filter((p) => p.source === "loopa");
  const live = ours.filter((p) => p.state === "live");
  const pre = ours.filter((p) => p.state === "draft");
  scanned += live.length + pre.length;
  candidates.push(...evaluateAll(e, live, "loopa_live", generous));
  candidates.push(...evaluateAll(e, pre, "loopa_incoming", generous));

  // Tradera, med köparens pristak nedskjutet i anropet.
  let traderaDegraded = false;
  try {
    const { searchForCategory, traderaSourceEnabled } = await import("../integrations/tradera/search.js");
    if (traderaSourceEnabled()) {
      const words = searchWordsFor(e);
      const found = await searchForCategory(e.filter.categorySlug ?? null, words, brands, e.filter.maxPriceSek ?? null);
      scanned += found.length;
      candidates.push(...evaluateAll(e, found, "tradera", generous));
    }
  } catch {
    traderaDegraded = true;
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const top = dedupe(candidates).slice(0, SWEEP_LIMIT);

  await store.recordSweep(e.id, scanned);
  await store.logMatches(
    top.map((c) => ({
      efterlysningId: e.id,
      productId: c.product.id,
      source: c.source,
      kind: c.kind,
      fitNote: c.fitNote,
    })),
  );

  return { candidates: top, scanned, traderaDegraded, forecast: await forecastFor(e) };
}

/** Samma möbel kan komma ur två källor — vår egen post och Traderas annons för den. */
function dedupe(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c.product.id)) return false;
    seen.add(c.product.id);
    return true;
  });
}

/**
 * Söksträngen till Tradera: köparens egna ord, inte vår sammanfattning.
 *
 * Märke och stil hjälper sökmotorn; färg och material gör det sällan — Tradera-säljare skriver
 * "grön" i beskrivningen och inte i rubriken, och `SearchInDescription` är av. Att skicka med dem
 * hade smalnat av sökningen till nästan ingenting.
 */
function searchWordsFor(e: Efterlysning): string | null {
  const words = [...(e.filter.brands ?? []), ...(e.filter.q ? [e.filter.q] : [])];
  return words.length ? words.join(" ") : null;
}

/**
 * "Soffor i din prisklass matchas oftast inom X dagar."
 *
 * NULL TILLS DATAN FINNS, och det är hela poängen. Siffran räknas ur riktiga matchningar — tiden
 * från att en efterlysning skapades till att dess första träff loggades — och under tröskeln
 * returneras null så att elementet döljer sig i stället för att visa en gissning.
 */
export async function forecastFor(e: Efterlysning): Promise<string | null> {
  const MIN_SAMPLES = Number(process.env.EFTERLYSNING_FORECAST_MIN ?? 5);
  const all = await store.all();
  const matches = await store.allMatches();

  const byId = new Map(all.map((x) => [x.id, x]));
  const days: number[] = [];
  const firstSeen = new Set<string>();
  for (const m of matches) {
    if (firstSeen.has(m.efterlysningId)) continue;
    firstSeen.add(m.efterlysningId);
    const owner = byId.get(m.efterlysningId);
    // Bara jämförbara efterlysningar: samma kategori. En soffa och en lampa har inget att säga om
    // varandras väntetid.
    if (!owner || owner.filter.categorySlug !== e.filter.categorySlug) continue;
    days.push((new Date(m.foundAt).getTime() - new Date(owner.createdAt).getTime()) / 86_400_000);
  }
  if (days.length < MIN_SAMPLES) return null;

  days.sort((a, b) => a - b);
  const median = Math.max(1, Math.round(days[Math.floor(days.length / 2)]));
  const { categoryLabel } = await import("../butik/catalog.js");
  const what = e.filter.categorySlug ? categoryLabel(e.filter.categorySlug) : "Möbler";
  return `${what} i din prisklass matchas oftast inom ${median} ${median === 1 ? "dag" : "dagar"}.`;
}
