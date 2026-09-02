import type { GeneratedListing } from "../types";

/**
 * Marknadsvärdet för en inklistrad annons.
 *
 * Hämtas ur ANNONSKORTET, inte ur `job.result.price`. Prismotorn som säljaren möter körs som ett
 * steg efter besiktningen, och köparens jobb har ingen besiktning — `skipGrading` ser till det. Att
 * läsa `job.result.price` här gav därför en skimrande platshållare som aldrig fylldes i, trots att
 * spannet låg färdigt i kortet hela tiden.
 *
 * Spannet gäller MODELLEN i normalt begagnat skick. Det är just därför det får visas för en köpare
 * som inte sett möbeln: det säger inget om exemplaret, och utger sig inte för att göra det.
 */
export interface MarketValue {
  low: number | null;
  high: number | null;
  retail: number | null;
  /** Sant när kortet har ett spann. Falskt = vi vet inte, och ska säga det rakt ut. */
  known: boolean;
}

export function marketValue(card: GeneratedListing | null): MarketValue {
  const p = card?.pricing;
  const low = p?.priceRangeMinSek ?? null;
  const high = p?.priceRangeMaxSek ?? null;
  return { low, high, retail: p?.retailPriceSek ?? null, known: low !== null && high !== null };
}

/** Är det begärda priset rimligt? Null när något av talen saknas — då sägs ingenting alls. */
export function verdictFor(askingPriceSek: number | null, { low, high }: MarketValue) {
  if (askingPriceSek === null || low === null || high === null) return null;
  if (askingPriceSek < low) return { tone: "under", text: "Priset ligger under marknadsvärdet." };
  if (askingPriceSek > high) return { tone: "over", text: "Priset ligger över marknadsvärdet." };
  return { tone: "inom", text: "Priset ligger inom marknadsvärdet." };
}
