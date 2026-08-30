import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file yet — GEMINI_API_KEY must be set some other way, checked below.
}
import { createJob, failOrphanedJobs, getJob, getJobSync, jobDir, listJobs, ownerIdOf, persist, getDebugTrace, watchJobDeadline } from "./jobStore.js";
import { runConditionGrading } from "./pipeline/run.js";
import { gradeCondition } from "./pipeline/grade.js";
import { adjudicateDispute } from "./pipeline/dispute.js";
import { checkApiKey } from "./apiAuth.js";
import { listAccounts } from "./admin.js";
import { identityFromRequest, issueMediaCookie, mediaSecretIsEphemeral, type Identity } from "./identity.js";
import { estimatePrice, repriceResult } from "./pricing.js";
import { finalizeWithModel, findMoreCandidates, runIdentify } from "./pipeline/identify.js";
import type { Resolution } from "./listing.js";
import { assessAddedPhoto } from "./pipeline/addFromPhoto.js";
import { mapRawDefect } from "./pipeline/inspect.js";
import { loadImageAsBase64 } from "./imageUtils.js";
import { getImageDimensions } from "./imageUtils.js";
import { JOB_DEADLINE_MS, MAX_IMAGES_PER_JOB } from "./config.js";
import { distExists, serveStatic } from "./static.js";
import { markTraderaPublishing, planTraderaPublish, runTraderaPublish } from "./integrations/tradera/publish.js";
import { blocketAdFor } from "./integrations/blocket.js";
import { missingTraderaEnv, traderaConfigured } from "./integrations/tradera/tradera.js";
import { makePriceLadder, startPriceLadderScheduler } from "./priceLadder.js";
import { coverFirst, resolveCoverImageId } from "./pipeline/cover.js";
import { loopaIdFor } from "./loopaId.js";
import { cutoutOf, jobByLoopaId, publicCardFor } from "./publicCard.js";
import { bearerToken } from "./supabaseAuth.js";
import { answerCardQuestion, MAX_QUESTION_CHARS, type ChatTurn } from "./cardChat.js";
import type { CapturedImage, ConditionJob, Damage, DamageType, FurnitureIdentity, Impact, ModelCandidate, Severity } from "./types.js";

const PORT = Number(process.env.PORT ?? 8799);
const MAX_BODY_BYTES = 60 * 1024 * 1024; // up to ~10 camera-resolution JPEGs as base64

/**
 * Ursprung som får läsa svaren.
 *
 * Var `*` tidigare, vilket räckte så länge servern satt på 127.0.0.1 och ingen annan kunde nå den.
 * På en publik adress betyder `*` att vilken sida som helst kan låta besökarens webbläsare anropa
 * API:t. Tom lista = bara samma ursprung, vilket är allt appen behöver: UI:t serveras av den här
 * servern och anropar relativa /api-vägar. Sätt ALLOWED_ORIGINS bara om något annat ska in.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function setCors(req: IncomingMessage, res: ServerResponse) {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  // Vary oavsett utfall: annars kan en cache servera ett svar med fel ursprung till nästa besökare.
  res.setHeader("Vary", "Origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * `maxBytes` är för de vägar som INTE tar bilder. Taket finns för uppladdningarna och är därför satt
 * i tiotals megabyte; en publik textväg som ärver det taket tar emot 60 MB innan den säger nej.
 */
