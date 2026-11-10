/**
 * EN SANNING OM PRODUKTEN — och reglerna som håller den hel.
 *
 * Problemet som mättes (2026-10-11, IKEA INGEMAR): modellen markerade varje mått med varianten
 * ("Sitthöjd 74 cm"), uppgifterna blev etiketter som "Bredd (Sitthöjd 74 cm)", och en regexläsare i
 * klienten som letade efter "sitthöjd" visade bredden 42 cm som sitthöjd — medan måttritningen läste
 * samma rader på sitt sätt och ritade en generisk stol med "≈"-tal som aldrig stått i någon källa.
 * Fyra läsare av samma data, fyra svar. Det som saknades var ett enda objekt som alla läser ur.
 *
 * `ProductFacts` är det objektet. Det bär ALLA varianter forskningen hittade. `viewForVariant` är den
 * enda funktion som avgör vad som visas för en given variant, och den gör tre saker:
 *
 *   1. Väljer ut varianten. En variant som säljaren valt och som matchar en dokumenterad variant
 *      filtrerar. Är varianterna flera och ingen är vald väljer vi INTE åt dem — mått som skiljer sig
 *      mellan varianterna hålls tillbaka och säljaren får välja.
 *   2. Håller isär det som inte hänger ihop: sitthöjd som inte kan vara högre än möbeln, sittbredd som
 *      inte kan vara bredare än den, två källor med olika värde för samma mått. Det osäkra utelämnas
 *      eller märks, det visas aldrig som två sanningar.
 *   3. Ger raderna deras slutliga form (`toAttributes`): ren etikett, typ, kind, belägg. Variantens namn
 *      hamnar aldrig i en etikett.
 */

import { foldText } from "./verify.js";
import { dedupeDimensions, dedupeMaterials, isLengthType, sortDimensions, sourceTier } from "./normalize.js";
import type {
  FactIssue,
  ProductFacts,
  ResearchDimension,
  ResearchFact,
  ResearchMaterial,
  ResearchSource,
  ResearchVariant,
  SpecIdentity,
  VerificationLevel,
} from "./types.js";
import type { ListingAttribute } from "../types.js";

// ─── Varianter ──────────────────────────────────────────────────────────────

/** Ord som inte skiljer en variant från en annan. */
const GENERIC = new Set([
  "variant", "version", "modell", "model", "storlek", "size", "art", "nr", "artikelnummer", "cm", "mm", "m", "med", "utan", "och", "and", "with",
  "stol", "barstol", "matstol", "soffa", "bord", "lampa", "fatolj", "skap", "hylla", "sang", "chair", "stool", "table", "sofa",
  "sitthojd", "sitshojd", "hojd", "bredd", "djup", "langd", "seat", "height", "width", "depth", "length",
]);

