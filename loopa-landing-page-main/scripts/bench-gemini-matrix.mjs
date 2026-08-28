// Grounded-call latency matrix — model × image-count × grounding.
//
// The single question this answers: is there ANY grounded (googleSearch)
// Gemini configuration that reliably returns inside a ~10-12s seller budget?
// bench-gemini-direct.mjs already showed gemini-3.7-flash + googleSearch + 5
// images blowing past 120s, and gemini-3.5-flash-lite non-grounded returning
// in 5.3s. This narrows down where the grounded cost actually comes from:
// the model, the image payload, or grounding itself.
//
// Usage: node scripts/bench-gemini-matrix.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const devVars = await readFile('.dev.vars', 'utf8')
const API_KEY = devVars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
const allImages = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  allImages.push({ inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') } })
}

const RESEARCH_PROMPT = `Säljaren säljer en begagnad produkt. Varumärke: "IKEA". Säljaren skriver: "Soffa, mörkgrått tyg, 3-sits". Bilderna är bifogade.

Använd Google Search för att identifiera exakt modell och hitta: mått i cm, material, färg/variant, nypris i SEK, samt observerade begagnatpriser i Sverige. Prioritera ikea.com. Använd bilderna för att verifiera att du researchar rätt variant.

Svara kort på svenska i löptext. Ange källans URL efter varje faktauppgift. Hitta ALDRIG på uppgifter — ofullständig research är INTE ett fel.`

const CASES = [
  { name: '3.6-flash  grounded  5 img', model: 'gemini-3.6-flash', n: 5, grounded: true },
  { name: '3.6-flash  grounded  2 img', model: 'gemini-3.6-flash', n: 2, grounded: true },
  { name: '3.7-flash  grounded  1 img', model: 'gemini-3.7-flash', n: 1, grounded: true },
  { name: '3.5-lite   grounded  2 img', model: 'gemini-3.5-flash-lite', n: 2, grounded: true },
  { name: '3.6-flash  grounded  0 img', model: 'gemini-3.6-flash', n: 0, grounded: true },
]

async function run(c) {
  const parts = [...allImages.slice(0, c.n), { text: RESEARCH_PROMPT }]
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
    serviceTier: 'priority',
  }
  if (c.grounded) body.tools = [{ googleSearch: {} }]

  const t0 = performance.now()
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const elapsed = performance.now() - t0
    if (!res.ok) return { ...c, elapsed, note: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
    const j = await res.json()
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
    return {
      ...c,
      elapsed,
      chunks: j?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0,
      chars: text.length,
      inTok: j?.usageMetadata?.promptTokenCount,
      outTok: j?.usageMetadata?.candidatesTokenCount,
      hasDims: /\b\d{2,3}\s*cm\b/.test(text),
      hasPrice: /\b\d[\d\s]{2,}\s*(kr|sek)\b/i.test(text),
    }
  } catch (err) {
    return { ...c, elapsed: performance.now() - t0, note: err.message }
  }
}

const results = await Promise.all(CASES.map(run))
console.log('case                          latency   chunks  dims  price  in/out tok   note')
console.log('─'.repeat(100))
for (const r of results) {
  const lat = `${(r.elapsed / 1000).toFixed(2)}s`.padStart(8)
  console.log(
    `${r.name.padEnd(28)} ${lat}  ${String(r.chunks ?? '—').padStart(6)}  ${(r.hasDims ? 'yes' : 'no').padStart(4)}  ${(r.hasPrice ? 'yes' : 'no').padStart(5)}  ${String(r.inTok ?? '—').padStart(5)}/${String(r.outTok ?? '—').padEnd(5)}  ${r.note ?? ''}`,
  )
}
