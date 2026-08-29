import type { Box, Palette, Vec3 } from "./render3d";
import type { ListingAttribute } from "../types";

/**
 * Möbeln som lådor, byggd ur det vi FAKTISKT vet: kategorin, måtten och det som stod i
 * specifikationerna.
 *
 * Modellen är en stand-in, inte en avbildning. Den säger sant om proportionerna — en 198 cm bred
 * soffa blir 198 cm bred — och håller tyst om allt annat: inget mönster, inga sömmar, ingen
 * dekoration. Det är precis vad ett skickintyg får påstå om en möbel det aldrig sett ritningen på.
 *
 * Men den ska inte hålla tyst om sådant vi VET. Stod sitthöjden i underlaget sitter sitsen där.
 * Står det "3-sits" i modellnamnet har soffan tre dynor. Står det "utan armstöd" ritas inga. Varje
 * sådant tal gör stand-in:en till en bild av just den här möbeln i stället för av kategorin, och det
 * är skillnaden mellan en figur säljaren känner igen och en generisk kloss.
 *
 * Saknas måtten helt byggs ingen modell alls. En soffa i standardmått, utritad som om den vore
 * uppmätt, hade varit en gissning med tre decimaler.
 */

export type Archetype = "sofa" | "chair" | "table" | "cabinet" | "shelf" | "bed" | "box";

export interface Dimensions {
  /** centimeter */
  width: number;
  depth: number;
  height: number;
  /** Vilka mått som INTE stod i underlaget utan är typiska för kategorin. */
  assumed: ("width" | "depth" | "height")[];
}

export interface Anchor {
  point: Vec3;
  normal: Vec3;
}

export interface FurnitureModel {
  archetype: Archetype;
  dims: Dimensions;
  boxes: Box[];
  palette: Palette;
  /** Ankarpunkter skador kan fästas på, i modellrymden. */
  anchors: Record<string, Anchor>;
  /** Ordningen nålar hamnar i när delen inte går att tolka. */
  fallbackZones: string[];
}

/** Texten runt möbeln: det är där "3-sits", "utan armstöd" och "ekfaner" står. */
export interface ModelContext {
  category?: string | null;
  title?: string | null;
  variant?: string | null;
}

/**
 * Formdrag som står i underlaget men inte i måtten.
 *
 * Var och en av dem är LÄST, aldrig gissad: fälten är null när texten inte sade något, och
 * byggarna faller tillbaka på kategorins typiska form först då.
 */
