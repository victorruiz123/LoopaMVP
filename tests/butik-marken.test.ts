// ─── Märkesbrickornas tal är ett löfte ──────────────────────────────────────
//
// "41 granskade · 33 via Tradera" är två påståenden om vad som ligger bakom brickan, och båda måste
// hålla när någon klickar. Räkningen bor därför i inventory.ts och inte i en HTTP-hanterare: ett
// löfte som bara finns i en route går inte att pröva.
//
// Delningen i sig är också ett löfte. En granskad möbel går att köpa i dag med hemleverans; en
// Tradera-annons är någon annans, som vi kan analysera. Ett sammanslaget tal hade lånat vår
// granskning till annonser vi inte granskat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { brandFacetsMerged } from "../server/src/butik/inventory.js";
import type { Product } from "../server/src/butik/types.js";

const vara = (over: Partial<Product> = {}): Product => ({
  id: Math.random().toString(36).slice(2), source: "loopa", title: "Soffa",
  brand: "IKEA", model: null, categorySlug: "soffor", color: null, material: null,
  dimensions: { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null },
  priceSek: 1000, retailPriceSek: null, imageUrl: null, condition: null,
  state: "live", listedAt: "2026-09-01T00:00:00Z", listedAtKnown: true,
  externalUrl: null, auction: null, region: "Stockholm", homeDeliveryAvailable: true,
  returnsAccepted: true, jobId: null, identity: null,
  ...over,
} as Product);

test("antalet delas per källa, och summan stämmer", () => {
  const [ikea] = brandFacetsMerged([
    vara({ brand: "IKEA", source: "loopa" }),
    vara({ brand: "IKEA", source: "loopa" }),
    vara({ brand: "IKEA", source: "tradera" }),
  ]);
  assert.equal(ikea.loopa, 2);
  assert.equal(ikea.tradera, 1);
  assert.equal(ikea.count, 3, "totalen är summan, inte ett tredje tal");
});

test("bara det man faktiskt kan gå till räknas", () => {
  // Samma tillståndsregel som rutnätet. En bricka som lovar fyra och visar två är ett brutet löfte.
  const rader = brandFacetsMerged([
    vara({ brand: "Mio", state: "live" }),
    vara({ brand: "Mio", state: "reserved" }),
    vara({ brand: "Mio", state: "sold" }),
    vara({ brand: "Mio", state: "draft" }),
  ]);
  assert.equal(rader[0].count, 2, "live och reserved syns i rutnätet, sold och draft inte");
});

test("en vara utan märke hamnar inte i någon bricka", () => {
  assert.deepEqual(brandFacetsMerged([vara({ brand: null })]), []);
});

test("störst först, och våra egna först vid lika", () => {
  const rader = brandFacetsMerged([
    vara({ brand: "Stor", source: "tradera" }), vara({ brand: "Stor", source: "tradera" }),
    vara({ brand: "Stor", source: "tradera" }),
    vara({ brand: "Granskad", source: "loopa" }), vara({ brand: "Granskad", source: "loopa" }),
    vara({ brand: "Extern", source: "tradera" }), vara({ brand: "Extern", source: "tradera" }),
  ]);
  assert.equal(rader[0].brand, "Stor", "flest först");
  assert.equal(rader[1].brand, "Granskad", "vid lika antal går den med granskade möbler före");
});

test("slugen är adressens form av namnet", () => {
  const [r] = brandFacetsMerged([vara({ brand: "Blå Station" })]);
  assert.equal(r.slug, "blå station".replace(" ", "-"));
});

test("ett märke som BARA finns via Tradera räknas ändå", () => {
  // Brickan ska finnas — men den lovar noll granskade, och det är precis vad delningen säger.
  const [r] = brandFacetsMerged([vara({ brand: "Artek", source: "tradera" })]);
  assert.equal(r.loopa, 0);
  assert.equal(r.tradera, 1);
});
