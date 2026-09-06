// ─── Lagret och migreringen ─────────────────────────────────────────────────
//
// Två saker prövas här. Det första är räknarna pulsen bygger på: "vi har bevakat 214 objekt" måste
// vara 214 objekt vi faktiskt läst, annars är brevet påhittat. Det andra är migreringen från
// butikens bevakningar — som körs vid varje uppstart och därför måste tåla att köras vid varje
// uppstart, mot en fil som är den enda kopian av data vi inte kan räkna fram igen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-efterlysning-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.BUTIK_DATA_DIR = path.join(TMP, "butik");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const { migrateBevakningar } = await import("../server/src/efterlysning/migrate.js");

const spec = (over = {}) => ({
  userId: "u1", email: "u@x.se",
  filter: { categorySlug: "soffor", maxPriceSek: 5000 },
  styleTags: [], deadline: null, urgency: "none" as const, note: null,
  summary: "Soffor · max 5 000 kr", parseMethod: "form" as const, area: "Södermalm",
  ...over,
});

test("en efterlysning somnar av sig själv efter 90 dagar", async () => {
  const e = await store.create(spec());
  const days = (new Date(e.expiresAt).getTime() - new Date(e.createdAt).getTime()) / 86_400_000;
  assert.equal(Math.round(days), 90);
  assert.equal(e.state, "active");
});

test("förnyelse flyttar fram 90 dagar och väcker en somnad", async () => {
  const e = await store.create(spec());
  await store.update(e.id, { state: "expired" });
  const renewed = await store.renew(e.id);
  assert.equal(renewed?.state, "active");
  assert.ok(new Date(renewed!.expiresAt).getTime() > Date.now() + 89 * 86_400_000);
});

test("räknarna summerar det vi faktiskt läst — pulsen får inte hitta på", async () => {
  const e = await store.create(spec());
  await store.recordSweep(e.id, 120);
  await store.recordSweep(e.id, 94, 2);
  const after = await store.get(e.id);
  assert.equal(after?.scannedCount, 214);
  assert.equal(after?.scannedClearances, 2);
  assert.ok(after?.lastSweptAt);
});

test("bara ägaren får radera", async () => {
  const e = await store.create(spec());
  assert.equal(await store.remove(e.id, "någon-annan"), false);
  assert.ok(await store.get(e.id), "ligger kvar");
  assert.equal(await store.remove(e.id, "u1"), true);
  assert.equal(await store.get(e.id), null);
});

test("samma möbel loggas en gång per efterlysning", async () => {
  const e = await store.create(spec());
  const row = { efterlysningId: e.id, productId: "LP-1", source: "loopa_live" as const, kind: "exact" as const, fitNote: "" };
  assert.equal((await store.logMatches([row])).length, 1);
  assert.equal((await store.logMatches([row])).length, 0, "andra gången ger ingen ny rad");
  assert.equal((await store.matchesFor(e.id)).length, 1);
});

test("ett köp märks på matchningen — norra stjärnan räknas härifrån", async () => {
  const e = await store.create(spec());
  await store.logMatches([{ efterlysningId: e.id, productId: "LP-2", source: "tradera", kind: "exact", fitNote: "" }]);
  await store.markPurchased(e.id, "LP-2");
  assert.ok((await store.matchesFor(e.id)).find((m) => m.productId === "LP-2")?.purchasedAt);
});

// ─── migreringen ────────────────────────────────────────────────────────────

test("utan gammal fil händer ingenting, och det är inte ett fel", async () => {
  assert.deepEqual(await migrateBevakningar(), { found: 0, migrated: 0, skipped: 0 });
});

test("en bevakning blir en efterlysning med samma spec", async () => {
  mkdirSync(process.env.BUTIK_DATA_DIR!, { recursive: true });
  const file = path.join(process.env.BUTIK_DATA_DIR!, "bevakningar.json");
  writeFileSync(file, JSON.stringify([{
    id: "b1", userId: "gammal", email: "g@x.se", categorySlug: "bord", brand: "Swedese",
    maxPriceSek: 3000, maxWidthMm: 1600, maxDepthMm: null, maxHeightMm: null,
    createdAt: "2026-01-01T00:00:00Z", notifiedProductIds: [],
  }]));

  const r = await migrateBevakningar();
  assert.deepEqual(r, { found: 1, migrated: 1, skipped: 0 });

  const [e] = await store.forUser("gammal");
  assert.equal(e.filter.categorySlug, "bord");
  assert.deepEqual(e.filter.brands, ["Swedese"], "ental blir lista");
  assert.equal(e.filter.maxPriceSek, 3000);
  assert.equal(e.parseMethod, "butik_filter", "varken chattad eller ifylld");
  assert.match(e.summary, /Swedese/);
});

test("den gamla filen flyttas undan, den raderas inte", async () => {
  const file = path.join(process.env.BUTIK_DATA_DIR!, "bevakningar.json");
  assert.equal(existsSync(file), false, "ur vägen");
  assert.equal(existsSync(`${file}.migrerad`), true, "men kvar på disk");
});

test("en andra körning skapar inga dubbletter", async () => {
  // Migreringen körs vid varje uppstart och måste tåla det.
  const file = path.join(process.env.BUTIK_DATA_DIR!, "bevakningar.json");
  writeFileSync(file, JSON.stringify([{
    id: "b1", userId: "gammal", email: "g@x.se", categorySlug: "bord", brand: "Swedese",
    maxPriceSek: 3000, maxWidthMm: 1600, maxDepthMm: null, maxHeightMm: null,
    createdAt: "2026-01-01T00:00:00Z", notifiedProductIds: [],
  }]));
  const r = await migrateBevakningar();
  assert.deepEqual(r, { found: 1, migrated: 0, skipped: 1 });
  assert.equal((await store.forUser("gammal")).length, 1);
});
