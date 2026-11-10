/**
 * Från modellens JSON till våra typer: enheter, kanoniska måttyper, svenska etiketter, dubbletter,
 * rimlighet. Ingen modell, inget nätverk — bara regler som går att testa.
 *
 * MÅTTYPERNA ÄR ÖPPNA. Tabellen nedan ger kända typer en stabil nyckel och etikett som resten av
 * appen redan läser (bredd/djup/hojd/sitthojd … i furnitureModel.ts, mattminne.ts, specHarvest.ts).
 * En typ som inte står i tabellen går igenom ändå, med modellens egen etikett och en slug som nyckel.
 * Det är hela poängen: en lampas kabellängd ska inte behöva stå i en tabell för att få finnas.
 */

import type { ResearchDimension, ResearchFact, ResearchMaterial, ResearchSource, ResearchVariant, VerificationLevel } from "./types.js";

interface KnownType {
  key: string;
  label: string;
}

/** Kända typer → nyckel + svensk etikett. Nycklarna matchar specHarvest/mattminne där de överlappar. */
export const KNOWN_DIMENSIONS: Record<string, KnownType> = {
  overall_width: { key: "bredd", label: "Bredd" },
  overall_depth: { key: "djup", label: "Djup" },
  overall_height: { key: "hojd", label: "Höjd" },
  length: { key: "langd", label: "Längd" },
  overall_length: { key: "langd", label: "Längd" },
  diameter: { key: "diameter", label: "Diameter" },
  seat_width: { key: "sittbredd", label: "Sittbredd" },
  seat_depth: { key: "sittdjup", label: "Sittdjup" },
  seat_height: { key: "sitthojd", label: "Sitthöjd" },
  backrest_height: { key: "rygghojd", label: "Rygghöjd" },
  back_height: { key: "rygghojd", label: "Rygghöjd" },
  armrest_height: { key: "armstodshojd", label: "Armstödshöjd" },
  arm_height: { key: "armstodshojd", label: "Armstödshöjd" },
  armrest_width: { key: "armstodsbredd", label: "Armstödsbredd" },
  leg_height: { key: "benhojd", label: "Benhöjd" },
  clearance_under: { key: "frihojd", label: "Fri höjd under" },
  leg_clearance: { key: "frihojd", label: "Fri höjd under" },
  tabletop_thickness: { key: "skivtjocklek", label: "Skivans tjocklek" },
  table_top_thickness: { key: "skivtjocklek", label: "Skivans tjocklek" },
  extension_length: { key: "utdragen_langd", label: "Längd utdragen" },
  extended_length: { key: "utdragen_langd", label: "Längd utdragen" },
  leaf_length: { key: "ilaggsskiva", label: "Iläggsskiva" },
  leg_distance: { key: "benavstand", label: "Avstånd mellan ben" },
  distance_between_legs: { key: "benavstand", label: "Avstånd mellan ben" },
  shade_diameter: { key: "skarmdiameter", label: "Skärmdiameter" },
  shade_height: { key: "skarmhojd", label: "Skärmhöjd" },
  base_diameter: { key: "fotdiameter", label: "Fotdiameter" },
  cable_length: { key: "kabellangd", label: "Kabellängd" },
  cord_length: { key: "kabellangd", label: "Kabellängd" },
  chaise_depth: { key: "schaslongdjup", label: "Schäslongens djup" },
  chaise_length: { key: "schaslonglangd", label: "Schäslongens längd" },
  bed_width: { key: "baddbredd", label: "Bäddbredd" },
  bed_length: { key: "baddlangd", label: "Bäddlängd" },
  mattress_width: { key: "madrassbredd", label: "Madrassbredd" },
  mattress_length: { key: "madrasslangd", label: "Madrasslängd" },
  min_height: { key: "minhojd", label: "Lägsta höjd" },
  max_height: { key: "maxhojd", label: "Högsta höjd" },
  weight: { key: "vikt", label: "Vikt" },
  max_load: { key: "maxlast", label: "Max belastning" },
  shelf_width: { key: "hyllbredd", label: "Hyllplanets bredd" },
  shelf_depth: { key: "hylldjup", label: "Hyllplanets djup" },
  inner_width: { key: "innerbredd", label: "Innerbredd" },
  inner_depth: { key: "innerdjup", label: "Innerdjup" },
  inner_height: { key: "innerhojd", label: "Innerhöjd" },
  drawer_width: { key: "ladbredd", label: "Lådans bredd" },
  drawer_depth: { key: "laddjup", label: "Lådans djup" },
  drawer_height: { key: "ladhojd", label: "Lådans höjd" },
};