export interface ShapeHints {
  /** Sitshöjd i cm, när den stod som ett eget mått. */
  seatHeight: number | null;
  /** Antal sitsar ur modellnamnet ("3-sits"). */
  seats: number | null;
  /** Möbeln har armstöd. */
  arms: boolean;
  /** Stoppad möbel — en fåtölj byggs som en ensitsig soffa, en pinnstol som ram och sits. */
  upholstered: boolean;
  /** Antal lådor/luckor ur specifikationerna. */
  drawers: number | null;
  /** Ben i metall i stället för trä. */
  metalLegs: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---- kategori -------------------------------------------------------------

const ARCHETYPE_PATTERNS: [RegExp, Archetype][] = [
  [/soffa|divan|bädd|3-sits|2-sits|schäslong|soffgrupp/i, "sofa"],
  [/fåtölj|stol|pall|karmstol|matstol|barstol|kontorsstol|puff/i, "chair"],
  [/bord|skrivbord|sängbord|soffbord|matbord|sidobord|avlastning/i, "table"],
  [/byrå|skåp|kommod|garderob|vitrin|sideboard|tv-bänk|hurts/i, "cabinet"],
  [/hylla|bokhylla|regal|vägghylla/i, "shelf"],
  [/säng|sängram|resårsäng|kontinental|madrass/i, "bed"],
];

export function archetypeFor(category: string | null, title: string | null): Archetype {
  const text = `${category ?? ""} ${title ?? ""}`;
  for (const [re, type] of ARCHETYPE_PATTERNS) if (re.test(text)) return type;
  return "box";
}

/** Typiska mått per kategori — används BARA för att fylla i ett mått som saknas, aldrig alla tre. */
const TYPICAL: Record<Archetype, [number, number, number]> = {
  sofa: [200, 90, 82],
  chair: [70, 72, 82],
  table: [120, 60, 45],
  cabinet: [100, 45, 80],
  shelf: [80, 30, 180],
  bed: [160, 200, 60],
  box: [80, 50, 60],
};

// ---- mått ur annonsunderlaget --------------------------------------------

/** "198 × 99 × 83 cm", "B 198 x D 99 x H 83", "198x99x83". */
const TRIPLE = /(\d{2,3})\s*(?:cm)?\s*[x×*]\s*(\d{2,3})\s*(?:cm)?\s*[x×*]\s*(\d{2,3})/i;
const SINGLE = /(\d{2,3})(?:[,.](\d))?\s*cm/i;

function firstNumber(value: string): number | null {
  const m = SINGLE.exec(value) ?? /(\d{2,3})/.exec(value);
  if (!m) return null;
  const n = Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
  return n > 0 && n < 400 ? n : null;
}

/**
 * Måtten kommer i två former: ett samlat "Mått"-attribut, eller ett attribut per riktning. Båda
 * förekommer i samma korpus, så båda läses — de enskilda etiketterna först, det samlade fältet som
 * ifyllnad, och det står i ordningen bredd × djup × höjd.
 *
 * Ingenting skriver över ett mått som redan lästs. Ett attribut som kommer senare i listan är inte en
 * rättelse av ett tidigare utan ett svagare belägg, och en ENDA överskrivning för mycket är hur en
 * barstol på 40 × 45 × 88 cm ritas ut som 90 × 34 × 88: förpackningens längd som bredd, sittdjupet
 * som djup.
 */
export function parseDimensions(attributes: ListingAttribute[], archetype: Archetype): Dimensions | null {
  const typical = TYPICAL[archetype];
  let width: number | null = null;
  let depth: number | null = null;
  let height: number | null = null;
  let length: number | null = null;
  let combined: [number, number, number] | null = null;

  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    if (/mått|dimension|size|storlek/.test(label)) {
      const m = TRIPLE.exec(a.value);
      if (m) combined = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  }
  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    // Delarnas mått är inte möbelns: sitthöjd är inte höjd, SITTDJUP ÄR INTE DJUP och rygghöjd är
    // inte möbelns höjd. Alla tre matchar annars sitt eget mått och skriver över det riktiga.
    if (/sitth|sitsh|sittd|sitsd|seat|arm|rygg/.test(label)) continue;
    // Först skrivet vinner. Listan börjar med det generatorn belagt mot en källa och slutar med det
    // sidskörden fyllt på med, så ett senare värde är ett SÄMRE värde — aldrig ett nyare.
    if (/bredd|width/.test(label)) width ??= firstNumber(a.value);
    else if (/djup|depth/.test(label)) depth ??= firstNumber(a.value);
    else if (/höjd|hojd|height/.test(label)) height ??= firstNumber(a.value);
    else if (/längd|langd|length/.test(label)) length ??= firstNumber(a.value);
  }
  if (combined) {
    width ??= combined[0];
    depth ??= combined[1];
    height ??= combined[2];
  }
  // Längden är bredden bara när ingen bredd står någonstans. En soffa mäts på längden, men en stol
  // med både "Bredd 40 cm" och "Längd 90 cm" är 40 cm bred — de 90 är kartongen den kom i.
  width ??= length;

  // Inget enda mått belagt: då finns ingen modell att rita. Se filens toppkommentar.
  if (width === null && depth === null && height === null) return null;

  const assumed: Dimensions["assumed"] = [];
  if (width === null) assumed.push("width");
  if (depth === null) assumed.push("depth");
  if (height === null) assumed.push("height");
  return {
    width: width ?? typical[0],
    depth: depth ?? typical[1],
    height: height ?? typical[2],
    assumed,
  };
}

// ---- form ur annonsunderlaget --------------------------------------------

const SEAT_WORDS: [RegExp, number][] = [
  [/\bensits|1[,.]?5?-?\s?sits/i, 1],
  [/\btvåsits|2[,.]?5?-?\s?sits/i, 2],
  [/\btresits|3[,.]?5?-?\s?sits/i, 3],
  [/\bfyrsits|4-?\s?sits/i, 4],
];

/** Stoppade kategorier byggs mjukt, resten som ram och skiva. */
const UPHOLSTERED = /fåtölj|karmstol|kontorsstol|puff|loungestol|öronlappsfåtölj/i;
const FABRIC = /tyg|sammet|velour|bouclé|boucle|linne|ull|chenille|läder|skinn|manchester/i;

export function parseShape(attributes: ListingAttribute[], ctx: ModelContext, archetype: Archetype): ShapeHints {
  const text = `${ctx.category ?? ""} ${ctx.title ?? ""} ${ctx.variant ?? ""}`;
  const specs = attributes.map((a) => `${a.key} ${a.label} ${a.value}`).join(" ");

  let seatHeight: number | null = null;
  let drawers: number | null = null;
  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    if (/sitthöjd|sitshöjd|seat height/.test(label)) seatHeight = seatHeight ?? firstNumber(a.value);
    if (/lådor|lådhurts|drawers|antal lådor|luckor|dörrar/.test(label)) {
      const n = Number(/(\d+)/.exec(a.value)?.[1]);
      if (n >= 1 && n <= 8) drawers = drawers ?? n;
    }
  }

  let seats: number | null = null;
  for (const [re, n] of SEAT_WORDS) if (re.test(text)) seats = seats ?? n;

  // "Utan armstöd" är ett påstående i underlaget och väger tyngre än kategorins standardform.
  const armless = /utan armstöd|armlös|armless|utan karm/i.test(`${text} ${specs}`);
  const arms = armless ? false : archetype === "sofa" || UPHOLSTERED.test(text);

  return {
    seatHeight,
    seats,
    arms,
    upholstered: UPHOLSTERED.test(text) || (archetype === "chair" && FABRIC.test(specs)),
    drawers,
    metalLegs: /metall|krom|stål|aluminium|metal|chrome|steel/i.test(`${specs} ${text}`),
  };
}

