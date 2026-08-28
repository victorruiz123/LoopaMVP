// Cloudflare Pages Function: POST /api/seller/review-photo
//
// ImageReviewEngine — the seller-product's guided-capture quality gate.
// Must feel INSTANT: one tiny, fast Gemini vision call (no Google Search, no
// grounded research, no heavy pipeline model) that answers a single
// question — is this photo good enough, and does it match the requested
// shot? See ../_shared/gemini.ts's FAST_REVIEW_MODEL doc comment for why
// gemini-3.5-flash-lite was selected (measured against this project's real
// available model list, not guessed) and docs/SELLER_MVP_ARCHITECTURE.md for
// the measured latency breakdown.
//
// The client sends a SEPARATE, small (~640px) JPEG derivative for review
// ONLY — never the seller's full-quality accepted photo. That derivative is
// created client-side (see src/features/seller/reviewPhotoClient.ts) and is
// discarded after review; the original file is what's compressed and stored
// for the final listing generation. This endpoint doesn't care which came in
// as long as it's small — resizing here too would just add latency for
// nothing, since the client-side derivative is already tiny.
//
// Two things are evaluated in one pass:
//   A. Photo quality — reject only when materially unusable (very blurry,
//      extremely dark, wrong subject, product significantly cropped when the
//      full product was required).
//   B. Requested-view match — the photo must show what was asked for. A
//      sharp, well-lit photo of the wrong angle/subject is REJECTED — good
//      quality never excuses the wrong view.
// Deliberately lenient on (A): ordinary phone photos, indoor lighting, minor
// clutter, and imperfect framing are always accepted. (B) is not negotiable.
//
// NO FAIL-OPEN: an AI/network/parse failure returns { ok: false } — never a
// fabricated { accepted: true }. The caller shows a review_failed state and
// lets the seller retry the SAME photo.

import { callGeminiFast, extractText, type GeminiEnv } from '../_shared/gemini'
import type { ImageReviewResult } from '../../../src/features/seller/types'
import type { UploadedImage } from '../../../src/features/generator/schema'

type Env = GeminiEnv

// Generous relative to the ~1-1.5s typical latency measured in testing — this
// is a ceiling for genuine network/model trouble, not the expected duration.
const TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 2 * 1024 * 1024 // the client sends a ~640px derivative — a few hundred KB at most

function corsHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() })
}

/** Deliberately tiny — {"status":"accept"} in the common case. Minimal output tokens = minimal latency. */
const REVIEW_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['accept', 'reject'] },
    reason: { type: 'STRING', nullable: true },
    suggestion: { type: 'STRING', nullable: true },
  },
  required: ['status', 'reason', 'suggestion'],
} as const

function buildPrompt(shotTitle: string, shotInstruction: string): string {
  return `Begärd bild: "${shotTitle}". Instruktion: "${shotInstruction}".

Bedöm TVÅ saker:
1) KVALITET — var generös. Vardagsljus, lite skakning, orolig bakgrund, ofullständig ramning ska godkännas. En naturlig fotograferingshöjd (stående, sittande, lite snett uppifrån) är helt normalt och INTE ett fel.
2) RÄTT VY — visar bilden faktiskt det som efterfrågades? Detta gäller ÄVEN OM bilden är skarp och fin. Exempel: om "Rakt framifrån" begärdes men bilden visar sidan, baksidan eller en tydlig snedvinkel av produkten, ska den underkännas oavsett kvalitet.

Underkänn ENDAST vid: fel vy/vinkel än begärt, produkten kraftigt beskuren när hela produkten efterfrågades, mycket suddigt, mycket mörkt/överexponerat, eller helt fel motiv.

Svara EXTREMT kort enligt schema. Vid reject: en kort, vardaglig svensk anledning (aldrig teknisk) + ett kort konkret förslag.`
}

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const requestStart = Date.now()
  const { request, env } = context

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: 'Bilden är för stor.' }, 413)

  let body: { image?: UploadedImage; shotTitle?: string; shotInstruction?: string }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  const image = body.image
  if (!image || typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/') || typeof image.dataBase64 !== 'string' || !image.dataBase64) {
    return json({ ok: false, error: 'image must be a {mimeType, dataBase64} object' }, 400)
  }
  const shotTitle = (body.shotTitle || 'produkten').trim().slice(0, 120)
  const shotInstruction = (body.shotInstruction || '').trim().slice(0, 300)

  if (!env.GEMINI_API_KEY) {
    return json({ ok: false, error: 'AI-tjänsten är inte konfigurerad.' }, 503)
  }

  const prepMs = Date.now() - requestStart

  try {
    const geminiBody = {
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } }, { text: buildPrompt(shotTitle, shotInstruction) }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: REVIEW_RESPONSE_SCHEMA,
        // Deliberately small — the whole point of the tiny schema above.
        maxOutputTokens: 200,
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
      console.error('[review-photo] model response was not valid JSON:', rawText.slice(0, 300))
      return json({ ok: false, error: 'review_failed', reason: 'invalid_model_response' }, 500)
    }
    const parseMs = Date.now() - parseStart

    const result: ImageReviewResult = {
      accepted: parsed?.status === 'accept',
      reason: typeof parsed?.reason === 'string' && parsed.reason ? parsed.reason : null,
      suggestion: typeof parsed?.suggestion === 'string' && parsed.suggestion ? parsed.suggestion : null,
    }

    // Dev-only timing breakdown — never sent to the client, never rendered in
    // the consumer UI. Visible via `wrangler pages dev`/deployment tail.
    const totalMs = Date.now() - requestStart
    console.log(
      `[review-photo] model=gemini-3.5-flash-lite prep_ms=${prepMs} gemini_ms=${geminiMs} parse_ms=${parseMs} total_ms=${totalMs} accepted=${result.accepted}`,
    )

    return json({ ok: true, result }, 200)
  } catch (err) {
    // NO FAIL-OPEN: a network/AI failure is a genuine, distinct failure —
    // never a fabricated accept. The client shows review_failed and lets the
    // seller retry the same photo.
    console.error('[review-photo] AI call failed:', err instanceof Error ? err.message : err)
    return json({ ok: false, error: 'review_failed', reason: 'ai_call_failed' }, 500)
  }
}

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405)
