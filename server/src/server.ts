import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file yet — GEMINI_API_KEY must be set some other way, checked below.
}
import { createJob, getJob, jobDir, listJobs, persist, getDebugTrace } from "./jobStore.js";
import { runConditionGrading } from "./pipeline/run.js";
import { gradeCondition } from "./pipeline/grade.js";
import { adjudicateDispute } from "./pipeline/dispute.js";
import { checkApiKey } from "./apiAuth.js";
import { assessAddedPhoto } from "./pipeline/addFromPhoto.js";
import { mapRawDefect } from "./pipeline/inspect.js";
import { loadImageAsBase64 } from "./imageUtils.js";
import { getImageDimensions } from "./imageUtils.js";
import { MAX_IMAGES_PER_JOB } from "./config.js";
import type { CapturedImage, Damage, DamageType, Impact, Severity } from "./types.js";

const PORT = Number(process.env.PORT ?? 8799);
const MAX_BODY_BYTES = 60 * 1024 * 1024; // up to ~10 camera-resolution JPEGs as base64

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
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
  /** Already curated by the client: selected video frames + any manual photos. No server-side selection. */
  images: Array<{ dataUrl: string; viewLabel?: string | null; source?: "video" | "manual" }>;
}

/**
 * The one place a job is created. Both the local web UI and the public API go through this, so the API
 * cannot drift from what the app does — "exactly the same pipeline" is structural, not a promise.
 */
async function createConditionJob(body: CreateJobBody): Promise<{ jobId: string; imageCount: number } | { error: string }> {
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { error: "At least one image is required" };
  }
  const job = await createJob(body.productContext ?? null);
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

  // Fire and forget: the caller polls for progress.
  void runConditionGrading(job.id, images, body.productContext ?? null);
  return { jobId: job.id, imageCount: images.length };
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse) {
  const out = await createConditionJob(await readJsonBody<CreateJobBody>(req));
  if ("error" in out) return sendJson(res, 400, out);
  sendJson(res, 202, out);
}

async function handleGetJob(id: string, res: ServerResponse) {
  const job = await getJob(id);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  sendJson(res, 200, job);
}

async function handleGetDebug(id: string, res: ServerResponse) {
  const trace = await getDebugTrace(id);
  if (!trace) return sendJson(res, 404, { error: "No debug trace for this job (not finished, or job not found)" });
  sendJson(res, 200, trace);
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

async function handleListJobs(res: ServerResponse) {
  const jobs = await listJobs();
  sendJson(
    res,
    200,
    jobs.map((j) => ({
      id: j.id,
      createdAt: j.createdAt,
      progress: j.progress,
      grade: j.result?.grade ?? null,
      thumbnailImageId: j.result?.images[0]?.id ?? null,
      error: j.error,
    })),
  );
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

  job.result.grade = gradeCondition(job.result.damages, job.result.overallCondition);
  await persist(job);
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

  job.result.grade = gradeCondition(job.result.damages, job.result.overallCondition);
  await persist(job);
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

  job.result.grade = gradeCondition(job.result.damages, job.result.overallCondition);
  await persist(job);
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
  job.result.grade = gradeCondition(job.result.damages, job.result.overallCondition);
  await persist(job);
  sendJson(res, 200, job.result);
}

const server = http.createServer(async (req, res) => {
  setCors(res);
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

    if (segments[0] === "api" && segments[1] === "jobs") {
      if (segments.length === 2 && req.method === "POST") return await handleCreateJob(req, res);
      if (segments.length === 2 && req.method === "GET") return await handleListJobs(res);
      if (segments.length === 3 && req.method === "GET") return await handleGetJob(segments[2], res);
      if (segments.length === 4 && segments[3] === "debug" && req.method === "GET") {
        return await handleGetDebug(segments[2], res);
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

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// Loopback ONLY. The whole /api surface is unauthenticated — it is what the local UI talks to — and
// binding to every interface put it on the network for anyone on the same WiFi to call without a key.
// The phone still reaches it: it loads the page from vite, and vite proxies /api from this machine.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[condition-grading-server] listening on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "[condition-grading-server] WARNING: GEMINI_API_KEY is not set. Analysis requests will fail until it is configured " +
        "(see experiments/condition-grading/server/.env.example).",
    );
  }
});
