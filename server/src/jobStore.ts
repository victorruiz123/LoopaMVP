import path from "node:path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ConditionJob, DebugTrace, FurnitureIdentity, JobProgress } from "./types.js";

export const DATA_DIR = path.resolve(import.meta.dirname, "..", "data");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");

const jobs = new Map<string, ConditionJob>();

export function jobDir(id: string): string {
  return path.join(JOBS_DIR, id);
}

export async function createJob(
  productContext: string | null,
  identity: FurnitureIdentity | null = null,
  ownerId: string | null = null,
): Promise<ConditionJob> {
  const id = randomUUID();
  const job: ConditionJob = {
    id,
    createdAt: new Date().toISOString(),
    ownerId,
    progress: { stage: "queued", message: "I kö…" },
    result: null,
    error: null,
    productContext,
    identity,
  };
  jobs.set(id, job);
  await mkdir(path.join(jobDir(id), "originals"), { recursive: true });
  await persist(job);
  return job;
}

export function getJobSync(id: string): ConditionJob | undefined {
  return jobs.get(id);
}

export async function getJob(id: string): Promise<ConditionJob | undefined> {
  const inMemory = jobs.get(id);
  if (inMemory) return inMemory;
  try {
    const raw = await readFile(path.join(jobDir(id), "job.json"), "utf-8");
    const job = JSON.parse(raw) as ConditionJob;
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

/** Stadier ett jobb kan ligga kvar i utan att någon längre arbetar på det. */
const IN_FLIGHT = new Set(["queued", "preparing", "inspecting", "verifying", "grading", "pricing"]);

/**
 * Jobb som stod mitt i en körning när processen dog.
 *
 * Pipelinen lever i minnet: startar servern om — tsx watch vid en filändring, en krasch, en deploy —
 * dör varje pågående körning tyst, medan job.json på disk står kvar på "inspecting" för alltid.
 * Klienten pollar vidare i evighet på ett jobb ingen längre arbetar med. Det var precis vad som hände
 * 2026-08-28: jobbet skrevs 22:47:23, servern startade om 23:03:39, och skärmen snurrade i 16 minuter.
 *
 * Körs en gång vid uppstart och märker dem som avbrutna, så klienten får ett svar i stället för en
 * spinner. Ett omtag spelar upp samma bildrutor igen — se POST /api/jobs/:id/retry.
 */
export async function failOrphanedJobs(): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await readdir(JOBS_DIR);
  } catch {
    return 0;
  }
  let n = 0;
  for (const id of entries) {
    const job = await getJob(id);
    if (!job || !IN_FLIGHT.has(job.progress.stage)) continue;
    job.error = "Analysen avbröts när servern startades om. Bildrutorna finns kvar — försök igen.";
    job.progress = { stage: "error", message: job.error };
    if (job.identityStatus === "identifying") job.identityStatus = "unavailable";
    await persist(job);
    n += 1;
  }
  return n;
}

export async function listJobs(): Promise<ConditionJob[]> {
  const result: ConditionJob[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(JOBS_DIR);
  } catch {
    return [];
  }
  for (const id of entries) {
    const job = await getJob(id);
    if (job) result.push(job);
  }
  result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return result;
}

export async function updateProgress(id: string, progress: JobProgress): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  // Ö.7: fasövergångar med tidsstämpel och hur länge föregående fas varade. En hängning ska synas i
  // loggen MEDAN den pågår, inte rekonstrueras efteråt ur job.json.
  const now = Date.now();
  const since = job.phaseStartedAt ? now - job.phaseStartedAt : 0;
  console.info(
    `[phase] ${id.slice(0, 8)} ${job.progress.stage} -> ${progress.stage}` +
      (since ? ` (föregående fas ${(since / 1000).toFixed(1)}s)` : ""),
  );
  job.phaseStartedAt = now;
  job.progress = progress;
  await persist(job);
}

/**
 * Vaktar HELA jobbet. Löser ut oavsett fas och oavsett hur många omförsök som pågår.
 *
 * Returnerar en funktion som avbryter vakten när jobbet blir klart av sig självt.
 */
export function watchJobDeadline(id: string, ms: number): () => void {
  const timer = setTimeout(() => {
    void (async () => {
      const job = jobs.get(id) ?? (await getJob(id));
      if (!job) return;
      if (job.progress.stage === "done" || job.progress.stage === "error") return;
      const msg = `Analysen tog längre än ${Math.round(ms / 1000)} s och avbröts. Bildrutorna finns kvar — försök igen.`;
      console.warn(`[deadline] ${id.slice(0, 8)} överskred ${Math.round(ms / 1000)}s i fas ${job.progress.stage}`);
      job.error = msg;
      job.progress = { stage: "error", message: msg };
      if (job.identityStatus === "identifying") job.identityStatus = "unavailable";
      await persist(job);
    })();
  }, ms);
  return () => clearTimeout(timer);
}

export async function completeJob(id: string, result: ConditionJob["result"]): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  // Annonsen kan bli klar innan skickresultatet finns att hänga den på — de två spåren kör
  // parallellt och identifieringen är ofta snabbare. Flytta in den i stället för att tappa den.
  if (result && !result.listing && job.pendingListing) result.listing = job.pendingListing;
  job.result = result;
  job.progress = { stage: "done", message: "Analysen är klar." };
  await persist(job);
}

export async function failJob(id: string, error: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  job.error = error;
  job.progress = { stage: "error", message: error };
  await persist(job);
}

export async function persist(job: ConditionJob): Promise<void> {
  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(path.join(jobDir(job.id), "job.json"), JSON.stringify(job, null, 2), "utf-8");
}

/** Debug trace is written separately from job.json and never sent to the normal seller-facing UI. */
export async function saveDebugTrace(id: string, trace: DebugTrace): Promise<void> {
  await mkdir(jobDir(id), { recursive: true });
  await writeFile(path.join(jobDir(id), "debug.json"), JSON.stringify(trace, null, 2), "utf-8");
}

export async function getDebugTrace(id: string): Promise<DebugTrace | undefined> {
  try {
    const raw = await readFile(path.join(jobDir(id), "debug.json"), "utf-8");
    return JSON.parse(raw) as DebugTrace;
  } catch {
    return undefined;
  }
}
