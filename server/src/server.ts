import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file yet — GEMINI_API_KEY must be set some other way, checked below.
}
import { createJob, failOrphanedJobs, getJob, getJobSync, jobDir, listJobs, ownerIdOf, persist, getDebugTrace, watchJobDeadline } from "./jobStore.js";
import { createConditionJob, readIdentity, type CreateJobBody } from "./jobCreate.js";
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
import { blocketAdFor } from "./integrations/blocket/ad.js";
import { missingTraderaEnv, traderaConfigured } from "./integrations/tradera/tradera.js";
import { markBlocketPublishing, planBlocketPublish, runBlocketPublish } from "./integrations/blocket/publish.js";
import { blocketConfigured, blocketLivePublishing, missingBlocketEnv, sessionFileExists } from "./integrations/blocket/blocket.js";
import { markChannelsPublishing, planAutoPublish, runAutoPublish } from "./integrations/autoPublish.js";
import { makePriceLadder, startPriceLadderScheduler } from "./priceLadder.js";
import { coverFirst, resolveCoverImageId } from "./pipeline/cover.js";
import { loopaIdFor } from "./loopaId.js";
import { cutoutOf, jobByLoopaId, publicCardFor, publikaBildrutor } from "./publicCard.js";
import { harGodkantOmslag } from "./pipeline/bild/omslag.js";
import { handleButikOrderRead, handleButikRequest, handleButikWrite } from "./butik/routes.js";
import { flyttadAdress } from "./butik/seo.js";
import { handleAffar, handleAffarPublic } from "./affar/routes.js";
import { handleEfterlysning, handleEfterlysningPublic } from "./efterlysning/routes.js";
import { startEfterlysningSweeper } from "./efterlysning/matcher.js";
import { migrateBevakningar } from "./efterlysning/migrate.js";
import { store as affarStore } from "./affar/store.js";
import { attachScan } from "./affar/scan.js";
import { syncFromJobs } from "./butik/inventory.js";
import { startButikSweeper } from "./butik/sweeper.js";
import { bearerToken } from "./supabaseAuth.js";
import { avtryck, KLIENTHANDELSER, spara } from "./analys/store.js";
import { answerCardQuestion, MAX_QUESTION_CHARS, type ChatTurn } from "./cardChat.js";
import { handleTranscribeTour, type TranscribeBody } from "./voiceTour.js";
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

  /**
   * Rollen skrivs ut, en rad per inloggning.
   *
   * DET HÄR ÄR ENDA STÄLLET rollen avgörs, och den avgörs på ADRESSEN (admin.ts). När adminingången
   * uteblir är frågan alltid densamma — vilken adress såg servern? — och utan raden finns svaret
   * ingenstans: klienten får ett `false` som ser exakt likadant ut vare sig adressen inte stod i
   * listan, kontot var ett annat än man trodde, eller anropet aldrig kom fram.
   *
   * Adressen skrivs hel med flit. Ett maskat `vi***@ruiz.se` hade dolt just det som brukar vara fel
   * — en bokstav, en annan domän, ett testkonto man glömt att man satt inloggad som.
   */
  console.log(
    `[loopa] session: ${identity.email ?? "adress okänd"} → ${identity.isAdmin ? "ADMIN" : "vanlig användare"}`,
  );

  // Klienten får veta om den ska rita adminingången här, i anropet den ändå gör vid varje inloggning.
  // Rollen avgörs på servern; svaret är bara en upplysning om vad den kom fram till.
  sendJson(res, 200, { ok: true, isAdmin: identity.isAdmin });
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse, identity: Identity) {
  // Ägaren avgörs HÄR, vid uppladdningen, och aldrig senare. En annons som får sin profil
  // efteråt är en annons som kan hamna i fel — filmningen och kontot hör ihop från början.
  const body = await readJsonBody<CreateJobBody>(req);

  /**
   * En skanning får bara knytas till en affär av affärens EGEN säljare.
   *
   * Utan kontrollen kan vem som helst skicka med ett `dealId` och därmed dels göra sitt eget jobb
   * osynligt i butiken, dels hänga en besiktning på någon annans affär. Prövningen sker här och inte
   * i affärsmodulen därför att det är här jobbet skapas — och märkningen måste sitta från början.
   */
  let dealId: string | null = null;
  if (body.dealId) {
    const deal = await affarStore().get(body.dealId);
    if (!deal || deal.sellerId !== identity.id) {
      return sendJson(res, 403, { error: "Du är inte säljare i den affären." });
    }
    dealId = deal.id;
  }

  const out = await createConditionJob(body, identity.id, dealId);
  if ("error" in out) return sendJson(res, 400, out);

  // Affären får veta vilket jobb som är dess. Skanningen är igång; tillståndsbytet till `scanned`
  // sker när besiktningen är klar — se attachScan.
  if (dealId) await attachScan(dealId, out.jobId, identity.id);

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
  void runConditionGrading(job.id, images, job.productContext ?? null, job.identity ?? null, job.sellerNotes ?? null);
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

/**
 * Läget för hela publiceringen, inte bara Traderas.
 *
 * Adressen heter `/tradera` för att det är den klienten redan pollar. Innehållet är numera båda
 * kanalerna: Tradera-fälten ligger kvar på toppnivå så den befintliga vyn fungerar oförändrad, och
 * Blocket plus `channels` ligger bredvid. Utan det här kunde gränssnittet inte veta att en annons går
 * att lägga ut fastän Tradera saknar nycklar — och dolde då knappen helt.
 */
async function handleGetTradera(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  const auto = await planAutoPublish(job);
  sendJson(res, 200, { ...(await traderaState(job)), blocket: await blocketPublishState(job), channels: auto.channels });
}

/**
 * Startar publiceringen och svarar direkt.
 *
 * PUBLICERAR PÅ ALLA KANALER SOM KAN TA EMOT ANNONSEN, inte bara Tradera. Rutten heter fortfarande
 * `/tradera` därför att det är den klienten redan trycker på, och att byta adress hade gjort en
 * beteendeändring till en trasig knapp. Vad som faktiskt händer står i `channels` i svaret.
 *
 * Ingen kanal kan hållas i ett HTTP-svar: Tradera köar annonsen i 10–60 s, och Blocket-roboten tar
 * minuter. Jobbet markeras som "publicerar" innan bakgrundsarbetet startar, så en andra tryckning
 * inte kan lägga upp samma möbel två gånger, och klienten pollar GET på samma väg.
 *
 * Svaret behåller Tradera-fälten på toppnivå av samma skäl — den befintliga vyn läser dem — och
 * lägger Blocket bredvid i stället för att bygga om formen.
 */
async function handlePublishAd(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });

  const auto = await planAutoPublish(job);
  const svar = async () => ({ ...(await traderaState(job)), blocket: await blocketPublishState(job), channels: auto.channels });

  if (auto.willPublish.length === 0) {
    // Ingen kanal kan ta emot annonsen. Skilj på "inget är påkopplat" (503, servern saknar
    // konfiguration) och "annonsen duger inte" (409, jobbet saknar något) — de lagas på olika håll.
    const running = auto.channels.filter((c) => c.alreadyRunning);
    if (running.length === auto.channels.length) {
      return sendJson(res, 409, { error: "Annonsen är redan publicerad, eller håller på att publiceras.", ...(await svar()) });
    }
    const unconfigured = auto.channels.filter((c) => !c.configured);
    if (unconfigured.length === auto.channels.length) {
      const saknas = unconfigured.map((c) => `${c.channel}: ${c.missingEnv.join(", ")}`).join(" — ");
      return sendJson(res, 503, { error: `Ingen publiceringskanal är konfigurerad på servern. Saknar ${saknas}.`, ...(await svar()) });
    }
    const reason = auto.channels.find((c) => c.configured && !c.ready)?.reason ?? "Annonsen går inte att publicera.";
    return sendJson(res, 409, { error: reason, ...(await svar()) });
  }

  await markChannelsPublishing(job, auto.willPublish);
  void runAutoPublish(job.id, auto.willPublish);
  sendJson(res, 202, await svar());
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

