// Round 2 of the grounded-latency matrix, run at concurrency 2 (round 1 hit
// two local `fetch failed` connection errors when firing 5 multi-MB uploads at
// once, which muddied those cells). Focus: how grounded latency scales with
// image count per model, to size the seller fast path's image cap.
//
// Usage: node scripts/bench-gemini-matrix2.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const devVars = await readFile('.dev.vars', 'utf8')
const API_KEY = devVars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
const img1024 = []
const img768 = []
for (const f of files) {
  const raw = await readFile(path.join(dir, f))
  img1024.push({ inlineData: { mimeType: 'image/jpeg', data: (await sharp(raw).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()).toString('base64') } })
  img768.push({ inlineData: { mimeType: 'image/jpeg', data: (await sharp(raw).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()).toString('base64') } })
}

const RESEARCH_PROMPT = `Säljaren säljer en begagnad produkt. Varumärke: "IKEA". Säljaren skriver: "Soffa, mörkgrått tyg, 3-sits". Bilderna är bifogade.

Använd Google Search för att identifiera exakt modell och hitta: mått i cm, material, färg/variant, nypris i SEK, samt observerade begagnatpriser i Sverige. Prioritera ikea.com. Använd bilderna för att verifiera att du researchar rätt variant.

Svara kort på svenska i löptext. Ange källans URL efter varje faktauppgift. Hitta ALDRIG på uppgifter — ofullständig research är INTE ett fel.`

const CASES = [
  { name: '3.7-flash grounded 3 img', model: 'gemini-3.7-flash', n: 3, set: img1024 },
  { name: '3.6-flash grounded 3 img', model: 'gemini-3.6-flash', n: 3, set: img1024 },
  { name: '3.5-lite  grounded 3 img', model: 'gemini-3.5-flash-lite', n: 3, set: img1024 },
  { name: '3.5-lite  grounded 5 img', model: 'gemini-3.5-flash-lite', n: 5, set: img1024 },
  { name: '3.5-lite  grounded 2 img', model: 'gemini-3.5-flash-lite', n: 2, set: img1024 },
  { name: '3.5-lite  grnd 3 img 768', model: 'gemini-3.5-flash-lite', n: 3, set: img768 },
]

async function run(c) {
  const body = {
    contents: [{ role: 'user', parts: [...c.set.slice(0, c.n), { text: RESEARCH_PROMPT }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
    serviceTier: 'priority',
  }
  const t0 = performance.now()
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const elapsed = performance.now() - t0
    if (!res.ok) return { ...c, elapsed, note: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` }
    const j = await res.json()
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
    return {
      ...c,
      elapsed,
      chunks: j?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0,
      inTok: j?.usageMetadata?.promptTokenCount,
      outTok: j?.usageMetadata?.candidatesTokenCount,
      hasDims: /\b\d{2,3}\s*cm\b/.test(text),
      hasPrice: /\b\d[\d\s]{2,}\s*(kr|sek)\b/i.test(text),
      söderhamn: /söderhamn/i.test(text),
    }
  } catch (err) {
    return { ...c, elapsed: performance.now() - t0, note: err.message }
  }
}

// Concurrency 2.
const results = []
for (let i = 0; i < CASES.length; i += 2) {
  results.push(...(await Promise.all(CASES.slice(i, i + 2).map(run))))
}

console.log('case                        latency   chunks  dims  price  söderhamn  in/out tok   note')
console.log('─'.repeat(104))
for (const r of results) {
  console.log(
    `${r.name.padEnd(26)} ${`${(r.elapsed / 1000).toFixed(2)}s`.padStart(8)}  ${String(r.chunks ?? '—').padStart(6)}  ${(r.hasDims ? 'yes' : 'no').padStart(4)}  ${(r.hasPrice ? 'yes' : 'no').padStart(5)}  ${(r.söderhamn ? 'yes' : 'no').padStart(9)}  ${String(r.inTok ?? '—').padStart(5)}/${String(r.outTok ?? '—').padEnd(5)}  ${r.note ?? ''}`,
  )
}