/** Lösa varianter modellen gärna skriver, till kanonisk typ. */
const TYPE_ALIASES: Record<string, string> = {
  width: "overall_width",
  total_width: "overall_width",
  depth: "overall_depth",
  total_depth: "overall_depth",
  height: "overall_height",
  total_height: "overall_height",
  overall_diameter: "diameter",
  seat_depth_cm: "seat_depth",
  seating_height: "seat_height",
  armrest_heigth: "armrest_height",
  cable: "cable_length",
  net_weight: "weight",
  product_weight: "weight",
  weight_kg: "weight",
  max_weight: "max_load",
  load_capacity: "max_load",
  maximum_load: "max_load",
  seat_w: "seat_width",
  seating_width: "seat_width",
  seat_breadth: "seat_width",
  seat_d: "seat_depth",
  seating_depth: "seat_depth",
  seat_h: "seat_height",
  sitthojd: "seat_height",
  sitshojd: "seat_height",
  sittbredd: "seat_width",
  sitsbredd: "seat_width",
  sittdjup: "seat_depth",
  sitsdjup: "seat_depth",
  bredd: "overall_width",
  djup: "overall_depth",
  hojd: "overall_height",
  totalhojd: "overall_height",
  langd: "length",
  diameter_cm: "diameter",
};

/**
 * Typer som är MÅTT i betydelsen längder: allt som mäts med måttband. Vikt och maxbelastning är
 * uppgifter om produkten men inget mått — de hör hemma bland övriga specifikationer, inte i måttlistan.
 */
export const NON_DIMENSIONAL_TYPES = new Set(["weight", "max_load"]);
export const isLengthType = (type: string): boolean => !NON_DIMENSIONAL_TYPES.has(type);

/** "Width" → "overall_width"; "Bredd" → "overall_width"; "sitthöjd" → "seat_height". */
const LABEL_TO_TYPE: Array<[RegExp, string]> = [
  [/^(sitt?s?h|seat ?h)/i, "seat_height"],
  [/^(sitt?s?d|seat ?d)/i, "seat_depth"],
  [/^(sitt?s?b|seat ?w|seat ?b)/i, "seat_width"],
  [/^(rygg|back(rest)? ?h)/i, "backrest_height"],
  [/^(armst[öo]dsh|arm(rest)? ?h)/i, "armrest_height"],
  [/^(armst[öo]dsb|arm(rest)? ?w)/i, "armrest_width"],
  [/^(benh|leg ?h)/i, "leg_height"],
  [/^(sk[äa]rmdiam|shade ?diam)/i, "shade_diameter"],
  [/^(sk[äa]rmh|shade ?h)/i, "shade_height"],
  [/^(kabel|cable|cord)/i, "cable_length"],
  [/^(diam|ø)/i, "diameter"],
  [/^(bredd|width)/i, "overall_width"],
  [/^(djup|depth)/i, "overall_depth"],
  [/^(h[öo]jd|height)/i, "overall_height"],
  [/^(l[äa]ngd|length)/i, "length"],
  [/^(vikt|weight)/i, "weight"],
];

