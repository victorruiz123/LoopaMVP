// Deterministic degradation tests for POST /api/seller/generate.
//
// Drives the REAL endpoint through `wrangler pages dev` while
// scripts/mock-gemini.mjs impersonates the upstream (via AI_GATEWAY_URL), so
// the endpoint's real timeouts, retry and assembly logic are exercised without
// spending a single Gemini call.
//
// The one non-negotiable assertion across every scenario: a valid seller
// submission NEVER produces an error. HTTP 200, ok:true, a usable title and a
// usable description, every time.
//
// Requires AI_GATEWAY_URL to point at the mock — see scripts/with-mock-gemini.md
// or run wrangler with `.dev.vars` temporarily pointing at 127.0.0.1:8799.
//
// Usage (with wrangler + mock-gemini already running):
//   node scripts/test-seller-degradation.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const BASE_URL = 'http://127.0.0.1:8788'
const MOCK_URL = 'http://127.0.0.1:8799'

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 5)
const images = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  images.push({ mimeType: 'image/jpeg', dataBase64: out.toString('base64') })
}

async function setScenario(name) {
  const r = await fetch(`${MOCK_URL}/__scenario`, { method: 'POST', body: JSON.stringify({ name }) })
  if (!r.ok) throw new Error(`could not set scenario ${name}: ${await r.text()}`)
}

async function submit(body) {
  const t0 = performance.now()
  const res = await fetch(`${BASE_URL}/api/seller/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { brand: 'IKEA', sellerNote: 'Soffa, mörkgrått tyg, 3-sits', images }),
  })
  const elapsed = performance.now() - t0
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, elapsed, parsed, raw: text }
}

let failures = 0
function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`     [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function reportResult(r) {
  const res = r.parsed?.result
  console.log(`     http=${r.status} ok=${r.parsed?.ok} elapsed=${(r.elapsed / 1000).toFixed(2)}s status=${res?.status}`)
  console.log(`     timings=${JSON.stringify(r.parsed?.timings ?? {})}`)
  console.log(`     title="${res?.listing?.title ?? '—'}"`)
  console.log(`     price=${res?.pricing?.suggestedPriceSek ?? '—'} basis=${res?.pricing?.basis ?? '—'} condition="${res?.condition?.label ?? '—'}"`)
  console.log(`     missingFields=${JSON.stringify(res?.missingFields ?? [])} researchUnavailable=${res?.researchUnavailable} warnings=${JSON.stringify(res?.warnings ?? [])}`)
}

/** The invariant that matters most: a valid submission never dead-ends. */
function assertAlwaysUsable(r) {
  const res = r.parsed?.result
  check('HTTP 200', r.status === 200, `got ${r.status}`)
  check('ok:true', r.parsed?.ok === true)
  check('has usable title', !!res?.listing?.title?.trim())
  check('has usable description', (res?.listing?.description?.trim()?.length ?? 0) > 20)
  check('has condition wording', !!(res?.condition?.label || res?.condition?.grade))
  check('within 30s hard limit', r.elapsed < 30_000, `${(r.elapsed / 1000).toFixed(2)}s`)
}

console.log('\n══ TEST A — good research case ════════════════════════════════')
await setScenario('full')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('status=full', res?.status === 'full', `got ${res?.status}`)
  check('identified exact model', res?.identity?.exactProduct === 'SÖDERHAMN')
  check('has dimensions', res?.attributes?.some((a) => /bredd/i.test(a.label)))
  check('has material', res?.attributes?.some((a) => /material/i.test(a.label)))
  check('has new price', res?.pricing?.retailPriceSek === 4095)
  check('pricing basis=comparables', res?.pricing?.basis === 'comparables', `got ${res?.pricing?.basis}`)
  check('no critical missing fields', !['dimensions', 'material', 'newPrice', 'model', 'price'].some((f) => res?.missingFields?.includes(f)), JSON.stringify(res?.missingFields))
  check('has sources', (res?.sources ?? []).length > 0)
  check('exactly 2 gemini calls', r.parsed?.timings?.geminiCalls === 2, `got ${r.parsed?.timings?.geminiCalls}`)
  check('exactly 1 grounded call', r.parsed?.timings?.groundedCalls === 1, `got ${r.parsed?.timings?.groundedCalls}`)
  check('no JSON-LD generated', res?.jsonLd === null)
  check('sourceUrl kept only when cited in research', res?.attributes?.every((a) => !a.sourceUrl || a.sourceUrl.includes('ikea.com')))
}

console.log('\n══ TEST B — research succeeds, some specs unavailable ══════════')
await setScenario('partial')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('status=partial', res?.status === 'partial', `got ${res?.status}`)
  check('missingFields lists dimensions', res?.missingFields?.includes('dimensions'))
  check('missingFields lists material', res?.missingFields?.includes('material'))
  check('missingFields lists newPrice', res?.missingFields?.includes('newPrice'))
  check('still has a price', res?.pricing?.suggestedPriceSek > 0)
  check('did NOT invent dimensions', !res?.attributes?.some((a) => /bredd|djup|höjd/i.test(a.label)))
}

console.log('\n══ TEST C — grounded research times out ═══════════════════════')
await setScenario('research-timeout')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('status=fallback', res?.status === 'fallback', `got ${res?.status}`)
  check('researchUnavailable=true', res?.researchUnavailable === true)
  check('research warning recorded', (res?.warnings ?? []).includes('research_failed'))
  check('research aborted at its budget, not 60s', r.parsed?.timings?.researchMs < 11_000, `${r.parsed?.timings?.researchMs}ms`)
  check('structuring still ran', r.parsed?.timings?.geminiCalls === 2, `got ${r.parsed?.timings?.geminiCalls}`)
  check('still produced a price estimate', res?.pricing?.suggestedPriceSek > 0)
  check('pricing basis=estimate', res?.pricing?.basis === 'estimate', `got ${res?.pricing?.basis}`)
  check('did NOT invent a model name', res?.identity?.exactProduct === null)
  check('bounded well under deadline', r.elapsed < 22_000, `${(r.elapsed / 1000).toFixed(2)}s`)
}

