// Regression check for the professional /secondhand pipeline
// (POST /api/generate-listing, mode=furniture) after seller mode was moved
// out of it into functions/api/seller/generate.ts.
//
// What must still hold:
//   - furniture mode still runs its grounded-research → structuring pipeline
//   - the SEO block (metaTitle / metaDescription / imageAlt) is still generated
//   - jsonLd + slug are still derived
//   - seller mode is no longer accepted here (it has its own endpoint)
//
// This calls the REAL heavy research models (gemini-3.7-flash →
// gemini-3.6-flash) and can legitimately take 1-3 minutes — that professional
// pipeline's timeouts are deliberately unchanged by the seller work.
//
// Usage: node scripts/smoke-secondhand.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const BASE_URL = 'http://127.0.0.1:8788'

const dir = path.resolve(process.cwd(), 'IKEA SÖDERHAMN')
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 3)
const images = []
for (const f of files) {
  const out = await sharp(await readFile(path.join(dir, f)))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  images.push({ mimeType: 'image/jpeg', dataBase64: out.toString('base64') })
}

let failures = 0
function check(label, cond, detail = '') {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('── seller mode must be rejected here (moved to /api/seller/generate)')
{
  const r = await fetch(`${BASE_URL}/api/generate-listing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'seller', brand: 'IKEA', images }),
  })
  const j = await r.json()
  check('seller mode → 400', r.status === 400, `got ${r.status}`)
  check('error points at the new endpoint', /seller\/generate/.test(j.error ?? ''), j.error)
}

console.log('\n── furniture mode validation unchanged')
{
  const r = await fetch(`${BASE_URL}/api/generate-listing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'furniture', brand: 'IKEA', images }),
  })
  check('furniture without model → 400', r.status === 400, `got ${r.status}`)
}

console.log('\n── furniture full run (real heavy models, may take minutes)')
{
  const t0 = performance.now()
  const r = await fetch(`${BASE_URL}/api/generate-listing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'furniture', brand: 'IKEA', model: 'SÖDERHAMN 3-sits', images }),
  })
  const elapsed = performance.now() - t0
  const j = await r.json()
  console.log(`  elapsed ${(elapsed / 1000).toFixed(1)}s, HTTP ${r.status}, ok=${j.ok}`)
  if (!j.ok) {
    console.log(`  error: ${j.error}`)
    check('furniture run succeeded', false, j.error)
  } else {
    const res = j.result
    check('mode=furniture', res.mode === 'furniture')
    check('SEO metaTitle generated', !!res.seo?.metaTitle, res.seo?.metaTitle)
    check('SEO metaDescription generated', !!res.seo?.metaDescription)
    check('SEO imageAlt generated', !!res.seo?.imageAlt)
    check('slug derived', !!res.slug, res.slug)
    check('jsonLd derived', res.jsonLd !== null)
    check('listing produced', !!res.listing?.title, res.listing?.title)
    check('seller-only fields absent', res.status === undefined && res.missingFields === undefined)

    // Attributes are only EXPECTED when the grounded research stage actually
    // succeeded. That stage is best-effort by design and currently fails often
    // on the heavy research models (gemini-3.7-flash + googleSearch measured
    // >90s — see docs/SELLER_GENERATION_PERFORMANCE.md §2), which is a
    // pre-existing upstream condition, not a regression. With no research, 0
    // attributes is the CORRECT behavior: the pipeline refuses to invent specs.
    const sources = (res.sources ?? []).length
    console.log(`  research sources: ${sources}, attributes: ${(res.attributes ?? []).length}`)
    console.log(`  missingNotes: ${JSON.stringify(res.missingNotes ?? [])}`)
    if (sources > 0) {
      check('attributes produced when research succeeded', (res.attributes ?? []).length > 0, `${(res.attributes ?? []).length} attrs`)
    } else {
      console.log('  [SKIP] attribute check — grounded research returned no sources (heavy-model upstream latency, pre-existing)')
      check('no specs invented without research', (res.attributes ?? []).length === 0)
    }
  }
}

console.log(`\n${failures === 0 ? '✅ /secondhand PRESERVED' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