// ---- Blocket: lägger upp annonsen med en robot i Blockets eget formulär ----

/**
 * Allt klienten behöver för att rita knappen, speglat mot `traderaState`.
 *
 * Två fält som Tradera-motsvarigheten inte har, och båda finns för att Blocket inte är ett API:
 * `sessionMissing` (nycklarna räcker inte — någon måste ha loggat in för hand) och `dryRun` (knappen
 * fyller i allt men publicerar inte, tills BLOCKET_PUBLICERA=1 är satt på servern).
 */
async function blocketPublishState(job: ConditionJob) {
  const readiness = await planBlocketPublish(job);
  return {
    configured: blocketConfigured(),
    missingEnv: missingBlocketEnv(),
    sessionMissing: blocketConfigured() && !sessionFileExists(),
    dryRun: !blocketLivePublishing(),
    publication: job.blocket ?? null,
    plan: readiness.ok ? readiness.plan : null,
    blockedReason: readiness.ok ? null : readiness.reason,
  };
}

async function handleGetBlocketPublish(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  sendJson(res, 200, await blocketPublishState(job));
}

/**
 * Publicerar BARA på Blocket.
 *
 * Vid sidan av den gemensamma knappen, inte i stället för den: den här vägen finns för att kunna göra
 * om en Blocket-körning som gick fel utan att röra en Tradera-annons som redan ligger uppe.
 */