async function readJsonBody<T>(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

interface CreateJobBody {
  productContext?: string | null;
  /** Brand + model as the seller typed them. Optional: grading works without them, pricing does not. */
  brand?: string | null;
  model?: string | null;
  /** Already curated by the client: selected video frames + any manual photos. No server-side selection. */
  images: Array<{ dataUrl: string; viewLabel?: string | null; source?: "video" | "manual" }>;
}

/**
 * Märket räcker för att starta. Modellen letar systemet upp ur bilderna.
 *
 * Tidigare krävdes modellnamnet, skrivet för hand, innan något kunde börja — och identifieringen låg
 * sist i flödet, där den ibland kom fram till att säljaren angett fel möbel efter att skick och pris
 * redan räknats på den. Nu är ordningen den omvända: märke in, bilder in, modell fram, sedan resten.
 */
function readIdentity(body: { brand?: string | null; model?: string | null }): FurnitureIdentity | null {
  const brand = body.brand?.trim() || null;
  const model = body.model?.trim() || "";
  if (!brand && !model) return null;
  return { brand, model };
}

/**
 * The one place a finished report is recomputed after the seller changes the findings. Grade and price
 * are refreshed together, from the same damage list, so the two halves of the report cannot drift
 * apart — the failure mode where a rejected damage disappears from the grade but is still deducted
 * from the price.
 */
async function regradeAndReprice(job: ConditionJob): Promise<void> {
  if (!job.result) return;
  job.result.grade = gradeCondition(job.result.damages, job.result.overallCondition);
  await repriceResult(job.result, await coverImageBase64(job));
  await persist(job);
}

async function coverImageBase64(job: ConditionJob): Promise<string | null> {
  const first = coverFirst(job.result?.images ?? [], job.result?.coverImageId ?? null)[0];
  if (!first) return null;
  try {
    const part = await loadImageAsBase64(path.join(jobDir(job.id), "originals", first.path));
    return part.base64;
  } catch {
    return null;
  }
}

/**
 * The one place a job is created. Both the local web UI and the public API go through this, so the API
 * cannot drift from what the app does — "exactly the same pipeline" is structural, not a promise.
 */
async function createConditionJob(
  body: CreateJobBody,
  ownerId: string | null = null,
): Promise<{ jobId: string; imageCount: number } | { error: string }> {
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { error: "At least one image is required" };
  }
  const identity = readIdentity(body);
  const job = await createJob(body.productContext ?? null, identity, ownerId);
  const dir = jobDir(job.id);
  const originalsDir = path.join(dir, "originals");
  await mkdir(originalsDir, { recursive: true });

  const limited = body.images.slice(0, MAX_IMAGES_PER_JOB);
  const images: CapturedImage[] = [];
  for (let i = 0; i < limited.length; i++) {
    const { dataUrl, viewLabel, source } = limited[i];
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    const [, mimeType, base64] = match;
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const filename = `img_${i}.${ext}`;
    const abs = path.join(originalsDir, filename);
    await writeFile(abs, Buffer.from(base64, "base64"));
    const { width, height } = await getImageDimensions(abs);
    images.push({
      id: randomUUID(),
      viewLabel: viewLabel ?? null,
      source: source ?? "manual",
      width,
      height,
      path: filename,
      capturedAt: new Date().toISOString(),
    });
  }

  if (images.length === 0) return { error: "No valid images were decoded" };

  job.images = images;
  await persist(job);

  // EN klocka för hela jobbet, startad här. Den enda gräns som binder oavsett fas och oavsett hur
  // många omförsök som pågår i något av spåren.
  const stopDeadline = watchJobDeadline(job.id, JOB_DEADLINE_MS);
  void (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = await getJob(job.id);
      if (!current || current.progress.stage === "done" || current.progress.stage === "error") break;
    }
    stopDeadline();
  })();

  // Två spår, parallellt. Besiktningen behöver inte modellen och identifieringen behöver inte
  // betyget — de delar bara bildrutorna. Kedjade hade de lagt sina tider ovanpå varandra.
  void runConditionGrading(job.id, images, body.productContext ?? null, identity);
  if (identity?.brand && !identity.model) {
    job.identityStatus = "identifying";
    await persist(job);
    void runIdentify(job.id, identity.brand, images);
  } else if (identity?.model) {
    // Säljaren angav modellen själv — hoppa identifieringen, gå direkt till annons och pris.
    job.identityStatus = "resolved";
    await persist(job);
    void finalizeWithModel(job.id, { kind: "manual", manualModel: identity.model });
  }
  return { jobId: job.id, imageCount: images.length };
}

/**
 * Price for a brand + model, with no job and no photos behind it.
 *
 * The price engine never needed the walkaround: it searches an ad corpus on the name, and the damage
 * list is a deduction applied afterwards. So this answer exists the moment the seller has typed the
 * two fields — which is why the app asks for it while they are still filming, and why the price is on
 * screen before the inspection has finished its first Gemini call.
 */
async function handlePreliminaryPrice(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody<{ brand?: string | null; model?: string | null }>(req);
  const identity = readIdentity(body);
  if (!identity) return sendJson(res, 400, { error: "model is required" });
  const price = await estimatePrice(identity, [], null, null);
  sendJson(res, 200, { identity, price });
}

/** Ägs jobbet av den som frågar? Ägarregeln själv står i jobStore.ownerIdOf. */
function owns(job: { ownerId?: string | null }, identity: Identity): boolean {
  const owner = ownerIdOf(job);
  return owner !== null && owner === identity.id;
}

/**
 * Bildkakan hämtas här, en gång per inloggning.
 *
 * `<img src>` kan inte bära ett Authorization-huvud, så utan den här vägen vore bildbytena tvungna
 * att stå öppna. Se identity.ts för varför kakan bara godtas för GET.
 */
function handleCreateSession(req: IncomingMessage, res: ServerResponse, identity: Identity) {
  const proto = req.headers["x-forwarded-proto"];
  const secure = (Array.isArray(proto) ? proto[0] : proto) === "https";
  res.setHeader("Set-Cookie", issueMediaCookie(identity.id, secure, identity.isAdmin));
  // Klienten får veta om den ska rita adminingången här, i anropet den ändå gör vid varje inloggning.
  // Rollen avgörs på servern; svaret är bara en upplysning om vad den kom fram till.
  sendJson(res, 200, { ok: true, isAdmin: identity.isAdmin });
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse, identity: Identity) {
  // Ägaren avgörs HÄR, vid uppladdningen, och aldrig senare. En annons som får sin profil
  // efteråt är en annons som kan hamna i fel — filmningen och kontot hör ihop från början.
  const out = await createConditionJob(await readJsonBody<CreateJobBody>(req), identity.id);
  if ("error" in out) return sendJson(res, 400, out);
  sendJson(res, 202, out);
}

async function handleGetJob(id: string, res: ServerResponse) {
  const job = await getJob(id);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  // Loopa-ID:t läggs på i svaret i stället för att sparas i jobbet: det är härlett ur id:t (se
  // loopaId.ts), så ett sparat fält hade bara varit en kopia som kan bli inaktuell.
  sendJson(res, 200, { ...job, loopaId: loopaIdFor(job.id) });
}

/**
 * Runs the pipeline again on the frames the job already has.
 *
 * The failures this exists for are upstream and transient — a Gemini 503 or 504 — and the walkaround
 * that triggered them is still perfectly good. Re-uploading it would mean filming again for a fault
 * that was never the seller's; the identical images also hit the Gemini disk cache for whatever part
 * of the run did succeed, so a retry is cheaper than the first attempt, not dearer.
 */
