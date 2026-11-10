/**
 * Vad en annonsrad ÄR: ett mått, ett material eller en annan uppgift.
 *
 * ETT ENDA SVAR PÅ DEN FRÅGAN. Tidigare avgjordes det på tre ställen med tre regexar — specifikationsskärmen
 * (DIM_ROWS), annonskortet och måttritningen — och regexarna läste etiketter. En rad som hette
 * "Bredd (Sitthöjd 74 cm)" blev därför sitthöjd på skärmen, bredd i listan och okänd i ritningen. Måtten
 * delades dessutom mellan "Måtten" och "Specifikationer" efter vilken etikett som råkade matcha: en
 * sittbredd (typ seat_width) hamnade bland specifikationerna.
 *
 * Reglerna:
 *   - Servern sätter `kind` och `type` på rader den själv byggt (productFacts.toAttributes). Det är
 *     sanningen och läses först.
 *   - Rader utan `kind` — generatorns, sidskörden, måttminnet, äldre jobb — klassas här, på etikettens
 *     BÖRJAN (efter att en eventuell parentes tagits bort) och med värdet som vittne: ett mått har
 *     tal och längdenhet.
 *   - Alla längdmått är mått, oavsett typ: okända typer ("hyllbredd", "lådans djup") följer med. Vikt och
 *     maxbelastning är uppgifter om produkten, inte mått — de hör till övriga specifikationer.
 *
 * Filen är avsiktligt utan beroenden och finns i två exemplar, server/src/research/attributeKinds.ts
 * och web/src/lib/attributeKinds.ts. Ett test (tests/attribute-kinds.test.ts) kräver att de är lika.
 */

export type AttributeKind = "dimension" | "material" | "fact";

export interface KindInput {
  key: string;
  label: string;
  value: string;
  kind?: AttributeKind;
  type?: string;
  component?: string;
}

export interface KindResult {
  kind: AttributeKind;
  /** Kanonisk måttyp för mått ("seat_width"), annars undefined. */
  type?: string;
  /** Komponent för material ("Stomme"). */
  component?: string;
}

const L = "a-zåäöéü";

/** Etiketter → kanonisk måttyp. Förankrade i början; längst först. */
const DIMENSION_ALIASES: Array<[RegExp, string]> = [
  [/^(sitt|sits)h[öo]jd|^seat ?height|^h[öo]jd till sits/i, "seat_height"],
  [/^(sitt|sits)bredd|^seat ?width|^seat ?breadth/i, "seat_width"],
  [/^(sitt|sits)djup|^seat ?depth/i, "seat_depth"],
  [/^(rygg|ryggst[öo]d)s?h[öo]jd|^back(rest)? ?height/i, "backrest_height"],
  [/^armst[öo]dsh[öo]jd|^arm(rest)? ?height/i, "armrest_height"],
  [/^armst[öo]dsbredd|^arm(rest)? ?width/i, "armrest_width"],
  [/^benh[öo]jd|^leg ?height/i, "leg_height"],
  [/^(fri h[öo]jd|frih[öo]jd|clearance)/i, "clearance_under"],
  [/^sk[äa]rmdiameter|^shade ?diameter/i, "shade_diameter"],
  [/^sk[äa]rmh[öo]jd|^shade ?height/i, "shade_height"],
  [/^(fotdiameter|base ?diameter)/i, "base_diameter"],
  [/^(kabell[äa]ngd|sladd|cable|cord)/i, "cable_length"],
  [/^(skivans? )?tjocklek|^(table ?top )?thickness/i, "tabletop_thickness"],
  [/^(total ?|[öo]vergripande )?bredd|^(overall |total )?width/i, "overall_width"],
  [/^(total ?|[öo]vergripande )?djup|^(overall |total )?depth/i, "overall_depth"],
  [/^(total ?|[öo]vergripande )?h[öo]jd|^(overall |total )?height/i, "overall_height"],
  [/^l[äa]ngd|^length/i, "length"],
  [/^(diameter|diam\b|ø)/i, "diameter"],
];

/** Andra längdmått: etiketter som INNEHÅLLER ett längdord ("Hyllplanets bredd", "Lådans djup"). */
const GENERIC_DIMENSION = new RegExp(`(?<![${L}])(bredd|djup|h[öo]jd|l[äa]ngd|diameter|tjocklek|width|depth|height|length|thickness)(?![${L}])`, "i");

/** Vikt och belastning är uppgifter om produkten, inget som mäts med måttband. */
const NON_DIMENSION = /^(vikt|weight|egenvikt|max(imal)? ?(belastning|last|load)|testad f[öo]r|b[äa]rf[öo]rm[åa]ga|load|capacity)/i;