// ---- färg -----------------------------------------------------------------

const COLOR_WORDS: [RegExp, string][] = [
  [/mörkgrå|antracit/i, "#6f6e6c"],
  [/ljusgrå/i, "#cdcac5"],
  [/grå|grey|gray/i, "#b5b1ab"],
  [/beige|sand|natur|linne/i, "#d3c4ae"],
  [/off.?white|krämvit|benvit/i, "#e6e0d5"],
  [/vit|white/i, "#eceae5"],
  [/svart|black/i, "#33302c"],
  [/mörkblå|marin|navy/i, "#3d4c63"],
  [/blå|blue/i, "#5b7288"],
  [/mörkgrön|petrol/i, "#3f5348"],
  [/grön|green/i, "#6f8069"],
  [/vinröd|bordeaux/i, "#7a3a3a"],
  [/röd|red/i, "#a4483c"],
  [/gul|senap|ockra/i, "#cfa94f"],
  [/rosa|puder/i, "#d0a8a2"],
  [/valnöt|walnut|mörkbrun/i, "#6f4d33"],
  [/\bek\b|oak/i, "#c2a077"],
  [/teak/i, "#a87a4d"],
  [/björk|birch|furu|pine|\bask\b/i, "#dcc39b"],
  [/brun|brown|cognac|läder|leather/i, "#8a6247"],
];

const DEFAULT_FABRIC = "#cbc0b0";

