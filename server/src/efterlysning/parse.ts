/**
 * Från en mening till en efterlysning.
 *
 * BYGGER PÅ BUTIKENS TOLKNING, inte bredvid den. `interpretQuery` översätter redan svenska till ett
 * `ProductFilter` mot katalogen som facit, med validering per fält och en reservväg när modellen
 * faller. Efterlysningen behöver samma sak plus fyra fält, och de fyra ligger därför i samma anrop
 * och samma schema (se EFTERLYSNING_FIELDS i aiSearch.ts). En andra parser hade blivit ett andra
 * ställe där "max 2 meter" kan tolkas — och en dag där de två gjorde det olika.
 *
 * INGEN ÖPPEN CHATBOT. Följdfrågorna nedan är BESTÄMDA I KOD och kostar inga modellanrop: de ställs
 * bara när ett fält saknas, de tar slut efter tre, och var och en går att hoppa över. En chatt som
 * kan fråga vad som helst blir en chatt man måste prata sig ur, och köparen kom hit för att beskriva
 * en soffa. Se `followUps` för vilka fält som frågas alltid och vilka som frågas bara när
 * beskrivningen är tunn.
 */

import { brandFacets } from "../butik/inventory.js";
import { interpretQuery } from "../butik/aiSearch.js";
import { CATEGORIES, categoryLabel } from "../butik/catalog.js";
import type { ProductFilter } from "../butik/types.js";
import type { ConditionGrade } from "../types.js";
import { fillHardFields } from "./backstop.js";

export interface ParsedSpec {
  filter: ProductFilter;
  styleTags: string[];
  deadline: string | null;
  urgency: "none" | "soon" | "urgent";
  note: string | null;
  summary: string;
  /** Falskt = modellen svarade inte, och vi föll tillbaka på ordmatchning. Styr om formuläret visas. */
  aiUsed: boolean;
}

export interface FollowUp {
  /** Fältet frågan gäller. Klienten fyller i det på svaret utan att tolka om hela meningen. */
  field: FollowUpField;
  question: string;
  /** Snabbsvar. Ett fritextsvar går alltid också. */
  options?: string[];
}

export type FollowUpField =
  | "kategori" | "maxpris" | "matt"
  | "marke" | "skick" | "farg" | "stil" | "ovrigt";

/**
 * Kategorier där ett mått nästan alltid avgör om möbeln går att ha.
 *
 * En lampa passar överallt; en soffa gör det inte. Att fråga om mått på allt hade gjort en följdfråga
 * till en formalitet man klickar förbi, och då hjälper den inte där den behövs.
 */
const BULKY = new Set(["soffor", "fatoljer", "bord", "sangar", "forvaring", "skrivbord-kontor"]);

export async function parse(text: string): Promise<ParsedSpec> {
  const brands = (await brandFacets()).map((b) => b.brand);
  const r = await interpretQuery(text, brands, { efterlysning: true });

  const deadline = r.extras.deadlineDays !== null
    ? new Date(Date.now() + r.extras.deadlineDays * 86_400_000).toISOString().slice(0, 10)
    : null;

  return {
    /**
     * Skyddsnätet läggs på HÄR, efter tolkningen och före allt annat.
     *
     * Det fyller bara luckor i pris och mått — de hårda gränserna — och rör aldrig ett fält
     * modellen satt. Se backstop.ts och DECISIONS.md #3.
     */
    filter: fillHardFields(r.filter, text),
    styleTags: r.extras.styleTags,
    deadline,
    urgency: r.extras.urgency,
    note: r.extras.note,
    summary: r.summary,
    aiUsed: r.aiUsed,
  };
}

/**
 * Hur mycket köparen redan berättat, räknat i fält.
 *
 * Styr om vi får ställa en MJUK fråga alls. En mening som "3-sits soffa i ljust tyg, gärna HAY, max
 * 7 000, får plats 220 cm" har sagt fem saker — att då fråga om stil är att be någon upprepa sig, och
 * det är precis vad "om texten redan är tydlig ställs inga frågor" betyder. En mening som "en soffa"
 * har sagt en sak, och där är varje fråga en tjänst.
 */
function beskrivenhet(spec: ParsedSpec): number {
  const f = spec.filter;
  return [
    f.categorySlug,
    f.brands?.length,
    f.grades?.length,
    f.maxPriceSek,
    f.colors?.length,
    f.materials?.length,
    spec.styleTags.length,
    f.maxWidthMm ?? f.maxDepthMm ?? f.maxHeightMm,
    spec.note,
  ].filter(Boolean).length;
}

/**
 * Vid så här många ifyllda fält ställs inga mjuka frågor. Hårda luckor frågas alltid om.
 *
 * TRE OCH INTE FYRA. "Soffa, max 5 000, högst 210 bred" är tre fält och en fullt användbar
 * efterlysning — den som skrivit den har svarat på det vi behöver veta, och tre frågor till läser
 * som att vi inte lyssnade. "Lampa under 500" är två, och där är varje fråga en tjänst.
 */
