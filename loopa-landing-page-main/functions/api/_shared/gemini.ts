// Shared Gemini call plumbing used by every Cloudflare Pages Function that
// talks to Gemini (generate-listing.ts, seller/review-photo.ts,
// seller/shot-plan.ts). Extracted so the reliability behavior — primary
// model first, fallback ONLY on a retryable failure, jittered pause before
// the fallback attempt, per-call timeout — is defined once and can't drift
// between endpoints.
//
// Model selection for this shared helper (used by generate-listing.ts and
// the seller/* endpoints) is owned entirely by this file, not by Cloudflare
// environment variables — no GEMINI_MODEL_PRIMARY/GEMINI_MODEL_FALLBACK read
// here. The only Gemini secret this helper requires is GEMINI_API_KEY.
// Changing which model runs is a code change (edit PRIMARY_MODEL/
// FALLBACK_MODEL below), never a deployment-config change — that keeps model
// routing reviewable, testable, and identical across every environment
// (local dev, preview, production) instead of quietly drifting per-environment.
//
// Two OTHER, unrelated functions still read their own env-driven model config
// independently of this helper: functions/api/chat.ts (GEMINI_MODEL, a single
// cheap model for the Ask Loopa bot) and functions/api/brand-preview.ts
// (its own GEMINI_MODEL_PRIMARY/FALLBACK). Neither is in scope here —
// brand-preview.ts is explicitly do-not-touch, and chat.ts is a separate,
// simpler bot unrelated to this pipeline.

export interface GeminiEnv {
  GEMINI_API_KEY?: string
  AI_GATEWAY_URL?: string
}

/** Hardcoded, not env-driven — see file header. Used by the heavy grounded research/structuring pipeline (generate-listing.ts) — NOT by photo review, which needs its own much faster path (see FAST_REVIEW_MODEL below). */
export const PRIMARY_MODEL = 'gemini-3.7-flash'
export const FALLBACK_MODEL = 'gemini-3.6-flash'

/**
 * Dedicated fast path for the seller photo-review gate (functions/api/seller/
 * review-photo.ts) ONLY — a trivial accept/reject vision task that must feel
 * instant, not the heavy grounded-research task PRIMARY_MODEL/FALLBACK_MODEL
 * are for. Selected by direct comparison against this project's actual
 * available model list (queried via the Gemini ListModels API, not guessed):
 * gemini-2.5-flash-lite is deprecated (404s, Google's own error redirects to
 * 3.5-flash-lite); gemini-3.5-flash-lite handles image input + a tiny
 * responseSchema reliably and correctly at ~1.0-1.5s per call in real testing
 * (see docs/SELLER_MVP_ARCHITECTURE.md's performance section) — dramatically
 * faster than routing review through the heavy pipeline's models, which
 * needed a fallback nearly every time during testing and could take 15-30s+.
 * Single attempt, no fallback chain: a failure here should surface quickly as
 * a genuine review_failed state (see callGeminiFast), not spend more time
 * retrying — speed is the whole point of this path.
 */
export const FAST_REVIEW_MODEL = 'gemini-3.5-flash-lite'

/**
 * Applied to every call this helper makes, primary AND fallback alike
 * (verified against the Listing Genie reference implementation). Injected
 * centrally here rather than by each call site, so it can't be forgotten on
 * a new endpoint.
 */
const SERVICE_TIER = 'priority'

/**
 * VAD som gick fel, inte bara om det får göras om.
 *
 * `retryable` slår ihop två fall som kräver motsatt beslut. En 503 "The model is overloaded" kommer
 * tillbaka på ett par hundra millisekunder och gäller EN modell — där är ett omförsök på en annan
 * modell nästan gratis och nästan alltid rätt. En timeout har tvärtom redan bränt hela budgeten, och
 * att skicka om samma nyttolast till en LÅNGSAMMARE modell är att lova något tiden inte räcker till.
 *
 * Anroparen kan inte skilja dem åt på `retryable` — båda är sanna — så den får skilja dem åt här.
 */
export type GeminiFailureKind = 'http' | 'timeout' | 'deadline' | 'network'

export class GeminiCallError extends Error {
  retryable: boolean
  kind: GeminiFailureKind
  /** HTTP-statusen, satt när kind === 'http'. 429 = kvot, 503 = överbelastad. */
  status?: number
  constructor(message: string, retryable: boolean, kind: GeminiFailureKind = 'http', status?: number) {
    super(message)
    this.retryable = retryable
    this.kind = kind
    this.status = status
  }
}

/**
 * Föll anropet SNABBT på något som gäller just den här modellen?
 *
 * 429 (kvot per modell), 5xx (överbelastning) och nätverksfel svarar direkt och säger ingenting om
 * huruvida en annan modell kan svara — Googles kvot är per modell, och överbelastningen likaså. Det
 * är precis de fallen där ett omförsök på en ANNAN modell är värt sin sekund. Timeout och överskriden
 * deadline är inte med: de har redan använt tiden som omförsöket skulle behöva.
 */
