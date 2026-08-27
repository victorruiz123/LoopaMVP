import path from "node:path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ConditionJob, DebugTrace, JobProgress } from "./types.js";

export const DATA_DIR = path.resolve(import.meta.dirname, "..", "data");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");

const jobs = new Map<string, ConditionJob>();

export function jobDir(id: string): string {
  return path.join(JOBS_DIR, id);
}

export async function createJob(productContext: string | null): Promise<ConditionJob> {
  const id = randomUUID();
  const job: ConditionJob = {
    id,
    createdAt: new Date().toISOString(),
    progress: { stage: "queued", message: "I kö…" },
    result: null,
    error: null,
    productContext,
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
  job.progress = progress;
  await persist(job);
}

export async function completeJob(id: string, result: ConditionJob["result"]): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
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
