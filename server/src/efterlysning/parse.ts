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
 * bara när ett fält som faktiskt avgör matchningen saknas, och de tar slut efter tre. En chatt som
 * kan fråga vad som helst blir en chatt man måste prata sig ur, och köparen kom hit för att beskriva
 * en soffa.
 */

import { brandFacets } from "../butik/inventory.js";
import { interpretQuery } from "../butik/aiSearch.js";
import { CATEGORIES, categoryLabel } from "../butik/catalog.js";
import type { ProductFilter } from "../butik/types.js";
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
  field: "kategori" | "maxpris" | "matt";
  question: string;
  /** Snabbsvar. Ett fritextsvar går alltid också. */
  options?: string[];
}

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
 * Vad vi fortfarande behöver veta, i ordning, max tre.
 *
 * BARA FÄLT SOM ÄNDRAR MATCHNINGEN. Kategori avgör vilka källor som frågas alls; pristaket skjuts
 * ned i Tradera-anropet och avgör om svepet ger något; måttet är det enda som kan göra en i övrigt
 * perfekt möbel oanvändbar. Färg och stil frågar vi aldrig om — de gör en träff bättre, inte
 * möjlig, och en fråga för varje sådant fält hade förvandlat intaget till ett formulär med extra steg.
 */
export function followUps(spec: ParsedSpec): FollowUp[] {
  const out: FollowUp[] = [];
  const f = spec.filter;

  if (!f.categorySlug) {
    out.push({
      field: "kategori",
      question: "Vilken sorts möbel är det?",
      options: CATEGORIES.map((c) => c.label),
    });
  }
  if (f.maxPriceSek === null || f.maxPriceSek === undefined) {
    out.push({
      field: "maxpris",
      question: "Vad är din övre gräns?",
      options: ["1 000 kr", "3 000 kr", "5 000 kr", "10 000 kr"],
    });
  }
  if (
    f.categorySlug && BULKY.has(f.categorySlug) &&
    f.maxWidthMm === undefined && f.maxHeightMm === undefined && f.maxDepthMm === undefined
  ) {
    out.push({
      field: "matt",
      question: `Finns det ett mått som måste stämma? ${categoryLabel(f.categorySlug)} är det vanligaste stället det går fel.`,
      options: ["Nej, inget särskilt"],
    });
  }
  return out.slice(0, 3);
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
    if (/^nej/i.test(text)) return next;
    const parsed = await parse(text);
    // Bara måtten plockas ut. Ett svar som "max 210 bred, helst grön" ska inte smyga in en färg
    // köparen inte blev tillfrågad om.
    if (parsed.filter.maxWidthMm) next.filter.maxWidthMm = parsed.filter.maxWidthMm;
    if (parsed.filter.maxDepthMm) next.filter.maxDepthMm = parsed.filter.maxDepthMm;
    if (parsed.filter.maxHeightMm) next.filter.maxHeightMm = parsed.filter.maxHeightMm;
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
  const dims = [
    f.maxWidthMm ? `b ${Math.round(f.maxWidthMm / 10)}` : null,
    f.maxDepthMm ? `d ${Math.round(f.maxDepthMm / 10)}` : null,
    f.maxHeightMm ? `h ${Math.round(f.maxHeightMm / 10)}` : null,
  ].filter(Boolean);
  if (dims.length) parts.push(`max ${dims.join(" × ")} cm`);
  return parts.join(" · ") || "Allt i lagret";
}
