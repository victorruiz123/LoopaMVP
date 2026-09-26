// ─── Den sålda möbelns sida: beskedet, den saknade köpknappen och "Liknande möbler" ──────
//
// Gamla Facebook-inlägg och Marketplace-annonser lever kvar efter försäljningen (V1 städar inte).
// Den som klickar sig hit ska mötas av "Denna möbel är såld", ingen köpknapp, och det vi har.
// Rangordningen av liknande möbler är deterministisk och faller alltid tillbaka på resten av lagret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { similarProducts, similarityScore, SIMILAR_WEIGHTS } = await import("../server/src/butik/similar.js");
const { applyFilter } = await import("../server/src/butik/inventory.js");
import type { Product } from "../server/src/butik/types.js";

function vara(patch: Partial<Product> = {}): Product {
  return {
    id: "LP-TEST-0000",
    source: "loopa",
    title: "Sweef Cloud 3-sits",
    brand: "Sweef",
    model: "Cloud",
    categorySlug: "soffor",
    color: "Grå",
    material: "Sammet",
    dimensions: { widthMm: 2300, depthMm: 980, heightMm: 820, seatHeightMm: null, estimated: false },
    priceSek: 6500,
    retailPriceSek: 14990,
    estimatedValueSek: 7000,
    priceHistory: [],
    priceDroppedAt: null,
    imageCount: 4,
    hasMeasurements: true,
    imageUrl: null,
    condition: null,
    state: "live",
    listedAt: "2026-09-01T10:00:00.000Z",
    listedAtKnown: true,
    externalUrl: null,
    auction: null,
    region: "Stockholm",
    homeDeliveryAvailable: true,
    returnsAccepted: true,
    jobId: "job",
    identity: null,
    ...patch,
  };
}

test("samma kategori, märke och pris ger högst poäng; skälen står med", () => {
  const sald = vara({ id: "SÅLD", state: "sold" });
  const bäst = similarityScore(sald, vara({ id: "a" }));
  assert.equal(bäst.score, SIMILAR_WEIGHTS.category + SIMILAR_WEIGHTS.brand + SIMILAR_WEIGHTS.type + SIMILAR_WEIGHTS.price);
  assert.deepEqual(bäst.reasons, ["samma kategori", "samma märke", "samma möbeltyp", "liknande pris"]);
  const annanKategori = similarityScore(sald, vara({ id: "b", categorySlug: "bord", brand: "IKEA", priceSek: 900, title: "IKEA bord", model: "Lack" }));
  assert.equal(annanKategori.score, 0);
});

test("ordningen: kategori före märke före pris — och den sålda möbeln själv är aldrig med", () => {
  const sald = vara({ id: "SÅLD", state: "sold" });
  const pool = [
    sald,
    vara({ id: "bord-billigt", categorySlug: "bord", brand: "Sweef", priceSek: 6400, title: "Sweef bord", model: "Bord" }),
    vara({ id: "soffa-annat-marke", brand: "IKEA", priceSek: 6600, title: "IKEA Kivik 3-sits", model: "Kivik" }),
    vara({ id: "soffa-samma-marke-dyr", brand: "Sweef", priceSek: 19000, title: "Sweef Cloud 4-sits", model: "Cloud" }),
    vara({ id: "soffa-samma-allt", brand: "Sweef", priceSek: 6900, title: "Sweef Cloud 3-sits beige", model: "Cloud" }),
  ];
  const ordning = similarProducts(sald, pool, 10).map((p) => p.id);
  assert.equal(ordning[0], "soffa-samma-allt");
  assert.ok(ordning.indexOf("soffa-samma-marke-dyr") < ordning.indexOf("bord-billigt"), "kategori + märke slår ett bord med rätt pris");
  assert.ok(ordning.indexOf("soffa-annat-marke") < ordning.indexOf("bord-billigt"), "samma kategori slår fel kategori");
  assert.ok(!ordning.includes("SÅLD"));
});