const RIKLIG = 3;

/**
 * Vad vi fortfarande behöver veta, i ordning, max tre.
 *
 * TVÅ SLAGS FRÅGOR, OCH ORDNINGEN MELLAN DEM ÄR HELA REGELN.
 *
 *   HÅRDA   kategori, pris, mått. De avgör om en möbel över huvud taget kan matcha: kategorin
 *           bestämmer vilka källor som frågas, pristaket skjuts ned i Tradera-anropet, och måttet är
 *           det enda som kan göra en i övrigt perfekt möbel oanvändbar. En lucka här frågas det
 *           alltid om.
 *   MJUKA   märke, skick, färg, stil, övrigt. De gör en träff BÄTTRE, inte möjlig. De frågas bara
 *           när beskrivningen är tunn — se `beskrivenhet`. Den som redan berättat mycket ska mötas
 *           av "tack", inte av tre frågor till.
 *
 * Taket på tre gäller summan. Är alla tre hårda luckor öppna ställs inga mjuka frågor alls, och det
 * är rätt ordning: en efterlysning utan kategori är oanvändbar, en utan färgpreferens är bara
 * bredare.
 */
export function followUps(spec: ParsedSpec): FollowUp[] {
  const hard: FollowUp[] = [];
  const f = spec.filter;

  if (!f.categorySlug) {
    hard.push({
      field: "kategori",
      question: "Vilken typ av möbel?",
      options: CATEGORIES.map((c) => c.label),
    });
  }
  if (f.maxPriceSek === null || f.maxPriceSek === undefined) {
    hard.push({
      field: "maxpris",
      question: "Ungefär vad vill du lägga?",
      options: ["3 000 kr", "5 000 kr", "10 000 kr", "Spelar mindre roll"],
    });
  }
  if (
    f.categorySlug && BULKY.has(f.categorySlug) &&
    f.maxWidthMm === undefined && f.maxHeightMm === undefined && f.maxDepthMm === undefined
  ) {
    hard.push({
      field: "matt",
      question: "Finns det något mått den måste passa?",
      options: ["Nej, inget särskilt"],
    });
  }

  if (hard.length >= 3 || beskrivenhet(spec) >= RIKLIG) return hard.slice(0, 3);

  const soft: FollowUp[] = [];
  if (!f.brands?.length) {
    soft.push({ field: "marke", question: "Något särskilt märke eller modell du har i åtanke?" });
  }
  if (!f.grades?.length) {
    soft.push({
      field: "skick",
      question: "Hur viktigt är skicket?",
      options: ["Som nytt", "Gott skick", "Spelar ingen roll"],
    });
  }
  if (!f.colors?.length) {
    soft.push({ field: "farg", question: "Någon färg du föredrar?" });
  }
  if (!spec.styleTags.length) {
    soft.push({ field: "stil", question: "Vilken stil passar hemma hos dig?" });
  }
  if (!spec.note) {
    soft.push({ field: "ovrigt", question: "Något mer vi ska veta?" });
  }

  return [...hard, ...soft].slice(0, 3);
}

/** Skicksvaren, som betyg. A = nyskick, B = mycket bra, C = bra, D = slitage (se aiSearch.ts). */
const SKICK: Record<string, ConditionGrade[] | null> = {
  "som nytt": ["A"],
  "gott skick": ["A", "B", "C"],
  // Uttryckligt null och inte en utelämnad nyckel: "spelar ingen roll" ÄR ett svar, och svaret är
  // att inte filtrera. Utan raden hade det fallit ned i fritextvägen och tolkats som en färg.
  "spelar ingen roll": null,
};

/** Ett svar som betyder "hoppa över det här", skrivet med egna ord. */
function avbojande(text: string): boolean {
  return /^(nej|inget|ingen|inga|vet inte|spelar (ingen |mindre )?roll)\b/i.test(text);
}

/**
 * Väver in ett svar på en följdfråga.
 *
 * Svaret tolkas för sig och inte genom att hela meningen läses om: köparen har redan bekräftat
 * resten, och en omtolkning kan ändra ett fält de inte frågade om. Fritext går genom samma tolkning
 * som meningen, men bara dess svar på DET fältet plockas ut.
 */