export function slugKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function canonicalType(rawType: string | null | undefined, rawLabel: string | null | undefined): string {
  const t = slugKey(rawType ?? "");
  if (t && KNOWN_DIMENSIONS[t]) return t;
  if (t && TYPE_ALIASES[t]) return TYPE_ALIASES[t];
  const label = (rawLabel ?? "").trim();
  for (const [re, type] of LABEL_TO_TYPE) if (re.test(label)) return type;
  // En svensk eller inbland slug i typfältet ("sittbredd_cm", "seat width") går via samma tabell.
  const spaced = (rawType ?? "").replace(/_/g, " ").trim();
  if (spaced) for (const [re, type] of LABEL_TO_TYPE) if (re.test(spaced)) return type;
  return t || slugKey(label) || "dimension";
}

function humanize(type: string): string {
  const s = type.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Mått";
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10).replace(".", ",");

export function toCm(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  const cm = u === "cm" ? value : u === "mm" ? value / 10 : u === "m" ? value * 100 : u === "in" || u === "inch" || u === "inches" || u === '"' ? value * 2.54 : u === "ft" ? value * 30.48 : NaN;
  return Number.isFinite(cm) ? cm : null;
}

export function toKg(value: number, unit: string): number | null {
  const u = unit.toLowerCase();
  const kg = u === "kg" ? value : u === "g" ? value / 1000 : u === "lb" || u === "lbs" ? value * 0.4536 : NaN;
  return Number.isFinite(kg) ? kg : null;
}

/** Vad en möbel rimligen mäter. Utanför det är det inte ett mått vi läst utan ett tal vi råkat på. */
const MIN_CM = 0.3;
const MAX_CM = 1000;
const MIN_KG = 0.05;
const MAX_KG = 1000;

export interface RawDimension {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  valueMax?: unknown;
  unit?: unknown;
  appliesTo?: unknown;
  sourceUrl?: unknown;
  quote?: unknown;
}

const strOrNull = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function cleanUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const url = v.trim().replace(/[.,;:)\]]+$/, "");
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 600) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/** Ett mått ur modellens JSON — eller null när det inte är ett mått. */
export function normalizeDimension(raw: RawDimension): ResearchDimension | null {
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return null;
  const unit = typeof raw.unit === "string" ? raw.unit : "cm";
  const type = canonicalType(typeof raw.type === "string" ? raw.type : null, typeof raw.label === "string" ? raw.label : null);
  const known = KNOWN_DIMENSIONS[type];
  const isWeight = type === "weight" || type === "max_load" || /^(kg|g|lb|lbs)$/i.test(unit);
  const max = typeof raw.valueMax === "number" && Number.isFinite(raw.valueMax) && raw.valueMax > raw.value ? raw.valueMax : null;

  let value: number | null;
  let valueMax: number | null = null;
  let outUnit: "cm" | "kg";
  if (isWeight) {
    value = toKg(raw.value, unit);
    valueMax = max === null ? null : toKg(max, unit);
    outUnit = "kg";
    if (value === null || value < MIN_KG || value > MAX_KG) return null;
  } else {
    value = toCm(raw.value, unit);
    valueMax = max === null ? null : toCm(max, unit);
    outUnit = "cm";
    if (value === null || value < MIN_CM || value > MAX_CM) return null;
  }
  const label = known?.label ?? (strOrNull(raw.label, 40) ?? humanize(type));
  const key = known?.key ?? slugKey(label) ?? type;
  const display = `${fmt(value)}${valueMax !== null ? `–${fmt(valueMax)}` : ""} ${outUnit}`;
  const rawValue = `${String(raw.value).replace(".", ",")}${max !== null ? `–${String(max).replace(".", ",")}` : ""} ${unit}`;
  return {
    type,
    key,
    label,
    value: Math.round(value * 10) / 10,
    valueMax: valueMax === null ? null : Math.round(valueMax * 10) / 10,
    unit: outUnit,
    display,
    rawValue,
    appliesTo: strOrNull(raw.appliesTo, 80),
    sourceUrl: cleanUrl(raw.sourceUrl),
    verification: "unverified",
    verified: false,
    quote: strOrNull(raw.quote, 300),
  };
}

