import { GoogleGenAI, Type, MediaResolution } from "@google/genai";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export { Type };

// Model choice, re-measured 2026-08-26 against the real workload (7 walkaround frames, the full taxonomy
// prompt, the full structured schema). The previous note here claimed the opposite ordering; that is no
// longer true and cost three failed runs to discover:
//
//   gemini-3.6-flash   7 images -> answered in 11.6s
//   gemini-3.5-flash   7 images -> no response in 45s
//   gemini-3.5-flash   2 images -> no response in 45s   (so it is the model, not the payload size)
//
// gemini-3.5-flash still appears in models.list() for this key but never answers generateContent, so it
// is useless as either primary or fallback. gemini-3.7-flash at least returns a real response (503 "high
// demand", which Google documents as temporary) and is the more plausible retry target of what is left.
export const GEMINI_MODEL = "gemini-3.6-flash";
// Retry target after a primary failure. This went back and forth on measurements taken hours apart, so
// the reasoning matters more than the choice:
//
// Retrying the SAME model is right when failures are timeouts — the model works, it was just slow, and
// a different model has no better odds. That is what the earlier measurements showed.
//
// It is exactly WRONG when the failure is a quota error. Free-tier quota is granted per model
// (GenerateRequestsPerDayPerProjectPerModel), so a 429 on the primary means a retry on the primary is
// guaranteed to fail while another model still has its own allowance untouched. Measured live:
// gemini-3.6-flash returned 429 while gemini-3.7-flash answered on the same key, same moment.
//
// So the retry goes to a DIFFERENT model, which covers the quota case, and costs nothing extra in the
// timeout case beyond what a same-model retry would have cost.
const RETRY_MODEL = "gemini-3.7-flash";

const CACHE_DIR = path.resolve(import.meta.dirname, "..", "data", "cache");

let client: GoogleGenAI | null = null;

/** Throws a clear, actionable error if GEMINI_API_KEY is missing. Never falls back to fake data. */
export function getGeminiClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Condition Grading calls Gemini directly (not via the Lovable gateway) " +
        "and refuses to fabricate results. Set GEMINI_API_KEY in experiments/condition-grading/server/.env " +
        "(get a key at https://aistudio.google.com/apikey) and restart the server.",
    );
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

export interface ImagePart {
  mimeType: string;
  base64: string;
  /**
   * Optional text emitted immediately BEFORE this image, so the model can address it by name
   * ("Utsnitt 3"). Without it a numbered image list is only a claim in the prompt — the images
   * themselves arrive unlabelled and the model has to count its way to them.
   */
  label?: string;
}

export interface GeminiCallResult<T> {
  data: T;
  tokensUsed: number;
  cached: boolean;
  purpose: string;
  modelUsed: string;
  latencyMs: number;
}

