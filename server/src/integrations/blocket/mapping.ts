/**
 * Loopas fält -> Blockets formulärfält.
 *
 * Allt här är rent: inga anrop, ingen webbläsare, inget filsystem. Det är med flit — det som går fel
 * i en publicering är nästan alltid en översättning ("vilket löv heter det egentligen?"), och en
 * översättning som kräver en inloggad browser för att provas blir aldrig provad.
 */

import type { ConditionGrade } from "../../types.js";

/**
 * Blockets VERKLIGA kategoriträd för möbler.
 *
 * Uppmätt ur 60 000 skördade annonser (`blocket-harvester`, fältet `category_path`), inte gissat och
 * inte kopierat. Det spelar roll: v40:s BLOCKET_CATEGORY_MAP i Vips railway-proxy innehåller lövnamn
 * som inte finns hos Blocket — "Matstolar" (heter "Stolar och pallar"), "Sovrum" (heter "Sängar och
 * madrasser"), "Förvaring" (heter "Garderober och förvaring"). Ett fel lövnamn ger ingen krasch:
 * matchningen i formuläret väljer något annat, och annonsen hamnar i fel kategori utan att någon får
 * veta det.
 *
 * Ligger kvar som exporterad konstant fastän kaskaden nedan är det som körs: den är facit när någon
 * undrar om ett lövnamn finns, och testet som vaktar att CATEGORY_BY_SLUG bara pekar på verkliga löv
 * läser den.
 */
export const BLOCKET_TREE: Record<string, string[]> = {
  "Soffor och fåtöljer": ["Soffor", "Fåtöljer", "Soffgrupper", "Hörnsoffor", "Bäddsoffor", "Sittpuffar"],
  "Bord och stolar": [
    "Stolar och pallar",
    "Soffbord",
    "Matbord",
    "Matgrupper",
    "Skrivbord",
    "Kontorsstolar",
    "Övriga bord och stolar",
  ],
  "Hyllor och byråer": ["Hyllor", "TV- och mediamöbler", "Byråer", "Sideboards", "Sängbord"],
  "Garderober och förvaring": ["Skåp", "Hyllsystem", "Garderober"],
  "Sängar och madrasser": ["Sängar", "Madrasser", "Rammadrasser"],
  "Övriga möbler och inredning": [],
  "Dekoration och prydnader": ["Tavlor och ramar", "Övriga prydnader"],
  "Mattor och textilier": [],
  Lampor: [],
};

/** Blockets tre nivåer. De två översta är obligatoriska; lövet finns inte för alla grenar. */
export interface BlocketCategory {
  main: string;
  sub: string | null;
  /** Lövet. Null när Blocket inte har någon nivå tre för underkategorin. */
  product: string | null;
}

const MAIN = "Möbler och inredning";

/**
 * Loopas nio butikskategorier (`butik/catalog.ts`) -> Blocket.
 *
 * Grovt med flit. `bord` blir "Övriga bord och stolar" och inte "Matbord", för en slug som täcker
 * både matbord, soffbord och sidobord vet inte vilket det är — och en gissning som råkar bli fel är
 * sämre än ett löv som är rätt men brett. Titelordlistan nedan skärper det när den kan.
 */
export const CATEGORY_BY_SLUG: Record<string, BlocketCategory> = {
  soffor: { main: MAIN, sub: "Soffor och fåtöljer", product: "Soffor" },
  fatoljer: { main: MAIN, sub: "Soffor och fåtöljer", product: "Fåtöljer" },
  bord: { main: MAIN, sub: "Bord och stolar", product: "Övriga bord och stolar" },
  stolar: { main: MAIN, sub: "Bord och stolar", product: "Stolar och pallar" },
  forvaring: { main: MAIN, sub: "Hyllor och byråer", product: "Hyllor" },
  sangar: { main: MAIN, sub: "Sängar och madrasser", product: "Sängar" },
  "skrivbord-kontor": { main: MAIN, sub: "Bord och stolar", product: "Skrivbord" },
  belysning: { main: MAIN, sub: "Lampor", product: null },
  ovrigt: { main: MAIN, sub: "Övriga möbler och inredning", product: null },
};

/**
 * Ord i rubriken som pekar ut ett smalare löv än slugen gör.
 *
 * Längsta träffen vinner, så "bäddsoffa" slår "soffa" och "soffbord" slår "bord". Listan läses bara
 * när den inte motsäger slugen: en möbel som Loopa kategoriserat som `sangar` ska inte hamna bland
 * soffor för att ordet "soffa" råkar stå i beskrivningen av tyget.
 */
