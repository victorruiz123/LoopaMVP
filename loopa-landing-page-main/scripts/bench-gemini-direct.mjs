// Direct Gemini latency benchmark — measures the candidate call shapes for the
// seller fast path in isolation, without the Pages Function in the way.
//
// Answers the three questions the seller architecture depends on:
//   1. How long does ONE grounded call (googleSearch + N images + JSON-in-text)
//      actually take? — decides whether the single-call Listing Genie shape can
//      hit the <15s target at all.
//   2. How long does a fast NON-grounded vision call with a responseSchema
//      take? — sizes the degraded fallback budget.
//   3. Does grounding + responseSchema in one call actually work? — the reason
//      the current pipeline is split into two sequential calls.
//
// Usage:
//   node scripts/bench-gemini-direct.mjs                 # runs all variants concurrently
//   node scripts/bench-gemini-direct.mjs --only grounded-primary
//
// Reads GEMINI_API_KEY from .dev.vars.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const IMAGE_DIR = 'IKEA SÖDERHAMN'
const IMAGE_COUNT = Number(process.argv.includes('--images') ? process.argv[process.argv.indexOf('--images') + 1] : 5)
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

const devVars = await readFile('.dev.vars', 'utf8')
const API_KEY = devVars.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!API_KEY) throw new Error('GEMINI_API_KEY not found in .dev.vars')

const BRAND = 'IKEA'
const NOTE = 'Soffa, mörkgrått tyg, 3-sits'

const dir = path.resolve(process.cwd(), IMAGE_DIR)
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, IMAGE_COUNT)
const images = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  images.push({ inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') } })
}
console.log(`images: ${files.length}, payload ${(images.reduce((n, i) => n + i.inlineData.data.length, 0) / 1024 / 1024).toFixed(2)} MB base64\n`)

// The single-call seller prompt: identity + specs + price + condition + listing,
// JSON in free text (no responseSchema — that is what frees the googleSearch tool).
const GROUNDED_PROMPT = `Du är Loopas produktexpert. Säljarens egna bilder är bifogade. Säljaren uppger: Varumärke: "${BRAND}". Övrigt: "${NOTE}".

Använd Google Search för att identifiera och researcha exakt denna produkt. Använd bilderna för att styra och verifiera sökningen. Prioritera tillverkarens egen webbplats, sedan officiella produktsidor/PDF, sedan trovärdiga återförsäljare.

Ta reda på: exakt modell/variant, kategori, mått i cm, material, färg, nypris i SEK, samt faktiska begagnatpriser på svenska begagnatmarknaden. Bedöm skicket ENBART från bilderna.

Svara med ENDAST ett JSON-objekt, inget annat, ingen kodfence:
{"identity":{"brand":string|null,"exactProduct":string|null,"variant":string|null,"category":string|null,"confidence":"high"|"medium"|"low","uncertain":boolean,"uncertaintyNote":string|null},
"attributes":[{"key":string,"label":string,"value":string,"sourceUrl":string|null}],
"condition":{"grade":string|null,"label":string|null,"defects":[string],"reasoning":string,"uncertain":boolean,"uncertaintyNote":string|null},
"pricing":{"available":boolean,"retailPriceSek":number|null,"suggestedPriceSek":number|null,"priceRangeMinSek":number|null,"priceRangeMaxSek":number|null,"rationale":string|null},
"listing":{"title":string,"description":string,"conditionText":string},
"missingNotes":[string]}

Hitta ALDRIG på mått, pris eller uppgifter. Utelämna hellre. Ofullständig research är INTE ett fel — men titel och beskrivning MÅSTE alltid produceras.`

const FAST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    identity: {
      type: 'OBJECT',
      properties: {
        brand: { type: 'STRING', nullable: true },
        exactProduct: { type: 'STRING', nullable: true },
        variant: { type: 'STRING', nullable: true },
        category: { type: 'STRING', nullable: true },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        uncertain: { type: 'BOOLEAN' },
        uncertaintyNote: { type: 'STRING', nullable: true },
      },
      required: ['brand', 'exactProduct', 'variant', 'category', 'confidence', 'uncertain', 'uncertaintyNote'],
    },
    attributes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { key: { type: 'STRING' }, label: { type: 'STRING' }, value: { type: 'STRING' } },
        required: ['key', 'label', 'value'],
      },
    },
    condition: {
      type: 'OBJECT',
      properties: {
        grade: { type: 'STRING', nullable: true },
        label: { type: 'STRING', nullable: true },
        defects: { type: 'ARRAY', items: { type: 'STRING' } },
        reasoning: { type: 'STRING' },
        uncertain: { type: 'BOOLEAN' },
        uncertaintyNote: { type: 'STRING', nullable: true },
      },
      required: ['grade', 'label', 'defects', 'reasoning', 'uncertain', 'uncertaintyNote'],
    },
    pricing: {
      type: 'OBJECT',
      properties: {
        available: { type: 'BOOLEAN' },
        retailPriceSek: { type: 'NUMBER', nullable: true },
        suggestedPriceSek: { type: 'NUMBER', nullable: true },
        priceRangeMinSek: { type: 'NUMBER', nullable: true },
        priceRangeMaxSek: { type: 'NUMBER', nullable: true },
        rationale: { type: 'STRING', nullable: true },
      },
      required: ['available', 'retailPriceSek', 'suggestedPriceSek', 'priceRangeMinSek', 'priceRangeMaxSek', 'rationale'],
    },
    listing: {
      type: 'OBJECT',
      properties: { title: { type: 'STRING' }, description: { type: 'STRING' }, conditionText: { type: 'STRING' } },
      required: ['title', 'description', 'conditionText'],
    },
    missingNotes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['identity', 'attributes', 'condition', 'pricing', 'listing', 'missingNotes'],
}