console.log('\n══ TEST D — research model fails (5xx) ════════════════════════')
await setScenario('research-500')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('status=fallback', res?.status === 'fallback', `got ${res?.status}`)
  check('failed fast, no timeout wait', r.elapsed < 15_000, `${(r.elapsed / 1000).toFixed(2)}s`)
  check('still produced a listing', !!res?.listing?.description)
  check('warning recorded', (res?.warnings ?? []).includes('research_failed'))
  check('no invented new price', res?.pricing?.retailPriceSek === null)
}

console.log('\n══ TEST C2 — research returns text but no grounding (recall) ══')
await setScenario('research-ungrounded-once')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('ungrounded attempt discarded', (res?.warnings ?? []).includes('research_ungrounded'))
  check('research retried once', r.parsed?.timings?.researchRetried === true)
  check('retry grounded properly → full', res?.status === 'full', `got ${res?.status}`)
  check('recovered real dimensions', res?.attributes?.some((a) => /bredd/i.test(a.label)))
  check('3 gemini calls (research ×2 + structure)', r.parsed?.timings?.geminiCalls === 3, `got ${r.parsed?.timings?.geminiCalls}`)
  check('still bounded', r.elapsed < 25_000, `${(r.elapsed / 1000).toFixed(2)}s`)
}

console.log('\n══ TEST D2 — structuring fails once, bounded retry recovers ═══')
await setScenario('structure-fails-once')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('retry happened', r.parsed?.timings?.structureRetried === true)
  check('recovered into a real listing', res?.identity?.exactProduct === 'SÖDERHAMN')
  check('retry warning recorded', (res?.warnings ?? []).includes('structure_retried'))
  check('still bounded', r.elapsed < 25_000, `${(r.elapsed / 1000).toFixed(2)}s`)
}

console.log('\n══ TEST E — ALL external AI fails ═════════════════════════════')
await setScenario('all-fail')
{
  const r = await submit()
  reportResult(r)
  assertAlwaysUsable(r)
  const res = r.parsed?.result
  check('status=fallback', res?.status === 'fallback')
  check('emergency result reached', (res?.warnings ?? []).includes('structure_failed'))
  check('brand preserved from session', res?.identity?.brand === 'IKEA')
  check('seller note reflected in description', /mörkgrått/i.test(res?.listing?.description ?? ''))
  check('truthful generic condition', /begagnat skick/i.test(res?.condition?.label ?? ''))
  check('no invented specs', (res?.attributes ?? []).length === 0)
  check('no invented price', res?.pricing?.available === false)
  check('bounded', r.elapsed < 30_000, `${(r.elapsed / 1000).toFixed(2)}s`)
}

console.log('\n══ Invalid requests still error properly ══════════════════════')
{
  const noBrand = await submit({ brand: '', images })
  check('missing brand → 400', noBrand.status === 400, `got ${noBrand.status}`)
  const noImages = await submit({ brand: 'IKEA', images: [] })
  check('no images → 400', noImages.status === 400, `got ${noImages.status}`)
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
