import type { ConditionJob, JobSummary, Damage, ConditionResult, DebugTrace, FurnitureIdentity, ModelCandidate, PriceEstimate, TraderaState } from "./types";

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

export async function createJob(
  images: CapturedShot[],
  identity: FurnitureIdentity | null,
): Promise<{ jobId: string; imageCount: number }> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images, brand: identity?.brand ?? null, model: identity?.model ?? null }),
  });
  return json(res);
}

/**
 * Prisförslag på bara märke och modell, utan jobb och utan bilder.
 *
 * Startas i samma ögonblick som säljaren lämnar startsidan och löper medan de filmar. Prismotorn
 * svarar på ungefär 5-11 s; en varvfilmning tar 30-40. Priset är alltså framme innan de ens tryckt
 * stopp, och ligger färdigt när prisvyn öppnas.
 */
export async function fetchPrice(identity: FurnitureIdentity): Promise<PriceEstimate> {
  const res = await fetch("/api/price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand: identity.brand, model: identity.model }),
  });
  const body = await json<{ price: PriceEstimate }>(res);
  return body.price;
}

/** Säljarens modellval. Startar fas 2: annonsen byggs på valet och priset räknas när skicket är klart. */
export async function selectModel(
  jobId: string,
  choice: { candidate?: ModelCandidate; manualModel?: string },
): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(choice),
  });
  await json(res);
}

/** Kör om pipelinen på de bildrutor jobbet redan har — ingen ny filmning, ingen ny uppladdning. */
export async function retryJob(jobId: string): Promise<{ jobId: string; imageCount: number }> {
  const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
  return json(res);
}

/**
 * Var Tradera-publiceringen står, och vad som skulle publiceras.
 *
 * Pollas medan status är "publishing": Tradera köar annonsen och kön tar 10-60 s, så servern svarar
 * direkt och arbetar vidare i bakgrunden.
 */
export async function getTraderaState(jobId: string): Promise<TraderaState> {
  const res = await fetch(`/api/jobs/${jobId}/tradera`);
  return json(res);
}

/** Publicerar truth-cardet som en riktig annons på Loopas Tradera-konto. Svarar innan den är uppe. */
export async function publishToTradera(jobId: string): Promise<TraderaState> {
  const res = await fetch(`/api/jobs/${jobId}/tradera`, { method: "POST" });
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