const FAST_PROMPT = `Du är Loopas produktexpert. Säljarens bilder är bifogade. Säljaren uppger varumärke "${BRAND}" och: "${NOTE}".

Du har INGEN webbsökning. Beskriv därför ENDAST det du kan se eller som säljaren uppgett. Hitta ALDRIG på mått, material, nypris eller exakt modellnamn — lämna dem null och skriv i missingNotes vad som saknas. Bedöm skick från bilderna. Föreslå ett rimligt begagnatpris utifrån märke, produkttyp och synligt skick, och skriv i rationale att det är en uppskattning utan prisresearch. Skriv alltid en stark titel och beskrivning.`

const VARIANTS = [
  {
    name: 'grounded-primary',
    model: 'gemini-3.7-flash',
    body: {
      contents: [{ role: 'user', parts: [...images, { text: GROUNDED_PROMPT }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
    },
  },
  {
    name: 'fast-fallback',
    model: 'gemini-3.5-flash-lite',
    body: {
      contents: [{ role: 'user', parts: [...images, { text: FAST_PROMPT }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: FAST_SCHEMA },
    },
  },
  {
    name: 'grounded-plus-schema',
    model: 'gemini-3.7-flash',
    body: {
      contents: [{ role: 'user', parts: [...images, { text: GROUNDED_PROMPT }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseSchema: FAST_SCHEMA },
    },
  },
]

async function runVariant(v) {
  const t0 = performance.now()
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${v.model}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v.body, serviceTier: 'priority' }),
      signal: AbortSignal.timeout(120_000),
    })
    const elapsed = performance.now() - t0
    if (!res.ok) {
      const t = await res.text()
      return { name: v.name, model: v.model, elapsed, ok: false, note: `HTTP ${res.status}: ${t.slice(0, 200)}` }
    }
    const j = await res.json()
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim()
    const chunks = j?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0
    let parseOk = false
    let identity = null
    let dims = null
    try {
      const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      const s = cleaned.indexOf('{')
      const e = cleaned.lastIndexOf('}')
      const p = JSON.parse(cleaned.slice(s, e + 1))
      parseOk = true
      identity = [p?.identity?.brand, p?.identity?.exactProduct, p?.identity?.variant].filter(Boolean).join(' ')
      dims = (p?.attributes ?? []).filter((a) => /bredd|djup|höjd|mått|width|depth|height/i.test(a.label ?? '')).map((a) => `${a.label}=${a.value}`).join(', ')
    } catch {
      parseOk = false
    }
    return {
      name: v.name,
      model: v.model,
      elapsed,
      ok: true,
      parseOk,
      identity,
      dims,
      chunks,
      inTok: j?.usageMetadata?.promptTokenCount,
      outTok: j?.usageMetadata?.candidatesTokenCount,
      thoughtsTok: j?.usageMetadata?.thoughtsTokenCount,
      chars: text.length,
    }
  } catch (err) {
    return { name: v.name, model: v.model, elapsed: performance.now() - t0, ok: false, note: err.message }
  }
}

const selected = ONLY ? VARIANTS.filter((v) => v.name === ONLY) : VARIANTS
const results = await Promise.all(selected.map(runVariant))
for (const r of results) {
  console.log(`─── ${r.name}  (${r.model})`)
  console.log(`    latency:   ${(r.elapsed / 1000).toFixed(2)} s`)
  if (!r.ok) {
    console.log(`    FAILED:    ${r.note}\n`)
    continue
  }
  console.log(`    JSON parse: ${r.parseOk ? 'ok' : 'FAILED'}`)
  console.log(`    identity:   ${r.identity || '—'}`)
  console.log(`    dimensions: ${r.dims || '—'}`)
  console.log(`    grounding chunks: ${r.chunks}`)
  console.log(`    tokens:     in=${r.inTok} out=${r.outTok} thoughts=${r.thoughtsTok ?? 0}  (${r.chars} chars)\n`)
}