async function handlePublishBlocket(jobId: string, res: ServerResponse) {
  const job = await getJob(jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });

  if (!blocketConfigured()) {
    return sendJson(res, 503, {
      error: `Blocket är inte konfigurerat på servern. Saknar ${missingBlocketEnv().join(", ")}.`,
      ...(await blocketPublishState(job)),
    });
  }
  if (!sessionFileExists()) {
    return sendJson(res, 503, {
      error: "Sessionsfilen som BLOCKET_SESSION pekar på finns inte. Logga in på Blocket för hand och exportera om den.",
      ...(await blocketPublishState(job)),
    });
  }
  if (job.blocket?.status === "publishing") return sendJson(res, 202, await blocketPublishState(job));
  if (job.blocket?.status === "published") {
    return sendJson(res, 409, { error: "Annonsen ligger redan uppe på Blocket.", ...(await blocketPublishState(job)) });
  }

  const readiness = await planBlocketPublish(job);
  if (!readiness.ok) return sendJson(res, 409, { error: readiness.reason, ...(await blocketPublishState(job)) });

  await markBlocketPublishing(job);
  void runBlocketPublish(job.id);
  sendJson(res, 202, await blocketPublishState(job));
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
  /**
   * Butikens läge per möbel, slaget upp en gång för hela listan.
   *
   * `sale` nedan är TRADERA och bara Tradera — den sattes när "Sälj med Loopa" byggdes. Loopa Butik
   * kom efteråt och har sitt eget lager (butik/store.ts), och utan den här uppslagningen kunde
   * profilen inte skilja en möbel som ligger ute i vår egen butik från en som bara är sparad. Det är
   * den enda frågan en säljare öppnar profilen för att få svar på.
   */
  const shopByJob = new Map<string, { state: string; listedAt: string; soldAt: string | null; soldChannel: string | null; priceSek: number | null }>();
  try {
    const { store: butikStore } = await import("./butik/store.js");
    for (const r of await butikStore().all()) {
      if (r.jobId) {
        shopByJob.set(r.jobId, {
          state: r.state,
          listedAt: r.listedAt,
          soldAt: r.soldAt,
          soldChannel: r.soldChannel,
          priceSek: r.reservedPriceSek,
        });
      }
    }
  } catch {
    // Utan butikslager är varje jobb bara en sparad annons, som förut. Profilen ska inte falla på det.
  }
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
        // Samma omslag som kortet, i samma ordning: tillverkarens katalogbild först, säljarens egna
        // bildruta som reserv. Listan och kortet ska visa samma bild — två olika bilder av samma
        // möbel på två skärmar är sämre än vilken av dem som helst.
        coverImageUrl: j.result?.productImage?.url
          ?? j.productImage?.url
          ?? (j.result?.coverImageId ? `/api/jobs/${j.id}/images/${j.result.coverImageId}` : null),
        error: j.error,
        hasListing: listing?.status === "ok" && !!listing.result,
        listingTitle: listing?.result?.listing.title ?? null,
        // `tradera` sätts först när säljaren tryckt på "Sälj med Loopa", så ett kort utan den har
        // aldrig lagts ut. Profilen skiljer på de två: en möbel som säljs just nu är inte en sparad
        // annons, den ligger ute hos köparna.
        sale: j.tradera ? { status: j.tradera.status, url: j.tradera.url } : null,
        // Loopa Butiks eget läge. Null = möbeln har aldrig lagts in i butiken.
        shop: shopByJob.get(j.id) ?? null,
      };
    }),
  );
}

// ---- mätningen: /api/analys och visningsräkningen ---------------------------

/**
 * Loopa-ID:t ur en egenskap som kan bära ett.
 *
 * Klienten skickar `item_id` på produkthändelser och `produkt` på utbudsraden — samma sak under två
 * namn, för att namnen redan fanns i GA-anropen och att byta dem hade gjort de befintliga
 * dataLayer-mätningarna oläsbara. Här slås de ihop.
 */
