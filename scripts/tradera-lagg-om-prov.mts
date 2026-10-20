/**
 * Provet av veckans omläggning på Tradera, för en annons UTAN Loopa-jobb (t.ex. en egen testannons).
 * Samma Tradera-funktioner som driften använder (tradera.ts): läget läses, den gamla avslutas, en ny
 * publiceras med det sänkta priset, och den nya läses tillbaka.
 *
 * Innehållet tas från en avläst Blocket-annons (scripts/blocket-las-annons.mts), så samma möbel med
 * samma text och bilder ligger på båda kanalerna. Körs på servern, där Tradera-nycklarna finns.
 *
 *   tsx scripts/tradera-lagg-om-prov.mts <blocket-id> --las                     visar planen, rör inget
 *   tsx scripts/tradera-lagg-om-prov.mts <blocket-id> --publicera --pris <kr>    lägger upp testannonsen
 *   tsx scripts/tradera-lagg-om-prov.mts <blocket-id> --lagg-om --pris <kr>      avslutar den och lägger upp en ny
 *
 * Testannonsens itemId sparas i server/data/tradera-prov/<blocket-id>.json, med hela historiken.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SERVER = new URL("../server", import.meta.url).pathname;
try {
  process.loadEnvFile(`${SERVER}/.env`);
} catch {}
const args = process.argv.slice(2);
const blocketId = args[0];
const lage = args.includes("--publicera") ? "publicera" : args.includes("--lagg-om") ? "lagg-om" : args.includes("--las") ? "las" : null;
const prisIdx = args.indexOf("--pris");
const pris = prisIdx >= 0 ? Math.round(Number(args[prisIdx + 1])) : NaN;
if (!blocketId || !lage || (lage !== "las" && !(pris > 0))) {
  console.error("\n  Användning: tsx scripts/tradera-lagg-om-prov.mts <blocket-id> (--las | --publicera --pris <kr> | --lagg-om --pris <kr>)\n");
  process.exit(1);
}

const KATALOG = path.join(SERVER, "data", "blocket-annonser", blocketId);
const annons = JSON.parse(readFileSync(path.join(KATALOG, "annons.json"), "utf-8"));
const falt = (etikett: string): string => {
  const f = annons.falt.find((x: { etikett: string }) => x.etikett === etikett);
  return (f?.valt ?? f?.varde ?? "").trim();
};
const bildfiler = readdirSync(KATALOG)
  .filter((f) => /^bild-\d+\.(jpg|png)$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  .map((f) => path.join(KATALOG, f));

const STATE_DIR = path.join(SERVER, "data", "tradera-prov");
mkdirSync(STATE_DIR, { recursive: true });
const STATE = path.join(STATE_DIR, `${blocketId}.json`);
const state: { itemId: number | null; url: string | null; historik: unknown[] } = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, "utf-8"))
  : { itemId: null, url: null, historik: [] };
const spara = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const t = await import(`${SERVER}/src/integrations/tradera/tradera.ts`);
const m = await import(`${SERVER}/src/integrations/tradera/mapping.ts`);

/** Blockets ren-text till enkel HTML: stycken, och "•"-rader som lista. Allt escapat. */
function tillHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((stycke) => {
      const rader = stycke.split("\n").map((r) => r.trim()).filter(Boolean);
      if (rader.length && rader.every((r) => r.startsWith("•"))) return `<ul>${rader.map((r) => `<li>${esc(r.slice(1).trim())}</li>`).join("")}</ul>`;
      return `<p>${rader.map(esc).join("<br>")}</p>`;
    })
    .join("");
}

const rubrik: string = annons.rubrik;
const kategori = m.traderaCategoryFor({ strong: [rubrik, falt("Underkategori")], weak: [falt("Beskrivning")] });
// Blockets "Bra skick - varsamt använd" → Traderas skala (TRADERA_SKICK_VALUES).
const skick = /mycket bra|som ny/i.test(falt("Skick")) ? "Mycket gott skick" : /bra/i.test(falt("Skick")) ? "Gott skick" : /okej|acceptabel/i.test(falt("Skick")) ? "Okej skick" : null;
const mode: "auction" | "fixed" = process.env.TRADERA_LISTING_MODE === "auction" ? "auction" : "fixed";
const beskrivning = tillHtml(falt("Beskrivning"));