export function modelUnavailable(err: unknown): boolean {
  return err instanceof GeminiCallError && err.retryable && (err.kind === 'http' || err.kind === 'network')
}

/** Recoverable-failure classification — the ONLY conditions that trigger a fallback attempt. A schema/application bug in a 200 response is never retryable through here; it must surface as a real error from the caller's own parsing. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

async function callGeminiOnce(
  model: string,
  apiKey: string,
  gatewayUrl: string | undefined,
  body: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<any> {
  const base = gatewayUrl
    ? `${gatewayUrl.replace(/\/$/, '')}/google-ai-studio/v1beta/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  const requestBody = { ...(body as Record<string, unknown>), serviceTier: SERVICE_TIER }

  const controller = new AbortController()
  // An externally-supplied signal (the seller pipeline's single overall
  // deadline) aborts this attempt too — so no in-flight Gemini request can
  // outlive the request budget that was already decided upstream.
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${base}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[gemini] model=${model} outcome=http_${res.status} ms=${Date.now() - startedAt}`)
      throw new GeminiCallError(`gemini ${model} ${res.status}: ${text.slice(0, 300)}`, isRetryableStatus(res.status), 'http', res.status)
    }
    const parsed = await res.json()
    console.log(`[gemini] model=${model} outcome=ok ms=${Date.now() - startedAt} out_tokens=${(parsed as any)?.usageMetadata?.candidatesTokenCount ?? '?'} in_tokens=${(parsed as any)?.usageMetadata?.promptTokenCount ?? '?'}`)
    return parsed
  } catch (err) {
    if (err instanceof GeminiCallError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      const cause = externalSignal?.aborted ? 'deadline' : 'timeout'
      console.error(`[gemini] model=${model} outcome=${cause} ms=${Date.now() - startedAt}`)
      throw new GeminiCallError(`gemini ${model} aborted (${cause}) after ${Date.now() - startedAt}ms`, cause !== 'deadline', cause === 'deadline' ? 'deadline' : 'timeout')
    }
    console.error(`[gemini] model=${model} outcome=network_error ms=${Date.now() - startedAt}`)
    throw new GeminiCallError(`gemini ${model} network error: ${err instanceof Error ? err.message : String(err)}`, true, 'network')
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Primary first; fallback ONLY on a retryable failure (timeout, 429, 5xx,
 * network error — see isRetryableStatus); at most 2 attempts total; identical
 * body both times, both at serviceTier "priority". A jittered 0.5-1.5s pause
 * before the fallback attempt, and an optional total budget so a slow primary
 * can't starve the fallback of time.
 */
export async function callGeminiWithFallback(env: GeminiEnv, body: unknown, timeoutMs: number, budgetMs?: number): Promise<any> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
  const startedAt = Date.now()

  try {
    return await callGeminiOnce(PRIMARY_MODEL, apiKey, env.AI_GATEWAY_URL, body, timeoutMs)
  } catch (err) {
    if (!(err instanceof GeminiCallError) || !err.retryable) throw err
    console.error(`[gemini] primary model (${PRIMARY_MODEL}) failed (${err.message}), falling back to ${FALLBACK_MODEL}`)
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000))
    const remaining = budgetMs != null ? budgetMs - (Date.now() - startedAt) : timeoutMs
    if (remaining <= 1000) {
      throw new GeminiCallError(`budget exhausted before fallback (${budgetMs}ms)`, true, 'deadline')
    }
    return await callGeminiOnce(FALLBACK_MODEL, apiKey, env.AI_GATEWAY_URL, body, Math.min(timeoutMs, remaining))
  }
}

/**
 * Single attempt against an explicitly named model, with an optional external
 * abort signal. Used by the seller fast path (functions/api/seller/generate.ts),
 * which owns its own orchestration: ONE overall request deadline, its own
 * per-call budgets, and a parallel hedge instead of a sequential primary→
 * fallback chain. That path must never inherit callGeminiWithFallback's
 * sequential second attempt — two chained attempts are exactly what pushed
 * seller generation past 140 seconds.
 *
 * Deliberately does not retry: retry policy belongs to the caller's budget.
 */
export async function callGeminiModel(
  env: GeminiEnv,
  model: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
  return callGeminiOnce(model, apiKey, env.AI_GATEWAY_URL, body, timeoutMs, signal)
}

/**
 * Single attempt against FAST_REVIEW_MODEL — no fallback chain, on purpose.
 * This path exists specifically so a photo review never waits out a 15-60s
 * timeout-then-fallback sequence; a failure here (network/5xx/timeout)
 * surfaces immediately as a genuine error so the caller can show a fast
 * review_failed/retry state instead.
 */
export async function callGeminiFast(env: GeminiEnv, body: unknown, timeoutMs: number): Promise<any> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
  return callGeminiOnce(FAST_REVIEW_MODEL, apiKey, env.AI_GATEWAY_URL, body, timeoutMs)
}

export function extractText(res: any): string {
  const parts = res?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim()
}