const TITLE_WORDS_UNSORTED: Array<[string, BlocketCategory]> = [
  ["bäddsoffa", { main: MAIN, sub: "Soffor och fåtöljer", product: "Bäddsoffor" }],
  ["hörnsoffa", { main: MAIN, sub: "Soffor och fåtöljer", product: "Hörnsoffor" }],
  ["soffgrupp", { main: MAIN, sub: "Soffor och fåtöljer", product: "Soffgrupper" }],
  ["sittpuff", { main: MAIN, sub: "Soffor och fåtöljer", product: "Sittpuffar" }],
  ["puff", { main: MAIN, sub: "Soffor och fåtöljer", product: "Sittpuffar" }],
  ["fåtölj", { main: MAIN, sub: "Soffor och fåtöljer", product: "Fåtöljer" }],
  ["soffbord", { main: MAIN, sub: "Bord och stolar", product: "Soffbord" }],
  ["matbord", { main: MAIN, sub: "Bord och stolar", product: "Matbord" }],
  ["matgrupp", { main: MAIN, sub: "Bord och stolar", product: "Matgrupper" }],
  ["skrivbord", { main: MAIN, sub: "Bord och stolar", product: "Skrivbord" }],
  ["kontorsstol", { main: MAIN, sub: "Bord och stolar", product: "Kontorsstolar" }],
  ["barstol", { main: MAIN, sub: "Bord och stolar", product: "Stolar och pallar" }],
  ["pinnstol", { main: MAIN, sub: "Bord och stolar", product: "Stolar och pallar" }],
  ["sängbord", { main: MAIN, sub: "Hyllor och byråer", product: "Sängbord" }],
  ["nattduksbord", { main: MAIN, sub: "Hyllor och byråer", product: "Sängbord" }],
  ["sideboard", { main: MAIN, sub: "Hyllor och byråer", product: "Sideboards" }],
  ["tv-bänk", { main: MAIN, sub: "Hyllor och byråer", product: "TV- och mediamöbler" }],
  ["mediamöbel", { main: MAIN, sub: "Hyllor och byråer", product: "TV- och mediamöbler" }],
  ["byrå", { main: MAIN, sub: "Hyllor och byråer", product: "Byråer" }],
  ["bokhylla", { main: MAIN, sub: "Hyllor och byråer", product: "Hyllor" }],
  ["hyllsystem", { main: MAIN, sub: "Garderober och förvaring", product: "Hyllsystem" }],
  ["garderob", { main: MAIN, sub: "Garderober och förvaring", product: "Garderober" }],
  ["skåp", { main: MAIN, sub: "Garderober och förvaring", product: "Skåp" }],
  ["madrass", { main: MAIN, sub: "Sängar och madrasser", product: "Madrasser" }],
  ["säng", { main: MAIN, sub: "Sängar och madrasser", product: "Sängar" }],
  ["spegel", { main: MAIN, sub: "Dekoration och prydnader", product: "Övriga prydnader" }],
  ["tavla", { main: MAIN, sub: "Dekoration och prydnader", product: "Tavlor och ramar" }],
  ["matta", { main: MAIN, sub: "Mattor och textilier", product: null }],
  ["lampa", { main: MAIN, sub: "Lampor", product: null }],
];

/** Längsta ordet först, så att "bäddsoffa" prövas före "soffa" och "soffbord" före "bord". */
const TITLE_WORDS = [...TITLE_WORDS_UNSORTED].sort((a, b) => b[0].length - a[0].length);

/** Fallbacken när Loopa inte har någon kategori alls. Bred, men aldrig fel. */
export const UNKNOWN_CATEGORY: BlocketCategory = { main: MAIN, sub: "Övriga möbler och inredning", product: null };

/**
 * Väljer Blocket-kategori ur Loopas slug, skärpt med rubriken.
 *
 * Rubriken får bara skärpa INOM samma underkategori, aldrig flytta möbeln till en annan. Slugen är
 * satt av besiktningen och är den starkare uppgiften; rubriken är säljande text som gärna nämner vad
 * möbeln passar till ("fåtölj till soffgruppen").
 */
export function blocketCategoryFor(categorySlug: string | null | undefined, title = ""): BlocketCategory {
  const base = (categorySlug && CATEGORY_BY_SLUG[categorySlug]) || null;
  const text = title.toLowerCase();
  const hit = TITLE_WORDS.find(([word]) => text.includes(word))?.[1] ?? null;

  if (!base) return hit ?? UNKNOWN_CATEGORY;
  if (!hit) return base;
  return hit.sub === base.sub ? hit : base;
}

