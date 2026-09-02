// ─── Handelns siffror ────────────────────────────────────────────────────────
//
// Talen i profilen räknas i webbläsaren, ur de tre listor skärmen ändå hämtar. Det gör dem billiga
// och det gör dem testbara — men det gör också att en felaktig definition syns först som ett tal
// som ser rimligt ut. Testerna nedan låser DEFINITIONERNA, inte formlerna:
//
//   ett saknat pris är inte noll kronor
//   en påbörjad kassa är inte ett köp
//   en avslutad affär pågår inte
//   sålt på Tradera är fortfarande sålt

import { test } from "node:test";
import assert from "node:assert/strict";
import { buyStats, sellStats, CLOSED_DEAL_STATES } from "../web/src/profil/stats.js";
import type { JobSummary } from "../web/src/types.js";
import type { DealView } from "../web/src/affar/types.js";
import type { Order } from "../web/src/butik/api.js";

function job(over: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "j", loopaId: "LP-A", createdAt: "2026-09-01T00:00:00Z",
    progress: { stage: "done", message: "" }, grade: null, identity: null,
    price: null, thumbnailImageId: null, coverImageUrl: null, error: null,
    hasListing: true, listingTitle: "Soffa", sale: null, shop: null,
    ...over,
  } as JobSummary;
}

const shop = (state: string, priceSek: number | null = null, soldChannel: string | null = null) =>
  ({ state, listedAt: "2026-09-01T00:00:00Z", soldAt: null, soldChannel, priceSek }) as JobSummary["shop"];

function deal(over: Partial<DealView> = {}): DealView {
  return {
    id: "d", state: "price_pending", role: "buyer", what: "soffa", askingPriceSek: 1000,
    proposals: [], awaiting: null, acceptedBy: [], counterRounds: 0, agreedPriceSek: null,
    scanJobId: null, expiresAt: null, createdAt: "2026-09-01T00:00:00Z",
    ...over,
  } as DealView;
}

const order = (status: string, priceSek = 1000, deliveryFeeSek = 495) =>
  ({ id: status, productId: "p", reference: "LO-X", priceSek, deliveryFeeSek,
     postalCode: null, deliveryZone: null, deliveryDate: null, deliveryWindow: null,
     status, createdAt: "2026-09-01T00:00:00Z" }) as Order;

// ─── säljsidan ──────────────────────────────────────────────────────────────

test("bara annonser räknas — en filmning utan kort är ingen möbel till salu", () => {
  const s = sellStats([job(), job({ hasListing: false })], []);
  assert.equal(s.cards, 1);
});

test("lägena skiljs åt: ute, reserverad, såld", () => {
  const s = sellStats(
    [job({ shop: shop("live") }), job({ shop: shop("reserved") }), job({ shop: shop("sold") }), job()],
    [],
  );
  assert.deepEqual([s.live, s.reserved, s.sold], [1, 1, 1]);
});

test("levererad räknas som såld — möbeln är borta och betald", () => {
  assert.equal(sellStats([job({ shop: shop("delivered", 2000) })], []).sold, 1);
});

test("sålt på Tradera är fortfarande sålt", () => {
  // Kanalen säger VAR den såldes, inte OM. En säljare som la ut sin soffa hos oss och sålde den där
  // ska se den i sin summa.
  const s = sellStats([job({ shop: shop("sold", 3000, "tradera") })], []);
  assert.equal(s.sold, 1);
  assert.equal(s.earned, 3000);
});

test("en såld möbel utan känt pris drar inte ner summan till noll", () => {
  const s = sellStats([job({ shop: shop("sold", 2000) }), job({ shop: shop("sold", null) })], []);
  assert.equal(s.sold, 2, "båda är sålda");
  assert.equal(s.earned, 2000, "men bara den ena har ett belopp");
});

test("lagervärdet gäller det som ligger ute, inte det som sålts", () => {
  const price = { status: "ok", default: 2500 } as JobSummary["price"];
  const s = sellStats([job({ shop: shop("live"), price }), job({ shop: shop("sold", 900), price })], []);
  assert.equal(s.liveValue, 2500);
});

test("säljarens egen tur räknas, inte köparens", () => {
  const s = sellStats([], [
    deal({ role: "seller", awaiting: "seller" }),
    deal({ role: "seller", awaiting: "buyer" }),
    deal({ role: "buyer", awaiting: "buyer" }),
  ]);
  assert.equal(s.needsMe, 1);
});

// ─── köpsidan ───────────────────────────────────────────────────────────────

test("en påbörjad kassa är inte ett köp", () => {
  const b = buyStats([{ order: order("pending") }, { order: order("paid") }], []);
  assert.equal(b.orders, 2, "båda syns i listan");
  assert.equal(b.completed, 1, "men bara den ena blev av");
});

test("en avbruten order kostar ingenting", () => {
  assert.equal(buyStats([{ order: order("cancelled") }], []).spent, 0);
});

test("frakten ingår i vad köpet kostade", () => {
  assert.equal(buyStats([{ order: order("paid", 1000, 495) }], []).spent, 1495);
});

test("en returnerad order räknas som ett köp som skett", () => {
  // Pengarna har bytt ägare och möbeln har varit hemma hos köparen. Att gömma den hade betytt att
  // returen försvann ur historiken.
  assert.equal(buyStats([{ order: order("returned") }], []).completed, 1);
});

test("avslutade affärer pågår inte", () => {
  const b = buyStats([], [
    deal({ state: "price_pending" }),
    deal({ state: "declined" }),
    deal({ state: "paid_out" }),
    deal({ state: "expired" }),
  ]);
  assert.equal(b.openDeals, 1);
  assert.deepEqual(CLOSED_DEAL_STATES.sort(), ["declined", "expired", "paid_out"]);
});

test("överenskommet pris slår begärt i vad affärerna landat på", () => {
  const b = buyStats([], [deal({ askingPriceSek: 1000, agreedPriceSek: 800 })]);
  assert.equal(b.committed, 800);
});

test("säljarens affärer räknas inte som mina köp", () => {
  const b = buyStats([], [deal({ role: "seller", state: "price_pending", awaiting: "seller" })]);
  assert.deepEqual([b.openDeals, b.needsMe], [0, 0]);
});
