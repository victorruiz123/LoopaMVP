// ─── Leveranszoner och kassans ordning ──────────────────────────────────────
//
// Två saker låses fast här. Att leveransavgiften räknas på servern och bara på hela postnummer, och
// att en betalning aldrig kan göra en redan såld möbel såld en gång till.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-checkout-test-"));
process.on("exit", () => rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true }));

const { zoneFor, deliveryQuote, slotsFor, normalizePostal } = await import("../server/src/butik/delivery.js");
const { createOrder, getOrder, updateOrder, orderByReference } = await import("../server/src/butik/orders.js");
const { ensureRecord, publish, reserve, claimForSale, store } = await import("../server/src/butik/store.js");
const { fulfilPaidOrder, checkoutConfigured } = await import("../server/src/butik/checkout.js");

// ---- zoner ----

test("postnumret normaliseras — mellanslag och bindestreck är samma nummer", () => {
  assert.equal(normalizePostal("112 23"), "11223");
  assert.equal(normalizePostal("112-23"), "11223");
});

test("innerstad, närförort och storstockholm har olika pris", () => {
  assert.equal(zoneFor("11223")!.id, "innerstad");
  assert.equal(zoneFor("13145")!.id, "narforort");
  assert.equal(zoneFor("18732")!.id, "storstockholm");
  assert.ok(zoneFor("11223")!.feeSek < zoneFor("18732")!.feeSek);
});

test("ett halvt postnummer ger inget löfte om en avgift", () => {
  // "11" räcker för att gissa innerstad. Ett halvt postnummer ska inte ge ett helt pris.
  assert.equal(zoneFor("112"), null);
  assert.equal(deliveryQuote("112").deliverable, false);
});

test("utanför Stockholm är ett besked, inte ett nej", () => {
  const q = deliveryQuote("41118"); // Göteborg
  assert.equal(q.deliverable, false);
  assert.equal(q.zone, null);
  assert.match(q.message, /Stockholms län/);
  assert.match(q.message, /hämta den själv/, "köparen ska få veta vad som ändå går");
});

test("leveranstider hoppar över söndagar och respekterar framförhållningen", () => {
  const zone = zoneFor("11223")!;
  const from = new Date("2026-09-01T10:00:00Z"); // tisdag
  const slots = slotsFor(zone, from, 6);
  assert.equal(slots.length, 6);
  assert.ok(slots.every((s) => new Date(s.date).getDay() !== 0), "inga söndagar");
  const first = new Date(slots[0].date);
  assert.ok(first.getTime() >= from.getTime(), "aldrig en tid som redan varit");
});

// ---- kassans ordning ----

const buyer = { kind: "buyer", userId: "kopare-1" } as const;
const tradera = { kind: "tradera", itemId: 9 } as const;

async function liveItem(id: string) {
  await ensureRecord(id, `job-${id}`, "loopa", new Date().toISOString());
  await publish(id, { kind: "seller", userId: "s" });
}

test("kassan är avstängd utan Stripe-nyckel — ingen knapp som lovar mer än den kan", () => {
  const had = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(checkoutConfigured(), false);
  if (had) process.env.STRIPE_SECRET_KEY = had;
});

test("en betald order säljer möbeln och blir betald", async () => {
  await liveItem("LP-CO-0001");
  const held = await reserve("LP-CO-0001", 2500, buyer);
  const order = await createOrder({ productId: "LP-CO-0001", userId: "kopare-1", email: "k@x.se", priceSek: 2500, reservationToken: held!.token });

  const done = await fulfilPaidOrder(order.id);
  assert.equal(done!.status, "paid");
  assert.equal((await store().get("LP-CO-0001"))!.state, "sold");
});

test("webhooken kan köras två gånger utan att sälja möbeln två gånger", async () => {
  // Stripe skickar om vid minsta osäkerhet. Ett andra anrop ska vara verkningslöst, inte ett fel.
  await liveItem("LP-CO-0002");
  const held = await reserve("LP-CO-0002", 900, buyer);
  const order = await createOrder({ productId: "LP-CO-0002", userId: "k", email: null, priceSek: 900, reservationToken: held!.token });

  const first = await fulfilPaidOrder(order.id);
  const second = await fulfilPaidOrder(order.id);
  assert.equal(first!.status, "paid");
  assert.equal(second!.status, "paid", "andra anropet ändrar ingenting");
  const log = await store().events("LP-CO-0002");
  assert.equal(log.filter((e) => e.to === "sold").length, 1, "möbeln får säljas exakt en gång");
});

test("BETALT MEN BORTA: möbeln såldes på Tradera medan kortet drogs", async () => {
  // Det enda läge där dubbelförsäljningsskyddet syns utåt. Ordern får INTE bli "paid" — då hade en
  // köpare fått en bekräftelse på en möbel som inte finns.
  await liveItem("LP-CO-0003");
  const held = await reserve("LP-CO-0003", 4000, buyer);
  const order = await createOrder({ productId: "LP-CO-0003", userId: "k", email: null, priceSek: 4000, reservationToken: held!.token });

  // Tradera vinner mitt i kassan.
  assert.ok(await claimForSale("LP-CO-0003", "tradera", tradera, { traderaItemId: 9 }));

  const result = await fulfilPaidOrder(order.id);
  assert.equal(result!.status, "cancelled", "ordern ska avbrytas, inte bekräftas");
  assert.equal((await store().get("LP-CO-0003"))!.soldChannel, "tradera", "Tradera-försäljningen står kvar");
});

test("fel reservationstoken kan inte fullfölja någon annans köp", async () => {
  await liveItem("LP-CO-0004");
  await reserve("LP-CO-0004", 700, buyer);
  const order = await createOrder({ productId: "LP-CO-0004", userId: "k", email: null, priceSek: 700, reservationToken: "fel-token" });
  const result = await fulfilPaidOrder(order.id);
  assert.equal(result!.status, "cancelled");
  assert.equal((await store().get("LP-CO-0004"))!.state, "reserved", "den riktiga reservationen står kvar");
});

test("ordernumret går att läsa upp i telefon", async () => {
  const held = await (async () => { await liveItem("LP-CO-0005"); return reserve("LP-CO-0005", 100, buyer); })();
  const order = await createOrder({ productId: "LP-CO-0005", userId: "k", email: null, priceSek: 100, reservationToken: held!.token });
  assert.match(order.reference, /^LO-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.ok(!/[01IO]/.test(order.reference.slice(3)), "inga tecken som hörs fel: 0/O, 1/I");
  assert.equal((await orderByReference(order.reference.toLowerCase()))!.id, order.id, "uppslag ska tåla gemener");
});

test("priset på ordern är det som frystes, inte det som råkar gälla nu", async () => {
  await liveItem("LP-CO-0006");
  const held = await reserve("LP-CO-0006", 3300, buyer);
  const order = await createOrder({ productId: "LP-CO-0006", userId: "k", email: null, priceSek: held!.record.reservedPriceSek!, reservationToken: held!.token });
  assert.equal(order.priceSek, 3300);
  // Prisstegen sänker priset under tiden köparen står i kassan.
  await updateOrder(order.id, {});
  assert.equal((await getOrder(order.id))!.priceSek, 3300, "kassans belopp får inte röra sig");
});