async function handleRetry(id: string, res: ServerResponse) {
  const job = await getJob(id);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  const images = job.images ?? job.result?.images;
  if (!images?.length) {
    return sendJson(res, 409, { error: "Jobbet har inga sparade bildrutor att köra om." });
  }
  if (job.progress.stage !== "error" && job.progress.stage !== "done") {
    return sendJson(res, 409, { error: "Analysen pågår redan." });
  }

  job.error = null;
  job.progress = { stage: "queued", message: "I kö…" };
  await persist(job);
  void runConditionGrading(job.id, images, job.productContext ?? null, job.identity ?? null);
  sendJson(res, 202, { jobId: job.id, imageCount: images.length });
}

/**
 * Säljaren väljer modell. Startar fas 2: annonsen byggs på valet, och priset räknas när
 * skickbedömningen är klar.
 */
async function handleSelectModel(id: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(id);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  const body = await readJsonBody<{ candidate?: ModelCandidate; manualModel?: string }>(req);

  let resolution: Resolution;
  if (body.candidate?.model) resolution = { kind: "seller_selected", selected: body.candidate };
  else if (body.manualModel?.trim()) resolution = { kind: "manual", manualModel: body.manualModel.trim() };
  else return sendJson(res, 400, { error: "candidate eller manualModel krävs" });

  void finalizeWithModel(id, resolution);
  sendJson(res, 202, { ok: true });
}

/**
 * "Ingen av dem" — säljaren vill se fyra andra modeller.
 *
 * Svarar 202 så fort jobbet står i sökläge; kandidaterna landar i bakgrunden och klienten pollar in
 * dem, samma väg som den första omgången tar. Regeln om vad som får sökas om och med vilken
 * förbudslista bor i findMoreCandidates, inte här.
 */
async function handleFindMoreCandidates(id: string, res: ServerResponse) {
  const out = await findMoreCandidates(id);
  if ("error" in out) return sendJson(res, out.error === "Job not found" ? 404 : 409, out);
  sendJson(res, 202, out);
}

async function handleGetDebug(id: string, res: ServerResponse) {
  const trace = await getDebugTrace(id);
  if (!trace) return sendJson(res, 404, { error: "No debug trace for this job (not finished, or job not found)" });
  sendJson(res, 200, trace);
}

/**
 * Säljarens prisspann: startpris, golv och den veckovisa sänkningen däremellan.
 *
 * Sätts på prisvyn, långt innan annonsen finns — därför på jobbet och inte på publiceringen. Efter
 * att annonsen gått upp är spannet däremot låst här: priset ligger på Tradera, och ett nytt startpris
 * i efterhand hade beskrivit en annons som inte finns.
 */
async function handleSetPricePlan(jobId: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  if (job.tradera?.status === "published") {
    return sendJson(res, 409, {
      error: "Annonsen ligger redan uppe på Tradera, så prisspannet går inte att ändra här.",
      ladder: job.priceLadder ?? null,
    });
  }

  const body = await readJsonBody<{ startPrice?: number; floorPrice?: number; weeklyDropPct?: number }>(req);
  if (body.startPrice === undefined || body.floorPrice === undefined) {
    return sendJson(res, 400, { error: "startPrice och floorPrice krävs." });
  }

  const ladder = makePriceLadder({
    startPrice: body.startPrice,
    floorPrice: body.floorPrice,
    weeklyDropPct: body.weeklyDropPct,
  });
  if ("error" in ladder) return sendJson(res, 400, { error: ladder.error });

  job.priceLadder = ladder;
  await persist(job);
  sendJson(res, 200, { ladder });
}

// ---- Tradera: lägger upp annonsen som en riktig Tradera-annons ------------

/**
 * Allt klienten behöver för att rita knappen: om integrationen ens är påkopplad, vad som skulle
 * publiceras, och var ett pågående försök står.
 */
async function traderaState(job: ConditionJob) {
  const readiness = await planTraderaPublish(job);
  return {
    configured: traderaConfigured(),
    missingEnv: missingTraderaEnv(),
    publication: job.tradera ?? null,
    plan: readiness.ok ? readiness.plan : null,
    blockedReason: readiness.ok ? null : readiness.reason,
    // Prisspannet följer med: bekräftelsesteget ska kunna säga vad annonsen gör EFTER publiceringen,
    // och den publicerade vyn var priset står i dag och när det sänks nästa gång.
    ladder: job.priceLadder ?? null,
  };
}

async function handleGetTradera(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  sendJson(res, 200, await traderaState(job));
}

/**
 * Startar publiceringen och svarar direkt.
 *
 * Tradera KÖAR annonsen — publiceringen tar 10–60 s och kan inte hållas i ett HTTP-svar. Jobbet
 * markeras som "publicerar" innan bakgrundsarbetet startar, så en andra tryckning inte kan lägga upp
 * samma möbel två gånger, och klienten pollar GET på samma väg.
 */