export interface RawMaterial {
  component?: unknown;
  material?: unknown;
  detail?: unknown;
  appliesTo?: unknown;
  sourceUrl?: unknown;
  quote?: unknown;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function normalizeMaterial(raw: RawMaterial): ResearchMaterial | null {
  const component = strOrNull(raw.component, 60);
  const material = strOrNull(raw.material, 200);
  if (!component || !material) return null;
  // "okänt", "ej angivet" är inte material.
  if (/^(okänt|okänd|ej angivet|uppgift saknas|unknown|n\/a|-)$/i.test(material)) return null;
  return {
    component: capitalize(component.replace(/[.:]+$/, "")),
    material: material.replace(/[.;]+$/, ""),
    detail: strOrNull(raw.detail, 200),
    appliesTo: strOrNull(raw.appliesTo, 80),
    sourceUrl: cleanUrl(raw.sourceUrl),
    verification: "unverified",
    verified: false,
    quote: strOrNull(raw.quote, 300),
  };
}

export function normalizeVariant(raw: { label?: unknown; differsBy?: unknown; sourceUrl?: unknown }): ResearchVariant | null {
  const label = strOrNull(raw.label, 60);
  if (!label) return null;
  return { label: label.replace(/[.:]+$/, ""), differsBy: strOrNull(raw.differsBy, 60), sourceUrl: cleanUrl(raw.sourceUrl) };
}

export function normalizeFact(raw: { label?: unknown; value?: unknown; sourceUrl?: unknown; appliesTo?: unknown }): ResearchFact | null {
  const label = strOrNull(raw.label, 60);
  const value = strOrNull(raw.value, 200);
  if (!label || !value) return null;
  // Står varianten i etiketten ("Artikelnummer (63 cm, svart)") flyttas den till appliesTo — etiketten ska vara ren.
  const paren = /\s*\(([^)]+)\)\s*$/.exec(label);
  const appliesTo = strOrNull(raw.appliesTo, 80) ?? (paren ? paren[1].trim() : null);
  const clean = paren ? label.slice(0, paren.index).trim() : label;
  return { label: capitalize(clean || label), value, appliesTo, sourceUrl: cleanUrl(raw.sourceUrl), verification: "unverified" };
}

const RANK: Record<VerificationLevel, number> = { page_confirmed: 3, cited: 2, unverified: 1 };

/**
 * En rad per mått. Samma typ två gånger (två källor) behålls bara när de gäller olika varianter;
 * annars vinner den bäst belagda, och vid lika den som kom först (modellens egen ordning).
 */
export function dedupeDimensions(dims: ResearchDimension[], tierOf: (url: string | null) => number): ResearchDimension[] {
  const out: ResearchDimension[] = [];
  for (const d of dims) {
    const i = out.findIndex((x) => x.type === d.type && (x.appliesTo ?? "") === (d.appliesTo ?? ""));
    if (i < 0) {
      out.push(d);
      continue;
    }
    const cur = out[i];
    const better =
      RANK[d.verification] > RANK[cur.verification] ||
      (RANK[d.verification] === RANK[cur.verification] && tierOf(d.sourceUrl) < tierOf(cur.sourceUrl));
    if (better) out[i] = d;
  }
  return out;
}

export function dedupeMaterials(ms: ResearchMaterial[]): ResearchMaterial[] {
  const out: ResearchMaterial[] = [];
  for (const m of ms) {
    const k = `${m.component.toLowerCase()}|${m.material.toLowerCase()}|${m.appliesTo ?? ""}`;
    const i = out.findIndex((x) => `${x.component.toLowerCase()}|${x.material.toLowerCase()}|${x.appliesTo ?? ""}` === k);
    if (i < 0) out.push(m);
    else if (RANK[m.verification] > RANK[out[i].verification]) out[i] = m;
  }
  return out;
}

