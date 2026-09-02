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

/**
 * TRE utfall, inte två: inom, över, eller okänt.
 *
 * Skillnaden mellan "över" och "okänt" är hela skillnaden mellan en lögn och en osäkerhet. En soffa
 * som mäter 220 cm passar bevisligen inte i en nisch på 210; en soffa vars bredd inte står i
 * annonsen kanske gör det. Att slå ihop dem åt endera hållet ger fel produkt: som "över" blir varje
 * måttsatt efterlysning ett tomt direktsvep (de flesta annonser saknar mått), som "inom" påstår vi
 * att något passar som vi inte vet något om.
 */
type Fit = "inom" | "over" | "okant";

function fits(max: number | null | undefined, actual: number | null): Fit {
  if (max === null || max === undefined) return "inom";
  if (actual === null) return "okant";
  return actual <= max ? "inom" : "over";
}

/** Det som är BEVISAT utanför specen. Fäller möbeln överallt, i alla lägen. */
export function violatesHard(e: Efterlysning, p: Product): string | null {
  const f = e.filter;
  if (f.categorySlug && p.categorySlug !== f.categorySlug) return "fel kategori";
  // Ett saknat pris räknas som över: en möbel utan pris kan inte visas mot ett pristak alls.
  if (f.maxPriceSek !== null && f.maxPriceSek !== undefined) {
    if (p.priceSek === null || p.priceSek > f.maxPriceSek) return "över priset";
  }
  if (fits(f.maxWidthMm, p.dimensions.widthMm) === "over") return "för bred";
  if (fits(f.maxDepthMm, p.dimensions.depthMm) === "over") return "för djup";
  if (fits(f.maxHeightMm, p.dimensions.heightMm) === "over") return "för hög";
  return null;
}

/** Måtten vi inte kan uttala oss om. Fäller i strikt läge, blir en ärlig nära-träff i generöst. */
function unknownDimensions(e: Efterlysning, p: Product): string[] {
  const f = e.filter;
  const out: string[] = [];
  if (fits(f.maxWidthMm, p.dimensions.widthMm) === "okant") out.push("bredden");
  if (fits(f.maxDepthMm, p.dimensions.depthMm) === "okant") out.push("djupet");
  if (fits(f.maxHeightMm, p.dimensions.heightMm) === "okant") out.push("höjden");
  return out;
}

/**
 * De mjuka önskemålen, var för sig, med TRE utfall.
 *
 * `fel` är ett påstående om MÖBELN: vi vet vad den är, och det stämmer inte. `okant` är ett påstående
 * om ANNONSEN: fältet är tomt och vi vet ingenting. Att skriva "inte String" om en annons som heter
 * "STRING vägghylla" är den första sortens mening på den andra sortens grund — mätt i skarp körning,
 * och det är därför skillnaden finns.
 */
type SoftVerdict = "ok" | "fel" | "okant";

interface SoftCheck {
  label: string;
  wanted: string;
  verdict: SoftVerdict;
  /** Vad möbeln faktiskt är, när det går att säga. Bär meningen "blå, inte grön". */
  actual: string | null;
}

/** Ett tomt fält är okänt, inte fel. Ett ifyllt fält prövas mot önskemålet. */
function verdictOf(actual: string | null, wanted: string[]): SoftVerdict {
  if (!actual) return "okant";
  const a = fold(actual);
  return wanted.some((w) => a.includes(fold(w)) || fold(w).includes(a)) ? "ok" : "fel";
}

