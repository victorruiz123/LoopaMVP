// Cloudflare Pages Function: POST /api/seller/shot-plan
//
// Adaptive shot planning: given the already-accepted frontal photo + brand +
// optional seller note, generate the REST of the guided capture sequence
// (the frontal shot itself is a fixed, hardcoded first step — never
// AI-planned, see src/features/seller/fixedShots.ts).
//
// Must feel INSTANT, same as photo review: one tiny, fast Gemini vision call
// on the same dedicated fast path (FAST_REVIEW_MODEL, see ../_shared/gemini.ts)
// — no Google Search, no grounding, no heavy pipeline model, no long
// reasoning. The client sends a small (~640px) review-derivative image, not
// the seller's full-quality accepted photo — that stays untouched for
// research/condition/listing.
//
// additionalShots is clamped server-side to 4-7 so the total guided sequence
// (frontal + additionalShots) always lands in the product's 5-8 target
// range, regardless of what the model returns. Subsequent shots are all
// skippable seller-side (see SellerFlow.tsx) so this is a target, not a trap.
//
// NO FAIL-OPEN: a genuine AI/network failure (or a response that fails to
// parse) returns { ok: false } — never a silently-substituted generic plan.
// padToMinimum() below is a different thing: it only tops up a REAL,
// successfully-parsed model response that came back thinner than the
// required minimum — it never runs in place of a failed call.

import { callGeminiFast, extractText, type GeminiEnv } from '../_shared/gemini'
import type { ShotPlan, ShotPlanShot } from '../../../src/features/seller/types'
import type { UploadedImage } from '../../../src/features/generator/schema'

type Env = GeminiEnv

// Generous relative to the ~1s typical latency measured in testing.
const TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 2 * 1024 * 1024 // client sends a ~640px derivative — a few hundred KB at most
const MIN_ADDITIONAL = 4
const MAX_ADDITIONAL = 7

function corsHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() })
}

/** Deliberately tiny — id/title/instruction only. No "purpose" field: nothing downstream reads it, so asking the model for it would only cost output tokens (and therefore latency) for nothing. */
const SHOT_PLAN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    shots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          title: { type: 'STRING' },
          instruction: { type: 'STRING' },
        },
        required: ['id', 'title', 'instruction'],
      },
    },
  },
  required: ['shots'],
} as const

