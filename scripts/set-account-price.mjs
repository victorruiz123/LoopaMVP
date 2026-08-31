#!/usr/bin/env node
/**
 * Sätter ETT pris på varje annons ett konto äger, genom säljarens egen prisstege.
 *
 * Priset går in där ett säljarbeslut hör hemma: `priceLadder`. resolveAdPrice (adContent.ts) låter
 * stegens pris gå före prismotorns förslag, så annonsen får det här priset på Tradera och Blocket
 * utan att besiktningens värdering skrivs om.
 *
 *   node scripts/set-account-price.mjs --owner=<uuid> [--price=150] [--floor=100] [--apply]
 *
 * Utan --apply skrivs ingenting: körningen visar vad den skulle ha gjort.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const JOBS_DIR = path.join(ROOT, "server", "data", "jobs");

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const PRICE = Math.round(Number(arg("price", 150)));
const FLOOR = Math.round(Number(arg("floor", 100)));
const OWNER = arg("owner", null);
const BACKUP = arg("backup", path.join(ROOT, ".price-backup"));

if (!OWNER) {
  console.error("Ange --owner=<uuid>. Kör med --owner=auto för att lista ägarna och deras annonser.");
  process.exit(1);
}
if (FLOOR > PRICE) {
  console.error("Golvet kan inte vara högre än priset.");
  process.exit(1);
}

const listingOf = (j) => j.result?.listing ?? j.listing ?? j.pendingListing ?? null;

const entries = await readdir(JOBS_DIR);
const jobs = [];
for (const id of entries) {
  try {
    jobs.push(JSON.parse(await readFile(path.join(JOBS_DIR, id, "job.json"), "utf-8")));
  } catch {}
}

if (OWNER === "auto") {
  const byOwner = new Map();
  for (const j of jobs) {
    const o = j.ownerId ?? "(ingen ägare)";
    const row = byOwner.get(o) ?? { jobs: 0, ads: 0 };
    row.jobs += 1;
    if (listingOf(j)) row.ads += 1;
    byOwner.set(o, row);
  }
  for (const [o, r] of [...byOwner].sort((a, b) => b[1].ads - a[1].ads)) {
    console.log(`${o}  jobb=${r.jobs}  annonser=${r.ads}`);
  }
  process.exit(0);
}

const mine = jobs.filter((j) => j.ownerId === OWNER && listingOf(j));
const published = mine.filter((j) => j.priceLadder && j.priceLadder.listingMode !== null);
const targets = mine.filter((j) => !published.includes(j));

console.log(`Konto ${OWNER}: ${mine.length} annonser, varav ${published.length} redan publicerade.`);
console.log(`Pris ${PRICE} kr, golv ${FLOOR} kr, 15 % i veckan.\n`);

if (APPLY) await mkdir(BACKUP, { recursive: true });

for (const job of targets) {
  const before = job.priceLadder ? `${job.priceLadder.startPrice}→${job.priceLadder.floorPrice}` : "inget spann";
  console.log(`  ${job.id}  ${before}  ->  ${PRICE}→${FLOOR}`);
  if (!APPLY) continue;
  const file = path.join(JOBS_DIR, job.id, "job.json");
  await writeFile(path.join(BACKUP, `${job.id}.json`), await readFile(file, "utf-8"));
  job.priceLadder = {
    startPrice: PRICE,
    floorPrice: FLOOR,
    weeklyDropPct: 0.15,
    currentPrice: PRICE,
    nextDropAt: null,
    drops: [],
    floorReachedAt: null,
    lastError: null,
    chosenAt: new Date().toISOString(),
    listingMode: null,
  };
  await writeFile(file, JSON.stringify(job, null, 2));
}

if (published.length) {
  console.log(`\n${published.length} annons(er) ligger redan uppe och rörs inte — priset på dem sitter hos Tradera`);
  console.log("och måste ändras där (updateTraderaPrice), annars ljuger currentPrice om vad som är publikt:");
  for (const j of published) console.log(`  ${j.id}  currentPrice=${j.priceLadder.currentPrice}`);
}
console.log(APPLY ? `\nKlart. Original sparade i ${BACKUP}` : "\nTorrkörning — inget skrevs. Lägg till --apply.");
