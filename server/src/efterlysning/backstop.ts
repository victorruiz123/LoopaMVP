/**
 * Skyddsnätet: pris och mått lästa ur meningen när tolkningen tappade dem.
 *
 * FYLLER BARA LUCKOR. Ett fält modellen redan satt rörs aldrig — nätet kan lägga till, inte
 * överpröva. Modellen ser sammanhang som ett mönster aldrig kommer åt ("en tvåsitssoffa till
 * hallen"), och att låta regexen vinna hade bytt ett bra svar mot ett grovt.
 *
 * VARFÖR JUST DE HÄR TVÅ FÄLTEN. Pris och mått är efterlysningens HÅRDA gränser — de som aldrig får
 * brytas, ens i det generösa svepet. Tappas de visar vi möbler köparen inte har råd med eller inte
 * får in genom dörren, vilket är precis det fel matchningen finns för att undvika. Färg och stil är
 * mjuka: tappas de blir träffarna sämre rankade, inte fel. Mätt skarpt föll "max 6000 kr och högst
 * 220 cm bred" bort ur en mening där kategorin togs rätt.
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
  const bounded = new RegExp(`(?:max(?:imalt)?|högst|upp till|under|budget(?:\\s*på)?|för)\\s*${NUM}\\s*(?:kr|:-|kronor)?`, "i");
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
  return out;
}
