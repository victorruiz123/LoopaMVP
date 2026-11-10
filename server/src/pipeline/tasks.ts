/**
 * Jobbets uppgifter och deras lägen — det klienten läser för att visa det som finns när det finns.
 *
 * Fyra uppgifter, med de beroenden som är sanna:
 *
 *   condition   skicket ur bilderna            — beror på ingenting, startar vid uppladdningen
 *   identify    modellförslag ur bilder + märke — beror på ingenting, startar vid uppladdningen, parallellt med skicket
 *   specs       mått, material och annonstext   — beror på en BEKRÄFTAD modell (säljarens val eller ett handskrivet namn)
 *   price       prisförslaget                   — beror på modellen OCH skicket
 *
 * Ingen uppgift fabricerar data för att se oberoende ut: \`specs\` och \`price\` står som \`pending\` tills modellen är bekräftad.
 *
 * REGLER SOM HÅLLER LÄGENA ÄRLIGA:
 *  - Ett slutläge (completed / failed / cancelled) skrivs inte över av ett sent svar. Det som ska göras om, gör om (\`restart\`) uttryckligen:
 *    ett omtag av identifieringen, ett nytt modellval.
 *  - En uppgift som faller tar inte de andras resultat med sig — varje uppgift har sitt eget läge och sin egen orsak.
 *  - Lägena ligger på jobbet och överlever en omstart; \`failOrphanedJobs\` (jobStore.ts) märker det som stod och körde när processen dog.
 */

import { getJob, getJobSync, persist } from "../jobStore.js";
import type { JobTask, TaskName, TaskStatus } from "../types.js";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
export const isTerminalStatus = (s: TaskStatus | undefined): boolean => !!s && TERMINAL.has(s);

/**
 * Pure övergång: nästa läge för en uppgift, eller `null` när övergången inte ska ske (ett sent svar på en redan avslutad uppgift).
 */
export function nextTask(current: JobTask | undefined, status: TaskStatus, opts: { note?: string | null; restart?: boolean } = {}, now = Date.now()): JobTask | null {
  if (current && isTerminalStatus(current.status) && !opts.restart) return null;
  const base: JobTask = opts.restart || !current ? { status } : { ...current, status };
  if (status === "running") {
    base.startedAt = opts.restart || !current?.startedAt ? now : current.startedAt;
    delete base.finishedAt;
    delete base.note;
  }
  if (isTerminalStatus(status)) {
    base.finishedAt = now;
    base.startedAt ??= current?.startedAt ?? now;
    if (opts.note !== undefined) base.note = opts.note;
  }
  return base;
}

/** Sätt en uppgifts läge på jobbet. Returnerar om något ändrades. */
export async function setTask(jobId: string, name: TaskName, status: TaskStatus, opts: { note?: string | null; restart?: boolean } = {}): Promise<boolean> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return false;
  const next = nextTask(job.tasks?.[name], status, opts);
  if (!next) return false;
  job.tasks = { ...(job.tasks ?? {}), [name]: next };
  await persist(job);
  return true;
}

/** Startläget när ett jobb skapas: det som går att köra direkt körs, resten väntar på det det beror på. */
export function initialTasks(opts: { skipGrading: boolean; identify: "run" | "resolved" | "none" }, now = Date.now()): Partial<Record<TaskName, JobTask>> {
  return {
    condition: opts.skipGrading ? { status: "cancelled", note: "Besiktning hoppades över för det här jobbet.", finishedAt: now } : { status: "running", startedAt: now },
    identify: opts.identify === "run" ? { status: "running", startedAt: now } : opts.identify === "resolved" ? { status: "completed", startedAt: now, finishedAt: now, note: "Modellen angavs av säljaren." } : { status: "pending" },
    specs: opts.identify === "resolved" ? { status: "running", startedAt: now } : { status: "pending" },
    price: { status: "pending" },
  };
}

/**
 * Markerar att omgången inte blev komplett (budgeten, en uppgift som föll). Kortet levereras med det som finns och en tydlig markering;
 * klienten och publiceringen läser den. Skrivs en gång och skrivs aldrig bort av ett sent svar.
 */
export async function markIncomplete(jobId: string, reason: string): Promise<void> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job || job.incomplete) return;
  job.incomplete = { reason, at: Date.now() };
  await persist(job);
}

/**
 * Saknas något som MÅSTE finnas för att ett kort ska få publiceras? Tom lista = publicerbart.
 * Skick, bekräftad modell och annonstext är obligatoriska; priset och måtten är det som gör annonsen bra men en säljare kan sätta dem själv.
 */
export function missingForPublish(job: {
  identityStatus?: string;
  identity?: { model?: string | null } | null;
  result?: { grade?: unknown; listing?: { status?: string; result?: unknown; improving?: boolean } | null; reviewPending?: boolean } | null;
  pendingListing?: { status?: string; result?: unknown; improving?: boolean } | null;
  tasks?: Partial<Record<TaskName, JobTask>>;
}): string[] {
  const missing: string[] = [];
  if (job.identityStatus !== "resolved" || !job.identity?.model?.trim()) missing.push("bekräftad modell");
  if (!job.result?.grade || job.result.reviewPending) missing.push("skickbedömning");
  const listing = job.result?.listing ?? job.pendingListing ?? null;
  if (!listing || listing.status === "pending" || !listing.result) missing.push("annonstext");
  else if (listing.improving) missing.push("pågående komplettering av annonsen");
  return missing;
}
