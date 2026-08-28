// Seller-generation latency benchmark for POST /api/seller/generate.
//
// Reproduces the real consumer seller submission against a locally running
// `wrangler pages dev dist` (default http://127.0.0.1:8788) and reports the
// wall-clock breakdown the seller actually experiences:
//
//   client preprocessing (resize/encode, mirrors the browser canvas step)
//   → request upload + server time (one fetch round trip)
//   → result received
//
// Per-stage SERVER timings come from the function's own structured
// `[generate-listing] stage=... ms=...` logs (visible in the wrangler
// terminal) and from `result.timings` once the instrumented endpoint returns
// it. This script owns only the client-side view.
//
// Usage:
//   node scripts/bench-seller.mjs [--images N] [--url URL] [--brand X] [--note "..."]
//   node scripts/bench-seller.mjs --runs 3
//
// Deliberately uses sharp with the SAME parameters as the browser client
// (src/features/generator/generateListingClient.ts: max edge 1024, JPEG q0.82)
// so the measured payload matches what a real seller uploads.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_IMAGE_EDGE = 1024
const JPEG_QUALITY = 82

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const IMAGE_DIR = arg('dir', 'IKEA SÖDERHAMN')
const IMAGE_COUNT = Number(arg('images', '5'))
const BASE_URL = arg('url', 'http://127.0.0.1:8788')
const BRAND = arg('brand', 'IKEA')
const NOTE = arg('note', 'Soffa, mörkgrått tyg, 3-sits')
const RUNS = Number(arg('runs', '1'))
const RAW = process.argv.includes('--raw')

function ms(n) {
  return `${Math.round(n)} ms`
}

async function loadImages() {
  const dir = path.resolve(process.cwd(), IMAGE_DIR)
  const files = (await readdir(dir))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .slice(0, IMAGE_COUNT)
  if (!files.length) throw new Error(`no images found in ${dir}`)

  const t0 = performance.now()
  let rawBytes = 0
  const images = []
  for (const f of files) {
    const buf = await readFile(path.join(dir, f))
    rawBytes += buf.byteLength
    if (RAW) {
      images.push({ mimeType: 'image/png', dataBase64: buf.toString('base64') })
      continue
    }
    const out = await sharp(buf)
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer()
    images.push({ mimeType: 'image/jpeg', dataBase64: out.toString('base64') })
  }
  const preprocessMs = performance.now() - t0
  const payloadBytes = images.reduce((n, i) => n + i.dataBase64.length, 0)
  return { images, files, preprocessMs, rawBytes, payloadBytes }
}

function summarize(result) {
  if (!result) return
  const lines = []
  lines.push(`  status:        ${result.status ?? '(legacy result, no status field)'}`)
  lines.push(`  identity:      ${[result.identity?.brand, result.identity?.exactProduct, result.identity?.variant].filter(Boolean).join(' ') || '—'}`)
  lines.push(`  category:      ${result.identity?.category ?? '—'}  confidence=${result.identity?.confidence ?? '—'} uncertain=${result.identity?.uncertain ?? '—'}`)
  const attrs = result.attributes ?? []
  lines.push(`  attributes:    ${attrs.length}`)
  for (const a of attrs.slice(0, 12)) lines.push(`     - ${a.label}: ${a.value}${a.sourceUrl ? '  [src]' : ''}`)
  lines.push(`  condition:     ${result.condition?.grade ?? '—'} / ${result.condition?.label ?? '—'}`)
  lines.push(`  retail (ny):   ${result.pricing?.retailPriceSek ?? '—'} kr`)
  lines.push(`  suggested:     ${result.pricing?.suggestedPriceSek ?? '—'} kr  (range ${result.pricing?.priceRangeMinSek ?? '—'}–${result.pricing?.priceRangeMaxSek ?? '—'})`)
  if (result.pricing?.basis) lines.push(`  pricingBasis:  ${result.pricing.basis}`)
  lines.push(`  title:         ${result.listing?.title ?? '—'}`)
  lines.push(`  description:   ${(result.listing?.description ?? '').slice(0, 160)}${(result.listing?.description ?? '').length > 160 ? '…' : ''}`)
  lines.push(`  sources:       ${(result.sources ?? []).length}`)
  if (result.missingFields) lines.push(`  missingFields: ${JSON.stringify(result.missingFields)}`)
  lines.push(`  missingNotes:  ${JSON.stringify(result.missingNotes ?? [])}`)
  if (result.warnings?.length) lines.push(`  warnings:      ${JSON.stringify(result.warnings)}`)
  if (result.timings) lines.push(`  server timings: ${JSON.stringify(result.timings)}`)
  console.log(lines.join('\n'))
}

async function run(images, preprocessMs, payloadBytes, i) {
  const body = JSON.stringify({ brand: BRAND, sellerNote: NOTE, images })
  console.log(`\n─── run ${i + 1}/${RUNS} ─────────────────────────────────────────`)
  const t0 = performance.now()
  let res
  try {
    res = await fetch(`${BASE_URL}/api/seller/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  } catch (err) {
    console.log(`  NETWORK FAILURE after ${ms(performance.now() - t0)}: ${err.message}`)
    return { totalMs: performance.now() - t0, ok: false }
  }
  const text = await res.text()
  const roundTripMs = performance.now() - t0

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    console.log(`  UNPARSEABLE RESPONSE (HTTP ${res.status}) after ${ms(roundTripMs)}: ${text.slice(0, 300)}`)
    return { totalMs: roundTripMs, ok: false }
  }

  console.log(`  HTTP ${res.status}  ok=${parsed.ok}`)
  console.log(`  client preprocess:      ${ms(preprocessMs)}`)
  console.log(`  upload + server + down: ${ms(roundTripMs)}`)
  console.log(`  TOTAL submit → result:  ${ms(preprocessMs + roundTripMs)}`)
  console.log(`  payload:                ${(payloadBytes / 1024 / 1024).toFixed(2)} MB base64`)
  if (parsed.timings) console.log(`  server timings:         ${JSON.stringify(parsed.timings)}`)
  if (parsed.ok) summarize(parsed.result)
  else console.log(`  ERROR BODY: ${parsed.error}`)
  return { totalMs: preprocessMs + roundTripMs, serverMs: roundTripMs, ok: parsed.ok === true, status: res.status }
}

const { images, files, preprocessMs, rawBytes, payloadBytes } = await loadImages()
console.log(`bench-seller → ${BASE_URL}`)
console.log(`images: ${files.length} (${files.join(', ')})`)
console.log(`raw on disk: ${(rawBytes / 1024 / 1024).toFixed(2)} MB → uploaded base64: ${(payloadBytes / 1024 / 1024).toFixed(2)} MB${RAW ? '  [RAW MODE — no resize]' : `  [resized ${MAX_IMAGE_EDGE}px q${JPEG_QUALITY}]`}`)
console.log(`client preprocessing: ${ms(preprocessMs)}`)

const results = []
for (let i = 0; i < RUNS; i++) results.push(await run(images, preprocessMs, payloadBytes, i))

if (RUNS > 1) {
  const oks = results.filter((r) => r.ok)
  console.log(`\n─── summary ─────────────────────────────────────────`)
  console.log(`  runs ok: ${oks.length}/${RUNS}`)
  if (oks.length) {
    const totals = oks.map((r) => r.totalMs).sort((a, b) => a - b)
    console.log(`  total submit→result: min ${ms(totals[0])} | median ${ms(totals[Math.floor(totals.length / 2)])} | max ${ms(totals[totals.length - 1])}`)
  }
}