function softChecks(e: Efterlysning, p: Product): SoftCheck[] {
  const f = e.filter;
  const out: SoftCheck[] = [];

  if (f.brands?.length) {
    /**
     * Märket läses ur RUBRIKEN när fältet är tomt.
     *
     * Tradera-varor får `brand: null` när igenkänningen inte träffar, och koden läste förut frånvaro
     * som fel. Mätt skarpt: efterlysningen "String-hylla" fick fyra träffar märkta "inte String" —
     * om annonser som heter "STRING vägghylla" och "Stringgavlar (String)".
     */
    const fromTitle = f.brands.find((b) => fold(p.title).includes(fold(b))) ?? null;
    const known = p.brand ?? fromTitle;
    out.push({
      label: "märke",
      wanted: f.brands.join(" eller "),
      verdict: verdictOf(known, f.brands),
      actual: known,
    });
  }
  if (f.colors?.length) {
    // Färgen matchas som delsträng: "mörkgrön" ska svara på "grön", och tvärtom.
    out.push({ label: "färg", wanted: f.colors.join(" eller "), verdict: verdictOf(p.color, f.colors), actual: p.color });
  }
  if (f.materials?.length) {
    out.push({ label: "material", wanted: f.materials.join(" eller "), verdict: verdictOf(p.material, f.materials), actual: p.material });
  }
  if (f.grades?.length) {
    // Betyg finns bara på Loopa-varor. En Tradera-annons har inget vi granskat, och att räkna det som
    // ett brott hade gjort varje extern möbel till en nära-träff på en grund vi inte kan belägga.
    const grade = p.condition?.grade ?? null;
    out.push({
      label: "skick",
      wanted: f.grades.join("/"),
      verdict: grade === null ? "ok" : ((f.grades as string[]).includes(grade) ? "ok" : "fel"),
      actual: grade,
    });
  }
  if (e.styleTags.length) {
    const hay = fold(`${p.title} ${p.brand ?? ""} ${p.model ?? ""} ${p.material ?? ""}`);
    out.push({
      label: "stil",
      wanted: e.styleTags.join(", "),
      // Stil står aldrig i ett fält — den läses ur texten, och frånvaro av ord är inte ett bevis.
      verdict: e.styleTags.some((t) => hay.includes(fold(t))) ? "ok" : "okant",
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
function fitNoteFor(checks: SoftCheck[], unknownDims: string[], kind: MatchKind): string {
  if (kind === "exact") return "Uppfyller allt du bad om.";

  const parts: string[] = [];
  // Först det vi VET är fel. Det är den informationen köparen fattar sitt beslut på.
  for (const c of checks.filter((x) => x.verdict === "fel")) {
    parts.push(c.actual ? `${c.actual}, inte ${c.wanted}` : `inte ${c.wanted}`);
  }
  // Sedan det vi inte vet. Formulerat som ett påstående om ANNONSEN, inte om möbeln.
  const unknowns = checks.filter((x) => x.verdict === "okant").map((x) => x.label);
  if (unknownDims.length) {
    unknowns.push(unknownDims.length === 3 ? "måtten" : unknownDims.join(" och "));
  }
  if (unknowns.length) {
    parts.push(`${unknowns.join(", ")} framgår inte av annonsen`);
  }

  return parts.length ? `Inom pris och kategori — men ${parts.join(", och ")}.` : "Inom pris och kategori.";
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

  const unknownDims = unknownDimensions(e, p);
  const checks = softChecks(e, p);
  const wrong = checks.filter((c) => c.verdict === "fel").length;
  const unsure = checks.filter((c) => c.verdict === "okant").length + unknownDims.length;

  const kind: MatchKind = wrong === 0 && unsure === 0 ? "exact" : "near";
  /**
   * STRIKT LÄGE SLÄPPER BARA IGENOM DET SOM ÄR BEVISAT RÄTT.
   *
   * Notiser går den här vägen, och där är ett okänt mått lika diskvalificerande som ett för stort:
   * vi väcker aldrig någon för en möbel vi inte vet får plats. Generositeten finns bara i
   * direktsvepet och veckans digest, där köparen själv står och tittar och kan avgöra.
   */
  if (kind === "near" && !generous) return null;

  return {
    product: p,
    source,
    kind,
    fitNote: fitNoteFor(checks, unknownDims, kind),
    /**
     * Källan väger tyngst, sedan KÄNDA fel, sedan osäkerheter.
     *
     * Ett belagt fel väger tyngre än en lucka: den som skrivit "grön" ska få en blå soffa längre ned
     * än en vars färg inte står. Prisdecimalen sist är bara en tiebreak, så två anrop med samma data
     * ger samma ordning.
     */
    rank: SOURCE_RANK[source] * 1000 + wrong * 100 + unsure * 10 + (p.priceSek ?? 0) / 1_000_000,
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