async function handlePublishTradera(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });

  if (!traderaConfigured()) {
    return sendJson(res, 503, {
      error: `Tradera är inte konfigurerat på servern. Saknar ${missingTraderaEnv().join(", ")}.`,
      ...(await traderaState(job)),
    });
  }
  if (job.tradera?.status === "publishing") return sendJson(res, 202, await traderaState(job));
  if (job.tradera?.status === "published") {
    return sendJson(res, 409, { error: "Annonsen är redan publicerad på Tradera.", ...(await traderaState(job)) });
  }

  const readiness = await planTraderaPublish(job);
  if (!readiness.ok) return sendJson(res, 409, { error: readiness.reason, ...(await traderaState(job)) });

  await markTraderaPublishing(job);
  void runTraderaPublish(job.id);
  sendJson(res, 202, await traderaState(job));
}

// ---- Blocket: annonsen färdig att föra över för hand ----------------------

/**
 * Annonsens fält, redo att klistras in i Blockets formulär.
 *
 * Läsande och utan sidoeffekter — till skillnad från Tradera-vägen publiceras ingenting här, för
 * Blocket har inget API att publicera till. Omslagsvalet räknas fram först, av samma skäl som vid
 * publiceringen: jobb från före omslagsvalet skulle annars lämna sin svarta första bildruta överst.
 */
async function handleGetBlocket(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  await resolveCoverImageId(job);
  sendJson(res, 200, await blocketAdFor(job));
}

// ---- Publik annons: /api/cards/:loopaId, utan inloggning --------------

/**
 * Kortet bakom ett Loopa-ID.
 *
 * Samma 404 för ett ogiltigt ID som för ett giltigt som ingen har: svaret ska inte gå att använda för
 * att kartlägga vilka ID som finns. Ett jobb utan färdig annonstext är ingen annons och räknas som
 * att ID:t inte finns.
 */
async function handleGetPublicCard(loopaId: string, res: ServerResponse) {
  const job = await jobByLoopaId(loopaId);
  const card = job ? publicCardFor(job) : null;
  if (!card) return sendJson(res, 404, { error: "Vi hittade ingen annons med det Loopa-ID:t." });
  sendJson(res, 200, card);
}

/** Frågan är text. 16 kB räcker för fråga plus samtalshistorik och är inte värt att ta emot mer av. */
const CHAT_BODY_BYTES = 16 * 1024;
const CHAT_WINDOW_MS = 60_000;
/** Per läsare. En verklig konversation är några frågor i minuten, inte tjugo. */
const CHAT_PER_IP = 10;
/** Över alla läsare tillsammans. Taket per IP hjälper inte mot någon som byter IP — det här gör. */
const CHAT_GLOBAL = 120;

const chatHits = new Map<string, number[]>();

/**
 * Vem frågan räknas på.
 *
 * Servern står bakom en Cloudflare-tunnel, så uttagets adress är tunnelns och alla läsare skulle bli
 * samma hink. `x-forwarded-for` är därför enda vägen till något som skiljer dem åt — och den går att
 * ljuga om. Det är avsiktligt godtaget: huvudet används BARA för att dela upp per-IP-hinken, och den
 * som förfalskar det springer i stället in i den globala gränsen, som ingen kan ta sig runt.
 */
function chatClientKey(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "okänd";
}

/** null = släpp igenom. En sträng = svaret läsaren ska få i stället. */
function chatRateLimit(key: string): string | null {
  const now = Date.now();
  let total = 0;
  for (const [k, hits] of chatHits) {
    const fresh = hits.filter((t) => now - t < CHAT_WINDOW_MS);
    if (fresh.length === 0) chatHits.delete(k);
    else {
      chatHits.set(k, fresh);
      total += fresh.length;
    }
  }
  if (total >= CHAT_GLOBAL) return "Chatten har många frågor just nu. Försök igen om en stund.";
  const mine = chatHits.get(key) ?? [];
  if (mine.length >= CHAT_PER_IP) return "Du har ställt många frågor på kort tid. Vänta en minut.";
  chatHits.set(key, [...mine, now]);
  return null;
}

/** Samtalet ägs av klienten, så inget i det är betrott. Formen prövas, längden kapas i cardChat.ts. */
function readChatHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is ChatTurn =>
      !!t && typeof t === "object" &&
      (t.role === "user" || t.role === "assistant") &&
      typeof t.content === "string" && t.content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }));
}

/**
 * Chatten på kortet.
 *
 * Öppen precis som kortet själv, och av samma skäl: den som läser ett Loopa-ID i en Tradera-annons
 * har inget konto hos oss. Boten får se exakt det `handleGetPublicCard` skulle ha svarat med — inget
 * som stannar bakom inloggningen kan läcka ut genom en fråga, eftersom det aldrig når modellen.
 */
async function handleCardChat(loopaId: string, req: IncomingMessage, res: ServerResponse) {
  const limited = chatRateLimit(chatClientKey(req));
  if (limited) return sendJson(res, 429, { error: limited });

  const body = await readJsonBody<{ question?: unknown; history?: unknown }>(req, CHAT_BODY_BYTES);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return sendJson(res, 400, { error: "Skriv en fråga." });
  if (question.length > MAX_QUESTION_CHARS) {
    return sendJson(res, 400, { error: `Frågan får vara högst ${MAX_QUESTION_CHARS} tecken.` });
  }

  // Samma 404 som kortet, av samma skäl: svaret ska inte gå att använda för att kartlägga vilka ID
  // som finns.
  const job = await jobByLoopaId(loopaId);
  const card = job ? publicCardFor(job) : null;
  if (!card) return sendJson(res, 404, { error: "Vi hittade ingen annons med det Loopa-ID:t." });

  try {
    const { answer, source } = await answerCardQuestion(card, question, readChatHistory(body.history));
    sendJson(res, 200, { answer, source });
  } catch (err) {
    // Modellen nere är inte samma sak som ett trasigt kort. Säg det, och låt läsaren försöka igen.
    console.error("[card-chat]", err);
    sendJson(res, 503, { error: "Chatten kunde inte nås just nu. Försök igen om en stund." });
  }
}

