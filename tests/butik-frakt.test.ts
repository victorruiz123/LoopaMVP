// ─── Fraktens tre lägen, historiken och vem som får läsa den ────────────────
//
// Det som låses fast här är skillnaden mellan en ÖNSKAD och en BOKAD tid. Den skillnaden är hela
// skälet till att `booking` finns som eget läge: en köpare som lämnat tre tider har inte fått en
// leverans lovad, och ett gränssnitt som säger "Frakt bokad" på en tid ingen bokat är värre än ett
// som inte säger något alls.
//
// Breven stängs av (EMAIL_PROVIDER=none) — testerna prövar tillstånden, inte utskicket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-frakt-test-"));
process.env.EMAIL_PROVIDER = "none";
process.on("exit", () => rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true }));

const { createOrder, getOrder, updateOrder, publikHistorik, recordOrderEvent } = await import("../server/src/butik/orders.js");
const { requestSlots, confirmDelivery, markOrderDelivered, CheckoutError } = await import("../server/src/butik/checkout.js");

async function betaldOrder() {
  const order = await createOrder({
    productId: "LP-TEST-0001",
    userId: "kopare-1",
    email: "kopare@exempel.se",
    priceSek: 4500,
    reservationToken: "token",
  });
  return (await updateOrder(order.id, { status: "paid", postalCode: "11223", deliveryZone: "innerstad", deliveryFeeSek: 495 }))!;
}

test("en ny order bär en historik från första sekunden", async () => {
  const order = await createOrder({ productId: "LP-A", userId: null, email: null, priceSek: 100, reservationToken: "t" });
  assert.equal(order.events.length, 1);
  assert.equal(order.events[0].status, "pending");
  // Kassan öppnad är en intern rad — köparen har inte gjort något som förtjänar ett besked än.
  assert.equal(publikHistorik(order).length, 0);
});

test("köparens tider gör ordern till 'vi bokar frakt' — INTE till bokad", async () => {
  const order = await betaldOrder();
  const efter = (await requestSlots(order.id, [
    { date: "2026-09-16", window: "08–12" },
    { date: "2026-09-17", window: "12–17" },
  ]))!;
  assert.equal(efter.status, "booking");
  assert.equal(efter.requestedSlots.length, 2);
  // Ingen tid är utlovad förrän en människa bokat den.
  assert.equal(efter.deliveryDate, null);
  assert.equal(efter.deliveryWindow, null);
});

test("ordningen bevaras — den första tiden är förstahandsvalet", async () => {
  const order = await betaldOrder();
  const efter = (await requestSlots(order.id, [
    { date: "2026-09-18", window: "12–17" },
    { date: "2026-09-16", window: "08–12" },
  ]))!;
  assert.deepEqual(efter.requestedSlots[0], { date: "2026-09-18", window: "12–17" });
});

test("högst tre tider tas emot, resten faller bort", async () => {
  const order = await betaldOrder();
  const efter = (await requestSlots(order.id, [
    { date: "2026-09-16", window: "08–12" },
    { date: "2026-09-17", window: "08–12" },
    { date: "2026-09-18", window: "08–12" },
    { date: "2026-09-19", window: "08–12" },
  ]))!;
  assert.equal(efter.requestedSlots.length, 3);
  assert.equal(efter.requestedSlots.at(-1)!.date, "2026-09-18");
});

test("skräpdatum avvisas och en tom lista blir ett fel", async () => {
  const order = await betaldOrder();
  await assert.rejects(() => requestSlots(order.id, [{ date: "imorgon", window: "08–12" }]), CheckoutError);
  await assert.rejects(() => requestSlots(order.id, []), CheckoutError);
});

test("en obetald order kan inte begära frakt", async () => {
  const order = await createOrder({ productId: "LP-B", userId: null, email: null, priceSek: 100, reservationToken: "t" });
  await assert.rejects(() => requestSlots(order.id, [{ date: "2026-09-16", window: "08–12" }]), CheckoutError);
});

test("panelen bokar en tid, och den behöver inte vara en av köparens", async () => {
  const order = await betaldOrder();
  await requestSlots(order.id, [{ date: "2026-09-16", window: "08–12" }]);
  const bokad = (await confirmDelivery(order.id, "2026-09-19", "12–17"))!;
  assert.equal(bokad.status, "scheduled");
  assert.equal(bokad.deliveryDate, "2026-09-19");
  assert.equal(bokad.deliveryWindow, "12–17");
  // Köparens önskemål står kvar: historiken ska visa både vad som önskades och vad som blev.
  assert.equal(bokad.requestedSlots[0].date, "2026-09-16");
});

test("hela kedjan skriver en läsbar historik för köparen", async () => {
  const order = await betaldOrder();
  await recordOrderEvent(order.id, { status: "paid", note: "Betalningen är genomförd.", actor: "system", publik: true });
  await requestSlots(order.id, [{ date: "2026-09-16", window: "08–12" }]);
  await confirmDelivery(order.id, "2026-09-16", "08–12");
  const levererad = (await markOrderDelivered(order.id))!;
  assert.equal(levererad.status, "delivered");
  const publika = publikHistorik(levererad).map((e) => e.status);
  assert.deepEqual(publika, ["paid", "booking", "scheduled", "delivered"]);
});

test("en intern anteckning når ALDRIG köparen", async () => {
  const order = await betaldOrder();
  await recordOrderEvent(order.id, { status: null, note: "Budfirman svarar inte, ring dem.", actor: "admin", publik: false });
  await recordOrderEvent(order.id, { status: null, note: "Vi hör av oss på måndag.", actor: "admin", publik: true });
  const nu = (await getOrder(order.id))!;
  const texter = publikHistorik(nu).map((e) => e.note);
  assert.ok(texter.includes("Vi hör av oss på måndag."));
  assert.ok(!texter.some((t) => t.includes("Budfirman")));
});

test("en levererad order kan inte levereras igen", async () => {
  const order = await betaldOrder();
  await confirmDelivery(order.id, "2026-09-16", "08–12");
  await markOrderDelivered(order.id);
  await assert.rejects(() => markOrderDelivered(order.id), CheckoutError);
});