/**
 * Loopas skicksträng -> etiketterna i Blockets skick-dropdown, i fallande träffsäkerhet.
 *
 * Första strängen i varje lista är Blockets egen etikett, avläst ur deras söktjänsts skickfilter.
 * Resten är varianter som railway-proxyn samlat på sig under fyrtio versioner — Blocket har skrivit
 * om etiketterna minst en gång, och listan är billigare än ett fel som bara syns i efterhand.
 */
export const BLOCKET_CONDITION_OPTIONS: Record<string, string[]> = {
  Nyskick: ["Nytt skick - helt ny", "Nytt skick", "Ny", "Oanvänd", "Nyskick"],
  "Mycket bra skick": ["Mycket bra skick - som ny", "Använt skick - mycket bra", "Mycket bra skick", "Mycket bra", "Nästan ny"],
  "Bra skick": ["Bra skick - varsamt använd", "Använt skick - bra", "Bra skick", "Bra", "Gott skick"],
  "Okej skick": ["Okej skick - synligt använd", "Använt skick - acceptabelt", "Okej skick", "Acceptabelt", "OK skick"],
};

/**
 * Loopas betyg -> Loopas egen skicksträng, som i sin tur har sina Blocket-etiketter ovan.
 *
 * Samma försiktighet som Tradera-mappningen: A blir inte "Nyskick". Nyskick är ett påstående om
 * möbelns historia, och en besiktning av bilder kan aldrig belägga att något aldrig använts.
 */
export const BLOCKET_CONDITION: Record<ConditionGrade, string> = {
  A: "Mycket bra skick",
  B: "Mycket bra skick",
  C: "Bra skick",
  D: "Okej skick",
  E: "Okej skick",
  F: "Okej skick",
};

/** Etiketterna att prova för ett skick, eller skicket självt om det säger något oväntat. */
export function conditionOptions(condition: string | null | undefined): string[] {
  if (!condition) return [];
  return BLOCKET_CONDITION_OPTIONS[condition] ?? [condition];
}

/** Blockets rubrikfält. Längre text kapas tyst av sajten — vi vill veta att det sker. */
export const TITLE_MAX = 50;

/** Blockets uppladdare tar åtta bilder. Loopa producerar högst sex, så taket biter sällan. */
export const MAX_BLOCKET_IMAGES = 8;

/**
 * Kapar rubriken till Blockets gräns, helst vid ett ordslut.
 *
 * En rubrik som slutar mitt i ett ord ("Sits Impulse fåtölj i mycket bra sk") ser ut som ett fel hos
 * säljaren, inte hos sajten. Finns inget mellanslag att kapa vid inom rimligt avstånd kapas den hårt
 * — en hårt kapad rubrik är fortfarande bättre än ingen annons.
 */
export function capTitle(title: string, max = TITLE_MAX): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= max - 15) return cut.slice(0, lastSpace).replace(/[\s,;:-]+$/, "");
  return cut.trim();
}

/** Måtten som Blockets formulär vill ha dem: hela centimeter, ett fält per riktning. */
export interface BlocketMeasurements {
  height: number | null;
  width: number | null;
  depth: number | null;
}

/**
 * Millimeter (Loopas enhet) -> hela centimeter (Blockets fält).
 *
 * Avrundas, inte trunkeras: 1995 mm är 200 cm för en möbel, inte 199.
 *
 * UPPSKATTADE MÅTT SKRIVS INTE UT. `dimensions.estimated` betyder att minst ett mått är en schablon
 * för möbeltypen och inte en uppgift om just den här möbeln. I Loopas eget kort står det som en
 * uppskattning; i ett Blocket-fält finns ingen sådan reservation — där blir schablonen ett påstående
 * säljaren får stå för. Hellre tomma fält.
 */
export function measurementsFrom(
  dimensions:
    | { widthMm: number | null; depthMm: number | null; heightMm: number | null; estimated?: boolean }
    | null
    | undefined,
): BlocketMeasurements {
  if (!dimensions || dimensions.estimated) return { height: null, width: null, depth: null };
  const cm = (mm: number | null | undefined): number | null =>
    typeof mm === "number" && Number.isFinite(mm) && mm > 0 ? Math.round(mm / 10) : null;
  return { height: cm(dimensions.heightMm), width: cm(dimensions.widthMm), depth: cm(dimensions.depthMm) };
}
