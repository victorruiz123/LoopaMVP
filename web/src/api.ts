import type { ConditionJob, JobSummary, Damage, ConditionResult, DebugTrace } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Client-curated shot — already selected/captured, ready to send as-is. */
export interface CapturedShot {
  dataUrl: string;
  viewLabel: string | null;
  source: "video" | "manual";
}

export async function createJob(images: CapturedShot[]): Promise<{ jobId: string; imageCount: number }> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images }),
  });
  return json(res);
}

export function debugUrl(jobId: string): string {
  return `/api/jobs/${jobId}/debug`;
}

export async function getDebugTrace(id: string): Promise<DebugTrace> {
  const res = await fetch(debugUrl(id));
  return json(res);
}

export async function getJob(id: string): Promise<ConditionJob> {
  const res = await fetch(`/api/jobs/${id}`);
  return json(res);
}

export async function listJobs(): Promise<JobSummary[]> {
  const res = await fetch("/api/jobs");
  return json(res);
}

export function imageUrl(jobId: string, imageId: string): string {
  return `/api/jobs/${jobId}/images/${imageId}`;
}

export function cropUrl(jobId: string, cropPath: string): string {
  const filename = cropPath.split("/").pop();
  return `/api/jobs/${jobId}/crops/${filename}`;
}

export async function actOnDamage(
  jobId: string,
  damageId: string,
  action: "confirm" | "reject" | "edit",
  patch?: Partial<Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">>,
): Promise<ConditionResult> {
  const res = await fetch(`/api/jobs/${jobId}/damages/${damageId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, patch }),
  });
  return json(res);
}

export interface DisputeResult {
  verdict: "REMOVE" | "KEEP";
  reason: string;
  result: ConditionResult;
}

/** Seller disputes one finding and backs it with a fresh close-up; Gemini adjudicates. */
export async function disputeDamage(jobId: string, damageId: string, dataUrl: string): Promise<DisputeResult> {
  const res = await fetch(`/api/jobs/${jobId}/damages/${damageId}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  return json(res);
}

export interface AddFromPhotoResult {
  added: boolean;
  reason: string;
  result: ConditionResult;
}

/** Seller photographs damage the walkaround missed; Gemini describes it and it joins the findings. */
export async function addDamageFromPhoto(jobId: string, dataUrl: string): Promise<AddFromPhotoResult> {
  const res = await fetch(`/api/jobs/${jobId}/damages/from-photo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  return json(res);
}

export async function addDamage(
  jobId: string,
  damage: Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">,
): Promise<ConditionResult> {
  const res = await fetch(`/api/jobs/${jobId}/damages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(damage),
  });
  return json(res);
}