function annonsUr(props: Record<string, unknown>): string | null {
  for (const nyckel of ["item_id", "produkt"]) {
    const v = props[nyckel];
    if (typeof v === "string" && /^LP-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

/**
 * Besökarens avtryck, för att kunna skilja en visning från en omladdning.
 *
 * Adressen tas ur X-Forwarded-For när den finns — servern står bakom nginx i drift
 * (deploy/oracle/) och skulle annars se samma proxy-IP för alla. Den lämnar aldrig den här raden:
 * `avtryck` hashar den med ett salt som byts vid varje omstart, och det är hashen som lagras.
 */
function besokare(req: IncomingMessage): string {
  const vidare = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(vidare) ? vidare[0] : vidare)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  return avtryck(ip, typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);
}

/** Sökrobotar räknas inte. En annons som "setts" 400 gånger av Googlebot är inte sedd av någon. */
const ROBOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|headless/i;

/**
 * Räknar en sidvisning. Väntar aldrig — en mätning får inte ligga i vägen för svaret.
 *
 * Serverräknad och inte klientmätt, av två skäl: anropet sker ändå (produktsidan och kortet hämtar
 * sin data härifrån), och en besökare ska inte kunna påstå visningar på någon annans annons.
 */
function raknaVisning(handelse: "annons_visning" | "kort_visning", id: string, req: IncomingMessage): void {
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
  if (ROBOT.test(ua)) return;
  void spara(handelse, id.trim().toUpperCase(), {}, besokare(req));
}

/**
 * Klientens händelser. Svarar 204 oavsett utfall — se anropsstället.
 *
 * Serverhändelser tas INTE emot här: `annons_visning` och `kort_visning` skrivs bara av servern
 * själv, och en väg som lät en besökare skicka in dem hade gjort visningssiffran till något vem som
 * helst kunde skriva.
 */
async function handleAnalys(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readJsonBody<{ event?: string; props?: Record<string, unknown> }>(req, 8 * 1024);
    const event = typeof body.event === "string" ? body.event : "";
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    if (KLIENTHANDELSER.has(event) && !ROBOT.test(ua)) {
      const props = body.props && typeof body.props === "object" ? body.props : {};
      await spara(event, annonsUr(props), props);
    }
  } catch {
    // En trasig kropp är inte värd ett felmeddelande — se anropsstället.
  }
  res.writeHead(204);
  return res.end();
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
 * Kortets omslag, slaget på Loopa-ID och utan inloggning: säljarens EGNA bildruta, orörd.
 *
 * Vägen serverade en tid urklippet — möbeln friklippt mot vitt eller mot sin egen suddade bakgrund.
 * Det är avvecklat: en mask som nästan lyckas ger en möbel med en tvättkorg fastvuxen i armstödet,
 * och redigerade foton som misslyckas ser värre ut än oredigerade som är tråkiga. Kortet visar
 * tillverkarens katalogbild när den finns, och den här bildrutan annars — se publicCard.ts.
 *
 * Kortet måste dessutom FINNAS publikt för att bilden ska lämnas ut: ett jobb utan färdig annons har
 * inget publikt kort, och då har det inget publikt omslag heller.
 */
async function handleGetPublicCover(loopaId: string, res: ServerResponse) {
  const job = await jobByLoopaId(loopaId);
  if (!job || !publicCardFor(job)) {
    return sendJson(res, 404, { error: "Vi hittade ingen annons med det Loopa-ID:t." });
  }
  /**
   * PRODUKTBILDEN FÖRST: säljarens möbel mot rent vitt, byggd av pipeline/bild/.
   *
   * Bara när kvalitetskontrollen godkänt den. Ett urklipp som flaggats för granskning finns på disk
   * — en människa ska kunna öppna det — men går inte ut här av sig självt. Frågan ställs på ett enda
   * ställe (`harGodkantOmslag`) så att den här porten och butikens rutnät inte kan svara olika; gör
   * de det pekar rutnätet på en bild porten vägrar lämna ut, och varje sådan ruta blir en trasig
   * bild.
   */
  const cutout = cutoutOf(job);
  if (harGodkantOmslag(cutout)) {
    const produktbild = path.join(jobDir(job.id), "cover", "cover.jpg");
    if (existsSync(produktbild)) return await streamFile(produktbild, res);
  }

  /**
   * Reserven: bildrutan som säljaren tog, med rummet kvar.
   *
   * Sämre som omslag och ändå rätt svar när urklippet uteblev — en möbel i ett vardagsrum säger vad
   * som säljs, en tom ruta säger ingenting. Exponeringen är oförändrad mot förut: det är samma
   * bildruta den här porten alltid lämnat ut.
   */
  const imageId = await resolveCoverImageId(job);
  const image = imageId ? findImage(job, imageId) : undefined;
  if (!image) return sendJson(res, 404, { error: "Annonsen har ingen bild." });
  await streamFile(path.join(jobDir(job.id), "originals", image.path), res);
}

/**
 * Bildrutan en skada syns i, publikt och slagen på Loopa-ID.
 *
 * Kortet räknar upp varje anmärkning i klartext. Den som läser "repa på vänster armstöd" har en
 * rimlig följdfråga — hur stor? — och den enda ärliga svaret är fotot med skadan utmärkt. Utan det
 * är skickrapporten ett påstående man får tro på.
 *
 * TRE SPÄRRAR, och de är hela gränsen:
 *
 *   1. Kortet måste finnas publikt. Inget färdigt annonsläge, ingen bild.
 *   2. Bild-id:t måste pekas ut av en KVARSTÅENDE skada — se publikaBildrutor. Den som gissar ett
 *      id kan alltså inte bläddra i filmningen, bara se de rutor kortet självt visar.
 *   3. Faller en skada bort ur rapporten tar den sin bild med sig ut ur porten samma sekund, för
 *      listan byggs ur samma filter som kortet.
 */
async function handleGetPublicDamageImage(loopaId: string, imageId: string, res: ServerResponse) {
  const job = await jobByLoopaId(loopaId);
  if (!job || !publicCardFor(job) || !publikaBildrutor(job).has(imageId)) {
    return sendJson(res, 404, { error: "Vi hittade ingen sådan bild." });
  }
  const image = findImage(job, imageId);
  if (!image) return sendJson(res, 404, { error: "Vi hittade ingen sådan bild." });
  await streamFile(path.join(jobDir(job.id), "originals", image.path), res);
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

  /**
   * Butiken har EN adress, och det är den i LOOPA_PUBLIC_URL.
   *
   * Butikssidorna nås numera under marknadsdomänen, via en router hos Cloudflare som skickar
   * /butik och /efterlyses hit (se deploy/cloudflare/loopa-router.js). Servern svarar fortfarande
   * på sitt eget värdnamn — tunneln kräver det — och utan raden nedan hade varje sida då legat på
   * två adresser med identiskt innehåll. Google räknar sådant som två sidor och delar värdet
   * mellan dem, vilket är precis tvärtemot varför flytten gjordes.
   *
   * BARA GET. En 301 på en POST är en trasig förfrågan: klienter får byta metod till GET på vägen,
   * och en kassa som förlorar sin kropp mitt i ett köp är värre än en dubblett i ett index.
   *
   * `x-forwarded-host` läses först och det är inte valfritt: routern framför oss anropar servern på
   * dess EGET namn, så utan huvudet ser servern sitt eget värdnamn, omdirigerar dit den redan står
   * och slingan blir oändlig. Huvudet går att förfalska, men det enda en förfalskning åstadkommer
   * är att en omdirigering uteblir.
   */
  if (req.method === "GET") {
    const bett = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? null;
    const dit = flyttadAdress(bett ? bett.split(",")[0].trim() : null, url.pathname, url.search);
    if (dit) {
      res.writeHead(301, { Location: dit });
      return res.end();
    }
  }

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
        raknaVisning("kort_visning", segments[2], req);
        return await handleGetPublicCard(segments[2], res);
      }

      /**
       * Mätningen, utanför grinden.
       *
       * MÅSTE vara det: den som tittar på en möbel är oftast inte inloggad, och det är just den
       * besökaren mätningen finns för. Vägen tar bara vitlistade händelsenamn och vitlistade
       * egenskaper (analys/store.ts) — en öppen skrivväg utan den listan är en gratis disk för vem
       * som helst på internet.
       *
       * Svarar 204 och aldrig något annat. `sendBeacon` i webbläsaren läser inte svaret, och ett
       * felmeddelande hit hade bara varit ett svar ingen läser — men som berättar för den som
       * provar vad som räknas.
       */
      if (segments[1] === "analys" && segments.length === 2 && req.method === "POST") {
        return await handleAnalys(req, res);
      }
      if (segments[1] === "cards" && segments.length === 4 && segments[3] === "chat" && req.method === "POST") {
        return await handleCardChat(segments[2], req, res);
      }
      if (segments[1] === "cards" && segments.length === 4 && segments[3] === "cover" && req.method === "GET") {
        return await handleGetPublicCover(segments[2], res);
      }
      if (segments[1] === "cards" && segments.length === 5 && segments[3] === "skada" && req.method === "GET") {
        return await handleGetPublicDamageImage(segments[2], segments[4], res);
      }

      /**
       * Butiken, före grinden och med flit.
       *
       * Rutnätet, kategorierna och produktsidorna ÄR den publika ingången: de ska gå att nå av en
       * sökmotor och av någon som aldrig hört talas om oss. Allt som kräver ett konto — reservation,
       * kassa, bevakningar — ligger kvar innanför grinden och prövar inloggningen för sig.
       */
      if (segments[1] === "butik") {
        // Läsande vägar: rutnätet, produktsidan, kategorierna, leveransbeskedet.
        if (await handleButikRequest(segments.slice(2), req, res, url)) return;
        /**
         * Stripes webhook, också utanför grinden.
         *
         * Stripe har inget konto hos oss och kan inte logga in. Den bevisar sig i stället med en
         * signatur över den råa kroppen, vilket är ett starkare bevis än en inloggning: bara den som
         * har vår webhook-hemlighet kan skriva den. Se parseWebhook.
         */
        if (segments[2] === "webhook") {
          if (await handleButikWrite(segments.slice(2), req, res, null)) return;
        }
        // AI-tolkningen av en sökning: publik av samma skäl som rutnätet — att söka efter en soffa
        // ska inte kräva ett konto.
        if (segments[2] === "tolka") {
          if (await handleButikWrite(segments.slice(2), req, res, null)) return;
        }
      }

      /**
       * Trygg affär, den publika halvan.
       *
       * `tolka` bedömer en annons utan att skapa något — köparen ska få se vad vi kan säga innan de
       * skapar konto. `inbjudan/:token` är säljarens vy, där token ÄR åtkomsten: en säljare som fått
       * en länk i Blockets chatt ska kunna läsa erbjudandet utan att registrera sig först.
       */
      if (segments[1] === "affar") {
        if (await handleAffarPublic(segments.slice(2), req, res)) return;
        // Allt annat under /api/affar faller igenom till grinden nedan.
        // Allt annat under /api/butik faller igenom till grinden nedan.
      }

      /**
       * Efterlysningens publika halva: tolka en mening, se ett direktsvep, läsa bevisremsan.
       *
       * Utanför grinden med flit. Köparen ska se att vi hittar saker INNAN de bestämt sig om oss —
       * att kräva ett konto för att få veta om tjänsten fungerar är att be om betalning före
       * leverans. Att SPARA kräver däremot konto: en bevakning åt någon vi inte kan nå är ett löfte
       * vi inte kan hålla.
       */
      if (segments[1] === "efterlysning") {
        if (await handleEfterlysningPublic(segments.slice(2), req, res)) return;
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
       * Butikens kontobundna vägar: kassan, ordern, returen.
       *
       * Innanför grinden med flit — en order ska ha en ägare, och en retur ska gå att knyta till
       * den som köpte. Bläddrandet ligger kvar utanför; se ovan.
       */
      if (segments[1] === "butik") {
        const who = { userId: identity.id, email: identity.email };
        if (await handleButikOrderRead(segments.slice(2), req, res, who)) return;
        if (await handleButikWrite(segments.slice(2), req, res, who)) return;
        return sendJson(res, 404, { error: "Not found" });
      }

      /**
       * Affärsrummet. Bara köparen och säljaren, och rollen prövas per affär inne i hanteraren —
       * inte här: vem som är vem beror på affären, inte på anropet.
       */
      if (segments[1] === "affar") {
        if (await handleAffar(segments.slice(2), req, res, { userId: identity.id, email: identity.email })) return;
        return sendJson(res, 404, { error: "Not found" });
      }

      /** Efterlysningens kontobundna halva: spara, lista, ändra, pausa, förnya. */
      if (segments[1] === "efterlysning") {
        if (await handleEfterlysning(segments.slice(2), req, res, { userId: identity.id, email: identity.email })) return;
        return sendJson(res, 404, { error: "Not found" });
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

        /**
         * Annonspanelen: allt vi fått in, med läge, priser, tider och mätning.
         *
         * EN RAD PER JOBB och inte per butiksvara — se adminAnnonser.ts. Listan är det enda stället i
         * produkten där ett jobb som aldrig blev en annons syns för en människa.
         */
        if (segments[2] === "annonser" && segments.length === 3 && req.method === "GET") {
          const { listaAnnonser } = await import("./adminAnnonser.js");
          return sendJson(res, 200, await listaAnnonser());
        }
        if (segments[2] === "annonser" && segments.length === 4 && req.method === "GET") {
          const { annonsDetalj } = await import("./adminAnnonser.js");
          const detalj = await annonsDetalj(segments[3]);
          if (!detalj) return sendJson(res, 404, { error: "Annonsen finns inte." });
          return sendJson(res, 200, detalj);
        }
        /**
         * Ändringen. PATCH och inte PUT: kroppen är en delmängd, och ett fält som inte nämns ska
         * lämnas i fred — skillnaden mellan "rör inte" och "sätt till tomt" är hela överstyrningen.
         */
        if (segments[2] === "annonser" && segments.length === 4 && req.method === "PATCH") {
          const { andraAnnons, AndringsFel } = await import("./adminAnnonser.js");
          try {
            const patch = await readJsonBody<Parameters<typeof andraAnnons>[1]>(req, 256 * 1024);
            return sendJson(res, 200, await andraAnnons(segments[3], patch, identity.id));
          } catch (err) {
            if (err instanceof AndringsFel) return sendJson(res, 400, { error: err.message });
            throw err;
          }
        }
        /**
         * Efterfrågepanelen: öppen efterfrågan per kategori, märke och prisband.
         *
         * Styr intaget och annonsutkasten. Rankad på OMÄTTAD efterfrågan — de som väntat utan att vi
         * hittat något alls — för det är den listan som säger vad vi ska be folk filma.
         *
         * Ingen köparidentitet, av samma skäl som på den publika väggen. Panelen behöver veta VAD
         * som söks, aldrig av vem.
         */
        if (segments[2] === "efterfragan" && req.method === "GET") {
          const { demandDashboard, toCsv } = await import("./efterlysning/wall.js");
          const rows = await demandDashboard();
          if (url.searchParams.get("format") === "csv") {
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="efterfragan.csv"',
            });
            return res.end(toCsv(rows));
          }
          return sendJson(res, 200, { rader: rows });
        }
        /**
         * Efterfrågeannonserna: godkännandekön.
         *
         * ALDRIG AUTONOMT. Utkasten genereras ur omättad efterfrågan och läggs i kö; en människa
         * godkänner, ändrar eller kastar. Publicering via API ligger bakom DEMAND_ADS_PUBLISH och är
         * av — och även påslagen kräver den ett godkännande först. En annons är Loopas ord i
         * offentligheten, på en budget som är riktiga pengar.
         */
        if (segments[2] === "demand-ads" && req.method === "GET") {
          const ads = await import("./efterlysning/demandAds.js");
          const state = url.searchParams.get("state") as never;
          const rows = await ads.list(state || undefined);
          if (url.searchParams.get("format") === "csv") {
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="efterfragan-annonser.csv"',
            });
            return res.end(ads.toCsv(rows.filter((a) => a.state === "approved")));
          }
          return sendJson(res, 200, { annonser: rows, publiceringPa: ads.publishingEnabled() });
        }
        if (segments[2] === "demand-ads" && segments[3] === "generera" && req.method === "POST") {
          const ads = await import("./efterlysning/demandAds.js");
          return sendJson(res, 200, await ads.generateDrafts());
        }
        if (segments[2] === "demand-ads" && segments.length === 4 && req.method === "POST") {
          const ads = await import("./efterlysning/demandAds.js");
          const body = await readJsonBody<{ beslut?: string; rubrik?: string; text?: string }>(req);
          if (body.beslut !== "approved" && body.beslut !== "rejected") {
            return sendJson(res, 400, { error: "beslut måste vara approved eller rejected." });
          }
          const ad = await ads.decide(segments[3], body.beslut, identity.email ?? identity.id, {
            headline: body.rubrik, body: body.text,
          });
          if (!ad) return sendJson(res, 404, { error: "Utkastet finns inte." });
          return sendJson(res, 200, { annons: ad });
        }
        /**
         * Tömningar: en känd hämtning matchas mot öppna efterlysningar innan något besiktigats.
         *
         * Breven lovar ett BESKED, inte en möbel — se clearance.ts. Läggs upp för hand av den som
         * bokat tömningen; vi har ingen väg in i någons flyttlista.
         */
        if (segments[2] === "tomningar" && req.method === "GET") {
          const t = await import("./efterlysning/clearance.js");
          return sendJson(res, 200, { tomningar: await t.list() });
        }
        if (segments[2] === "tomningar" && req.method === "POST") {
          const t = await import("./efterlysning/clearance.js");
          const body = await readJsonBody<{ namn?: string; hamtas?: string; besked?: string; poster?: unknown[] }>(req);
          if (!body.namn || !body.hamtas || !Array.isArray(body.poster) || body.poster.length === 0) {
            return sendJson(res, 400, { error: "namn, hamtas och minst en post krävs." });
          }
          const c = await t.create({
            name: body.namn.slice(0, 120),
            pickupDate: body.hamtas.slice(0, 10),
            verdictDate: body.besked?.slice(0, 10),
            expected: body.poster as never,
          });
          const skickade = await t.notifyForClearance(c);
          return sendJson(res, 201, { tomning: c, notiser: skickade.length });
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

      // Röstrundan (VOICE-TOUR.md): hela rundans ljud in, transkript med segment-tidsstämplar ut.
      // Bakom samma inloggningsgrind som allt annat — anropet kostar riktiga Aqua-pengar.
      if (segments[1] === "voice-tour" && segments.length === 3 && segments[2] === "transcribe" && req.method === "POST") {
        const body = await readJsonBody<TranscribeBody>(req);
        return await handleTranscribeTour(body, res);
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
        // POST publicerar på ALLA kanaler som kan ta emot annonsen, inte bara Tradera. Adressen är
        // kvar för att klienten redan trycker på den; se handlePublishAd.
        if (req.method === "POST") return await handlePublishAd(segments[2], res);
        if (req.method === "GET") return await handleGetTradera(segments[2], res);
      }
      if (segments.length === 4 && segments[3] === "blocket" && req.method === "GET") {
        return await handleGetBlocket(segments[2], res);
      }
      // /blocket är upptagen av den MANUELLA annonsen ovan — den som klistras in för hand. Roboten
      // ligger ett steg ner, så att båda kan finnas samtidigt.
      if (segments.length === 5 && segments[3] === "blocket" && segments[4] === "publicering") {
        if (req.method === "POST") return await handlePublishBlocket(segments[2], res);
        if (req.method === "GET") return await handleGetBlocketPublish(segments[2], res);
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

    /**
     * robots.txt och sitemap.xml.
     *
     * FÖRE serveStatic, och det är inte kosmetik: den serverar index.html för allt som inte är en
     * fil på disk (se static.ts), så utan de här raderna hade Googlebot fått en HTML-sida med
     * Content-Type text/html när den bad om robots.txt — vilket den tolkar som "ingen robots.txt
     * som går att läsa" och sitemapen som ett trasigt dokument.
     *
     * Byggs vid varje förfrågan ur lagerindexet, som redan är cachat i minnet. En kort
     * Cache-Control gör att en robot som frågar ofta inte bygger om den varje gång, utan att en
     * nypublicerad möbel behöver vänta på en utrullning för att stå med.
     */
    if (req.method === "GET" && url.pathname === "/robots.txt") {
      const { robotsTxt } = await import("./butik/sitemap.js");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.end(robotsTxt());
    }
    if (req.method === "GET" && url.pathname === "/sitemap.xml") {
      const { sitemapXml } = await import("./butik/sitemap.js");
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" });
      return res.end(await sitemapXml());
    }

    /**
     * /kop → /butik, permanent.
     *
     * Landningssidan på /kop är borttagen. Adressen står i delade länkar, i bokmärken, i sökresultat
     * och i toppradens "Köp" i äldre klienter — en 301 är det enda svaret som tar dem alla med sig,
     * och den enda som talar om för en sökmotor att flytta värdet till butiken.
     *
     * BARA ROTEN, och det är viktigare här än det låter: /kop/analysera är Trygg affärs ingång och
     * /kop/mina-efterlysningar är köparens egen lista. Båda ligger kvar, båda skulle dö av en
     * omdirigering på prefixet.
     *
     * Riktningen var tidigare den motsatta — /butik 301:ades hit. Den raden är borta med sidan.
     */
    if (url.pathname === "/kop" || url.pathname === "/kop/") {
      res.writeHead(301, { Location: "/butik" });
      return res.end();
    }

    // Allt som inte är API är UI. Ligger bygget inte där svarar vi som förut, med 404 i JSON — det
    // är läget i utveckling, där sidan kommer från vite.
    if (req.method === "GET" && (await serveStatic(url.pathname, res, url.search))) return;

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

/**
 * Butiken lär känna lagret vid uppstart: varje besiktigat och prissatt jobb får en post, och det som
 * redan ligger uppe på Tradera går live även här. Se syncFromJobs.
 */
void syncFromJobs().then(({ enrolled, published, withdrawn }) => {
  if (enrolled || published || withdrawn) {
    console.info(`[butik] ${enrolled} varor infogade, ${published} publicerade, ${withdrawn} tillbakadragna`);
  }
});

// Släpper reservationer som gått ut. Utan den låser en avbruten utcheckning möbeln för alltid.
startButikSweeper();

/**
 * Efterlysningarna: migrering en gång, sedan sveparen.
 *
 * Migreringen körs vid VARJE uppstart och är byggd för det — den hoppar över rader som redan har en
 * efterlysning och flyttar undan den gamla filen först när något faktiskt flyttats. Att köra den en
 * gång manuellt hade betytt att en miljö som deployas innan någon kommit ihåg det tappar sina
 * bevakningar tyst.
 */
void migrateBevakningar()
  .then((r) => { if (r.migrated) console.info(`[efterlysning] migrerade ${r.migrated} bevakningar`); })
  .catch((err) => console.warn("[efterlysning] migreringen föll:", err));
startEfterlysningSweeper();

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