test("reserven: räcker inte de lika fylls listan med resten av lagret, nyast först — men bara det som går att köpa", () => {
  const sald = vara({ id: "SÅLD", state: "sold" });
  const pool = [
    sald,
    vara({ id: "gammal", categorySlug: "bord", brand: "IKEA", priceSek: 300, title: "IKEA Lack", model: "Lack", listedAt: "2026-01-01T00:00:00.000Z" }),
    vara({ id: "ny", categorySlug: "stolar", brand: "HAY", priceSek: 900, title: "HAY stol", model: "AAC", listedAt: "2026-09-20T00:00:00.000Z" }),
    vara({ id: "annan-sald", categorySlug: "soffor", brand: "Sweef", priceSek: 6500, state: "sold", title: "Sweef Cloud", model: "Cloud" }),
    vara({ id: "tradera", source: "tradera", categorySlug: "soffor", brand: "Sweef", priceSek: 6500, title: "Sweef Cloud", model: "Cloud" }),
    vara({ id: "reserverad", categorySlug: "soffor", brand: "Sweef", priceSek: 6500, state: "reserved", title: "Sweef Cloud", model: "Cloud" }),
  ];
  const ut = similarProducts(sald, pool, 10).map((p) => p.id);
  assert.deepEqual(ut, ["reserverad", "ny", "gammal"], "reserverad syns (inte såld), sedan reserven nyast först; sålda och Tradera aldrig");
  assert.deepEqual(similarProducts(sald, pool, 1).map((p) => p.id), ["reserverad"]);
  assert.deepEqual(similarProducts(sald, [sald], 8), [], "ett tomt lager ger en tom lista, inte ett fel");
});

test("listan är deterministisk: samma lager ger samma ordning oavsett inmatningsordning", () => {
  const sald = vara({ id: "SÅLD", state: "sold" });
  const pool = [vara({ id: "x", listedAt: "2026-09-10T00:00:00.000Z" }), vara({ id: "y", listedAt: "2026-09-10T00:00:00.000Z" }), vara({ id: "z", listedAt: "2026-09-11T00:00:00.000Z" })];
  const a = similarProducts(sald, [sald, ...pool], 5).map((p) => p.id);
  const b = similarProducts(sald, [...pool].reverse().concat(sald), 5).map((p) => p.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["z", "x", "y"]);
});

test("en såld möbel ligger inte i rutnätet men finns kvar som vara", () => {
  const sald = vara({ id: "SÅLD", state: "sold" });
  const ut = applyFilter([sald, vara({ id: "live" })], {});
  assert.deepEqual(ut.items.map((p) => p.id), ["live"]);
});

// ─── produktsidan (källkodsvakt) ────────────────────────────────────────────
//
// Sidan ritas i React och har ingen testrigg; det som går sönder tyst är ORDEN och VILLKORET, och de
// går att läsa i källan. Faller de här testerna har någon skrivit om sidan så att en såld möbel
// antingen inte säger att den är såld, eller fortfarande visar köpet.

const produktsida = readFileSync(path.resolve("web/src/butik/screens/ProductScreen.tsx"), "utf-8");

test("en såld Loopa-möbel är indexerbar; utkast, returer och andras sålda varor är det inte", async () => {
  const { arIndexerbar } = await import("../server/src/butik/seo.js");
  assert.equal(arIndexerbar(vara({ state: "live" })), true);
  assert.equal(arIndexerbar(vara({ state: "reserved" })), true);
  assert.equal(arIndexerbar(vara({ state: "sold" })), true, "beslut 2026-09-26: såld = landningssida, inte noindex");
  assert.equal(arIndexerbar(vara({ state: "delivered" })), true);
  assert.equal(arIndexerbar(vara({ state: "draft" })), false);
  assert.equal(arIndexerbar(vara({ state: "returned" })), false);
  assert.equal(arIndexerbar(vara({ state: "sold", source: "tradera" as Product["source"] })), false, "andras sålda annonser är inte vår landningssida");
});

test("produktsidan säger att möbeln hittat ett nytt hem och visar fler alternativ", () => {
  assert.ok(produktsida.includes("Den här möbeln har redan hittat ett nytt hem"));
  assert.ok(produktsida.includes("Men vi har fler alternativ för dig"));
  assert.ok(produktsida.includes("Fler alternativ för dig"));
  assert.ok(produktsida.includes("fetchSimilar("), "listan hämtas från servern, inte påhittad i vyn");
});

test("köpknappen ritas bara när möbeln är varken såld eller reserverad", () => {
  assert.ok(/\{!sold && !reserved && <BuyPanel/.test(produktsida), "BuyPanel måste stå bakom !sold");
  assert.ok(/sold && loopa && !utanKop && <SimilarProducts/.test(produktsida), "liknande möbler bara på den sålda köpsidan");
});
