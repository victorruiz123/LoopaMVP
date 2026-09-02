/**
 * Skyddsnätet: pris och mått lästa ur meningen när tolkningen tappade dem.
 *
 * FYLLER BARA LUCKOR. Ett fält modellen redan satt rörs aldrig — nätet kan lägga till, inte
 * överpröva. Modellen ser sammanhang som ett mönster aldrig kommer åt ("en tvåsitssoffa till
 * hallen"), och att låta regexen vinna hade bytt ett bra svar mot ett grovt.
 *
 * VILKA FÄLT OCH VARFÖR. Pris och mått först: de är de HÅRDA gränserna, de som aldrig får brytas, och
 * tappas de visar vi möbler köparen inte har råd med eller inte får in genom dörren. Färg och
 * material kom till efteråt, av ett annat skäl: mätt skarpt föll "grön" bort ur meningen "grön
 * sammetssoffa max 6000 kr" två körningar av tre. Sammanfattningen förblev ärlig — den nämner bara
 * det vi faktiskt filtrerar på — men köparen som skrev "grön" och fick sex soffor utan färgkrav har
 * ändå inte blivit hörd.
 *
 * Stil och epok lämnas åt modellen. "60-tal", "funkis", "lantligt" är en öppen mängd, och en ordlista
 * över dem hade varit en gissning om vad folk säger snarare än en avläsning av vad de sa.
 *
 * MÖNSTREN ÄR SNÄVA MED FLIT. "3-sits" är inte ett pris och "60-tal" är inte en bredd; ett generöst
 * mönster hade hittat båda. Varje tal måste bäras av ett ord som gör det till vad det är.
 */

import type { ProductFilter } from "../butik/types.js";

