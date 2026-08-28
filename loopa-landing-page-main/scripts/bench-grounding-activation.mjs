// Does the seller endpoint's single grounded call actually SEARCH?
//
// The first end-to-end run of /api/seller/generate returned correct-looking
// product facts in ~4-6s but with ZERO groundingChunks — i.e. Gemini answered
// from parametric memory instead of invoking googleSearch. Unverified recall
// dressed up as research is exactly what this pipeline must not ship, so this
// benchmark compares prompt shapes by the only thing that proves a search
// happened: the number of grounding chunks returned.
//
// Usage: node scripts/bench-grounding-activation.mjs

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

const BRAND = 'IKEA'
const NOTE = 'Soffa, mörkgrått tyg, 3-sits'

const JSON_CONTRACT = `{"identity":{"brand":string|null,"exactProduct":string|null,"variant":string|null,"category":string|null,"confidence":"high"|"medium"|"low","uncertain":boolean,"uncertaintyNote":string|null},
"attributes":[{"key":string,"label":string,"value":string,"sourceUrl":string|null}],
"condition":{"grade":string|null,"label":string|null,"defects":[string],"reasoning":string,"uncertain":boolean,"uncertaintyNote":string|null},
"pricing":{"available":boolean,"retailPriceSek":number|null,"suggestedPriceSek":number|null,"priceRangeMinSek":number|null,"priceRangeMaxSek":number|null,"rationale":string|null,"basis":"comparables"|"retail"|"estimate"|"none"},
"listing":{"title":string,"description":string,"conditionText":string},
"missingFields":[string],"missingNotes":[string]}`

/** As currently written in functions/api/seller/generate.ts. */
const CURRENT = `Du är Loopas produktexpert. Du hjälper en privatperson sälja en begagnad produkt. Säljarens egna bilder är bifogade.

SÄLJARENS UPPGIFTER (sanning):
- Varumärke: "${BRAND}"
- Säljaren berättar: "${NOTE}"

ANVÄND GOOGLE SEARCH. Låt bilderna styra och verifiera sökningen. Prioritera tillverkarens egen webbplats.

Leta efter: exakt modell/variant, MÅTT i cm, MATERIAL, NYPRIS i SEK, faktiska BEGAGNATPRISER i Sverige.

Hitta ALDRIG på uppgifter. Svara med ENDAST ett giltigt JSON-objekt, ingen kodfence:

${JSON_CONTRACT}`

/** Explicit two-step ordering: search is a mandatory FIRST action, JSON is the second. */
const SEARCH_FIRST = `Du är Loopas produktexpert. Du hjälper en privatperson sälja en begagnad produkt. Säljarens egna bilder är bifogade.

SÄLJARENS UPPGIFTER (sanning):
- Varumärke: "${BRAND}"
- Säljaren berättar: "${NOTE}"

STEG 1 — SÖK FÖRST (obligatoriskt):
Du MÅSTE använda Google Search innan du svarar. Gör minst två sökningar:
a) identifiera exakt modell utifrån märke + vad bilderna visar
b) slå upp produktens mått, material och nypris på tillverkarens webbplats
c) slå upp faktiska begagnatpriser i Sverige
Förlita dig ALDRIG på ditt eget minne för mått, nypris eller modellnamn — dessa MÅSTE komma från sökresultat. Har du inte sökt upp ett värde ska det vara null.

STEG 2 — SVARA:
När sökningarna är klara, svara med ENDAST ett giltigt JSON-objekt, ingen kodfence, ingen text före eller efter:

${JSON_CONTRACT}

Sätt "sourceUrl" till en URL du faktiskt sett i sökresultaten, annars null. Lägg fält du inte kunde belägga i "missingFields".`

const CASES = [
  { name: 'current prompt, thinking low', prompt: CURRENT, thinking: 'low' },
  { name: 'search-first, thinking low', prompt: SEARCH_FIRST, thinking: 'low' },
  { name: 'search-first, no thinkingCfg', prompt: SEARCH_FIRST, thinking: null },
]

async function run(c) {
  const generationConfig = { temperature: 0.2 }
  if (c.thinking) generationConfig.thinkingConfig = { thinkingLevel: c.thinking }
  const t0 = performance.now()
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [...images, { text: c.prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig,
        serviceTier: 'priority',
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const elapsed = performance.now() - t0
    if (!res.ok) return { ...c, elapsed, note: `HTTP ${res.status}` }
    const j = await res.json()
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
    const chunks = j?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0
    const queries = j?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []
    let parsed = null
    try {
      const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
    } catch {}
    const attrs = parsed?.attributes ?? []
    return {
      ...c,
      elapsed,
      chunks,
      queries: queries.length,
      parseOk: !!parsed,
      model: parsed?.identity?.exactProduct ?? '—',
      dims: attrs.filter((a) => /bredd|djup|höjd|mått/i.test(a.label ?? '')).map((a) => a.value).join(' / ') || '—',
      material: attrs.find((a) => /material/i.test(a.label ?? ''))?.value ?? '—',
      retail: parsed?.pricing?.retailPriceSek ?? '—',
      suggested: parsed?.pricing?.suggestedPriceSek ?? '—',
      withSrc: attrs.filter((a) => a.sourceUrl).length,
      outTok: j?.usageMetadata?.candidatesTokenCount,
    }
  } catch (err) {
    return { ...c, elapsed: performance.now() - t0, note: err.message }
  }
}

for (const c of CASES) {
  const r = await run(c)
  console.log(`─── ${r.name}`)
  if (r.note) {
    console.log(`    ${(r.elapsed / 1000).toFixed(2)}s  FAILED: ${r.note}\n`)
    continue
  }
  console.log(`    latency ${(r.elapsed / 1000).toFixed(2)}s   groundingChunks=${r.chunks}   searchQueries=${r.queries}   parse=${r.parseOk ? 'ok' : 'FAIL'}   outTok=${r.outTok}`)
  console.log(`    model="${r.model}"  dims="${r.dims}"  material="${r.material}"  nypris=${r.retail}  förslag=${r.suggested}  attrs_with_source=${r.withSrc}\n`)
}