console.log(`\nTradera-prov för Blocket-annonsen ${blocketId} — ${lage}\n`);
console.log(`  Rubrik:     ${rubrik}`);
console.log(`  Kategori:   ${kategori.name} (${kategori.id})   Skick: ${skick}   Typ: ${mode === "fixed" ? "Köp nu" : "auktion"}`);
console.log(`  Bilder:     ${bildfiler.length}   Beskrivning: ${beskrivning.length} tecken HTML`);
console.log(`  Tradera:    ${t.traderaConfigured() ? "konfigurerat" : "INTE konfigurerat"}`);
console.log(`  Testannons: ${state.itemId ? `${state.itemId} ${state.url ?? ""}` : "ingen än"}\n`);
if (!t.traderaConfigured()) process.exit(1);

async function publicera(kr: number) {
  const images = bildfiler.map((f) => ({ data: readFileSync(f), mime: (f.endsWith(".png") ? "image/png" : "image/jpeg") as "image/png" | "image/jpeg" }));
  return t.publishToTradera({
    ownReference: `prov-blocket-${blocketId}`,
    title: rubrik,
    description: beskrivning,
    categoryId: kategori.id,
    price: kr,
    images,
    condition: skick,
    conditionAttributeId: m.TRADERA_SKICK_ATTRIBUTE_ID,
    shippingOptionId: m.TRADERA_SHIPPING_OTHER_ID,
    shippingCost: 0,
    paymentOptionIds: m.traderaPaymentOptionIds(),
    durationDays: mode === "auction" ? 7 : undefined,
    mode,
  });
}

async function lasTillbaka(itemId: number) {
  const item = (await t.getTraderaItem(itemId)) as Record<string, unknown>;
  const l = await t.getTraderaLage(itemId);
  return { pris: item.buyItNowPrice ?? item.openingBid ?? item.openingPrice ?? null, slutar: item.endDate ?? null, lage: l };
}

try {
  if (lage === "las") {
    if (state.itemId) console.log("  Läget:", JSON.stringify(await lasTillbaka(state.itemId)));
    console.log("\n  ✓ Bara läsning — ingenting ändrat.\n");
  } else if (lage === "publicera") {
    if (state.itemId) {
      const l = await t.getTraderaLage(state.itemId);
      if (l && !l.ended) throw new Error(`Testannonsen ${state.itemId} ligger redan uppe — använd --lagg-om.`);
    }
    const r = await publicera(pris);
    Object.assign(state, { itemId: r.itemId, url: r.url });
    state.historik.push({ at: new Date().toISOString(), hande: "publicerad", itemId: r.itemId, url: r.url, pris });
    spara();
    console.log(`  ✓ Publicerad: ${r.url}`);
    console.log("  Tillbaka från Tradera:", JSON.stringify(await lasTillbaka(r.itemId)), "\n");
  } else {
    if (!state.itemId) throw new Error("Ingen testannons att lägga om — kör --publicera först.");
    const gammal = state.itemId;
    // Samma regel som driften (priceLadder.ts): bud eller såld → ingen omläggning; oläsbart → avbryt.
    const l = await t.getTraderaLage(gammal);
    if (!l) throw new Error("Läget gick inte att läsa hos Tradera — ingenting rört.");
    if (l.totalBids > 0 || l.gotWinner) throw new Error(`Annonsen har ${l.totalBids} bud${l.gotWinner ? " och är såld" : ""} — läggs inte om.`);
    console.log(`  Gamla annonsen ${gammal}: ${JSON.stringify(await lasTillbaka(gammal))}`);
    if (!l.ended) {
      await t.endTraderaItem(gammal);
      console.log(`  ✓ Gamla annonsen ${gammal} avslutad.`);
    } else console.log(`  Gamla annonsen ${gammal} hade redan gått ut.`);
    const r = await publicera(pris);
    Object.assign(state, { itemId: r.itemId, url: r.url });
    state.historik.push({ at: new Date().toISOString(), hande: "omlagd", fran: gammal, itemId: r.itemId, url: r.url, pris });
    spara();
    console.log(`  ✓ Ny annons: ${r.url}`);
    console.log(`  Tillbaka från Tradera (ny):    ${JSON.stringify(await lasTillbaka(r.itemId))}`);
    console.log(`  Tillbaka från Tradera (gamla): ${JSON.stringify(await t.getTraderaLage(gammal))}\n`);
  }
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