/** Siffergrupper med mellanslag eller punkt: "6000", "6 000", "6.000". */
const NUM = "(\\d[\\d\\s.]{0,7}\\d|\\d)";

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/[\s.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pristaket.
 *
 * Kräver ETT av två stöd: ett gränsord före talet ("max", "budget", "upp till"), eller "kr" efter
 * det. Utan stöd är ett tal i en möbelmening lika ofta ett antal sitsar som ett pris.
 */
export function readMaxPrice(text: string): number | null {
  const t = text.toLowerCase();
  /**
   * Ett tal som följs av en LÄNGDENHET är ett mått, inte ett pris.
   *
   * Utan den spärren läste "ekbord max 160 cm" bordets bredd som dess pristak — gränsordet "max"
   * bar talet, valutan var frivillig, och 160 låg inom det rimliga prisintervallet. Mätt skarpt.
   */
  const notLength = `(?!\\s*(?:cm|mm|centimeter|meter|m\\b))`;
  const bounded = new RegExp(
    `(?:max(?:imalt)?|högst|upp till|under|budget(?:\\s*på)?|för)\\s*${NUM}${notLength}\\s*(?:kr|:-|kronor)?`,
    "i",
  );
  const withCurrency = new RegExp(`${NUM}\\s*(?:kr\\b|:-|kronor)`, "i");

  for (const re of [bounded, withCurrency]) {
    const m = re.exec(t);
    const n = m ? toNumber(m[1]) : null;
    // Ett rimligt möbelpris. 50 kr är en krok, 2 000 000 är ett skrivfel — båda är sannolikt något
    // annat än ett pristak, och ett felläst tak är värre än inget.
    if (n !== null && n >= 100 && n <= 200_000) return n;
  }
  return null;
}

/**
 * Ett mått i millimeter, buret av ett riktningsord. "220 cm bred" och "bredd 220 cm" är samma sak.
 *
 * ORDGRÄNSERNA ÄR INTE KOSMETIK. Utan dem matchade "hög" inuti "högst", och meningen "…max 6000 kr
 * och högst 220 cm bred" gav både bredd OCH höjd 220 cm — ur ett ord som betyder "som mest". Mätt
 * skarpt. Svenska gränsen skrivs för hand: \b i JavaScript räknar å, ä och ö som icke-bokstäver och
 * hade brutit mitt i "höjden".
 */
function readDimension(text: string, words: string[]): number | null {
  const t = text.toLowerCase();
  const w = `(?<![a-zåäö])(?:${words.join("|")})(?![a-zåäö])`;
  const after = new RegExp(`${NUM}\\s*(?:cm|centimeter)\\s*${w}`, "i");
  // 16 tecken emellan, inte 12: "höjden får vara max 200 cm" har fjorton. Fortfarande snävt nog att
  // ett riktningsord inte kan plocka ett tal ur nästa sats.
  const before = new RegExp(`${w}[^\\d]{0,16}${NUM}\\s*(?:cm|centimeter)`, "i");
  const meters = new RegExp(`(\\d(?:[.,]\\d)?)\\s*(?:m|meter)\\s*${w}`, "i");

  for (const re of [after, before]) {
    const m = re.exec(t);
    const n = m ? toNumber(m[1]) : null;
    // 20–400 cm: under det är det en detalj, över det är det ett rum.
    if (n !== null && n >= 20 && n <= 400) return Math.round(n * 10);
  }
  const mm = meters.exec(t);
  if (mm) {
    const n = Number(mm[1].replace(",", "."));
    if (Number.isFinite(n) && n >= 0.2 && n <= 4) return Math.round(n * 1000);
  }
  return null;
}

export function readMaxWidth(text: string): number | null {
  return readDimension(text, ["bred", "bredd", "brett", "bredden"]);
}
export function readMaxDepth(text: string): number | null {
  return readDimension(text, ["djup", "djupt", "djupet"]);
}
export function readMaxHeight(text: string): number | null {
  return readDimension(text, ["hög", "höjd", "högt", "höjden"]);
}

/**
 * Färgord som folk faktiskt skriver om möbler.
 *
 * SLUTEN LISTA med flit. Ett öppet mönster ("ordet före 'soffa'") hade plockat "begagnad", "stor"
 * och "fin" som färger. Sammansättningar fångas av matchningens delsträngsjämförelse: "mörkgrön"
 * i en annons svarar på "grön" här, och tvärtom.
 */
const COLORS = [
  "vit", "svart", "grå", "beige", "brun", "blå", "grön", "gul", "röd", "rosa",
  "orange", "lila", "turkos", "petrol", "sand", "creme", "krämvit", "antracit",
];

/** Material likaså: en sluten lista över det möbler faktiskt är gjorda av. */
const MATERIALS = [
  "sammet", "tyg", "skinn", "läder", "ek", "björk", "furu", "teak", "valnöt",
  "ask", "plywood", "rotting", "metall", "stål", "glas", "marmor", "linne", "bouclé",
];
/*
 * "bok" och "al" är borta ur listan med flit. Båda är riktiga träslag och båda är för dyra att ha
 * med: "bokhylla" är inte gjord av bok och "alltid" är inte gjort av al. En träffbild där var
 * fjärde efterlysning får ett påhittat materialkrav är sämre än att missa de få som verkligen
 * söker bok.
 */

/**
 * Orden ur en mening. Sammansättningar räknas — men inte alla ord tål att sitta i en.
 *
 * TVÅ REGLER, och skillnaden går vid ordlängd. Ett långt ord som "sammet" eller "marmor" kan stå var
 * som helst i en sammansättning utan att bli något annat: "sammetssoffa" är sammet, "ekbordsskiva"
 * är ek. Ett kort ord kan det inte — "ek" sitter i "ekonomi", "al" i "alltid", "bok" i "bokning" —
 * och de måste därför stå som eget ord eller först i en sammansättning vi kan känna igen.
 *
 * Mätt skarpt: utan sammansättningsregeln tappade "grön sammetssoffa" sitt material, och med en
 * för generös regel blev "ekonomiskt matbord" ett bord i ek.
 */
const SHORT_WORD = 4;

function wordsIn(text: string, vocabulary: string[], kind: "color" | "material"): string[] {
  const t = text.toLowerCase();
  const hits = vocabulary.filter((w) => {
    let re: RegExp;
    if (kind === "color") {
      /**
       * Färger böjs, de sitter inte i sammansättningar.
       *
       * "mörkblått" är blå; "vitrinskåp" är inte vitt. Skillnaden är att svenska färgord tar en
       * handfull böjningsändelser — t, tt, a, e — och ingenting annat. Att i stället tillåta vilka
       * bokstäver som helst efter ordet hade gjort varje vitrinskåp vitt.
       */
      re = new RegExp(`(?<![a-zåäö])(?:mörk|ljus|klar)?${w}(?:tt|t|a|e)?(?![a-zåäö])`, "i");
    } else if (w.length >= SHORT_WORD) {
      // Långt material: får inledas och följas fritt. "sammetssoffa" är sammet, "marmorbord" marmor.
      re = new RegExp(`(?<![a-zåäö])[a-zåäö]{0,6}${w}`, "i");
    } else {
      // Kort material: eget ord, eller först i en sammansättning med en möbeldel efter sig.
      re = new RegExp(`(?<![a-zåäö])${w}(?![a-zåäö])|(?<![a-zåäö])${w}(?=(?:bord|stol|skåp|säng|soffa|skiva|ben|fanér))`, "i");
    }
    return re.test(t);
  });
  return [...new Set(hits)];
}

/** Fyller luckorna i ett filter. Returnerar en kopia — anroparens filter rörs inte. */
export function fillHardFields(filter: ProductFilter, text: string): ProductFilter {
  const out: ProductFilter = { ...filter };
  const missing = (v: number | null | undefined) => v === null || v === undefined;

  if (missing(out.maxPriceSek)) {
    const p = readMaxPrice(text);
    if (p !== null) out.maxPriceSek = p;
  }
  if (missing(out.maxWidthMm)) {
    const w = readMaxWidth(text);
    if (w !== null) out.maxWidthMm = w;
  }
  if (missing(out.maxDepthMm)) {
    const d = readMaxDepth(text);
    if (d !== null) out.maxDepthMm = d;
  }
  if (missing(out.maxHeightMm)) {
    const h = readMaxHeight(text);
    if (h !== null) out.maxHeightMm = h;
  }
  if (!out.colors?.length) {
    const c = wordsIn(text, COLORS, "color");
    if (c.length) out.colors = c;
  }
  if (!out.materials?.length) {
    const m = wordsIn(text, MATERIALS, "material");
    if (m.length) out.materials = m;
  }
  return out;
}
