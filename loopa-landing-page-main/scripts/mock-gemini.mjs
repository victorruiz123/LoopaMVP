// Mock Gemini upstream for deterministic seller-generation failure tests.
//
// Stands in for the real API by impersonating a Cloudflare AI Gateway: point
// AI_GATEWAY_URL at this server and functions/api/_shared/gemini.ts will call
// it instead of generativelanguage.googleapis.com. That exercises the REAL
// endpoint end-to-end through wrangler — real timeouts, real retries, real
// assembly — while spending zero Gemini calls.
//
// The seller endpoint issues both of its calls against the same model
// (gemini-3.5-flash-lite), so the RESEARCH call and the STRUCTURE call are
// distinguished the only way they can be: whether the request body carries a
// `tools` array (research is grounded, structuring is not).
//
// Usage:
//   node scripts/mock-gemini.mjs [--port 8799]
//   curl -X POST localhost:8799/__scenario -d '{"name":"research-timeout"}'

import { createServer } from 'node:http'

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8799)

const SCENARIOS = new Set(['full', 'partial', 'research-timeout', 'research-500', 'all-fail', 'structure-fails-once', 'research-ungrounded-once'])
let scenario = 'full'
/** Lets `structure-fails-once` fail the first structuring attempt and succeed on the bounded retry. Reset whenever the scenario changes. */
let structureAttempts = 0
/** Lets `research-ungrounded-once` return an ungrounded first attempt, then a properly grounded retry. */
let researchAttempts = 0

/** Free-text grounded research output — what the REAL research call returns (prose + inline source URLs), never JSON. */
const RESEARCH_TEXT = `Produkten på bilderna är en IKEA SÖDERHAMN 3-sitssoffa.

Mått: bredd 186 cm, djup 99 cm, höjd 83 cm (källa: https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/).
Material: klädsel i polyester/bomull, stomme av trä och stål (källa: https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/).
Formgivare: Ola Wihlborg.
Nypris: 4 095 kr (källa: https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/).

ANDRAHANDSPRISER:
Begagnade SÖDERHAMN 3-sits säljs för 1 800–2 700 kr i gott skick (källa: https://www.blocket.se/annonser/soderhamn).`

/** Research prose that legitimately failed to establish dimensions, material and nypris — TEST B. */
const RESEARCH_TEXT_THIN = `Produkten på bilderna är sannolikt en soffa ur IKEA:s SÖDERHAMN-serie, men exakt variant kunde inte bekräftas.

Mått och material kunde inte hittas på tillverkarens webbplats. Nypris kunde inte bekräftas.

ANDRAHANDSPRISER:
Jämförbara IKEA-soffor säljs begagnat för 1 800–2 700 kr (källa: https://www.blocket.se/annonser/soffa-ikea).`

/** A complete structured answer — the TEST A shape. */
const FULL_JSON = {
  identity: {
    brand: 'IKEA',
    exactProduct: 'SÖDERHAMN',
    variant: '3-sits, Gunnared beige',
    category: 'Soffa',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
  },
  attributes: [
    { key: 'width_cm', label: 'Bredd', value: '186 cm', sourceUrl: 'https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/' },
    { key: 'depth_cm', label: 'Djup', value: '99 cm', sourceUrl: 'https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/' },
    { key: 'height_cm', label: 'Höjd', value: '83 cm', sourceUrl: 'https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/' },
    { key: 'material', label: 'Material', value: 'Polyester/bomull, stomme av trä', sourceUrl: 'https://www.ikea.com/se/sv/p/soderhamn-3-sits-soffa/' },
    { key: 'designer', label: 'Formgivare', value: 'Ola Wihlborg', sourceUrl: null },
  ],
  condition: {
    grade: 'very_good',
    label: 'Mycket gott skick',
    defects: [],
    reasoning: 'Tyget är jämnt och rent på bilderna, inga synliga fläckar eller slitage.',
    uncertain: false,
    uncertaintyNote: null,
  },
  pricing: {
    available: true,
    retailPriceSek: 4095,
    suggestedPriceSek: 2200,
    priceRangeMinSek: 1800,
    priceRangeMaxSek: 2700,
    rationale: 'Nypris 4 095 kr. Observerade begagnatpriser 1 800–2 700 kr för samma modell i gott skick.',
    basis: 'comparables',
  },
  listing: {
    title: 'IKEA SÖDERHAMN 3-sits soffa',
    description: 'Rymlig och bekväm SÖDERHAMN-soffa från IKEA med djupa sittdynor och avtagbar, tvättbar klädsel. Mycket gott skick.',
    conditionText: 'Mycket gott skick, inga synliga skador.',
  },
  missingFields: [],
  missingNotes: [],
}

/** TEST B: research ran but could not establish dimensions, material or nypris. */
const PARTIAL_JSON = {
  ...FULL_JSON,
  identity: { ...FULL_JSON.identity, variant: null, confidence: 'medium', uncertain: true, uncertaintyNote: 'Exakt tygvariant kunde inte bekräftas.' },
  attributes: [{ key: 'designer', label: 'Formgivare', value: 'Ola Wihlborg', sourceUrl: null }],
  pricing: { ...FULL_JSON.pricing, retailPriceSek: null, rationale: 'Observerade begagnatpriser 1 800–2 700 kr.' },
  missingNotes: ['Mått och material kunde inte bekräftas från tillverkarens webbplats.'],
}