const numbersIn = (folded: string): string[] =>
  (folded.match(/\d+(?:\s?\d{3})*(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/\s/g, "").replace(",", ".")).filter((n) => n.length <= 5);

/**
 * Gäller två beteckningar samma variant? Tal är avgörande ("63 cm" ≠ "74 cm"), bokstäverna bara när
 * inga tal finns. Samma funktion används för att matcha säljarens val mot de dokumenterade varianterna
 * och för att koppla ett mått till sin variant.
 */
export function sameVariant(a: string, b: string): boolean {
  const fa = foldText(a);
  const fb = foldText(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  // Artikelnummer ("001.299.51") räknas inte som storlekstal: bara tal som står ensamma med enhet eller i ett kort namn.
  const strip = (f: string) => f.replace(/\bart\b.*$/, "").replace(/\d{3}\s\d{3}\s\d{2}/g, "");
  const na = numbersIn(strip(fa));
  const nb = numbersIn(strip(fb));
  if (na.length > 0 && nb.length > 0) return na.some((n) => nb.includes(n));
  const wa = fa.split(" ").filter((w) => w.length >= 3 && !GENERIC.has(w));
  const wb = fb.split(" ").filter((w) => w.length >= 3 && !GENERIC.has(w));
  if (wa.length === 0 || wb.length === 0) return fa.includes(fb) || fb.includes(fa);
  return wa.some((w) => wb.some((x) => x === w || (w.length >= 4 && x.length >= 4 && (w.startsWith(x) || x.startsWith(w)))));
}

const hasNumber = (s: string): boolean => numbersIn(foldText(s).replace(/\d{3}\s\d{3}\s\d{2}/g, "")).length > 0;

/** Den dokumenterade variant säljarens val avser — eller null när inget val matchar exakt EN variant. */
export function matchVariant(chosen: string | null | undefined, variants: ResearchVariant[]): ResearchVariant | null {
  if (!chosen?.trim() || variants.length === 0) return null;
  const hits = variants.filter((v) => sameVariant(chosen, v.label));
  return hits.length === 1 ? hits[0] : null;
}

/** Skilda beteckningar som avser samma variant slås ihop; första skrivsättet vinner. */
function clusterScopes(scopes: string[]): string[] {
  const out: string[] = [];
  for (const s of scopes) if (!out.some((o) => sameVariant(o, s))) out.push(s);
  return out;
}

// ─── Komposition ────────────────────────────────────────────────────────────

/**
 * "33 % bomull, 25 % lin, 22 % viskos, 20 % polyester" → fyra rader. Tomt när texten inte är en
 * procentuell sammansättning. Summan behöver inte vara 100: källor avrundar, och vi rättar dem inte.
 */
export function parseComposition(text: string): Array<{ material: string; percent: number }> {
  const out: Array<{ material: string; percent: number }> = [];
  const re = /(\d{1,3}(?:[.,]\d+)?)\s*%\s*([^,;%\d]+?)(?=\s*(?:[,;]|\boch\b|\band\b|$|\d{1,3}(?:[.,]\d+)?\s*%))/gi;
  for (const m of text.matchAll(re)) {
    const percent = Number(m[1].replace(",", "."));
    const material = m[2].trim().replace(/^[-–:]\s*/, "").replace(/\s+/g, " ");
    if (Number.isFinite(percent) && percent > 0 && percent <= 100 && material.length >= 2) out.push({ material, percent });
  }
  return out;
}

// ─── Bygga objektet ─────────────────────────────────────────────────────────

const RANK: Record<VerificationLevel, number> = { page_confirmed: 3, cited: 2, unverified: 1 };
const sameValue = (a: ResearchDimension, b: ResearchDimension) => Math.abs(a.value - b.value) <= 0.6 && Math.abs((a.valueMax ?? a.value) - (b.valueMax ?? b.value)) <= 0.6;

export interface BuildFactsInput {
  identity: SpecIdentity;
  variants: ResearchVariant[];
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  retailPrice: ProductFacts["retailPrice"];
  sources: ResearchSource[];
  conflicts: string[];
  missing: string[];
  brand: string | null;
  /** Anropet gick igenom och gav ett svar (till skillnad från ett som föll). */
  runOk?: boolean;
  /** Avvisade påståenden (varken källa eller citat). */
  rejectedCount?: number;
  productPages?: string[];
  /** Adresser som visade sig döda. */
  unlinkable?: string[];
  now?: number;
}

/** Träslag, hopvikta (utan diakriter). Delas med kontrollen av annonstexten. */
export const WOOD_SPECIES = ["bjork", "bok", "ek", "furu", "gran", "teak", "valnot", "ask", "korsbar", "mahogny", "bambu", "alm", "lonn", "tall", "ceder", "rosentra", "akacia"];

const COMPONENT_SYNONYMS: Array<[RegExp, string]> = [
  [/^(stomme|ram|frame|kropp|underrede)/i, "stomme"],
  [/^(kl[äa]dsel|[öo]vertyg|tyg|upholstery|fabric|textil)/i, "klädsel"],
  [/^(stoppning|fyllning|f[öo]llning|filling|padding|skum)/i, "stoppning"],
  [/^(sits|seat)/i, "sits"],
  [/^(rygg|back)/i, "rygg"],
  [/^(ben|f[öo]tter|legs?)/i, "ben"],
];
const componentKey = (c: string): string => {
  const hit = COMPONENT_SYNONYMS.find(([re]) => re.test(c.trim()));
  return hit ? hit[1] : foldText(c);
};

export function buildProductFacts(input: BuildFactsInput): ProductFacts {
  const issues: FactIssue[] = [];
  const tierOf = (url: string | null) => (url ? sourceTier(url, input.brand) : 4);
  const sourceScore = (x: { verification: VerificationLevel; sourceUrl: string | null }) => RANK[x.verification] * 10 - tierOf(x.sourceUrl);

  // 1. Två källor, olika värde för samma mått och samma variant → rapportera, behåll den bäst belagda.
  const buckets = new Map<string, ResearchDimension[]>();
  for (const d of input.dimensions) {
    const k = `${d.type}|${d.appliesTo ? foldText(d.appliesTo) : ""}`;
    buckets.set(k, [...(buckets.get(k) ?? []), d]);
  }
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    const best = [...group].sort((a, b) => sourceScore(b) - sourceScore(a))[0];
    const others = group.filter((g) => g !== best && !sameValue(g, best));
    if (others.length > 0) {
      issues.push({
        code: "conflicting_values",
        severity: "warning",
        message: `Källorna anger olika ${best.label.toLowerCase()}: ${[best, ...others].map((d) => d.display).join(" och ")}. Visar ${best.display}.`,
        keys: [best.type],
      });
    }
  }
  let dimensions = sortDimensions(dedupeDimensions(input.dimensions, tierOf));
  let materials = dedupeMaterials(input.materials);

  // 2. Material: samma komponent, samma variant, olika material → motsägelse. Den bäst belagda behålls.
  const matGroups = new Map<string, ResearchMaterial[]>();
  for (const m of materials) {
    const k = `${componentKey(m.component)}|${m.appliesTo ? foldText(m.appliesTo) : ""}`;
    matGroups.set(k, [...(matGroups.get(k) ?? []), m]);
  }
  const dropMats = new Set<ResearchMaterial>();
  for (const group of matGroups.values()) {
    if (group.length < 2) continue;
    // Flera rader för en komponent är normalt (stomme: trä + lack). En motsägelse är två SKILDA träslag
    // för samma del — björk och bok förväxlas lätt, och ett träslag är något källan antingen sagt eller inte.
    const species = group.map((g) => foldText(g.material).split(" ").find((w) => WOOD_SPECIES.includes(w)) ?? "");
    const distinct = new Set(species.filter(Boolean));
    if (distinct.size < 2) continue;
    const best = [...group].sort((a, b) => sourceScore(b) - sourceScore(a))[0];
    for (const g of group) if (g !== best) dropMats.add(g);
    issues.push({
      code: "material_conflict",
      severity: "warning",
      message: `Källorna anger olika material för ${best.component.toLowerCase()}: ${group.map((g) => g.material).join(" och ")}. Visar ${best.material}.`,
      keys: [best.component],
    });
  }
  materials = materials.filter((m) => !dropMats.has(m));

  // 3. Varianter: modellens egen lista + de olika beteckningar som mått faktiskt bär.
  const dimScopes = clusterScopes(dimensions.map((d) => d.appliesTo).filter((s): s is string => !!s));
  const declared = input.variants.filter((v) => v.label.trim());
  const variants: ResearchVariant[] = [];
  for (const v of declared) if (!variants.some((x) => sameVariant(x.label, v.label))) variants.push(v);
  for (const s of dimScopes) if (!variants.some((x) => sameVariant(x.label, s))) variants.push({ label: s, differsBy: null, sourceUrl: null });
  // En "variant" som inget mått skiljer är ingen variant för vårt ändamål (färgen, till exempel). Vi
  // behöver minst ett mått som bär en variantbeteckning, och minst två utföranden att välja mellan.
  const effectiveVariants = dimScopes.length >= 1 && variants.length >= 2 ? variants : [];

  // 4. Tomt resultat: säg VARFÖR det är tomt.
  if (dimensions.length === 0) {
    issues.push(
      input.runOk === false
        ? { code: "extraction_failed", severity: "warning", message: "Sökningen efter mått avbröts innan den blev klar." }
        : { code: "no_evidence", severity: "info", message: "Inga mått gick att belägga i de källor som hittades." },
    );
  }
  if (materials.length === 0) {
    issues.push(
      input.runOk === false
        ? { code: "extraction_failed", severity: "warning", message: "Sökningen efter material avbröts innan den blev klar.", keys: ["material"] }
        : { code: "no_evidence", severity: "info", message: "Inga materialuppgifter gick att belägga i de källor som hittades.", keys: ["material"] },
    );
  }
  if ((input.unlinkable?.length ?? 0) > 0) {
    issues.push({ code: "source_unreachable", severity: "info", message: `${input.unlinkable!.length} källa${input.unlinkable!.length > 1 ? "or" : ""} gick inte att öppna och länkas därför inte.` });
  }

  return {
    version: 1,
    identity: input.identity,
    variants: effectiveVariants,
    dimensions,
    materials,
    facts: input.facts,
    retailPrice: input.retailPrice,
    sources: input.sources,
    conflicts: input.conflicts,
    missing: input.missing,
    issues,
    productPages: input.productPages ?? [],
    researchedAt: input.now ?? Date.now(),
  };
}

// ─── Vyn för en variant ─────────────────────────────────────────────────────

export interface FactsView {
  /** Varianten vyn gäller — den säljaren valt, eller den enda dokumenterade — annars null. */
  variant: string | null;
  /** Flera varianter med olika mått och ingen vald. Det som skiljer sig hålls tillbaka. */
  ambiguous: boolean;
  /** Alternativen säljaren ska välja bland när `ambiguous`. */
  options: ResearchVariant[];
  /** Varianten är vald men forskningen har inga mått för just den — ett riktat omtag behövs. */
  needsResearch: boolean;
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  /** Mått som utelämnats och varför: variantberoende eller motsägelsefulla. */
  heldBack: Array<{ type: string; label: string; reason: "variant" | "contradiction"; values: string[] }>;
  issues: FactIssue[];
}

/** Överordnade mått som härledda mått inte får överskrida. */
const PARENT: Record<string, string> = {
  seat_height: "overall_height",
  backrest_height: "overall_height",
  armrest_height: "overall_height",
  leg_height: "overall_height",
  seat_width: "overall_width",
  seat_depth: "overall_depth",
  armrest_width: "overall_width",
};

function relationIssues(dims: ResearchDimension[]): { drop: Set<ResearchDimension>; issues: FactIssue[] } {
  const drop = new Set<ResearchDimension>();
  const issues: FactIssue[] = [];
  const byType = new Map(dims.map((d) => [d.type, d]));
  for (const [child, parent] of Object.entries(PARENT)) {
    const c = byType.get(child);
    const p = byType.get(parent);
    if (!c || !p) continue;
    // Likhet är tillåten: en pall utan rygg har sitthöjd = höjd.
    if (c.value <= p.value + 0.6) continue;
    const seatVsOverall = child === "seat_height";
    // Den sämre belagda av de två är den som felat; lika bra → ingen av dem visas som säker.
    const winner = RANK[c.verification] === RANK[p.verification] ? null : RANK[c.verification] > RANK[p.verification] ? c : p;
    if (winner === c) drop.add(p);
    else if (winner === p) drop.add(c);
    else {
      drop.add(c);
      drop.add(p);
    }
    issues.push({
      code: seatVsOverall ? "seat_vs_overall" : "implausible_relation",
      severity: "warning",
      message: `${c.label} (${c.display}) kan inte vara ${child.endsWith("height") ? "högre" : "större"} än ${p.label.toLowerCase()} (${p.display}) — uppgifterna håller inte ihop och hålls tillbaka.`,
      keys: [child, parent],
    });
  }
  return { drop, issues };
}

export function viewForVariant(facts: ProductFacts, chosen: string | null | undefined): FactsView {
  const issues = [...facts.issues];
  const multi = facts.variants.length >= 2;
  const match = multi ? matchVariant(chosen, facts.variants) : null;
  const heldBack: FactsView["heldBack"] = [];
  let dims = facts.dimensions;
  let mats = facts.materials;
  let uppgifter = facts.facts;
  let ambiguous = false;
  let needsResearch = false;
  let variant: string | null = null;

  const scopedTo = (x: { appliesTo: string | null }, v: ResearchVariant) => !!x.appliesTo && sameVariant(x.appliesTo, v.label);
  const scopedToAny = (x: { appliesTo: string | null }) => !!x.appliesTo && facts.variants.some((v) => scopedTo(x, v));

  if (!multi) {
    variant = facts.variants[0]?.label ?? (chosen?.trim() || null);
    /**
     * Mått som bär EN variantbeteckning ("Sitthöjd 74 cm") men där säljaren valt ett annat utförande
     * ("barstol 63 cm"): modellen nämnde inga fler varianter, men talen säger emot varandra. Då lånas
     * 74-måtten inte ut till en 63-stol — vi har ingenting för det valda utförandet, och ett riktat
     * omtag behövs. Kräver tal på BÅDA sidor; en färg eller ett ord mot ett tal säger ingenting.
     */
    const scoped = dims.filter((d) => !!d.appliesTo);
    if (chosen?.trim() && scoped.length > 0 && hasNumber(chosen) && scoped.every((d) => hasNumber(d.appliesTo!) && !sameVariant(d.appliesTo!, chosen))) {
      dims = dims.filter((d) => !d.appliesTo);
      mats = mats.filter((m) => !m.appliesTo || !hasNumber(m.appliesTo) || sameVariant(m.appliesTo, chosen));
      needsResearch = true;
    }
  } else if (match) {
    variant = match.label;
    dims = dims.filter((d) => !scopedToAny(d) || scopedTo(d, match));
    mats = mats.filter((m) => !scopedToAny(m) || scopedTo(m, match));
    uppgifter = uppgifter.filter((f) => !scopedToAny({ appliesTo: f.appliesTo ?? null }) || scopedTo({ appliesTo: f.appliesTo ?? null }, match));
    // Finns inga mått alls som hör till just den här varianten, men det finns för andra → vi har inget för den.
    const anyScoped = facts.dimensions.some(scopedToAny);
    const hasOwn = facts.dimensions.some((d) => scopedTo(d, match));
    if (anyScoped && !hasOwn) {
      needsResearch = true;
      // Mått som bara gäller en annan variant ska inte låna ut sig: de var redan bortfiltrerade ovan.
    }
  } else {
    ambiguous = true;
    if (chosen?.trim()) {
      issues.push({ code: "variant_unmatched", severity: "info", message: `Valet "${chosen.trim()}" motsvarar ingen av de dokumenterade varianterna (${facts.variants.map((v) => v.label).join(", ")}).` });
    }
    // Ett mått är "gemensamt" när varje variant som har det anger samma värde. Det visas; resten hålls tillbaka.
    const byType = new Map<string, ResearchDimension[]>();
    for (const d of dims) byType.set(d.type, [...(byType.get(d.type) ?? []), d]);
    const keep: ResearchDimension[] = [];
    for (const [type, group] of byType) {
      const scoped = group.filter(scopedToAny);
      const unscoped = group.filter((d) => !scopedToAny(d));
      const allSame = scoped.every((d) => sameValue(d, scoped[0]));
      // Ett mått som bara en av flera varianter anger kan vara variantspecifikt — det visas inte som gemensamt.
      const coversAll = facts.variants.every((v) => scoped.some((d) => scopedTo(d, v)));
      if (unscoped.length > 0) keep.push(...unscoped);
      else if (scoped.length > 0 && allSame && coversAll) keep.push({ ...scoped[0], appliesTo: null });
      else if (scoped.length > 0) {
        heldBack.push({ type, label: scoped[0].label, reason: "variant", values: scoped.map((d) => `${d.display}${d.appliesTo ? ` (${d.appliesTo})` : ""}`) });
      }
    }
    dims = keep;
    mats = mats.filter((m) => !scopedToAny(m));
    // Ett artikelnummer per utförande: tills säljaren valt visas inget av dem (det ena vore fel).
    uppgifter = uppgifter.filter((f) => !scopedToAny({ appliesTo: f.appliesTo ?? null }));
    issues.push({
      code: "variant_ambiguous",
      severity: "warning",
      message: `Produkten finns i flera utföranden (${facts.variants.map((v) => v.label).join(", ")}) med olika mått. Välj vilket som är ditt.`,
      keys: heldBack.map((h) => h.type),
    });
  }

  // Motsägelser inom den vy som blev kvar.
  const rel = relationIssues(dims);
  if (rel.drop.size > 0) {
    for (const d of rel.drop) heldBack.push({ type: d.type, label: d.label, reason: "contradiction", values: [d.display] });
    dims = dims.filter((d) => !rel.drop.has(d));
  }
  issues.push(...rel.issues);

  return {
    variant,
    ambiguous,
    options: ambiguous ? facts.variants : [],
    needsResearch,
    dimensions: sortDimensions(dims.map((d) => ({ ...d, appliesTo: null }))),
    materials: mats.map((m) => ({ ...m, appliesTo: null })),
    facts: uppgifter.map((f) => ({ ...f, appliesTo: null })),
    heldBack,
    issues,
  };
}

// ─── Till annonsens rader ───────────────────────────────────────────────────

/**
 * Raderna annonsen, specifikationsskärmen, måttritningen och kortet läser. Etiketten är ALLTID den
 * rena ("Bredd", "Stomme") — varianten, belägget och typen ligger i egna fält, så att ingen läsare
 * behöver gissa av en sträng vad en rad är.
 */
export function toAttributes(view: FactsView): ListingAttribute[] {
  const out: ListingAttribute[] = [];
  for (const d of view.dimensions) {
    const length = isLengthType(d.type);
    out.push({
      key: d.key,
      label: d.label,
      value: d.display,
      sourceUrl: d.sourceUrl,
      kind: length ? "dimension" : "fact",
      type: d.type,
      verified: d.verified,
      verification: d.verification,
    });
  }
  for (const m of view.materials) {
    const label = /^material$/i.test(m.component) ? "Material" : m.component;
    const composition = parseComposition(m.material);
    out.push({
      key: `material_${foldText(m.component).replace(/\s+/g, "_")}`,
      label,
      value: m.detail ? `${m.material}, ${m.detail}` : m.material,
      sourceUrl: m.sourceUrl,
      kind: "material",
      component: m.component,
      verified: m.verified,
      verification: m.verification,
      ...(composition.length > 0 ? { composition } : {}),
    });
  }
  for (const f of view.facts) {
    // Ett påstående utan någon belagd källa är den ena kategorin vi hellre tiger om (artikelnummer,
    // formgivare kan lätt vara påhittade); mått och material däremot visas, märkta som osäkra.
    if (f.verification === "unverified") continue;
    out.push({
      key: foldText(f.label).replace(/\s+/g, "_"),
      label: f.label,
      value: f.value,
      sourceUrl: f.sourceUrl,
      kind: "fact",
      verified: f.verification === "page_confirmed",
      verification: f.verification,
    });
  }
  return out;
}

// ─── Annonstexten mot uppgifterna ───────────────────────────────────────────

const MEASURE_WORDS = /\b(mått|måtten|höjd|hög|bredd|bred|djup|djupt|längd|lång|diameter|diam|sitthöjd|sitshöjd|sittdjup|mäter|height|width|depth|length|cm)\b/i;
const DAMAGE_WORDS = /\b(repa|repor|skråma|skråmor|skada|skador|fläck|fläckar|märke|märken|nagg|spricka|sprickor|slitage|buckla|hack|jack|slitning|reva|hål)\b/i;
const MEASURE_RE = /(\d+(?:[.,]\d+)?(?:\s*(?:x|×|X|-|–|\/)\s*\d+(?:[.,]\d+)?)*)\s*(cm|mm|m|centimeter|meter)\b/gi;

const toCm = (n: number, unit: string): number => {
  const u = unit.toLowerCase();
  return u === "mm" ? n / 10 : u === "m" || u === "meter" ? n * 100 : n;
};

/** Alla tal (i cm) som annonsens egna måttrader tillåter att texten nämner. */
export function allowedCentimetres(attrs: Array<Pick<ListingAttribute, "value" | "kind">>): number[] {
  const out: number[] = [];
  for (const a of attrs) {
    if (a.kind !== "dimension") continue;
    for (const m of a.value.matchAll(MEASURE_RE)) {
      for (const n of m[1].split(/\s*(?:x|×|X|-|–|\/)\s*/)) out.push(toCm(Number(n.replace(",", ".")), m[2]));
    }
    // "80–82 cm": talet före bindestrecket saknar enhet i värdet.
    for (const m of a.value.matchAll(/(\d+(?:[.,]\d+)?)\s*[–-]\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m)\b/gi)) {
      out.push(toCm(Number(m[1].replace(",", ".")), m[3]), toCm(Number(m[2].replace(",", ".")), m[3]));
    }
  }
  return out.filter((n) => Number.isFinite(n));
}