// ---- public API: /v1/condition, authenticated with x-api-key ---------------

async function handleApiCreate(req: IncomingMessage, res: ServerResponse) {
  const auth = checkApiKey(req.headers["x-api-key"]);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const out = await createConditionJob(await readJsonBody<CreateJobBody>(req));
  if ("error" in out) return sendJson(res, 400, out);
  sendJson(res, 202, { ...out, statusUrl: `/v1/condition/${out.jobId}` });
}

async function handleApiGet(jobId: string, req: IncomingMessage, res: ServerResponse) {
  const auth = checkApiKey(req.headers["x-api-key"]);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  sendJson(res, 200, {
    jobId: job.id,
    status: job.error ? "error" : job.progress.stage === "done" ? "done" : "running",
    stage: job.progress.stage,
    message: job.progress.message,
    error: job.error,
    result: job.result,
  });
}

/**
 * Säljarens egna annonser, och bara de.
 *
 * Ägarlösa jobb ligger kvar synliga för alla: de skapades innan appen hade konton, och att dölja dem
 * hade tömt historiken för den som byggde upp den. Allt som skapas härefter bär en ägare.
 */
async function handleListJobs(res: ServerResponse, identity: Identity) {
  const all = await listJobs();
  return sendJobSummaries(res, all.filter((j) => owns(j, identity)));
}

/**
 * Listraderna, i EN form.
 *
 * Profilen och adminpanelen visar samma rad — samma miniatyr, samma pris, samma avgörande av om
 * jobbet blev en annons. Två kopior av den uträkningen hade betytt att panelen förr eller senare
 * påstod något annat om ett kort än säljarens egen profil gör.
 */
async function sendJobSummaries(res: ServerResponse, jobs: Awaited<ReturnType<typeof listJobs>>) {
  // Jobb från före omslagsvalet får sitt uträknat här, en gång, och sparat. Utan det behåller de sin
  // första bildruta som miniatyr — den som ofta är svart.
  await Promise.all(jobs.map((j) => resolveCoverImageId(j)));
  sendJson(
    res,
    200,
    jobs.map((j) => {
      // Annonsen kan sitta på tre ställen: i resultatet, kvar på jobbet när besiktningen föll, eller
      // ännu inte inflyttad. Profilen ska visa kortet i alla tre fallen.
      const listing = j.result?.listing ?? j.listing ?? j.pendingListing ?? null;
      return {
        id: j.id,
        loopaId: loopaIdFor(j.id),
        createdAt: j.createdAt,
        progress: j.progress,
        grade: j.result?.grade ?? null,
        identity: j.identity ?? null,
        price: j.result?.price ?? null,
        thumbnailImageId: j.result?.coverImageId ?? j.result?.images[0]?.id ?? null,
        // Samma omslag som kortet, i samma ordning: säljarens möbel urklippt mot vitt först, och
        // tillverkarens katalogbild bara för de jobb som inte fick något urklipp. Listan och kortet
        // ska visa SAMMA möbel — en miniatyr av en ny exemplar bredvid ett kort med den begagnade
        // var två bilder av två olika saker.
        coverImageUrl: cutoutOf(j)
          ? `/api/jobs/${j.id}/cover`
          : (j.result?.productImage?.url ?? j.productImage?.url ?? null),
        error: j.error,
        hasListing: listing?.status === "ok" && !!listing.result,
        listingTitle: listing?.result?.listing.title ?? null,
        // `tradera` sätts först när säljaren tryckt på "Sälj med Loopa", så ett kort utan den har
        // aldrig lagts ut. Profilen skiljer på de två: en möbel som säljs just nu är inte en sparad
        // annons, den ligger ute hos köparna.
        sale: j.tradera ? { status: j.tradera.status, url: j.tradera.url } : null,
      };
    }),
  );
}

// ---- adminpanelen: /api/admin/*, bara för adresserna i admin.ts -------------

/**
 * Alla konton, med hur många annonser var och en har.
 *
 * Adminens egen token skickas vidare till Supabase av `listAccounts` — utan servicenyckel är det den
 * enda vägen till namnen bakom id:na, och den lyder databasens radsäkerhet precis som klienten gör.
 */
async function handleAdminUsers(req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, await listAccounts(bearerToken(req)));
}

/** Ett kontos jobb, i samma form som säljarens egen profil ser dem. */
async function handleAdminUserJobs(userId: string, res: ServerResponse) {
  const all = await listJobs();
  return sendJobSummaries(res, all.filter((j) => ownerIdOf(j) === userId));
}

function findImage(job: Awaited<ReturnType<typeof getJob>>, imageId: string): CapturedImage | undefined {
  return job?.result?.images.find((i) => i.id === imageId);
}

async function handleGetImage(jobId: string, imageId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  const image = findImage(job, imageId);
  if (!image) return sendJson(res, 404, { error: "Image not found" });
  const abs = path.join(jobDir(jobId), "originals", image.path);
  await streamFile(abs, res);
}

