// ─── Bevakningar: löftet att höra av sig ────────────────────────────────────
//
// En bevakning är ett löfte om ett mejl. Testerna nedan låser fast att löftet inte överuppfylls
// (samma möbel två gånger, eller Traderas hela utbud) och inte underuppfylls tyst.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-bev-test-"));
process.on("exit", () => rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true }));

const { createBevakning, listBevakningar, deleteBevakning, matches, takePendingNotifications } =
  await import("../server/src/butik/bevakningar.js");
import type { Product } from "../server/src/butik/types.js";

const base: Product = {
  id: "LP-B-1", source: "loopa", title: "IKEA Ektorp", brand: "IKEA", model: "Ektorp",
  categorySlug: "soffor-fatoljer", color: null, material: null,
  dimensions: { widthMm: 2000, depthMm: 880, heightMm: 880, seatHeightMm: null, estimated: false },
  priceSek: 2500, retailPriceSek: null, imageUrl: null, condition: null,
  state: "live", listedAt: "2026-08-31", listedAtKnown: true, externalUrl: null, auction: null,
  region: "Stockholm", homeDeliveryAvailable: true, returnsAccepted: true, jobId: "j", identity: null,
};

const watch = (over: Partial<Parameters<typeof matches>[0]> = {}) => ({
  id: "b1", userId: "u1", email: "u@x.se", categorySlug: "soffor-fatoljer", brand: null,
  maxPriceSek: 3000, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null,
  createdAt: "2026-08-01", notifiedProductIds: [], ...over,
});

test("kategori och tak matchar", () => {
  assert.equal(matches(watch(), base), true);
  assert.equal(matches(watch({ maxPriceSek: 2000 }), base), false, "för dyr");
  assert.equal(matches(watch({ categorySlug: "bord" }), base), false, "fel hylla");
});

test("märket matchar oavsett stavning", () => {
  assert.equal(matches(watch({ brand: "ikea" }), base), true);
  assert.equal(matches(watch({ brand: "Swedese" }), base), false);
});

test("en möbel utan mått matchar inte ett måttkrav", () => {
  // "Max 210 cm bred" och en möbel utan bredd: ett mejl om en möbel som kanske inte får plats
  // hjälper ingen.
  const utanMatt = { ...base, dimensions: { ...base.dimensions, widthMm: null } };
  assert.equal(matches(watch({ maxWidthMm: 2100 }), utanMatt), false);
  assert.equal(matches(watch({ maxWidthMm: 2100 }), base), true);
  assert.equal(matches(watch({ maxWidthMm: 1900 }), base), false, "för bred");
});

test("bevakningar gäller aldrig Traderas utbud", () => {
  // Deras lager ändras utan att vi gjort något. Ett mejl per ny auktion i Stockholm är spam.
  assert.equal(matches(watch(), { ...base, source: "tradera" }), false);
});

test("en möbel som inte är live matchar inte", () => {
  assert.equal(matches(watch(), { ...base, state: "sold" }), false);
  assert.equal(matches(watch(), { ...base, state: "reserved" }), false, "reserverad är inte köpbar");
});

test("samma möbel aviseras en gång, inte en gång per körning", async () => {
  await createBevakning({ userId: "u-dup", email: "d@x.se", categorySlug: "soffor-fatoljer", brand: null, maxPriceSek: 3000, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null });
  const first = await takePendingNotifications([base]);
  const second = await takePendingNotifications([base]);
  assert.equal(first.filter((p) => p.bevakning.userId === "u-dup").length, 1);
  assert.equal(second.filter((p) => p.bevakning.userId === "u-dup").length, 0, "andra körningen ska vara tyst");
});

test("en identisk bevakning skapas inte två gånger", async () => {
  const input = { userId: "u-same", email: "s@x.se", categorySlug: "bord", brand: "IKEA", maxPriceSek: 1000, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null };
  const a = await createBevakning(input);
  const b = await createBevakning(input);
  assert.equal(a.id, b.id, "knappen står i varje tomt läge — den ska inte ge tre mejl om samma soffa");
  assert.equal((await listBevakningar("u-same")).length, 1);
});

test("bevakningar är privata och går att ta bort", async () => {
  const mine = await createBevakning({ userId: "u-a", email: null, categorySlug: "stolar", brand: null, maxPriceSek: null, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null });
  assert.equal((await listBevakningar("u-b")).length, 0, "någon annans bevakningar syns inte");
  assert.equal(await deleteBevakning(mine.id, "u-b"), false, "och går inte att ta bort");
  assert.equal(await deleteBevakning(mine.id, "u-a"), true);
});