export interface TextCheck {
  text: string;
  removed: string[];
  issues: FactIssue[];
}

/**
 * Annonstexten får inte säga mer än uppgifterna. En mening som anger ett MÅTT utan stöd i annonsens
 * måttrader tas bort — hellre en kortare text än en text som säger 78 cm där källan säger 74.
 * Skadebeskrivningar ("repa, 3 cm") och tal utan längdenhet (årtal, priser) rörs aldrig.
 *
 * Generatorn får ändå aldrig skriva över uppgifterna: den läser underlaget, men raderna kommer ur
 * `toAttributes`. Det här är bältet till hängslena.
 */
export function checkListingText(text: string, attrs: Array<Pick<ListingAttribute, "value" | "kind">>): TextCheck {
  if (!text.trim()) return { text, removed: [], issues: [] };
  const allowed = allowedCentimetres(attrs);
  const near = (cm: number) => allowed.some((a) => Math.abs(a - cm) <= Math.max(0.6, a * 0.01));
  const lines = text.split(/(\n+)/);
  const removed: string[] = [];
  const rebuilt = lines.map((line) => {
    if (/^\n+$/.test(line) || !line.trim()) return line;
    // Meningar, med skiljetecknet kvar på sin mening.
    const sentences = line.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/g) ?? [line];
    return sentences
      .filter((s) => {
        if (DAMAGE_WORDS.test(s) || !MEASURE_WORDS.test(s)) return true;
        const unsupported: number[] = [];
        for (const m of s.matchAll(MEASURE_RE)) {
          for (const n of m[1].split(/\s*(?:x|×|X|-|–|\/)\s*/)) {
            const cm = toCm(Number(n.replace(",", ".")), m[2]);
            if (Number.isFinite(cm) && cm >= 3 && !near(cm)) unsupported.push(cm);
          }
        }
        if (unsupported.length === 0) return true;
        removed.push(s.trim());
        return false;
      })
      .join("");
  });
  const cleaned = rebuilt.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const issues: FactIssue[] =
    removed.length > 0
      ? [
          {
            code: "listing_text_unsupported",
            severity: "warning",
            message: `${removed.length} mening${removed.length > 1 ? "ar" : ""} i annonstexten angav mått som saknar belägg och togs bort.`,
          },
        ]
      : [];
  return { text: cleaned, removed, issues };
}

