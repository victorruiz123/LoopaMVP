import type { PriceEstimate } from "../types";
import { currentLang, t } from "./i18n";

/**
 * Talet skrivs på skärmens språk, valutan gör det inte.
 *
 * "1 600" på svenska och franska, "1,600" på engelska — tusenavskiljaren hör till läsaren. Men
 * enheten är kronor oavsett vem som läser: möbeln säljs i Sverige, och "SEK 1,600" hade varit ett
 * annat påstående än det som står i annonsen. En formaterare per språk, byggd en gång.
 */
const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(): Intl.NumberFormat {
  const lang = currentLang();
  let found = FORMATTERS.get(lang);
  if (!found) {
    found = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
    FORMATTERS.set(lang, found);
  }
  return found;
}

export function formatSek(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${formatter().format(value)} kr`;
}

/** "1 500 – 3 000 kr" for the compact places; the result screen shows the three points separately. */
export function formatPriceRange(price: PriceEstimate): string {
  if (price.status !== "ok") return t("Inget prisförslag");
  if (price.low === null || price.high === null) return formatSek(price.default);
  return `${formatter().format(price.low)} – ${formatter().format(price.high)} kr`;
}

export const CONFIDENCE_LABELS: Record<string, string> = {
  high: "Hög säkerhet",
  medium: "Medelhög säkerhet",
  low: "Låg säkerhet",
  none: "Ingen säkerhet",
};

/** The price engine's own valuation sources, in seller-facing Swedish. */
export const DEDUCTION_SOURCE_LABELS: Record<string, string> = {
  table: "Uppmätt avdrag",
  estimated_repair: "Uppskattad lagningskostnad",
  below_materiality: "För liten för att påverka priset",
  no_valuation: "Kunde inte värderas",
};

/**
 * Prismotorns möbeltyper kommer tillbaka ASCII-foldade — den normaliserar all text vid inläsningen, så
 * `hörnsoffa` blir `hornsoffa`. Rått i en säljarvy ser det ut som en bugg ("baddsoffa, hornsoffa"), så
 * de fälls tillbaka mot motorns egen etikettlista (GET /variants).
 */
const VARIANT_LABELS = [
  "bäddsoffa", "hörnsoffa", "matgrupp", "matbord", "soffa", "fotpall", "fåtölj",
  "stol", "sänggavel", "säng", "byrå", "hylla", "spegel", "bord", "okänd",
];

const BY_FOLDED = new Map(
  VARIANT_LABELS.map((label) => [label.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""), label]),
);

export function variantLabel(variant: string): string {
  return BY_FOLDED.get(variant) ?? variant;
}