/**
 * Omslaget: säljarens bildruta, urklippt mot vitt. Ligger som en enda fil per jobb.
 *
 * Egen väg och inte en bild bland `images`: den är HÄRLEDD, inte fotograferad, och den är den enda
 * bilden av säljarens möbel som får lämna inloggningen (se den publika vägen nedan).
 */
async function handleGetCover(jobId: string, res: ServerResponse) {
  await streamFile(path.join(jobDir(jobId), "cover", "cover.jpg"), res);
}

/**
 * Samma fil, men slagen på Loopa-ID och utan inloggning — kortets omslag för den som läser annonsen.
 *
 * Det här är den enda bild av säljarens egen möbel som är publik, och det är ett medvetet undantag:
 * urklippet visar möbeln mot vitt och ingenting av rummet den står i. Bildrutorna själva, med hem,
 * ansikten och allt annat som råkade vara i bild, ligger kvar bakom inloggningen.
 *
 * Kortet måste dessutom FINNAS publikt för att bilden ska lämnas ut: ett jobb utan färdig annons har
 * inget publikt kort, och då har det inget publikt omslag heller.
 */
async function handleGetPublicCover(loopaId: string, res: ServerResponse) {
  const job = await jobByLoopaId(loopaId);
  if (!job || !publicCardFor(job) || !cutoutOf(job)) {
    return sendJson(res, 404, { error: "Vi hittade ingen annons med det Loopa-ID:t." });
  }
  await streamFile(path.join(jobDir(job.id), "cover", "cover.jpg"), res);
}

async function handleGetCrop(jobId: string, filename: string, res: ServerResponse) {
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return sendJson(res, 400, { error: "Invalid filename" });
  }
  const abs = path.join(jobDir(jobId), "crops", filename);
  await streamFile(abs, res);
}

async function streamFile(abs: string, res: ServerResponse) {
  try {
    await stat(abs);
  } catch {
    return sendJson(res, 404, { error: "File not found" });
  }
  const buf = await readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  const contentType = ext === ".png" ? "image/png" : "image/jpeg";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  res.end(buf);
}

interface DamageActionBody {
  action: "confirm" | "reject" | "edit";
  patch?: Partial<Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">>;
}

async function handleDamageAction(jobId: string, damageId: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job || !job.result) return sendJson(res, 404, { error: "Job or result not found" });

  const body = await readJsonBody<DamageActionBody>(req);
  const damage = job.result.damages.find((d) => d.id === damageId);
  if (!damage) return sendJson(res, 404, { error: "Damage not found" });

  if (body.action === "reject") {
    damage.sellerAction = "rejected";
  } else if (body.action === "confirm") {
    damage.sellerAction = "confirmed";
  } else if (body.action === "edit") {
    damage.sellerAction = "corrected";
    if (body.patch) Object.assign(damage, body.patch);
  }

  await regradeAndReprice(job);
  sendJson(res, 200, job.result);
}

interface DisputeBody {
  dataUrl: string;
}

/**
 * The seller disputes one finding and backs it with a fresh close-up. Separate from handleDamageAction
 * on purpose: that one applies a decision the seller already made, this one asks for an adjudication
 * and may well come back KEEP.
 */
async function handleDispute(jobId: string, damageId: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job || !job.result) return sendJson(res, 404, { error: "Job or result not found" });
  const damage = job.result.damages.find((d) => d.id === damageId);
  if (!damage) return sendJson(res, 404, { error: "Damage not found" });

  const body = await readJsonBody<DisputeBody>(req);
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(body.dataUrl ?? "");
  if (!match) return sendJson(res, 400, { error: "Behöver en närbild som data-URL" });
  const [, mimeType, base64] = match;

  const dir = jobDir(jobId);
  await mkdir(path.join(dir, "disputes"), { recursive: true });
  const closeUpRel = path.join("disputes", `${damageId}.jpg`).replace(/\\/g, "/");
  await writeFile(path.join(dir, closeUpRel), Buffer.from(base64, "base64"));

  // The crop the finding was based on, when one was produced — it gives the adjudicator the "before".
  const cropPath = damage.evidence.find((e) => e.cropPath)?.cropPath;
  let originalCrop = null;
  if (cropPath) {
    try {
      originalCrop = await loadImageAsBase64(path.join(dir, cropPath));
    } catch {
      originalCrop = null;
    }
  }

  const outcome = await adjudicateDispute(damage, originalCrop, { mimeType, base64 });

  if (outcome.verdict === "REMOVE") {
    damage.sellerAction = "rejected";
  } else {
    damage.sellerAction = "confirmed";
  }
  damage.verificationReason = outcome.reason;

  await regradeAndReprice(job);
  sendJson(res, 200, { verdict: outcome.verdict, reason: outcome.reason, result: job.result });
}

interface AddFromPhotoBody {
  dataUrl: string;
  partHint?: string | null;
}

/**
 * The seller photographs damage the walkaround missed. The close-up is appended to the job's own image
 * list as a manual capture, so the new finding carries real evidence and renders like any other — the
 * UI needs no special case for "damage that came from a photo".
 */