/**
 * Övergripande mått först, sedan sittmått, sedan resten i modellens ordning. Läsarna som tar
 * "första höjd" (furnitureModel.ts) ska få möbelns höjd, inte benens.
 */
const ORDER = ["overall_width", "overall_depth", "overall_height", "length", "diameter", "seat_width", "seat_depth", "seat_height"];
export function sortDimensions(dims: ResearchDimension[]): ResearchDimension[] {
  const rank = (d: ResearchDimension) => {
    const i = ORDER.indexOf(d.type);
    return i < 0 ? ORDER.length : i;
  };
  return [...dims].map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
}

/** Tillverkare, återförsäljare, övrigt — ur adressen, aldrig ur modellen. Kort lista, medvetet. */
const MANUFACTURER_HOSTS = [
  "ikea.", "string.se", "stringfurniture.com", "hay.dk", "hay.com", "muuto.com", "bolia.com", "swedese.", "fogia.", "norrgavel.",
  "boconcept.", "kinnarps.", "mio.se", "jysk.", "ellos.se", "lammhults.", "carlhansen.", "fritzhansen.", "vitra.com", "artek.fi",
  "louispoulsen.", "flos.com", "gubi.", "andtradition.", "normann-copenhagen.", "karlandersson.se", "gardsjo", "bruno-mathsson", "dux.se",
  "hastens.", "sofacompany.", "sweef.se", "stolab.se", "offecct.", "skandiform.", "materia.se", "blastation.", "gemla.se", "nordicnest.",
];
const RETAILER_HOSTS = ["svenssons.se", "rum21.se", "royaldesign.", "nordicnest.", "trademax.", "furniturebox.", "chilli.se", "lannamobler.se", "olssonsmobler.se", "webhallen.", "bygghemma."];
const MARKETPLACE_HOSTS = ["blocket.se", "tradera.com", "sellpy.", "vinted.", "ebay.", "facebook.com", "etsy.", "1stdibs.", "pamono.", "chairish.", "bukowskis.", "auctionet.", "lauritz."];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function sourceTier(url: string, brand?: string | null): 1 | 2 | 3 {
  const host = hostOf(url);
  if (!host) return 3;
  if (brand) {
    const b = slugKey(brand).replace(/_/g, "");
    if (b.length >= 3 && host.replace(/[^a-z0-9]/g, "").includes(b)) return 1;
  }
  if (MANUFACTURER_HOSTS.some((h) => host.includes(h))) return 1;
  if (RETAILER_HOSTS.some((h) => host.includes(h))) return 2;
  return 3;
}

export const isMarketplace = (url: string): boolean => MARKETPLACE_HOSTS.some((h) => hostOf(url).includes(h));

/** Googles omdirigeringsadresser bär ingen läsbar värd — de duger som citat men aldrig som källa att visa. */
export const isRedirectUrl = (url: string): boolean => /vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i.test(url);

export function buildSources(
  urls: Array<{ url: string; title: string | null; retrieved?: boolean; cited?: boolean }>,
  brand: string | null,
): ResearchSource[] {
  const map = new Map<string, ResearchSource & { titled: boolean }>();
  for (const u of urls) {
    const url = cleanUrl(u.url);
    if (!url || isRedirectUrl(url)) continue;
    const title = u.title?.trim() || "";
    const cur = map.get(url);
    if (cur) {
      cur.retrieved = cur.retrieved || !!u.retrieved;
      cur.cited = cur.cited || !!u.cited;
      // Första RIKTIGA titeln vinner över värdnamnet som stod där i väntan på en.
      if (!cur.titled && title) {
        cur.title = title;
        cur.titled = true;
      }
      continue;
    }
    map.set(url, { url, title: title || hostOf(url) || url, titled: !!title, tier: sourceTier(url, brand), retrieved: !!u.retrieved, cited: !!u.cited });
  }
  return [...map.values()]
    .sort((a, b) => a.tier - b.tier)
    .map(({ titled: _titled, ...s }) => s);
}