function buildPrompt(brand: string, sellerNote: string): string {
  return `Bilden visar en produkt rakt framifrån (märke: "${brand}"${sellerNote ? `, säljarens notering: "${sellerNote}"` : ''}).

Avgör snabbt vilken typ av produkt det är och föreslå ${MIN_ADDITIONAL}-${MAX_ADDITIONAL} ytterligare bilder anpassade till just den produkttypen (en soffa behöver andra vinklar än en lampa eller tröja). Inkludera märkning/etikett om rimligt för produkttypen.

Varje bild: "id" (kort, t.ex. "angle_side"), "title" (2-4 svenska ord, t.ex. "Sidovinkel"), "instruction" (EN kort konkret svensk mening, t.ex. "Ta en bild snett från sidan.").

Svara EXTREMT kort. Inga förklaringar utöver detta.`
}

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const requestStart = Date.now()
  const { request, env } = context

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: 'Bilden är för stor.' }, 413)

  let body: { image?: UploadedImage; brand?: string; sellerNote?: string }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  const image = body.image
  if (!image || typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/') || typeof image.dataBase64 !== 'string' || !image.dataBase64) {
    return json({ ok: false, error: 'image must be a {mimeType, dataBase64} object' }, 400)
  }
  const brand = (body.brand || '').trim().slice(0, 120)
  if (!brand) return json({ ok: false, error: 'brand is required' }, 400)
  const sellerNote = (body.sellerNote || '').trim().slice(0, 500)

  if (!env.GEMINI_API_KEY) {
    return json({ ok: false, error: 'AI-tjänsten är inte konfigurerad.' }, 503)
  }

  const prepMs = Date.now() - requestStart

  try {
    const geminiBody = {
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } }, { text: buildPrompt(brand, sellerNote) }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: SHOT_PLAN_RESPONSE_SCHEMA,
        // Deliberately small — 3 short fields per shot, 4-7 shots, no "purpose" text.
        maxOutputTokens: 500,
      },
    }
    const geminiStart = Date.now()
    const res = await callGeminiFast(env, geminiBody, TIMEOUT_MS)
    const geminiMs = Date.now() - geminiStart

    const parseStart = Date.now()
    const rawText = extractText(res)
    let parsed: any
    try {
      parsed = JSON.parse(rawText)
    } catch {
      // A genuine application bug (bad JSON from a 200 response) must never
      // be hidden behind a fake generic plan — surface it as a real failure.
      console.error('[shot-plan] model response was not valid JSON:', rawText.slice(0, 300))
      return json({ ok: false, error: 'shot_plan_failed', reason: 'invalid_model_response' }, 500)
    }
    const parseMs = Date.now() - parseStart

    const rawShots: any[] = Array.isArray(parsed?.shots) ? parsed.shots : []
    const shots: ShotPlanShot[] = rawShots
      .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.instruction === 'string')
      .slice(0, MAX_ADDITIONAL)
      .map((s) => ({ id: s.id, title: s.title, instruction: s.instruction, purpose: '', required: true }))

    // Never let a thin/malformed model response leave the seller with fewer
    // than the required minimum — pad with generic-but-useful fallback shots.
    const result: ShotPlan = {
      productHint: null,
      additionalShots: shots.length >= MIN_ADDITIONAL ? shots : padToMinimum(shots),
    }

    // Dev-only timing breakdown — never sent to the client, never rendered in
    // the consumer UI. Visible via `wrangler pages dev`/deployment tail.
    const totalMs = Date.now() - requestStart
    console.log(
      `[shot-plan] model=gemini-3.5-flash-lite prep_ms=${prepMs} gemini_ms=${geminiMs} parse_ms=${parseMs} total_ms=${totalMs} shots=${result.additionalShots.length}`,
    )

    return json({ ok: true, result }, 200)
  } catch (err) {
    // NO FAIL-OPEN: a network/AI failure is a genuine, distinct failure —
    // never a silently-substituted generic plan. The client shows a real
    // error/retry state.
    console.error('[shot-plan] AI call failed:', err instanceof Error ? err.message : err)
    return json({ ok: false, error: 'shot_plan_failed', reason: 'ai_call_failed' }, 500)
  }
}

/** Used ONLY to top up a real, successfully-parsed model response that came back thinner than the required minimum — never substituted for a failed call. */
const GENERIC_FALLBACK_SHOTS: ShotPlanShot[] = [
  { id: 'angle_side', title: 'Sidovinkel', instruction: 'Ta en bild snett från sidan.', purpose: '', required: true },
  { id: 'angle_other_side', title: 'Andra vinkeln', instruction: 'Ta en bild från en annan vinkel.', purpose: '', required: true },
  { id: 'detail_close', title: 'Närbild', instruction: 'Ta en närbild på en detalj eller yta.', purpose: '', required: true },
  { id: 'label', title: 'Märkning', instruction: 'Fotografera eventuell etikett eller märkning, om det finns.', purpose: '', required: true },
  { id: 'overview_back', title: 'Baksida', instruction: 'Ta en bild bakifrån eller från undersidan.', purpose: '', required: true },
]

function padToMinimum(shots: ShotPlanShot[]): ShotPlanShot[] {
  const seen = new Set(shots.map((s) => s.id))
  const padded = [...shots]
  for (const fallback of GENERIC_FALLBACK_SHOTS) {
    if (padded.length >= MIN_ADDITIONAL) break
    if (seen.has(fallback.id)) continue
    padded.push(fallback)
    seen.add(fallback.id)
  }
  return padded
}

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405)