async function handleAddFromPhoto(jobId: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job || !job.result) return sendJson(res, 404, { error: "Job or result not found" });

  const body = await readJsonBody<AddFromPhotoBody>(req);
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(body.dataUrl ?? "");
  if (!match) return sendJson(res, 400, { error: "Behöver en närbild som data-URL" });
  const [, mimeType, base64] = match;

  const outcome = await assessAddedPhoto({ mimeType, base64 }, body.partHint ?? null);
  if (!outcome.isDamage || !outcome.defect) {
    return sendJson(res, 200, { added: false, reason: outcome.reason, result: job.result });
  }

  const dir = jobDir(jobId);
  const filename = `added_${Date.now()}.jpg`;
  const abs = path.join(dir, "originals", filename);
  await writeFile(abs, Buffer.from(base64, "base64"));
  const { width, height } = await getImageDimensions(abs);
  const image: CapturedImage = {
    id: randomUUID(),
    viewLabel: "Närbild",
    source: "manual",
    width,
    height,
    path: filename,
    capturedAt: new Date().toISOString(),
  };
  job.result.images.push(image);

  const index = job.result.images.length - 1;
  // The close-up IS the evidence, framed generously since the seller aimed at the damage.
  const raw = { ...outcome.defect, evidence: [{ image_index: index, mark_kind: "box" as const, x: 0.15, y: 0.15, w: 0.7, h: 0.7 }] };
  const damage = mapRawDefect(raw, job.result.images, `added_${index}`);
  damage.verification = "CONFIRMED";
  damage.verificationReason = outcome.reason;
  damage.sellerAdded = true;
  job.result.damages.push(damage);

  await regradeAndReprice(job);
  sendJson(res, 200, { added: true, reason: outcome.reason, damage, result: job.result });
}

interface AddDamageBody {
  type: DamageType;
  part: string;
  semanticLocation?: string;
  severity: Severity;
  impact: Impact;
  description: string;
}