/** What structuring legitimately produces with NO research to work from: no researched facts, an honest estimate. */
const NO_RESEARCH_JSON = {
  identity: { brand: 'IKEA', exactProduct: null, variant: null, category: 'Soffa', confidence: 'low', uncertain: true, uncertaintyNote: 'Exakt modell kunde inte fastställas utan webbsökning.' },
  attributes: [{ key: 'colour', label: 'Färg', value: 'Ljusgrå/beige', sourceUrl: null }],
  condition: { grade: 'good', label: 'Gott skick', defects: [], reasoning: 'Inga synliga skador på bilderna.', uncertain: true, uncertaintyNote: 'Bedömt enbart utifrån bilder.' },
  pricing: { available: true, retailPriceSek: null, suggestedPriceSek: 1500, priceRangeMinSek: 1200, priceRangeMaxSek: 2000, rationale: 'Uppskattning utifrån märke, produkttyp och synligt skick.', basis: 'estimate' },
  listing: { title: 'IKEA soffa', description: 'IKEA-soffa i ljusgrått/beige tyg. Rymlig 3-sitsmodell i gott begagnat skick. Se bilderna för detaljer.', conditionText: 'Begagnat skick, se bilder.' },
  missingNotes: ['Ingen webbsökning tillgänglig — mått, material och nypris kunde inte verifieras.'],
}

/** Research responses carry prose + groundingChunks; structure responses carry JSON and no grounding. */
function researchResponse(text) {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa', title: 'SÖDERHAMN 3-sits soffa - IKEA' } },
            { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb', title: 'Soffa SÖDERHAMN - Blocket' } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 3400, candidatesTokenCount: 350 },
  }
}

function structureResponse(payload) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: { promptTokenCount: 6200, candidatesTokenCount: 900 },
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(text)
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (req.url === '/__scenario') {
      const name = JSON.parse(raw || '{}').name
      if (!SCENARIOS.has(name)) return send(res, 400, { ok: false, known: [...SCENARIOS] })
      scenario = name
      structureAttempts = 0
      researchAttempts = 0
      console.log(`[mock-gemini] scenario → ${scenario}`)
      return send(res, 200, { ok: true, scenario })
    }
    if (!req.url.includes(':generateContent')) return send(res, 404, { error: 'not_found' })

    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {}
    const isResearch = Array.isArray(body.tools) && body.tools.length > 0
    console.log(`[mock-gemini] ${isResearch ? 'research' : 'structure'} call, scenario=${scenario}`)

    if (scenario === 'full') {
      return send(res, 200, isResearch ? researchResponse(RESEARCH_TEXT) : structureResponse(FULL_JSON))
    }
    if (scenario === 'partial') {
      return send(res, 200, isResearch ? researchResponse(RESEARCH_TEXT_THIN) : structureResponse(PARTIAL_JSON))
    }
    if (scenario === 'research-timeout') {
      // Never answer the research call — the endpoint's own budget must abort
      // it and continue to structuring with empty research.
      if (isResearch) return
      return send(res, 200, structureResponse(NO_RESEARCH_JSON))
    }
    if (scenario === 'research-500') {
      if (isResearch) return send(res, 500, { error: { message: 'simulated upstream failure' } })
      return send(res, 200, structureResponse(NO_RESEARCH_JSON))
    }
    if (scenario === 'research-ungrounded-once') {
      // The intermittent real-world case: a 200 with prose but NO
      // groundingChunks (the model answered from memory). The endpoint must
      // discard it and retry research once, which then grounds properly.
      if (isResearch) {
        researchAttempts++
        if (researchAttempts === 1) {
          return send(res, 200, {
            candidates: [{ content: { parts: [{ text: 'Soffan är sannolikt en IKEA-modell. Mått cirka 200x95x85 cm. Nypris runt 6000 kr.' }] } }],
            usageMetadata: { promptTokenCount: 3400, candidatesTokenCount: 120 },
          })
        }
        return send(res, 200, researchResponse(RESEARCH_TEXT))
      }
      return send(res, 200, structureResponse(FULL_JSON))
    }
    if (scenario === 'structure-fails-once') {
      // Research is fine; the first structuring attempt 503s and the bounded
      // retry must recover into a real listing rather than an emergency one.
      if (isResearch) return send(res, 200, researchResponse(RESEARCH_TEXT))
      structureAttempts++
      if (structureAttempts === 1) return send(res, 503, { error: { message: 'simulated structuring failure' } })
      return send(res, 200, structureResponse(FULL_JSON))
    }
    if (scenario === 'all-fail') return send(res, 503, { error: { message: 'simulated total outage' } })

    return send(res, 500, { error: 'unknown_scenario' })
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-gemini] listening on http://127.0.0.1:${PORT} (scenario=${scenario})`))
