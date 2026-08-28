// How RELIABLY does the research call actually invoke googleSearch?
//
// A real seller benchmark run came back `research_ungrounded` (text returned,
// zero groundingChunks) — the model answered from memory, so the endpoint
// correctly discarded it and the seller got no dimensions and no price. Search
// firing is therefore not a yes/no property of the prompt but a RATE, and the
// rate is what determines how often sellers get a fully researched listing.
//
// This runs each prompt variant N times and reports the grounding rate plus
// whether dimensions/price were actually found.
//
// Usage: node scripts/bench-research-reliability.mjs [--runs 3]

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const devVars = await readFile('.dev.vars', 'utf8')
const API_KEY = devVars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
const MODEL = 'gemini-3.5-flash-lite'
const RUNS = Number(process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 3)

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 3)
const images = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  images.push({ inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') } })
}

const BRAND = 'IKEA'
const NOTE = 'Soffa, mörkgrått tyg, 3-sits'

/** Exactly as currently written in functions/api/seller/generate.ts. */
const CURRENT = `Säljaren är en privatperson som säljer en begagnad produkt. Bilderna är säljarens egna.

- Varumärke: "${BRAND}"
- Säljaren berättar: "${NOTE}"

Ingen kategori och ingen modell är angiven. Avgör själv från bilderna vad det är för produkt.

Använd Google Search för att identifiera exakt modell och ta reda på, i denna prioritetsordning:
1. Exakt modellnamn/variant och produktkategori
2. MÅTT i cm
3. MATERIAL och färg/utförande
4. NYPRIS (originalpris) i SEK
5. Faktiska BEGAGNATPRISER i Sverige

Redovisa begagnatpriser under rubriken "ANDRAHANDSPRISER:".

Svara kort på svenska i löptext. Ange källans URL direkt efter varje faktauppgift.

Hitta ALDRIG på mått, priser eller andra uppgifter.`

/** Search stated as a hard precondition in the FIRST line, with an explicit "your memory is not a source" rule. */
const FORCEFUL = `SÖK FÖRST. Du MÅSTE göra minst två Google-sökningar innan du svarar. Ditt eget minne räknas INTE som källa — varje mått och varje pris nedan måste komma från ett sökresultat.

Säljaren är en privatperson som säljer en begagnad produkt. Bilderna är säljarens egna.
- Varumärke: "${BRAND}"
- Säljaren berättar: "${NOTE}"

Sök så här:
1. Sök på varumärket + vad bilderna visar för att hitta exakt modellnamn.
2. Sök på modellnamnet för att hitta mått i cm, material och nypris i SEK.
3. Sök på modellnamnet + "begagnad" / "blocket" / "tradera" för faktiska begagnatpriser i Sverige.

Redovisa sedan kort på svenska i löptext, med källans URL direkt efter varje faktauppgift. Lägg begagnatpriser under rubriken "ANDRAHANDSPRISER:".

Hitta ALDRIG på mått eller priser. Skriv hellre "kunde inte bekräftas".`

const VARIANTS = [
  { name: 'current', prompt: CURRENT },
  { name: 'forceful', prompt: FORCEFUL },
]

async function once(prompt) {
  const t0 = performance.now()
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [...images, { text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
        serviceTier: 'priority',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const elapsed = performance.now() - t0
    const j = await res.json()
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
    const gm = j?.candidates?.[0]?.groundingMetadata
    return {
      elapsed,
      chunks: gm?.groundingChunks?.length ?? 0,
      queries: gm?.webSearchQueries?.length ?? 0,
      dims: /\b\d{2,3}\s*cm\b/.test(text),
      price: /\b\d[\d\s]{2,}\s*(kr|sek)\b/i.test(text),
      söderhamn: /söderhamn/i.test(text),
    }
  } catch (err) {
    return { elapsed: performance.now() - t0, error: err.message }
  }
}

for (const v of VARIANTS) {
  const results = []
  for (let i = 0; i < RUNS; i++) results.push(await once(v.prompt))
  const grounded = results.filter((r) => r.chunks > 0).length
  const avg = results.reduce((n, r) => n + r.elapsed, 0) / results.length
  console.log(`─── ${v.name}`)
  console.log(`    grounded: ${grounded}/${RUNS}   avg latency ${(avg / 1000).toFixed(2)}s`)
  results.forEach((r, i) =>
    console.log(
      `      run ${i + 1}: ${(r.elapsed / 1000).toFixed(2)}s chunks=${r.chunks ?? '—'} queries=${r.queries ?? '—'} dims=${r.dims ? 'y' : 'n'} price=${r.price ? 'y' : 'n'} model=${r.söderhamn ? 'y' : 'n'}${r.error ? ` ERROR ${r.error}` : ''}`,
    ),
  )
  console.log()
}
