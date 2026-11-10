/**
 * Kostnadsboken per jobb: var posterna skrivs, och hur budgeten läses.
 *
 * `withCostScope({ jobId, stage })` lägger jobbet (och steget) i den asynkrona kontexten. Allt som körs inom — också det som startas med
 * `void` och väntas in av ingen — rapporterar sina anrop dit via cost/hooks.ts, och mottagaren här skriver posten på rätt jobb. Det gör att de
 * låga anropslagren inte behöver bära ett jobb-id genom varje signatur.
 *
 * Posterna ligger på jobbet (`job.cost`) och överlever en omstart. Budgeten läses på samma ställe som den skrivs: ett steg frågar
 * `allowanceFor` precis innan det startar ett betalt anrop.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getJobSync, getJob, persist } from "../jobStore.js";
import { setUsageSink, type UsageReport } from "./hooks.js";
import {
  ATTEMPT_TARGET_SEK,
  budgetStatus,
  byStage,
  newJobCost,
  searchAllowance,
  spentSek,
  usdToSek,
  type Allowance,
  type CostEntry,
  type CostStage,
  type JobCost,
} from "./ledger.js";

export interface CostScope {
  jobId: string;
  stage?: CostStage;
}

const store = new AsyncLocalStorage<CostScope>();

/** Kör `fn` med jobbet (och steget) i kontexten. Kapslade anrop kan byta steg men behåller jobbet. */
export function withCostScope<T>(scope: CostScope, fn: () => T): T {
  const outer = store.getStore();
  return store.run({ jobId: scope.jobId, stage: scope.stage ?? outer?.stage }, fn);
}

export const currentCostScope = (): CostScope | undefined => store.getStore();

/** Jobbets bok, skapad vid första behovet. */
export async function costOf(jobId: string): Promise<JobCost | null> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return null;
  job.cost ??= newJobCost();
  return job.cost;
}

/** Skriv en post på ett jobb. Läggs till i minnet direkt (så att nästa tillåtelse ser den) och sparas därefter. */
export async function recordCost(jobId: string, report: UsageReport): Promise<void> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;
  job.cost ??= newJobCost();
  const entry: CostEntry = { ...report, stage: report.stage ?? "other", at: Date.now() };
  job.cost.entries.push(entry);
  await persist(job);
  const sek = usdToSek(entry.usd, job.cost.usdSek);
  console.info(
    `[kostnad] ${jobId.slice(0, 8)} ${entry.stage}/${entry.label} ${entry.model} ≈${sek.toFixed(2)} SEK` +
      `${entry.searchQueries ? ` (${entry.searchQueries} sökfrågor)` : ""}${entry.estimated ? " uppskattad" : ""}${entry.ok ? "" : " FÖLL"}` +
      ` — omgången hittills ${spentSek(job.cost).toFixed(2)} av ${job.cost.budgetSek.toFixed(2)} SEK`,
  );
}

/** Mottagaren som de låga lagren rapporterar till. Utanför ett scope finns inget jobb att skriva på. */
setUsageSink((report) => {
  const scope = store.getStore();
  if (!scope) return;
  void recordCost(scope.jobId, { ...report, stage: report.stage ?? scope.stage }).catch((err) =>
    console.warn(`[kostnad] ${scope.jobId.slice(0, 8)} kunde inte skriva posten: ${err instanceof Error ? err.message : String(err)}`),
  );
});

/** Tillåtelsen för ett sökande steg, ur jobbets bok. Utan jobb (ett mätskript) gäller hela budgeten. */
export async function allowanceFor(jobId: string | null | undefined, stage: "identify" | "specs"): Promise<Allowance> {
  const cost = jobId ? await costOf(jobId) : null;
  return searchAllowance(cost ?? newJobCost(), stage);
}

/** Läget i korthet, för loggen och för klienten. */
export function costSummary(cost: JobCost | undefined): {
  budgetSek: number;
  /** Det affärsmässiga målet (≈2,00 SEK) och om omgången gått över det. Målet rapporteras; säkerhetsbudgeten är det som stoppar. */
  targetSek: number;
  overTarget: boolean;
  spentSek: number;
  status: ReturnType<typeof budgetStatus>;
  stages: Record<string, { sek: number; searchQueries: number; calls: number }>;
} {
  const c = cost ?? newJobCost();
  const stages: Record<string, { sek: number; searchQueries: number; calls: number }> = {};
  for (const [name, s] of Object.entries(byStage(c))) stages[name] = { sek: Math.round(s.sek * 1000) / 1000, searchQueries: s.searchQueries, calls: s.calls };
  const spent = Math.round(spentSek(c) * 1000) / 1000;
  return { budgetSek: c.budgetSek, targetSek: ATTEMPT_TARGET_SEK, overTarget: spent > ATTEMPT_TARGET_SEK, spentSek: spent, status: budgetStatus(c), stages };
}
