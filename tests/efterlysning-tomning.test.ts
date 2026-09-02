// ─── Tömningar: ett löfte om besked, inte om en möbel ───────────────────────
//
// En kontorstömning är känd dagar innan någon sett möblerna. Det som finns då är en förväntad lista,
// och den räcker för att säga något till den som väntat i tre veckor på en kontorsstol. Men vi vet
// ingenting än, och brevet måste bära det:
//
//   "Din stol kommer på torsdag."                  — ett påstående vi inte kan hålla
//   "…innehåller troligen din stol. Besked torsdag" — ett löfte om ett BESKED, som vi kan hålla
//
// Matchningen är grov med flit: före besiktningen finns inga mått, betyg eller priser, och en
// efterlysning med "max 210 cm bred" ska inte gå miste om beskedet för att ingen mätt stolen än.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-tomning-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.OUTBOX_DIR = path.join(TMP, "outbox");
process.env.EMAIL_PROVIDER = "file";
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const notify = await import("../server/src/efterlysning/notify.js");
const clearance = await import("../server/src/efterlysning/clearance.js");

const spec = (over = {}) => ({
  userId: "u1", email: "k@example.com",
  filter: { categorySlug: "stolar", maxPriceSek: 1500, maxWidthMm: 600 },
  styleTags: [], deadline: null, urgency: "none" as const, note: null,
  summary: "Stolar · max 1 500 kr", parseMethod: "chat" as const, area: null,
  ...over,
});

const om = (dagar: number) => new Date(Date.now() + dagar * 86_400_000).toISOString().slice(0, 10);

test("beskedsdatumet sätts automatiskt till dagen efter hämtningen", async () => {
  const c = await clearance.create({
    name: "Kontorstömning på Kungsholmen", pickupDate: om(7),
    expected: [{ categorySlug: "stolar", brand: null, count: 20, note: null }],
  });
  assert.equal(c.verdictDate, om(8), "besiktningen tar en dag");
});

test("brevet lovar ett BESKED, inte en möbel", async () => {
  await store.create(spec({ userId: "t1" }));
  const c = (await clearance.list())[0];
  await clearance.notifyForClearance(c);
  const n = (await notify.inbox("t1"))[0];
  assert.ok(n, "en notis");
  assert.match(n.title, /innehåller troligen/, "troligen, inte säkert");
  // Ental: "din stol", aldrig "din stolar" — meningen hann gå ut i skarp körning innan
  // categoryNoun fanns.
  assert.match(n.title, /din stol$/);
  assert.match(n.body, /Vi vet inte skicket förrän vi sett dem/);
  assert.match(n.body, new RegExp(`Du får besked den ${om(8)}`));
  assert.doesNotMatch(n.body, /kommer på/, "inget löfte om leverans");
});

test("MÅTT OCH PRIS PRÖVAS INTE — ingen har mätt stolen än", async () => {
  // Efterlysningen har max 600 mm bredd och max 1 500 kr. Tömningsraden har varken mått eller pris,
  // och att fälla den på det hade gett noll träffar varje gång.
  const e = await store.create(spec({ userId: "t2", filter: { categorySlug: "stolar", maxPriceSek: 200, maxWidthMm: 100 } }));
  const c = (await clearance.list())[0];
  await clearance.notifyForClearance(c);
  assert.ok((await notify.inbox("t2")).length >= 1, "beskedet går ut ändå");
  void e;
});

test("men fel kategori matchar inte", async () => {
  await store.create(spec({ userId: "t3", filter: { categorySlug: "sangar", maxPriceSek: 5000 } }));
  const c = (await clearance.list())[0];
  await clearance.notifyForClearance(c);
  assert.equal((await notify.inbox("t3")).length, 0);
});

test("märket prövas bara när BÅDA har ett", async () => {
  // En tömningsrad utan märke kan innehålla vad som helst; att fälla den mot en efterlysning som
  // vill ha String vore att gissa åt köparen i fel riktning.
  await store.create(spec({ userId: "t4", filter: { categorySlug: "stolar", brands: ["String"] } }));
  const c = (await clearance.list())[0];
  await clearance.notifyForClearance(c);
  assert.ok((await notify.inbox("t4")).length >= 1, "omärkt rad kan innehålla en String");

  const medMarke = await clearance.create({
    name: "Dödsbo i Vasastan", pickupDate: om(5),
    expected: [{ categorySlug: "stolar", brand: "IKEA", count: 6, note: null }],
  });
  await store.create(spec({ userId: "t5", filter: { categorySlug: "stolar", brands: ["String"] } }));
  await clearance.notifyForClearance(medMarke);
  assert.equal((await notify.inbox("t5")).length, 0, "IKEA-rad matchar inte en String-efterlysning");
});

test("en köpare får ett brev per tömning, inte per rad", async () => {
  const flera = await clearance.create({
    name: "Stor kontorstömning", pickupDate: om(9),
    expected: [
      { categorySlug: "stolar", brand: null, count: 20, note: null },
      { categorySlug: "stolar", brand: "IKEA", count: 8, note: null },
      { categorySlug: "stolar", brand: null, count: 4, note: "höga" },
    ],
  });
  await store.create(spec({ userId: "t6" }));
  const skickade = await clearance.notifyForClearance(flera);
  assert.equal(skickade.filter((s) => s.efterlysningId).length, skickade.length);
  assert.equal((await notify.inbox("t6")).length, 1, "ett brev trots tre passande rader");
});

test("en genomgången tömning räknas i pulsens siffror", async () => {
  // "Vi har bevakat 214 objekt och 2 tömningar åt dig" — den andra siffran kommer härifrån.
  const e = await store.create(spec({ userId: "t7" }));
  const c = await clearance.create({
    name: "Tömning i Solna", pickupDate: om(3),
    expected: [{ categorySlug: "stolar", brand: null, count: 10, note: null }],
  });
  await clearance.notifyForClearance(c);
  assert.equal((await store.get(e.id))!.scannedClearances, 1);
});

test("en avslutad tömning skickar inga fler brev", async () => {
  const c = await clearance.create({
    name: "Avslutad tömning", pickupDate: om(1),
    expected: [{ categorySlug: "stolar", brand: null, count: 5, note: null }],
  });
  await clearance.settle(c.id);
  await store.create(spec({ userId: "t8" }));
  assert.deepEqual(await clearance.notifyForClearance(c), []);
  assert.equal((await notify.inbox("t8")).length, 0);
});
