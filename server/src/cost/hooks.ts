/**
 * Anslutningen mellan de låga anropslagren och kostnadsboken.
 *
 * Forskningslagret (research/geminiInteractions.ts), besiktningens anropare (gemini.ts) och annonsgeneratorn
 * (loopa-landing-page-main/functions/api/_shared/gemini.ts) vet inget om jobb. De rapporterar vad ett anrop kostade till en mottagare
 * som sätts utifrån — cost/jobCost.ts sätter den och knyter posten till det jobb som anropet körs inom. Utan mottagare (ett mätskript, ett
 * test) händer ingenting.
 *
 * En egen liten modul, utan beroenden, för att forskningslagret inte ska behöva dra in jobblagret för att kunna rapportera ett öre.
 */

import type { CostEntry } from "./ledger.js";

export type UsageReport = Omit<CostEntry, "at" | "stage"> & { stage?: CostEntry["stage"] };
export type UsageSink = (report: UsageReport) => void;

let sink: UsageSink | null = null;

export function setUsageSink(next: UsageSink | null): void {
  sink = next;
}

/** Rapportera ett betalt anrop. Fel hos mottagaren får aldrig nå anropet som rapporterar. */
export function reportUsage(report: UsageReport): void {
  try {
    sink?.(report);
  } catch (err) {
    console.warn(`[kostnad] kunde inte skriva posten: ${err instanceof Error ? err.message : String(err)}`);
  }
}
