import type { PriceEstimate } from "../types";

const SEK = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });

export function formatSek(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${SEK.format(value)} kr`;
}

/** "1 500 – 3 000 kr" for the compact places; the result screen shows the three points separately. */
export function formatPriceRange(price: PriceEstimate): string {
  if (price.status !== "ok") return "Inget prisförslag";
  if (price.low === null || price.high === null) return formatSek(price.default);
  return `${SEK.format(price.low)} – ${SEK.format(price.high)} kr`;
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
