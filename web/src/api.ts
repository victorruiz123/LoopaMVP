import { supabase } from "./lib/supabase";
import type { AdminUsers, CardAnswer, ConditionJob, JobSummary, Damage, ConditionResult, DebugTrace, FurnitureIdentity, ModelCandidate, PriceEstimate, PriceLadder, PublicCard, TraderaState } from "./types";

/**
 * Varje anrop bär säljarens Supabase-token.
 *
 * Det är den servern knyter jobbet till ett konto med — utan huvudet vet den inte vems truth-card
 * som skapas, och profilen skulle antingen bli tom eller visa allas möbler.
 *
 * Bild-URL:erna (imageUrl/cropUrl) går utanför den här vägen: de sätts som src på <img> och kan inte
 * bära huvuden. De ligger kvar öppna, precis som förut.
 */
async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}

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
  const res = await authFetch("/api/jobs", {
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
  const res = await authFetch("/api/price", {
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
  const res = await authFetch(`/api/jobs/${jobId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(choice),
  });
  await json(res);
}

/** Kör om pipelinen på de bildrutor jobbet redan har — ingen ny filmning, ingen ny uppladdning. */
export async function retryJob(jobId: string): Promise<{ jobId: string; imageCount: number }> {
  const res = await authFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
  return json(res);
}

/**
 * Säljarens prisspann: startpriset annonsen läggs upp med, och golvet den veckovisa sänkningen
 * stannar på.
 *
 * Sparas på jobbet, inte i webbläsaren: det är servern som sänker priset varje vecka, långt efter att
 * den här fliken är stängd.
 */
export async function savePricePlan(
  jobId: string,
  plan: { startPrice: number; floorPrice: number; weeklyDropPct?: number },
): Promise<PriceLadder> {
  const res = await authFetch(`/api/jobs/${jobId}/price-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  const body = await json<{ ladder: PriceLadder }>(res);
  return body.ladder;
}

/**
 * Var Tradera-publiceringen står, och vad som skulle publiceras.
 *
 * Pollas medan status är "publishing": Tradera köar annonsen och kön tar 10-60 s, så servern svarar
 * direkt och arbetar vidare i bakgrunden.
 */
export async function getTraderaState(jobId: string): Promise<TraderaState> {
  const res = await authFetch(`/api/jobs/${jobId}/tradera`);
  return json(res);
}

/** Publicerar truth-cardet som en riktig annons på Loopas Tradera-konto. Svarar innan den är uppe. */
export async function publishToTradera(jobId: string): Promise<TraderaState> {
  const res = await authFetch(`/api/jobs/${jobId}/tradera`, { method: "POST" });
  return json(res);
}

/**
 * Det publika truth-cardet bakom ett Loopa-ID.
 *
 * ENDA anropet i klienten som går utan Authorization-huvud, och det är avsiktligt: sidan öppnas av
 * någon som läst ett ID i en Tradera-annons och inte har något konto hos oss. Ett authFetch här hade
 * gjort ett publikt kort inloggningspliktigt i det ögonblick en session råkade finnas.
 */
export async function fetchPublicCard(loopaId: string): Promise<PublicCard> {
  const res = await fetch(`/api/cards/${encodeURIComponent(loopaId)}`);
  return json(res);
}

/**
 * En fråga om möbeln på ett truth-card.
 *
 * Går utan Authorization-huvud av samma skäl som kortet själv: chatten sitter på kortet, och kortet
 * läses av någon som kom från en annons. Servern bygger sitt underlag ur det publika kortet, så
 * frågan bär ingen kontext — bara ID:t avgör vad boten kan se.
 */
export async function askTruthCard(
  loopaId: string,
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<CardAnswer> {
  const res = await fetch(`/api/cards/${encodeURIComponent(loopaId)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  return json(res);
}

export function debugUrl(jobId: string): string {
  return `/api/jobs/${jobId}/debug`;
}

export async function getDebugTrace(id: string): Promise<DebugTrace> {
  const res = await authFetch(debugUrl(id));
  return json(res);
}

export async function getJob(id: string): Promise<ConditionJob> {
  const res = await authFetch(`/api/jobs/${id}`);
  return json(res);
}

export async function listJobs(): Promise<JobSummary[]> {
  const res = await authFetch("/api/jobs");
  return json(res);
}

/**
 * Hämtar bildkakan.
 *
 * Bild-URL:erna nedan sätts som `src` på `<img>` och kan inte bära något Authorization-huvud. Servern
 * utfärdar i stället en signerad HttpOnly-kaka mot säljarens token, som webbläsaren skickar med av
 * sig själv på samma ursprung. Utan det här anropet svarar bildvägarna 401.
 *
 * Körs en gång per inloggning; kakan lever ett dygn.
 */
export async function ensureMediaSession(): Promise<{ isAdmin: boolean }> {
  const res = await authFetch("/api/session", { method: "POST" });
  if (!res.ok) throw new Error(`Kunde inte upprätta bildsession: ${res.status}`);
  // Svaret säger också om kontot är admin. Rollen avgörs på servern — det här är bara beskedet om
  // huruvida adminingången ska ritas, och den som fejkar flaggan i klienten får 404 på varje väg.
  const body = (await res.json().catch(() => ({}))) as { isAdmin?: boolean };
  return { isAdmin: !!body.isAdmin };
}

/** Alla konton, för adminpanelen. Svarar 404 för alla andra än adresserna i serverns admin.ts. */
export async function listUsers(): Promise<AdminUsers> {
  const res = await authFetch("/api/admin/users");
  return json(res);
}

/** Ett kontos jobb, i samma form som profilens egen lista. */
export async function listUserJobs(userId: string): Promise<JobSummary[]> {
  const res = await authFetch(`/api/admin/users/${encodeURIComponent(userId)}/jobs`);
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
  const res = await authFetch(`/api/jobs/${jobId}/damages/${damageId}`, {
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
  const res = await authFetch(`/api/jobs/${jobId}/damages/${damageId}/dispute`, {
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
  const res = await authFetch(`/api/jobs/${jobId}/damages/from-photo`, {
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
  const res = await authFetch(`/api/jobs/${jobId}/damages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(damage),
  });
  return json(res);
}
