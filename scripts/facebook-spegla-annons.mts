/**
 * Speglar en LIVE produktionsannons (loopa.nu) till ett lokalt jobb, så att Facebook-distributionen
 * kan köras från en utvecklingsmaskin utan produktionsdata.
 *
 *   npx tsx scripts/facebook-spegla-annons.mts LP-9X20-66BZ
 *
 * BARA PUBLIKA, KANONISKA UPPGIFTER: produktposten (/api/butik/produkter/<id>), sanningskortet
 * (/api/cards/<id>) och omslagsbilden. Ingenting hittas på. Jobbet får SAMMA job-id som i produktion,
 * så Loopa-ID:t — och därmed den kanoniska adressen — blir identisk. Butiksposten sätts live lokalt så
 * att kön ser möbeln som till salu.
 *
 * Ett utvecklingsverktyg för den kontrollerade valideringen — inte en del av driften.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const id = process.argv[2];
if (!id) {
  console.error("Ange ett Loopa-ID, t.ex. LP-9X20-66BZ");
  process.exit(1);
}
const BAS = process.env.LOOPA_PUBLIC_URL?.replace(/\/+$/, "") || "https://loopa.nu";

const { JOBS_DIR } = await import("../server/src/jobStore.ts");
const { loopaIdFor } = await import("../server/src/loopaId.ts");
const butik = await import("../server/src/butik/store.ts");

const productRes = await fetch(`${BAS}/api/butik/produkter/${id}`);
if (!productRes.ok) throw new Error(`Produkten svarade ${productRes.status}`);
const { product } = (await productRes.json()) as { product: any };
const cardRes = await fetch(`${BAS}/api/cards/${id}`);
if (!cardRes.ok) throw new Error(`Kortet svarade ${cardRes.status}`);
const card = (await cardRes.json()) as any;

if (!product.jobId) throw new Error("Produkten bär inget job-id — kan inte spegla med samma Loopa-ID.");
if (loopaIdFor(product.jobId) !== id) throw new Error(`Job-id ${product.jobId} ger inte ${id}.`);

const dir = path.join(JOBS_DIR, product.jobId);
await mkdir(path.join(dir, "originals"), { recursive: true });

// Bilderna: omslaget och galleriet, i den ordning kortet visar dem. Bara det som är publikt.
const bildUrls: string[] = [card.cover?.url, ...(card.bilder ?? []).map((b: { url: string }) => b.url)].filter(Boolean);
const images = [];
for (const [i, rel] of bildUrls.entries()) {
  const res = await fetch(`${BAS}${rel}`);
  if (!res.ok) continue;
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
  const name = `img_${i}.${ext}`;
  await writeFile(path.join(dir, "originals", name), buf);
  const sharp = (await import("../server/node_modules/sharp/lib/index.js")).default;
  const meta = await sharp(buf).metadata();
  images.push({ id: `img_${i}`, viewLabel: i === 0 ? "Omslag" : null, source: "manual", width: meta.width ?? 0, height: meta.height ?? 0, path: name, ...(i === 0 ? { role: "cover" } : {}) });
}
if (images.length === 0) throw new Error("Ingen publik bild gick att hämta.");

const now = new Date().toISOString();
const job = {
  id: product.jobId,
  createdAt: card.createdAt,
  ownerId: null,
  ownerEmail: null,
  progress: { stage: "done", message: "Speglad från produktion." },
  error: null,
  productContext: null,
  identity: card.identity,
  images,
  // Produktsidans pris kommer ur prisstegen i produktion. Samma tal här, som en frusen steg.
  priceLadder: {
    startPrice: product.priceSek,
    floorPrice: product.priceSek,
    weeklyDropPct: 0,
    currentPrice: product.priceSek,
    nextDropAt: null,
    drops: [],
    floorReachedAt: now,
    lastError: null,
    chosenAt: now,
    listingMode: "fixed",
  },
  tradera: card.tradera?.status === "published"
    ? { status: "published", requestId: null, itemId: null, url: card.tradera.url, error: null, startedAt: card.createdAt, publishedAt: product.listedAt, approvedAt: product.listedAt, approvedBy: "produktion" }
    : { status: "pending", requestId: null, itemId: null, url: null, error: null, startedAt: card.createdAt, publishedAt: null, approvedAt: product.listedAt, approvedBy: "produktion" },
  result: {
    jobId: product.jobId,
    createdAt: card.createdAt,
    identity: card.identity,
    price: card.price
      ? { ...card.price, confidence: null, note: null, matchCount: 0, variant: null, variantMethod: null }
      : null,
    reviewPending: false,
    reviewed: card.reviewed,
    listing: { status: "ok", unavailableReason: null, result: { ...card.card, sources: card.card.sources ?? [] } },
    coverage: card.damages?.length ? "INSPECTED_DAMAGE" : "INSPECTED_CLEAR",
    coverageNote: null,
    grade: card.grade,
    // Skadorna på det publika kortet har en annan form än jobbets; skicket (betyg, etikett) är det som går ut.
    damages: [],
    overallCondition: null,
    images,
    coverImageId: "img_0",
    productImage: card.productImage ?? null,
    speglad: { fran: `${BAS}/butik/objekt/${id}`, at: now },
  },
};
await writeFile(path.join(dir, "job.json"), JSON.stringify(job, null, 2), "utf-8");

await butik.ensureRecord(id, product.jobId, "loopa", product.listedAt);
const live = (await butik.store().get(id))?.state === "live" ? null : await butik.publish(id, { kind: "system", job: "spegling" });

console.log(JSON.stringify({ loopaId: id, jobId: product.jobId, title: product.title, price: product.priceSek, grade: card.grade?.grade, images: images.length, jobDir: dir, butikState: live?.state ?? (await butik.store().get(id))?.state, canonical: `${BAS}/butik/objekt/${id}` }, null, 2));