const RESOLUTION_MAP: Record<"low" | "medium" | "high", MediaResolution> = {
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  high: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

function hashCall(model: string, systemPrompt: string, userPrompt: string, responseSchema: object, images: ImagePart[]): string {
  const h = createHash("sha256");
  h.update(model);
  h.update(" ");
  // The schema shapes the answer as much as the prompt does — changing it and replaying a cached
  // response would serve an answer to a question that was never asked in that form.
  h.update(JSON.stringify(responseSchema));
  h.update(" ");
  h.update(systemPrompt);
  h.update(" ");
  h.update(userPrompt);
  for (const img of images) {
    h.update(" ");
    h.update(img.mimeType);
    // The label is part of the request, so it must be part of the key — otherwise relabelling the
    // same bytes would silently replay a cached answer to a different question.
    h.update(img.label ?? "");
    h.update(createHash("sha256").update(img.base64).digest("hex"));
  }
  return h.digest("hex");
}

interface CacheEntry {
  data: unknown;
  tokensUsed: number;
  modelUsed: string;
}

async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(path.join(CACHE_DIR, `${key}.json`), "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(key: string, entry: CacheEntry): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(entry), "utf-8");
}

// Requests that will NEVER succeed on retry (bad key, bad request shape) skip straight to failure —
// no point burning the fallback attempt on them.
const NON_RETRYABLE_MARKERS = ["400", "401", "403", "404", "INVALID_ARGUMENT", "PERMISSION_DENIED", "UNAUTHENTICATED", "API_KEY_INVALID"];
// Defaults for a small/simple call. The main inspection call (bigger payload, bigger schema) passes its
// own more generous primaryTimeoutMs — measured live, 15s was cutting off gemini-3.6-flash before it
// finished a 6-image call, forcing an UNNECESSARY fallback that made the run slower overall, not faster.
// 10s is a hard floor: the API itself rejects any httpOptions.timeout below 10000ms with a 400
// ("Minimum allowed deadline is 10s"), also discovered live — every value below MUST clamp to this.
const MIN_TIMEOUT_MS = 10_000;
const DEFAULT_PRIMARY_TIMEOUT_MS = MIN_TIMEOUT_MS;
const DEFAULT_FALLBACK_TIMEOUT_MS = MIN_TIMEOUT_MS;

/**
 * Single structured-output Gemini call, cached on disk by (model, prompts, image bytes) hash so
 * re-running the same job (or the frontend's "analyze again") never re-spends tokens on identical input.
 *
 * Resilience is deliberately minimal for this latency-critical MVP: ONE attempt on the primary model; if
 * that fails or times out (and the error looks transient), exactly ONE attempt on the fallback model. No
 * exponential backoff, no multi-minute retry chains — a slow/unavailable model should fail fast, not hang.
 */
export async function callGeminiStructured<T>(opts: {
  /** short label for debug traces, e.g. "main_inspection" — does not affect caching */
  purpose: string;
  systemPrompt: string;
  userPrompt: string;
  images: ImagePart[];
  responseSchema: object;
  /** "low" for cheap/simple passes, "high" (default) for anything defect-relevant */
  resolution?: "low" | "medium" | "high";
  primaryTimeoutMs?: number;
  fallbackTimeoutMs?: number;
}): Promise<GeminiCallResult<T>> {
  const resolution = opts.resolution ?? "high";
  // Keyed per MODEL. The key has to be computed before the call, when it is not yet known which model
  // will answer, so a fallback answer used to be written under the primary's key and then replayed as
  // if the primary had produced it — silently hiding that the primary never responded. Writes now go
  // under the answering model's key, and a read that finds a mismatched modelUsed is treated as a miss
  // so any entry already poisoned on disk self-heals.
  const cacheKeyFor = (model: string) =>
    hashCall(`${model}:${resolution}`, opts.systemPrompt, opts.userPrompt, opts.responseSchema, opts.images);
  const cached = await readCache(cacheKeyFor(GEMINI_MODEL));
  if (cached && cached.modelUsed === GEMINI_MODEL) {
    return { data: cached.data as T, tokensUsed: cached.tokensUsed, cached: true, purpose: opts.purpose, modelUsed: cached.modelUsed, latencyMs: 0 };
  }

  const ai = getGeminiClient();
  const generate = (model: string, timeoutMs: number) =>
    ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: opts.userPrompt },
            ...opts.images.flatMap((img) => {
              const image = { inlineData: { mimeType: img.mimeType, data: img.base64 } };
              return img.label ? [{ text: img.label }, image] : [image];
            }),
          ],
        },
      ],
      config: {
        systemInstruction: opts.systemPrompt,
        responseMimeType: "application/json",
        responseSchema: opts.responseSchema,
        temperature: 0,
        mediaResolution: RESOLUTION_MAP[resolution],
        httpOptions: { timeout: timeoutMs },
      },
    });

  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof generate>>;
  let modelUsed = GEMINI_MODEL;
  try {
    response = await generate(GEMINI_MODEL, Math.max(MIN_TIMEOUT_MS, opts.primaryTimeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The primary's failure used to be swallowed entirely, so a silently-broken primary model looked
    // exactly like a slow one and only the retry's error ever surfaced. Always say what happened.
    console.warn(`[gemini] ${opts.purpose}: ${GEMINI_MODEL} failed — ${message.slice(0, 200)}`);
    const nonRetryable = NON_RETRYABLE_MARKERS.some((m) => message.includes(m));
    if (nonRetryable) throw err;
    console.warn(`[gemini] ${opts.purpose}: one retry on ${RETRY_MODEL}`);
    modelUsed = RETRY_MODEL;
    response = await generate(RETRY_MODEL, Math.max(MIN_TIMEOUT_MS, opts.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS));
  }
  const latencyMs = Date.now() - startedAt;

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }
  const data = JSON.parse(text) as T;
  const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

  await writeCache(cacheKeyFor(modelUsed), { data, tokensUsed, modelUsed });
  return { data, tokensUsed, cached: false, purpose: opts.purpose, modelUsed, latencyMs };
}