async function handleAddDamage(jobId: string, req: IncomingMessage, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job || !job.result) return sendJson(res, 404, { error: "Job or result not found" });

  const body = await readJsonBody<AddDamageBody>(req);
  if (!body.type || !body.part || !body.severity || !body.impact || !body.description) {
    return sendJson(res, 400, { error: "type, part, severity, impact, description are required" });
  }

  const damage: Damage = {
    id: `manual_${randomUUID()}`,
    type: body.type,
    part: body.part,
    semanticLocation: body.semanticLocation ?? "",
    severity: body.severity,
    impact: body.impact,
    description: body.description,
    confidence: 100,
    verification: "CONFIRMED",
    verificationReason: "Tillagd manuellt av säljaren.",
    evidence: [],
    recaptureRequested: false,
    sellerAction: "confirmed",
    sellerAdded: true,
  };

  job.result.damages.push(damage);
  await regradeAndReprice(job);
  sendJson(res, 200, job.result);
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const segments = url.pathname.split("/").filter(Boolean);

  // Public API. Its own namespace so the local UI keeps working through /api without a key.
  if (segments[0] === "v1" && segments[1] === "condition") {
    try {
      if (segments.length === 2 && req.method === "POST") return await handleApiCreate(req, res);
      if (segments.length === 3 && req.method === "GET") return await handleApiGet(segments[2], req, res);
      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  }

  try {
    if (segments[0] === "health") {
      return sendJson(res, 200, { ok: true, service: "condition-grading-server" });
    }

    if (segments[0] === "api") {
      /**
       * Den publika annonsen, före grinden.
       *
       * Kortet ÄR publikt: Tradera-annonsen bär ett Loopa-ID, och den som läser annonsen har inget
       * konto hos oss. Vägen är läsande, tar inget jobb-id och lämnar aldrig ut ägaren eller
       * säljarens egna bildrutor — se publicCard.ts för vad som följer med.
       */
      if (segments[1] === "cards" && segments.length === 3 && req.method === "GET") {
        return await handleGetPublicCard(segments[2], res);
      }
      if (segments[1] === "cards" && segments.length === 4 && segments[3] === "chat" && req.method === "POST") {
        return await handleCardChat(segments[2], req, res);
      }
      if (segments[1] === "cards" && segments.length === 4 && segments[3] === "cover" && req.method === "GET") {
        return await handleGetPublicCover(segments[2], res);
      }

      /**
       * EN grind framför hela /api.
       *
       * Tidigare krävde ingen av de här vägarna något alls — nyckeln skyddade bara /v1/condition.
       * På 127.0.0.1 var det försvarbart; på en publik adress betyder det att vem som helst kan
       * starta besiktningar på din Gemini-kvot och läsa vilket jobb som helst vars id de får tag i.
       *
       * Kontrollen sitter här och inte i varje hanterare med flit: fjorton vägar som var och en
       * måste komma ihåg att fråga är fjorton tillfällen att glömma.
       */
      const identity = await identityFromRequest(req);
      if (!identity) return sendJson(res, 401, { error: "Inloggning krävs." });

      if (segments[1] === "session" && segments.length === 2 && req.method === "POST") {
        return handleCreateSession(req, res, identity);
      }

      /**
       * Adminpanelen. Ligger bakom samma inloggning som allt annat under /api, med rollen prövad en
       * gång här — och svarar 404 för alla andra, av samma skäl som ägarskapet nedan gör det.
       */
      if (segments[1] === "admin") {
        if (!identity.isAdmin) return sendJson(res, 404, { error: "Not found" });
        if (segments[2] === "users" && segments.length === 3 && req.method === "GET") {
          return await handleAdminUsers(req, res);
        }
        if (segments[2] === "users" && segments.length === 5 && segments[4] === "jobs" && req.method === "GET") {
          return await handleAdminUserJobs(segments[3], res);
        }
        return sendJson(res, 404, { error: "Not found" });
      }

      /**
       * Ägarskapet prövas på samma ställe. 404 och inte 403 — ett 403 vore ett besked om att jobbet
       * finns, vilket är precis vad den som gissar id:n är ute efter.
       *
       * En admin får LÄSA vilket jobb som helst, och bara läsa. Panelen finns för att se andras
       * annonser; att ändra i dem är säljarens sak, och en GET-gräns här gör den skillnaden
       * strukturell i stället för att lita på att panelen aldrig råkar skicka en POST.
       */
      if (segments[1] === "jobs" && segments.length >= 3) {
        const job = getJobSync(segments[2]) ?? (await getJob(segments[2]));
        const mayRead = !!job && (owns(job, identity) || (identity.isAdmin && req.method === "GET"));
        if (!mayRead) return sendJson(res, 404, { error: "Job not found" });
      }

      if (segments[1] === "price" && segments.length === 2 && req.method === "POST") {
        return await handlePreliminaryPrice(req, res);
      }

      if (segments[1] === "jobs") {
      if (segments.length === 2 && req.method === "POST") return await handleCreateJob(req, res, identity);
      if (segments.length === 2 && req.method === "GET") return await handleListJobs(res, identity);
      if (segments.length === 3 && req.method === "GET") return await handleGetJob(segments[2], res);
      if (segments.length === 4 && segments[3] === "debug" && req.method === "GET") {
        return await handleGetDebug(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "model" && req.method === "POST") {
        return await handleSelectModel(segments[2], req, res);
      }
      if (segments.length === 5 && segments[3] === "model" && segments[4] === "more" && req.method === "POST") {
        return await handleFindMoreCandidates(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "retry" && req.method === "POST") {
        return await handleRetry(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "price-plan" && req.method === "POST") {
        return await handleSetPricePlan(segments[2], req, res);
      }
      if (segments.length === 4 && segments[3] === "tradera") {
        if (req.method === "POST") return await handlePublishTradera(segments[2], res);
        if (req.method === "GET") return await handleGetTradera(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "blocket" && req.method === "GET") {
        return await handleGetBlocket(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "cover" && req.method === "GET") {
        return await handleGetCover(segments[2], res);
      }
      if (segments.length === 5 && segments[3] === "images" && req.method === "GET") {
        return await handleGetImage(segments[2], segments[4], res);
      }
      if (segments.length === 5 && segments[3] === "crops" && req.method === "GET") {
        return await handleGetCrop(segments[2], segments[4], res);
      }
      if (segments.length === 5 && segments[3] === "damages" && segments[4] === "from-photo" && req.method === "POST") {
        return await handleAddFromPhoto(segments[2], req, res);
      }
      if (segments.length === 4 && segments[3] === "damages" && req.method === "POST") {
        return await handleAddDamage(segments[2], req, res);
      }
      if (segments.length === 6 && segments[3] === "damages" && segments[5] === "dispute" && req.method === "POST") {
        return await handleDispute(segments[2], segments[4], req, res);
      }
      if (segments.length === 5 && segments[3] === "damages" && req.method === "POST") {
        return await handleDamageAction(segments[2], segments[4], req, res);
      }
      }
    }

    // Allt som inte är API är UI. Ligger bygget inte där svarar vi som förut, med 404 i JSON — det
    // är läget i utveckling, där sidan kommer från vite.
    if (req.method === "GET" && (await serveStatic(url.pathname, res))) return;

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Loopback som förval, och det ska det förbli.
 *
 * Skälet har ändrats: /api är inte längre oautentiserat, men servern har fortfarande ingen anledning
 * att synas på det lokala nätet. Cloudflare-tunneln kopplar upp sig UTIFRÅN maskinen mot 127.0.0.1,
 * så publiceringen kräver ingen öppen port. BIND_HOST finns för den som ändå kör bakom en egen
 * omvänd proxy på en annan maskin.
 */
const BIND_HOST = process.env.BIND_HOST ?? "127.0.0.1";

void failOrphanedJobs().then((n) => {
  if (n > 0) console.warn(`[condition-grading] ${n} avbrutna jobb märktes som fel vid uppstart`);
});

// Prisstegen lever i den här processen. Den är avstängd av sig själv när Tradera inte är
// konfigurerat — utan konto finns ingen annons att sänka priset på.
startPriceLadderScheduler();

server.listen(PORT, BIND_HOST, () => {
  console.log(`[condition-grading-server] listening on http://${BIND_HOST}:${PORT}`);
  if (mediaSecretIsEphemeral()) {
    console.warn(
      "[condition-grading-server] MEDIA_COOKIE_SECRET saknas — bildkakor slumpas per start och slutar " +
        "gälla vid omstart. Sätt den i server/.env innan drift.",
    );
  }
  if (!process.env.CONDITION_SERVICE_KEY) {
    console.info("[condition-grading-server] CONDITION_SERVICE_KEY saknas — mätharnessen kan inte logga in.");
  }
  void distExists().then((yes) => {
    console.log(yes ? "[condition-grading-server] serverar web/dist" : "[condition-grading-server] web/dist saknas — kör npm run web:build för att servera UI:t härifrån");
  });
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "[condition-grading-server] WARNING: GEMINI_API_KEY is not set. Analysis requests will fail until it is configured " +
        "(see experiments/condition-grading/server/.env.example).",
    );
  }
});