export async function applyAnswer(spec: ParsedSpec, field: FollowUp["field"], answer: string): Promise<ParsedSpec> {
  const text = answer.trim();
  const next: ParsedSpec = { ...spec, filter: { ...spec.filter } };
  if (!text) return next;

  if (field === "kategori") {
    const hit = CATEGORIES.find((c) => c.label.toLowerCase() === text.toLowerCase() || c.slug === text);
    if (hit) next.filter.categorySlug = hit.slug;
    else {
      const parsed = await parse(text);
      if (parsed.filter.categorySlug) next.filter.categorySlug = parsed.filter.categorySlug;
    }
  }

  if (field === "maxpris") {
    const digits = Number(text.replace(/[^\d]/g, ""));
    if (Number.isFinite(digits) && digits > 0) next.filter.maxPriceSek = digits;
  }

  if (field === "matt") {
    if (avbojande(text)) return next;
    const parsed = await parse(text);
    // Bara måtten plockas ut. Ett svar som "max 210 bred, helst grön" ska inte smyga in en färg
    // köparen inte blev tillfrågad om.
    if (parsed.filter.maxWidthMm) next.filter.maxWidthMm = parsed.filter.maxWidthMm;
    if (parsed.filter.maxDepthMm) next.filter.maxDepthMm = parsed.filter.maxDepthMm;
    if (parsed.filter.maxHeightMm) next.filter.maxHeightMm = parsed.filter.maxHeightMm;
  }

  /**
   * MÄRKET FÅR STÅ KVAR ÄVEN NÄR VI INTE HAR DET I LAGER.
   *
   * `interpretQuery` släpper bara igenom märken som finns i lagret just nu — rätt för en SÖKNING,
   * där ett märke vi inte har är en garanterat tom sida. För en efterlysning är det tvärtom: att
   * någon letar en Muuto vi inte har ÄR hela poängen med att skriva upp sig. Filtret får därför bara
   * kända märken, och det okända hamnar i anteckningen, som människan som matchar för hand läser.
   */
  if (field === "marke") {
    if (avbojande(text)) return next;
    const brands = (await brandFacets()).map((b) => b.brand);
    const known = brands.find((b) => b.toLowerCase() === text.toLowerCase());
    if (known) next.filter.brands = [known];
    else next.note = [spec.note, text].filter(Boolean).join(" · ").slice(0, 300);
  }

  if (field === "skick") {
    const key = text.toLowerCase();
    if (key in SKICK) {
      const grades = SKICK[key];
      if (grades) next.filter.grades = grades;
    } else if (!avbojande(text)) {
      const parsed = await parse(text);
      if (parsed.filter.grades?.length) next.filter.grades = parsed.filter.grades;
    }
  }

  /**
   * Färgen tas ur tolkningen när den känner igen en, annars ur ordet självt.
   *
   * `colors` matchas mot produktens egen färgsträng och är inte en uppräkning — ett ord modellen
   * inte kände igen är därför inte ogiltigt, bara ovanligt. "Cognac" ska få bli ett färgfilter.
   * Gränsen går vid längden: ett svar på fem ord är en mening, inte en färg, och hör i anteckningen.
   */
  if (field === "farg") {
    if (avbojande(text)) return next;
    const parsed = await parse(text);
    if (parsed.filter.colors?.length) next.filter.colors = parsed.filter.colors;
    else if (text.split(/\s+/).length <= 2) next.filter.colors = [text.toLowerCase()];
    else next.note = [spec.note, text].filter(Boolean).join(" · ").slice(0, 300);
  }

  // Stilen är ostrukturerad med flit — se StyleTag i types.ts. Orden sparas som de skrevs.
  if (field === "stil") {
    if (avbojande(text)) return next;
    next.styleTags = text
      .split(/[,/]| och /)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1)
      .slice(0, 5);
  }

  if (field === "ovrigt") {
    if (avbojande(text)) return next;
    next.note = [spec.note, text].filter(Boolean).join(" · ").slice(0, 300);
  }

  next.summary = summarize(next);
  return next;
}

/** Meningen köparen bekräftar. Beskriver bara det vi FAKTISKT filtrerar på. */
export function summarize(spec: ParsedSpec): string {
  const f = spec.filter;
  const parts: string[] = [];
  if (f.categorySlug) parts.push(categoryLabel(f.categorySlug));
  if (f.brands?.length) parts.push(f.brands.join("/"));
  if (spec.styleTags.length) parts.push(spec.styleTags.join(", "));
  if (f.colors?.length) parts.push(f.colors.join("/"));
  if (f.materials?.length) parts.push(f.materials.join("/"));
  if (f.maxPriceSek) parts.push(`max ${f.maxPriceSek.toLocaleString("sv-SE")} kr`);
  // Skicket står med sedan det går att svara på det. En sammanfattning som tiger om ett filter vi
  // faktiskt lägger på är den sortens tystnad som ser ut som ett fel när träffarna uteblir.
  if (f.grades?.length) parts.push(`skick ${f.grades.join("/")}`);
  const dims = [
    f.maxWidthMm ? `b ${Math.round(f.maxWidthMm / 10)}` : null,
    f.maxDepthMm ? `d ${Math.round(f.maxDepthMm / 10)}` : null,
    f.maxHeightMm ? `h ${Math.round(f.maxHeightMm / 10)}` : null,
  ].filter(Boolean);
  if (dims.length) parts.push(`max ${dims.join(" × ")} cm`);
  return parts.join(" · ") || "Allt i lagret";
}
