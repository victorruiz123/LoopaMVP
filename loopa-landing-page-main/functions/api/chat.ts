// Cloudflare Pages Function: POST /api/chat
//
// Server-side proxy for the "Ask Loopa" listing chat. Keeps the Gemini API
// key out of the client entirely. The model is restricted to the structured
// listing context and can never negotiate the fixed price — that rule is
// enforced deterministically here, both before and after the model call, in
// addition to the system prompt.
//
// Env vars (see .env.example):
//   GEMINI_API_KEY   - required to call the real model. If absent, the
//                       function returns deterministic local-demo answers
//                       instead of failing, so the UI stays testable.
//   GEMINI_MODEL      - e.g. "gemini-2.0-flash-lite". Defaults to a cheap
//                       Flash-Lite class model if unset.
//   AI_GATEWAY_URL    - optional. Base URL of a Cloudflare AI Gateway
//                       "google-ai-studio" provider endpoint. When set, the
//                       Gemini request is routed through it instead of
//                       calling generativelanguage.googleapis.com directly.

import {
  answerFromFacts,
  buildSystemPrompt,
  isNegotiationAttempt,
  localDemoAnswer,
  stripWideDashes,
  FIXED_PRICE_REPLY,
  type Lang,
} from '../../src/lib/listingQA'

interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  AI_GATEWAY_URL?: string
}

interface ChatRequestBody {
  message?: string
  lang?: string
}

const DEFAULT_MODEL = 'gemini-2.0-flash-lite'
const MAX_MESSAGE_LENGTH = 500

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() })
}

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context

  let body: ChatRequestBody
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const message = (body.message ?? '').toString().trim().slice(0, MAX_MESSAGE_LENGTH)
  const lang: Lang = body.lang === 'en' ? 'en' : 'sv'

  if (!message) {
    return json({ error: 'empty_message' }, 400)
  }

  // 1. Deterministic guard — never let a negotiation attempt reach the model.
  if (isNegotiationAttempt(message)) {
    return json({ reply: FIXED_PRICE_REPLY[lang], source: 'guard' })
  }

  // 2. Deterministic FAQ short-circuit — cheap, exact, and can't hallucinate.
  const faqAnswer = answerFromFacts(message, lang)
  if (faqAnswer) {
    return json({ reply: faqAnswer, source: 'faq' })
  }

  // 3. No credentials configured (e.g. local dev) — clearly-marked demo mode.
  if (!env.GEMINI_API_KEY) {
    return json({ reply: localDemoAnswer(message, lang), source: 'local-demo' })
  }

  // 4. Real model call, scoped strictly to the structured listing context.
  try {
    const model = env.GEMINI_MODEL || DEFAULT_MODEL
    const base = env.AI_GATEWAY_URL
      ? `${env.AI_GATEWAY_URL.replace(/\/$/, '')}/google-ai-studio/v1beta/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

    const response = await fetch(`${base}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(lang) }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
      }),
    })

    if (!response.ok) {
      return json({ reply: localDemoAnswer(message, lang), source: 'local-demo' })
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!text) {
      return json({ reply: localDemoAnswer(message, lang), source: 'local-demo' })
    }

    // 5. Post-check — if the model still drifted toward a counteroffer or a
    // different price despite the system prompt, override it deterministically.
    if (isNegotiationAttempt(text)) {
      return json({ reply: FIXED_PRICE_REPLY[lang], source: 'guard-post' })
    }

    // 6. Strip any em/en dashes the model used despite the prompt instruction.
    return json({ reply: stripWideDashes(text), source: 'gemini' })
  } catch {
    return json({ reply: localDemoAnswer(message, lang), source: 'local-demo' })
  }
}

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405)
