// One-off dev step: converts the already-downloaded real Asket "The
// Overshirt" (Dark Navy) product photos into optimized webp copies under
// public/assets/fashion-demo/. Source: https://www.asket.com/en-us/mens-overshirt-dark-navy
// (public CDN images.asket.com, fetched 2026-08-24). Not a runtime scraper —
// run manually if the raw downloads in the temp dir need reprocessing.
import sharp from 'sharp'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = process.env.ASKET_SRC_DIR || '/tmp/asket-imgs'
const OUT_DIR = path.join(ROOT, 'public/assets/fashion-demo')

const files = [
  { src: 'slideshow_1.jpg', out: 'overshirt-full.webp', width: 900 },
  { src: 'slideshow_2.jpg', out: 'overshirt-front.webp', width: 900 },
  { src: 'slideshow_5.jpg', out: 'overshirt-detail.webp', width: 900 },
]

for (const f of files) {
  const srcPath = path.join(SRC_DIR, f.src)
  const outPath = path.join(OUT_DIR, f.out)
  await sharp(srcPath).resize({ width: f.width, withoutEnlargement: true }).webp({ quality: 84 }).toFile(outPath)
  console.log(`${f.src} -> ${f.out}`)
}
