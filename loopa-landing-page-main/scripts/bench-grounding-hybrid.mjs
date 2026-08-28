// Can ONE call both search AND emit JSON?
//
// bench-grounding-activation.mjs showed that a JSON-first prompt makes
// gemini-3.5-flash-lite skip googleSearch entirely (0 chunks, 0 queries) and
// answer from memory — inventing retail prices (4095 / 5495 / 6395 across
// three runs) and even inventing sourceUrl values. bench-gemini-matrix2.mjs
// showed the same model DOES search (5 chunks) when asked for free-text
// research. This tests the in-between shapes before accepting a two-call
// design:
//
//   research-then-json  research instructions first, JSON appended at the end
//   freetext-control    pure free-text research (known to search) as control
//
// The bar: groundingChunks > 0 AND parseable JSON in the same response.
//
// Usage: node scripts/bench-grounding-hybrid.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const devVars = await readFile('.dev.vars', 'utf8')
const API_KEY = devVars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
const MODEL = 'gemini-3.5-flash-lite'

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 5)
const images = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  images.push({ inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') } })
}

const RESEARCH_CORE = `Säljaren säljer en begagnad produkt. Varumärke: "IKEA". Säljaren skriver: "Soffa, mörkgrått tyg, 3-sits". Bilderna är bifogade.

Använd Google Search för att identifiera exakt modell och hitta: mått i cm, material, färg/variant, nypris i SEK, samt observerade begagnatpriser i Sverige. Prioritera ikea.com. Använd bilderna för att verifiera att du researchar rätt variant.

Svara kort på svenska i löptext. Ange källans URL efter varje faktauppgift. Hitta ALDRIG på uppgifter — ofullständig research är INTE ett fel.`

const CASES = [
  {
    name: 'freetext-control',
    prompt: RESEARCH_CORE,
  },
  {
    name: 'research-then-json',
    prompt: `${RESEARCH_CORE}

När du redovisat researchen ovan i löptext: avsluta ditt svar med ett JSON-objekt inom en kodfence \`\`\`json ... \`\`\`, som sammanfattar EXAKT det du hittade (aldrig mer):
{"exactProduct":string|null,"variant":string|null,"category":string|null,"dimensions":string|null,"material":string|null,"retailPriceSek":number|null,"usedPriceLowSek":number|null,"usedPriceHighSek":number|null}
Fält du inte hittat belägg för ska vara null.`,
  },
]

async function run(c) {
  const t0 = performance.now()
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [...images, { text: c.prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
      serviceTier: 'priority',
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const elapsed = performance.now() - t0
  const j = await res.json()
  const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
  const gm = j?.candidates?.[0]?.groundingMetadata
  const fence = text.match(/```json\s*([\s\S]*?)```/i)
  let parsed = null
  try {
    parsed = fence ? JSON.parse(fence[1]) : null
  } catch {}
  return {
    name: c.name,
    elapsed,
    chunks: gm?.groundingChunks?.length ?? 0,
    queries: gm?.webSearchQueries ?? [],
    chars: text.length,
    outTok: j?.usageMetadata?.candidatesTokenCount,
    parsed,
    text,
  }
}

for (const c of CASES) {
  const r = await run(c)
  console.log(`─── ${r.name}`)
  console.log(`    latency ${(r.elapsed / 1000).toFixed(2)}s  groundingChunks=${r.chunks}  outTok=${r.outTok}  chars=${r.chars}`)
  console.log(`    searchQueries: ${JSON.stringify(r.queries)}`)
  if (r.name === 'research-then-json') {
    console.log(`    JSON tail parsed: ${r.parsed ? 'YES' : 'NO'}`)
    if (r.parsed) console.log(`    ${JSON.stringify(r.parsed)}`)
  } else {
    console.log(`    excerpt: ${r.text.slice(0, 220).replace(/\n/g, ' ')}…`)
  }
  console.log()
}