function colorFrom(attributes: ListingAttribute[], variant: string | null): string | null {
  const haystack = [
    ...attributes
      .filter((a) => /färg|kulör|colour|color|klädsel|tyg|material|träslag/i.test(`${a.key} ${a.label}`))
      .map((a) => a.value),
    variant ?? "",
  ].join(" ");
  for (const [re, hex] of COLOR_WORDS) if (re.test(haystack)) return hex;
  return null;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function mix(hex: string, other: string, amount: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(other.slice(1), 16);
  const out = [16, 8, 0].map((shift) => {
    const va = (a >> shift) & 255;
    const vb = (b >> shift) & 255;
    return Math.round(va + (vb - va) * amount);
  });
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function paletteFor(archetype: Archetype, attributes: ListingAttribute[], ctx: ModelContext, shape: ShapeHints): Palette {
  const found = colorFrom(attributes, ctx.variant ?? null);
  const soft = archetype === "sofa" || archetype === "bed" || (archetype === "chair" && shape.upholstered);
  const body = found ?? (soft ? DEFAULT_FABRIC : "#c9ab82");
  return {
    body,
    // Dynan aningen ljusare än stommen: så läser en dyna även när den har samma tyg.
    cushion: mix(body, "#ffffff", 0.12),
    // Mörkt trä under en tygmöbel, men samma trä som skivan på ett bord — ett massivt ekbord
    // med mörkbruna ben ser ut som två möbler ihopsatta.
    leg: shape.metalLegs ? "#9a9da0" : soft ? "#5e4634" : mix(body, "#000000", 0.35),
    surface: soft ? mix(body, "#ffffff", 0.06) : body,
    // Lådfronter måste synas mot stommen. En mörk stomme får ljusare fronter och tvärtom — mixat
    // åt ett fast håll försvann fronterna helt på en svartbrun byrå.
    panel: mix(body, luminance(body) > 0.45 ? "#000000" : "#ffffff", 0.13),
  };
}

// ---- geometri -------------------------------------------------------------

/**
 * Radien är det som skiljer en dyna från en kloss.
 *
 * Talen är i centimeter och ungefär vad man mäter upp på riktiga möbler: en stoppad dyna rundar av
 * ett par centimeter, en lackad skiva knappt alls. Se render3d: rundningen ritas i bildled, så det
 * här är enda stället där formen bestäms.
 */
const R: Record<string, number> = { cushion: 4.5, arm: 8, body: 2.5, leg: 1.4, panel: 1.6, top: 1.2 };

function box(center: Vec3, size: Vec3, material: Box["material"], radius = 0, tilt = 0): Box {
  return { center, size, material, radius, tilt };
}

function legs(w: number, d: number, height: number, thickness: number, inset: number, radius = R.leg): Box[] {
  const x = w / 2 - inset;
  const z = d / 2 - inset;
  return ([
    [-x, z],
    [x, z],
    [-x, -z],
    [x, -z],
  ] as [number, number][]).map(([lx, lz]) =>
    box({ x: lx, y: height / 2, z: lz }, { x: thickness, y: height, z: thickness }, "leg", radius),
  );
}

type Built = { boxes: Box[]; anchors: Record<string, Anchor> };

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const FRONT: Vec3 = { x: 0, y: 0, z: 1 };
const LEFT: Vec3 = { x: -1, y: 0, z: 0 };
const RIGHT: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * Soffan: ben, stomme, armstöd, sitsdynor och RYGGDYNOR.
 *
 * Ryggdynorna är inte dekoration — de är det som gör att formen läser som en soffa och inte som en
 * bänk. Utan dem är ryggen en enda hög låda, och det var den bilden som fick kortet att se ut som en
 * skiss. De lutar lite bakåt, som de gör i verkligheten.
 */
function buildSofa(w: number, d: number, h: number, shape: ShapeHints): Built {
  const legH = clamp(h * 0.15, 8, 17);
  const arms = shape.arms && w > 55;
  const armW = arms ? clamp(w * 0.11, 13, 26) : 0;
  const backD = clamp(d * 0.19, 11, 22);
  const cushionH = clamp(h * 0.15, 9, 15);
  // Sitshöjden är ovansidan på dynan. Stod den i underlaget är det den som gäller — den är det mått
  // en köpare faktiskt känner igen sin egen soffa på.
  const seatTop = clamp(shape.seatHeight ?? Math.max(legH + 20, h * 0.5), legH + cushionH + 4, h - 16);
  const armTop = Math.min(h - 6, seatTop + clamp(h * 0.2, 12, 24));
  const innerW = w - armW * 2;
  const seatD = d - backD;
  const frameTop = seatTop - cushionH;
  const seats = clamp(shape.seats ?? Math.round(w / 85), 1, 4);
  const backZ = -(d / 2 - backD / 2);

  const boxes: Box[] = [
    ...legs(w, d, legH, 6.5, 10),
    // Stommen under dynorna.
    box({ x: 0, y: (legH + frameTop) / 2, z: backD / 2 }, { x: innerW, y: frameTop - legH, z: seatD }, "body", R.body),
    // Ryggens stomme går MELLAN armstöden, inte bakom dem. Full bredd gav en tunn vinge som stack
    // ut utanför varje armstöd i vyn — geometriskt riktigt, men det såg ut som en lös skiva.
    box({ x: 0, y: (legH + h) / 2, z: backZ }, { x: innerW + armW, y: h - legH, z: backD }, "body", R.body),
  ];
  if (arms) {
    for (const sx of [-1, 1]) {
      boxes.push(
        box(
          { x: sx * (w / 2 - armW / 2), y: (legH + armTop) / 2, z: 0 },
          { x: armW, y: armTop - legH, z: d },
          "body",
          Math.min(R.arm, armW / 2.4),
        ),
      );
    }
  }
  const cw = innerW / seats;
  for (let i = 0; i < seats; i++) {
    const x = -innerW / 2 + cw * (i + 0.5);
    // Sitsdynan: en fog på var sida, annars läser raden som ett enda långt block.
    boxes.push(
      box({ x, y: seatTop - cushionH / 2, z: backD / 2 + 1 }, { x: cw - 2.5, y: cushionH, z: seatD - 4 }, "cushion", R.cushion),
    );
    // Ryggdynan vilar PÅ stommen och lutar bakåt. Startade den vid sitsdynans ovansida blev det ett
    // hål under den, och en dyna med luft under läser som en lös kloss.
    const backTop = h - clamp(h * 0.05, 2, 6);
    boxes.push(
      box(
        { x, y: (frameTop + backTop) / 2, z: backZ + backD / 2 + 6 },
        { x: cw - 3.5, y: backTop - frameTop, z: 12 },
        "cushion",
        R.cushion,
        -0.07,
      ),
    );
  }

  const anchors: Record<string, Anchor> = {
    seat: { point: { x: 0, y: seatTop, z: backD / 2 }, normal: UP },
    "seat-left": { point: { x: -innerW / 4, y: seatTop, z: backD / 2 }, normal: UP },
    "seat-right": { point: { x: innerW / 4, y: seatTop, z: backD / 2 }, normal: UP },
    top: { point: { x: 0, y: seatTop, z: backD / 2 }, normal: UP },
    backrest: { point: { x: 0, y: h - 12, z: backZ + backD / 2 + 12 }, normal: FRONT },
    front: { point: { x: 0, y: (legH + frameTop) / 2, z: d / 2 }, normal: FRONT },
    "side-left": { point: { x: -w / 2, y: seatTop, z: 0 }, normal: LEFT },
    "side-right": { point: { x: w / 2, y: seatTop, z: 0 }, normal: RIGHT },
    "leg-front-left": { point: { x: -(w / 2 - 10), y: legH / 2, z: d / 2 - 10 }, normal: FRONT },
    "leg-front-right": { point: { x: w / 2 - 10, y: legH / 2, z: d / 2 - 10 }, normal: FRONT },
    "leg-back-left": { point: { x: -(w / 2 - 10), y: legH / 2, z: -(d / 2 - 10) }, normal: LEFT },
    "leg-back-right": { point: { x: w / 2 - 10, y: legH / 2, z: -(d / 2 - 10) }, normal: RIGHT },
  };
  if (arms) {
    anchors["arm-left"] = { point: { x: -(w / 2 - armW / 2), y: armTop, z: 0 }, normal: UP };
    anchors["arm-right"] = { point: { x: w / 2 - armW / 2, y: armTop, z: 0 }, normal: UP };
  }
  return { boxes, anchors };
}

/**
 * Stolen. En pinnstol och en fåtölj är inte samma möbel.
 *
 * Är den stoppad byggs den som en ensitsig soffa — det ÄR vad en fåtölj är. Är den det inte får den
 * ram och sits: fyra smala ben, en skiva och ett ryggstöd som lutar. Tidigare ritades allt som
 * matchade /stol/ med soffbyggaren, så en matstol fick armstöd och tre dynor.
 */
function buildChair(w: number, d: number, h: number, shape: ShapeHints): Built {
  if (shape.upholstered) return buildSofa(w, d, h, { ...shape, seats: 1 });

  const seatH = 4.5;
  const seatTop = clamp(shape.seatHeight ?? h * 0.52, 24, h - 22);
  const legT = shape.metalLegs ? 3.4 : 4.6;
  const inset = legT * 1.3;
  const legH = seatTop - seatH;
  const backZ = -(d / 2 - inset);
  /**
   * Ryggen lutar bakåt, och stolparna lutar med den.
   *
   * Varje låda vrids kring sin EGEN mitt, så två lutande delar hänger bara ihop om mitterna ligger
   * på samma lutande linje. Det är vad zAt räknar ut — utan den gled ryggbrickan bakåt från
   * stolparna och stolen såg ut att ha gått isär.
   */
  const lean = 0.1;
  const zAt = (y: number) => backZ - (y - seatTop) * Math.tan(lean);

  const postY = (seatTop + h) / 2;
  const railBottom = seatTop + (h - seatTop) * 0.45;
  const railY = (railBottom + h) / 2;

  const boxes: Box[] = [
    ...legs(w, d, legH, legT, inset, shape.metalLegs ? legT / 2 : R.leg),
    box({ x: 0, y: seatTop - seatH / 2, z: 0 }, { x: w, y: seatH, z: d }, "surface", R.top),
    // Ryggstolparna är bakbenen förlängda uppåt — så är en stol byggd, och det är de som gör att
    // ryggen ser buren ut i stället för fastklistrad.
    ...[-1, 1].map((sx) =>
      box(
        { x: sx * (w / 2 - inset), y: postY, z: zAt(postY) },
        { x: legT, y: h - seatTop, z: legT },
        "body",
        R.leg,
        -lean,
      ),
    ),
    // Ryggbrickan mellan stolparna, i övre halvan av ryggen.
    box(
      { x: 0, y: railY, z: zAt(railY) },
      { x: w - inset * 2, y: h - railBottom, z: 3 },
      "body",
      R.panel,
      -lean,
    ),
  ];
  if (shape.arms) {
    for (const sx of [-1, 1]) {
      boxes.push(
        box({ x: sx * (w / 2 - legT / 2), y: seatTop + 18, z: 2 }, { x: legT, y: 3.4, z: d * 0.7 }, "body", R.leg),
      );
    }
  }

  const anchors: Record<string, Anchor> = {
    seat: { point: { x: 0, y: seatTop, z: 0 }, normal: UP },
    top: { point: { x: 0, y: seatTop, z: 0 }, normal: UP },
    "seat-left": { point: { x: -w / 4, y: seatTop, z: 0 }, normal: UP },
    "seat-right": { point: { x: w / 4, y: seatTop, z: 0 }, normal: UP },
    backrest: { point: { x: 0, y: railY, z: zAt(railY) + 2 }, normal: FRONT },
    front: { point: { x: 0, y: seatTop - seatH / 2, z: d / 2 }, normal: FRONT },
    "side-left": { point: { x: -w / 2, y: seatTop - seatH / 2, z: 0 }, normal: LEFT },
    "side-right": { point: { x: w / 2, y: seatTop - seatH / 2, z: 0 }, normal: RIGHT },
    "leg-front-left": { point: { x: -(w / 2 - inset), y: legH / 2, z: d / 2 - inset }, normal: FRONT },
    "leg-front-right": { point: { x: w / 2 - inset, y: legH / 2, z: d / 2 - inset }, normal: FRONT },
    "leg-back-left": { point: { x: -(w / 2 - inset), y: legH / 2, z: -(d / 2 - inset) }, normal: LEFT },
    "leg-back-right": { point: { x: w / 2 - inset, y: legH / 2, z: -(d / 2 - inset) }, normal: RIGHT },
  };
  if (shape.arms) {
    anchors["arm-left"] = { point: { x: -(w / 2 - legT / 2), y: seatTop + 20, z: 2 }, normal: UP };
    anchors["arm-right"] = { point: { x: w / 2 - legT / 2, y: seatTop + 20, z: 2 }, normal: UP };
  }
  return { boxes, anchors };
}

/** Bordet: skiva, sarg och ben. Sargen är det som gör att skivan vilar på något. */
function buildTable(w: number, d: number, h: number, shape: ShapeHints): Built {
  const topH = clamp(h * 0.07, 2.5, 5);
  const legH = h - topH;
  const legT = shape.metalLegs ? 3.6 : 6;
  const inset = legT * 1.5;
  const boxes: Box[] = [
    ...legs(w, d, legH, legT, inset, shape.metalLegs ? legT / 2 : R.leg),
    box({ x: 0, y: h - topH / 2, z: 0 }, { x: w, y: topH, z: d }, "surface", R.top),
  ];
  // Sarg bara under träben: ett metallunderrede har inget sådant, och en sarg på det ser ut som
  // en låda som klämts fast under skivan.
  if (!shape.metalLegs && Math.min(w, d) > 45) {
    boxes.push(
      box({ x: 0, y: h - topH - 3.2, z: 0 }, { x: w - inset * 2.2, y: 6.4, z: d - inset * 2.2 }, "body", R.leg),
    );
  }
  return {
    boxes,
    anchors: {
      top: { point: { x: 0, y: h, z: 0 }, normal: UP },
      "top-left": { point: { x: -w / 4, y: h, z: 0 }, normal: UP },
      "top-right": { point: { x: w / 4, y: h, z: 0 }, normal: UP },
      "corner-front-left": { point: { x: -w / 2 + 4, y: h, z: d / 2 - 4 }, normal: UP },
      "corner-front-right": { point: { x: w / 2 - 4, y: h, z: d / 2 - 4 }, normal: UP },
      front: { point: { x: 0, y: h - topH / 2, z: d / 2 }, normal: FRONT },
      "side-left": { point: { x: -w / 2, y: h - topH / 2, z: 0 }, normal: LEFT },
      "side-right": { point: { x: w / 2, y: h - topH / 2, z: 0 }, normal: RIGHT },
      "leg-front-left": { point: { x: -(w / 2 - inset), y: legH / 2, z: d / 2 - inset }, normal: FRONT },
      "leg-front-right": { point: { x: w / 2 - inset, y: legH / 2, z: d / 2 - inset }, normal: FRONT },
      "leg-back-left": { point: { x: -(w / 2 - inset), y: legH / 2, z: -(d / 2 - inset) }, normal: LEFT },
      "leg-back-right": { point: { x: w / 2 - inset, y: legH / 2, z: -(d / 2 - inset) }, normal: RIGHT },
    },
  };
}

/** Byrån: stomme, en skiva med överhäng, lådfronter med handtag. */
function buildCabinet(w: number, d: number, h: number, shape: ShapeHints): Built {
  const legH = clamp(h * 0.12, 6, 13);
  const topH = 2.6;
  const bodyH = h - legH - topH;
  const rows = clamp(shape.drawers ?? Math.round(bodyH / 26), 1, 6);
  const boxes: Box[] = [
    ...legs(w, d, legH, 5.5, 7),
    box({ x: 0, y: legH + bodyH / 2, z: 0 }, { x: w, y: bodyH, z: d }, "body", R.body),
    // Skivan skjuter ut en centimeter runt om. Det överhänget är hela skillnaden mellan en byrå
    // och en låda: det ger möbeln en kant som fångar ljuset.
    box({ x: 0, y: h - topH / 2, z: 0 }, { x: w + 2, y: topH, z: d + 2 }, "surface", R.top),
  ];
  // Lådfronter som paneler utanpå stommen, var och en med ett handtag. Utan handtagen läser
  // fronterna som fogar i en låda; med dem läser möbeln som en byrå på en meters håll.
  for (let i = 0; i < rows; i++) {
    const rh = bodyH / rows;
    const cy = legH + rh * (i + 0.5);
    boxes.push(box({ x: 0, y: cy, z: d / 2 + 0.9 }, { x: w - 6, y: rh - 3, z: 1.8 }, "panel", R.panel));
    boxes.push(
      box({ x: 0, y: cy, z: d / 2 + 2.4 }, { x: Math.min(w * 0.34, 28), y: 1.9, z: 1.3 }, "leg", 0.9),
    );
  }
  return {
    boxes,
    anchors: {
      top: { point: { x: 0, y: h, z: 0 }, normal: UP },
      front: { point: { x: 0, y: legH + bodyH * 0.55, z: d / 2 + 1.8 }, normal: FRONT },
      "front-upper": { point: { x: 0, y: legH + bodyH * 0.82, z: d / 2 + 1.8 }, normal: FRONT },
      "front-lower": { point: { x: 0, y: legH + bodyH * 0.25, z: d / 2 + 1.8 }, normal: FRONT },
      "side-left": { point: { x: -w / 2, y: legH + bodyH / 2, z: 0 }, normal: LEFT },
      "side-right": { point: { x: w / 2, y: legH + bodyH / 2, z: 0 }, normal: RIGHT },
      "corner-front-left": { point: { x: -w / 2 + 3, y: h, z: d / 2 - 3 }, normal: UP },
      "corner-front-right": { point: { x: w / 2 - 3, y: h, z: d / 2 - 3 }, normal: UP },
      "leg-front-left": { point: { x: -(w / 2 - 7), y: legH / 2, z: d / 2 - 7 }, normal: FRONT },
      "leg-front-right": { point: { x: w / 2 - 7, y: legH / 2, z: d / 2 - 7 }, normal: FRONT },
    },
  };
}

/** Hyllan: gavlar, hyllplan och en tunn ryggskiva. Utan ryggen ser den ut som ett galler. */
function buildShelf(w: number, d: number, h: number, shape: ShapeHints): Built {
  const t = 2.6;
  const shelves = clamp(shape.drawers ?? Math.round(h / 40), 2, 7);
  const boxes: Box[] = [
    box({ x: -w / 2 + t / 2, y: h / 2, z: 0 }, { x: t, y: h, z: d }, "body", R.top),
    box({ x: w / 2 - t / 2, y: h / 2, z: 0 }, { x: t, y: h, z: d }, "body", R.top),
    box({ x: 0, y: h / 2, z: -d / 2 + 0.6 }, { x: w - t * 2, y: h - t, z: 1.2 }, "panel"),
  ];
  for (let i = 0; i <= shelves; i++) {
    boxes.push(
      box({ x: 0, y: (h / shelves) * i + t / 2, z: 0.6 }, { x: w - t * 2, y: t, z: d - 1.2 }, "surface", R.top),
    );
  }
  return {
    boxes,
    anchors: {
      top: { point: { x: 0, y: h, z: 0 }, normal: UP },
      front: { point: { x: 0, y: h * 0.5, z: d / 2 }, normal: FRONT },
      "side-left": { point: { x: -w / 2, y: h * 0.6, z: 0 }, normal: LEFT },
      "side-right": { point: { x: w / 2, y: h * 0.6, z: 0 }, normal: RIGHT },
      "shelf-upper": { point: { x: 0, y: h * 0.75, z: d / 2 - 2 }, normal: UP },
      "shelf-lower": { point: { x: 0, y: h * 0.25, z: d / 2 - 2 }, normal: UP },
    },
  };
}

/** Sängen: ram, madrass och gavel. Höjden är ramens, madrassen ligger ovanpå. */
function buildBed(w: number, d: number, h: number): Built {
  const legH = clamp(h * 0.2, 6, 12);
  const mattressH = Math.max(16, h * 0.4);
  const headH = h + 32;
  const boxes: Box[] = [
    ...legs(w, d, legH, 7, 8),
    box({ x: 0, y: legH + (h - legH) / 2, z: 0 }, { x: w, y: h - legH, z: d }, "body", R.body),
    box({ x: 0, y: h + mattressH / 2, z: 2 }, { x: w - 5, y: mattressH, z: d - 5 }, "cushion", R.cushion * 1.6),
    box({ x: 0, y: (legH + headH) / 2, z: -d / 2 - 2.5 }, { x: w, y: headH - legH, z: 5 }, "panel", R.panel, -0.05),
  ];
  return {
    boxes,
    anchors: {
      top: { point: { x: 0, y: h + mattressH, z: 0 }, normal: UP },
      backrest: { point: { x: 0, y: headH - 10, z: -d / 2 - 2.5 }, normal: FRONT },
      "side-left": { point: { x: -w / 2, y: h, z: 0 }, normal: LEFT },
      "side-right": { point: { x: w / 2, y: h, z: 0 }, normal: RIGHT },
      front: { point: { x: 0, y: h - 4, z: d / 2 }, normal: FRONT },
      "leg-front-left": { point: { x: -(w / 2 - 8), y: legH / 2, z: d / 2 - 8 }, normal: FRONT },
      "leg-front-right": { point: { x: w / 2 - 8, y: legH / 2, z: d / 2 - 8 }, normal: FRONT },
    },
  };
}

function buildBox(w: number, d: number, h: number): Built {
  return {
    boxes: [box({ x: 0, y: h / 2, z: 0 }, { x: w, y: h, z: d }, "body", R.body)],
    anchors: {
      top: { point: { x: 0, y: h, z: 0 }, normal: UP },
      front: { point: { x: 0, y: h / 2, z: d / 2 }, normal: FRONT },
      "side-left": { point: { x: -w / 2, y: h / 2, z: 0 }, normal: LEFT },
      "side-right": { point: { x: w / 2, y: h / 2, z: 0 }, normal: RIGHT },
      "corner-front-left": { point: { x: -w / 2 + 2, y: h, z: d / 2 - 2 }, normal: UP },
      "corner-front-right": { point: { x: w / 2 - 2, y: h, z: d / 2 - 2 }, normal: UP },
    },
  };
}

const BUILDERS: Record<Archetype, (w: number, d: number, h: number, shape: ShapeHints) => Built> = {
  sofa: buildSofa,
  chair: buildChair,
  table: buildTable,
  cabinet: buildCabinet,
  shelf: buildShelf,
  bed: buildBed,
  box: buildBox,
};

const FALLBACK_ZONES: Record<Archetype, string[]> = {
  sofa: ["seat-left", "arm-right", "backrest", "seat-right", "arm-left", "front"],
  chair: ["seat", "backrest", "arm-right", "arm-left", "front"],
  table: ["top-left", "corner-front-right", "top-right", "front", "leg-front-left"],
  cabinet: ["front-upper", "top", "front-lower", "side-right", "corner-front-left"],
  shelf: ["shelf-upper", "side-right", "shelf-lower", "front"],
  bed: ["top", "backrest", "side-right", "front"],
  box: ["front", "top", "side-right", "corner-front-left"],
};

export function buildModel(
  archetype: Archetype,
  dims: Dimensions,
  attributes: ListingAttribute[],
  ctx: ModelContext = {},
): FurnitureModel {
  const shape = parseShape(attributes, ctx, archetype);
  const built = BUILDERS[archetype](dims.width, dims.depth, dims.height, shape);
  return {
    archetype,
    dims,
    boxes: built.boxes,
    anchors: built.anchors,
    palette: paletteFor(archetype, attributes, ctx, shape),
    fallbackZones: FALLBACK_ZONES[archetype].filter((z) => z in built.anchors),
  };
}

// ---- var skadan sitter ----------------------------------------------------

/**
 * Inspektionen beskriver delen på svenska i fri text ("vänster armstöd", "sitsens ovansida"), så
 * placeringen blir en ordtolkning. Träffar den inte fördelas nålen på en ledig zon i stället — en
 * skada som inte går att placera ska ändå SYNAS, bara utan att påstå exakt var.
 *
 * Vänster och höger läses från den som står framför möbeln, samma håll som på bilderna.
 */
export function zoneForPart(part: string, semanticLocation: string, model: FurnitureModel): string | null {
  const t = `${part} ${semanticLocation}`.toLowerCase();
  const left = /vänster|vänstra|left/.test(t);
  const right = /höger|högra|right/.test(t);
  const side = left ? "left" : right ? "right" : null;
  const has = (z: string) => (z in model.anchors ? z : null);

  // "ben\b" och inte "\bben\b": inspektionen skriver "vänster framben", inte "vänster ben".
  if (/ben(et|en)?\b|fot(en)?\b|sockel/.test(t)) {
    const front = /bak|bakre/.test(t) ? "back" : "front";
    return has(`leg-${front}-${side ?? "left"}`) ?? has(`leg-front-${side ?? "left"}`) ?? has("front");
  }
  if (/armstöd|armlän|\barm\b/.test(t)) return has(`arm-${side ?? "right"}`) ?? has("side-right");
  if (/rygg|nackstöd|sänggavel/.test(t)) return has("backrest") ?? has("front");
  if (/sits|sittdyna|dyna|säte/.test(t)) return has(side ? `seat-${side}` : "seat") ?? has("seat") ?? has("top");
  if (/skiva|ovansida|översida|topp|bänkskiva/.test(t)) return has(side ? `top-${side}` : "top") ?? has("top");
  if (/hörn/.test(t)) return has(`corner-front-${side ?? "left"}`) ?? has("top");
  if (/låda|lådfront|dörr|lucka|front/.test(t)) {
    if (/övre|överst/.test(t)) return has("front-upper") ?? has("front");
    if (/nedre|underst/.test(t)) return has("front-lower") ?? has("front");
    return has("front");
  }
  if (/hylla|hyllplan/.test(t)) {
    return (/övre|överst/.test(t) ? has("shelf-upper") : has("shelf-lower")) ?? has("front");
  }
  if (/sida|gavel|kortsida|långsida/.test(t)) return has(`side-${side ?? "right"}`) ?? has("side-right");
  if (/baksida|ryggsida|ryggpanel/.test(t)) return has("backrest") ?? has("side-right");
  if (/kant/.test(t)) return has("corner-front-left") ?? has("top") ?? has("front");
  return null;
}
