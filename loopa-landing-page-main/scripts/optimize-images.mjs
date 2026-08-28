// One-off local script: reads from the READ-ONLY source asset folders and
// writes optimized copies into ./public/assets/. Never writes back to the
// source folders.
import sharp from 'sharp'
import { readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

async function convert(srcDir, destDir, files, { width, quality = 82, prefix = '' }) {
  await mkdir(destDir, { recursive: true })
  const out = []
  for (const file of files) {
    const srcPath = path.join(srcDir, file)
    const base = prefix + slugify(path.parse(file).name)
    const destPath = path.join(destDir, `${base}.webp`)
    await sharp(srcPath)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toFile(destPath)
    out.push({ src: file, out: `${base}.webp` })
  }
  return out
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const results = {}

// IKEA SODERHAMN sofa photos -> full size + thumb size
{
  const dir = path.join(ROOT, 'IKEA SÖDERHAMN')
  const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f))
  files.sort()
  results.ikeaFull = await convert(dir, path.join(ROOT, 'public/assets/ikea'), files, {
    width: 1600,
    quality: 82,
  })
  results.ikeaThumb = await convert(dir, path.join(ROOT, 'public/assets/ikea'), files, {
    width: 480,
    quality: 78,
    prefix: 'thumb-',
  })
}

// Listing pictures (Soffadirekt storefront grid)
{
  const dir = path.join(ROOT, 'Listing Pictures')
  const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f))
  files.sort()
  results.listings = await convert(dir, path.join(ROOT, 'public/assets/listings'), files, {
    width: 900,
    quality: 80,
  })
}

// Person pictures (team + advisors)
{
  const dir = path.join(ROOT, 'Person Pictures')
  const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g)$/i.test(f))
  files.sort()
  results.people = await convert(dir, path.join(ROOT, 'public/assets/people'), files, {
    width: 600,
    quality: 85,
  })
}

for (const [group, items] of Object.entries(results)) {
  console.log(`\n${group}:`)
  for (const item of items) console.log(`  ${item.src} -> ${item.out}`)
}
