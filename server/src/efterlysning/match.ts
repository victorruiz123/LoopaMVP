/**
 * Matchningen: en efterlysning mot en möbel.
 *
 * EN TJÄNST, FYRA KÄLLOR, och rangordningen mellan dem är produkten:
 *
 *   loopa_live      granskad, prissatt och köpbar nu — bäst för alla inblandade
 *   loopa_incoming  besiktigad men ännu inte publicerad; köparen får förtur (fortur.ts)
 *   tradera         någon annans annons, som vi kan analysera och leverera
 *   own_find        köparens egen länk, kopplad till efterlysningen
 *
 * TVÅ HÅRDHETER, och skillnaden avgör om ett brev skickas:
 *
 *   `exact`  uppfyller HELA specen. Får väcka en notis.
 *   `near`   bryter mot en mjuk önskan — stil, färg, märke — men aldrig mot en hård gräns.
 *            Visas i direktsvepet och i veckans digest. Väcker aldrig en notis.
 *
 * DE HÅRDA GRÄNSERNA ÄR VERKLIGA MÅTT PÅ VERKLIGHETEN. En soffa 30 cm för bred kommer inte in genom
 * dörren hur välformulerad kompromissen än är, och ett pris över taket är inte en kompromiss utan
 * ett annat objekt. Därför prövas de först, för sig, och kan inte vägas bort av något annat.
 */

import { fold } from "../butik/catalog.js";
import type { Product } from "../butik/types.js";
import type { Efterlysning, MatchKind, MatchSource } from "./types.js";
import { SOURCE_RANK } from "./types.js";

export interface Candidate {
  product: Product;
  source: MatchSource;
  kind: MatchKind;
  /** Vad som stämmer och vad som inte gör det, i klartext. Byggs i kod — se `fitNoteFor`. */
  fitNote: string;
  /** Lägre är bättre. Källrang först, sedan hur mycket som avviker. */
  rank: number;
}

const within = (max: number | null | undefined, actual: number | null): boolean =>
  max === null || max === undefined || (actual !== null && actual <= max);

/**
 * Bryter möbeln någon hård gräns?
 *
 * Ett SAKNAT mått fäller möbeln när köparen satt en gräns. Det är strängare än det ser ut och det är
 * med flit: "max 210 cm bred" ställd av någon med en nisch på 215 cm får inte besvaras med en soffa
 * vars bredd vi inte känner till. Att gissa åt köparen är precis vad hela produkten finns för att
 * slippa.
 */
export function violatesHard(e: Efterlysning, p: Product): string | null {
  const f = e.filter;
  if (f.categorySlug && p.categorySlug !== f.categorySlug) return "fel kategori";
  if (f.maxPriceSek !== null && f.maxPriceSek !== undefined) {
    if (p.priceSek === null || p.priceSek > f.maxPriceSek) return "över priset";
  }
  if (!within(f.maxWidthMm, p.dimensions.widthMm)) return "för bred";
  if (!within(f.maxDepthMm, p.dimensions.depthMm)) return "för djup";
  if (!within(f.maxHeightMm, p.dimensions.heightMm)) return "för hög";
  return null;
}

/** De mjuka önskemålen, var för sig, så vi kan säga vilket som brast. */
interface SoftCheck {
  label: string;
  wanted: string;
  ok: boolean;
  /** Vad möbeln faktiskt är, när det går att säga. Bär meningen "blå, inte grön". */
  actual: string | null;
}

function softChecks(e: Efterlysning, p: Product): SoftCheck[] {
  const f = e.filter;
  const out: SoftCheck[] = [];

  if (f.brands?.length) {
    const want = f.brands.map(fold);
    out.push({
      label: "märke",
      wanted: f.brands.join(" eller "),
      ok: !!p.brand && want.includes(fold(p.brand)),
      actual: p.brand,
    });
  }
  if (f.colors?.length) {
    const want = f.colors.map(fold);
    // Färgen matchas som delsträng: "mörkgrön" ska svara på "grön", och tvärtom.
    const hit = !!p.color && want.some((w) => fold(p.color!).includes(w) || w.includes(fold(p.color!)));
    out.push({ label: "färg", wanted: f.colors.join(" eller "), ok: hit, actual: p.color });
  }
  if (f.materials?.length) {
    const want = f.materials.map(fold);
    const hit = !!p.material && want.some((w) => fold(p.material!).includes(w) || w.includes(fold(p.material!)));
    out.push({ label: "material", wanted: f.materials.join(" eller "), ok: hit, actual: p.material });
  }
  if (f.grades?.length) {
    // Betyg finns bara på Loopa-varor. En Tradera-annons har inget vi granskat, och att räkna det som
    // ett brott hade gjort varje extern möbel till en nära-träff på en grund vi inte kan belägga.
    const grade = p.condition?.grade ?? null;
    out.push({
      label: "skick",
      wanted: f.grades.join("/"),
      ok: grade === null ? true : (f.grades as string[]).includes(grade),
      actual: grade,
    });
  }
  if (e.styleTags.length) {
    const hay = fold(`${p.title} ${p.brand ?? ""} ${p.model ?? ""} ${p.material ?? ""}`);
    out.push({
      label: "stil",
      wanted: e.styleTags.join(", "),
      ok: e.styleTags.some((t) => hay.includes(fold(t))),
      actual: null,
    });
  }
  return out;
}

/**
 * Meningen under en träff, byggd i KOD och aldrig av en modell.
 *
 * "Rätt modell och pris — men blå, inte grön" är ett påstående om varför vi visar något, och den
 * sortens påstående får inte kunna hitta på ett skäl. Den skrivs därför ur samma jämförelse som
 * fattade beslutet.
 */
function fitNoteFor(checks: SoftCheck[], kind: MatchKind): string {
  if (kind === "exact") return "Uppfyller allt du bad om.";
  const missed = checks.filter((c) => !c.ok);
  const parts = missed.map((c) => (c.actual ? `${c.actual}, inte ${c.wanted}` : `inte ${c.wanted}`));
  const kept = checks.filter((c) => c.ok).length;
  const head = kept > 0 ? "Inom pris och mått" : "Inom pris och mått";
  return `${head} — men ${parts.join(" och ")}.`;
}

/**
 * Prövar en möbel mot en efterlysning.
 *
 * Returnerar null när en HÅRD gräns bryts — då finns ingen kandidat, inte ens en dålig. `generous`
 * avgör bara om mjuka missar får passera som `near`: direktsvepet och digesten är generösa, notiser
 * är det aldrig.
 */
export function evaluate(
  e: Efterlysning,
  p: Product,
  source: MatchSource,
  generous: boolean,
): Candidate | null {
  if (violatesHard(e, p)) return null;

  const checks = softChecks(e, p);
  const missed = checks.filter((c) => !c.ok).length;
  const kind: MatchKind = missed === 0 ? "exact" : "near";
  if (kind === "near" && !generous) return null;

  return {
    product: p,
    source,
    kind,
    fitNote: fitNoteFor(checks, kind),
    // Källan väger tyngst, sedan antalet missar. Ett prisnära objekt sist som tiebreak, så listan
    // inte kastas om mellan två anrop med samma data.
    rank: SOURCE_RANK[source] * 100 + missed * 10 + (p.priceSek ?? 0) / 1_000_000,
  };
}

/** Prövar en hel lista och lämnar den rangordnad. */
export function evaluateAll(
  e: Efterlysning,
  products: Product[],
  source: MatchSource,
  generous: boolean,
): Candidate[] {
  return products
    .map((p) => evaluate(e, p, source, generous))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => a.rank - b.rank);
}