const COMBINED = /^(m[åa]tt|dimension|dimensioner|storlek|size|m[åa]tt \(|total ?m[åa]tt)/i;

const MATERIAL_LABEL =
  /^(material|tyg|kl[äa]dsel|tr[äa]slag|stomme|stoppning|fyllning|ram|bordsskiva|skiva|ytbehandling|yta|ytskikt|lack|beklädnad|[öo]vertyg|[öo]verdrag|fabric|upholstery|frame|filling|padding|surface|finish|veneer|fan[ée]r|sk[äa]rm|sitsdyna|dyna|b[äa]rande konstruktion)/i;
/** Komponenter som bara är material när värdet INTE är ett mått ("Sits: Massiv björk" men inte "Sitthöjd: 46 cm"). */
const COMPONENT_LABEL = /^(sits|rygg|ben|f[öo]tter|armst[öo]d|stativ|underrede)(\s|:|$|\/|,|\()/i;

const MEASURE_VALUE = /\d\s*(?:[.,]\d+)?\s*(?:cm|mm|centimeter|meter|"|tum|in\b|\bm\b)|\d+\s*[x×*]\s*\d+/i;
const NUMBER_ONLY = /^\s*~?≈?\s*\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?\s*$/;

const stripQualifier = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, "").replace(/[:：]\s*$/, "").trim();

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/** Känns raden igen som ett längdmått utifrån etiketten ensam? Ger den kanoniska typen. */
export function dimensionTypeOfLabel(label: string): string | null {
  const l = stripQualifier(label);
  for (const [re, type] of DIMENSION_ALIASES) if (re.test(l)) return type;
  return null;
}

export function classifyAttribute(a: KindInput): KindResult {
  // Servern har redan avgjort: det är sanningen.
  if (a.kind === "dimension") return { kind: "dimension", type: a.type ?? dimensionTypeOfLabel(a.label) ?? slug(stripQualifier(a.label)) };
  if (a.kind === "material") return { kind: "material", component: a.component ?? stripQualifier(a.label) };
  if (a.kind === "fact") return { kind: "fact", ...(a.type ? { type: a.type } : {}) };

  const label = stripQualifier(a.label);
  const key = a.key.toLowerCase();
  const value = a.value ?? "";

  if (/^material_/.test(key)) return { kind: "material", component: label };
  if (NON_DIMENSION.test(label)) return { kind: "fact", type: /vikt|weight/i.test(label) ? "weight" : "max_load" };

  const measure = MEASURE_VALUE.test(value);
  const known = dimensionTypeOfLabel(a.label);
  if (known && (measure || NUMBER_ONLY.test(value))) return { kind: "dimension", type: known };
  if (COMBINED.test(label) && measure) return { kind: "dimension", type: "combined" };
  if (MATERIAL_LABEL.test(label) && !measure) return { kind: "material", component: label };
  if (COMPONENT_LABEL.test(label) && !measure) return { kind: "material", component: label.replace(/[:/,]+$/, "") };
  if (measure && GENERIC_DIMENSION.test(label)) return { kind: "dimension", type: slug(label) || "dimension" };
  return { kind: "fact" };
}

/** Sätter kind/type/component på varje rad som saknar dem. Rör inget annat. */
export function withKinds<T extends KindInput>(attrs: T[]): T[] {
  return attrs.map((a) => {
    if (a.kind) return a;
    const k = classifyAttribute(a);
    return { ...a, kind: k.kind, ...(k.type ? { type: k.type } : {}), ...(k.component ? { component: k.component } : {}) };
  });
}

/** Svensk etikett för en känd måttyp — det som visas i måttlistan oavsett vad källan kallade raden. */
export const DIMENSION_LABELS: Record<string, string> = {
  overall_width: "Bredd",
  overall_depth: "Djup",
  overall_height: "Höjd",
  length: "Längd",
  diameter: "Diameter",
  seat_width: "Sittbredd",
  seat_depth: "Sittdjup",
  seat_height: "Sitthöjd",
  backrest_height: "Rygghöjd",
  armrest_height: "Armstödshöjd",
  armrest_width: "Armstödsbredd",
  leg_height: "Benhöjd",
  clearance_under: "Fri höjd under",
  tabletop_thickness: "Skivans tjocklek",
  shade_diameter: "Skärmdiameter",
  shade_height: "Skärmhöjd",
  base_diameter: "Fotdiameter",
  cable_length: "Kabellängd",
  combined: "Mått",
};

/** Ordningen en möbel mäts i: övergripande först, sedan sittmått, sedan resten. */
export const DIMENSION_ORDER = [
  "combined",
  "length",
  "overall_width",
  "overall_depth",
  "overall_height",
  "diameter",
  "seat_height",
  "seat_width",
  "seat_depth",
  "backrest_height",
  "armrest_height",
  "armrest_width",
  "leg_height",
  "clearance_under",
  "tabletop_thickness",
  "shade_diameter",
  "shade_height",
  "base_diameter",
  "cable_length",
];