/**
 * Kontroll av materialpåståenden i texten. Träslag är det som förväxlas (björk/bok): står det ett
 * träslag i texten som inget material i uppgifterna anger — medan uppgifterna anger ANDRA träslag —
 * är meningen en motsägelse och tas bort.
 */
const WOODS = WOOD_SPECIES;
export function checkMaterialClaims(text: string, materials: Array<{ material: string }>): TextCheck {
  const known = new Set<string>();
  for (const m of materials) for (const w of foldText(m.material).split(" ")) if (WOODS.includes(w)) known.add(w);
  if (known.size === 0 || !text.trim()) return { text, removed: [], issues: [] };
  const removed: string[] = [];
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+(?=\s|$)|$)\s*|\n+/g) ?? [text];
  const kept = sentences.filter((s) => {
    if (/^\n+$/.test(s)) return true;
    const words = foldText(s).split(" ");
    const mentioned = words.filter((w) => WOODS.includes(w));
    // Bara "massiv"/"lackad"/"trä"-sammanhang: ett träslag i ett helt annat ord ("bokhylla") räknas inte.
    if (mentioned.length > 0 && mentioned.every((w) => !known.has(w)) && /\b(massiv|massivt|lackad|lackat|trä|tra|stomme|ram|fanér|faner)\b/i.test(foldText(s))) {
      removed.push(s.trim());
      return false;
    }
    return true;
  });
  return {
    text: kept.join("").trim(),
    removed,
    issues: removed.length
      ? [{ code: "listing_text_unsupported", severity: "warning", message: "En mening i annonstexten angav ett träslag som motsäger uppgifterna och togs bort." }]
      : [],
  };
}
