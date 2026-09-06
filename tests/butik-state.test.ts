// ─── Butikens tillståndsmaskin: att samma möbel bara kan säljas en gång ──────
//
// Möbeln finns i ett exemplar och ligger uppe i två kanaler. Testerna nedan låser fast det som gör
// den kombinationen ofarlig: att övergången till `sold` är ett anspråk som exakt en anropare kan
// vinna, och att en Tradera-försäljning vinner även över en påbörjad kassa hos oss.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egen datamapp, satt INNAN store.ts läses in — annars skriver testerna bland de skarpa varorna i
// server/data/butik. Modulen läser sökvägen en gång vid import, så ordningen här är inte kosmetisk.
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-butik-test-"));
process.env.BUTIK_RESERVATION_MINUTES = "15";
process.on("exit", () => rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true }));

const { ensureRecord, publish, reserve, release, claimForSale, markDelivered, markReturned, sweepExpiredReservations, store, resetStore } =
  await import("../server/src/butik/store.js");
const { canTransition, ALLOWED_TRANSITIONS } = await import("../server/src/butik/types.js");
const { shopReadiness, makeEvent, TransitionError } = await import("../server/src/butik/state.js");

const seller = { kind: "seller", userId: "u1" } as const;
const buyer = { kind: "buyer", userId: "u2" } as const;
const tradera = { kind: "tradera", itemId: 555 } as const;

let n = 0;
const freshId = () => `LP-TEST-${(n++).toString().padStart(4, "0")}`;

async function liveProduct(): Promise<string> {
  const id = freshId();
  await ensureRecord(id, "job-" + id, "loopa", new Date().toISOString());
  await publish(id, seller);
  return id;
}

test("övergångstabellen tillåter bara det den räknar upp", () => {
  assert.equal(canTransition("draft", "live"), true);
  assert.equal(canTransition("live", "reserved"), true);
  assert.equal(canTransition("live", "sold"), true, "Tradera säljer utan att passera vår kassa");
  assert.equal(canTransition("reserved", "sold"), true);
  assert.equal(canTransition("reserved", "live"), true, "reservationen ska kunna släppas");
  // Det som INTE får gå:
  assert.equal(canTransition("draft", "sold"), false, "ett utkast har aldrig legat uppe");
  assert.equal(canTransition("sold", "live"), false, "en såld möbel kan inte läggas ut igen");
  assert.equal(canTransition("returned", "live"), false);
  assert.deepEqual(ALLOWED_TRANSITIONS.returned, [], "returnerad är slutstation");
});

test("makeEvent vägrar bygga en händelse för en omöjlig övergång", () => {
  assert.throws(() => makeEvent("LP-X", "sold", "live", seller), TransitionError);
});

test("reservation håller möbeln och ger en token som köpet måste visa upp", async () => {
  const id = await liveProduct();
  const held = await reserve(id, 2500, buyer);
  assert.ok(held, "en ledig möbel ska gå att reservera");
  assert.equal((await store().get(id))!.state, "reserved");
  assert.equal((await store().get(id))!.reservedPriceSek, 2500, "priset fryses vid reservationen");

  // Fel token = fel köpare fullföljer någon annans reservation.
  assert.equal(await claimForSale(id, "butik", buyer, { requireToken: "fel-token" }), null);
  assert.equal((await store().get(id))!.state, "reserved", "möbeln ska stå kvar reserverad");

  const sold = await claimForSale(id, "butik", buyer, { requireToken: held.token });
  assert.ok(sold);
  assert.equal(sold.state, "sold");
  assert.equal(sold.soldChannel, "butik");
});

test("en möbel som redan är reserverad går inte att reservera igen", async () => {
  const id = await liveProduct();
  assert.ok(await reserve(id, 1000, buyer));
  assert.equal(await reserve(id, 1000, buyer), null, "andra köparen ska bli avvisad, inte köa");
});

test("DUBBELFÖRSÄLJNING: två samtidiga anspråk, exakt ett vinner", async () => {
  const id = await liveProduct();

  // Båda startar innan någon av dem hunnit skriva. Det är hela tävlingsfönstret.
  const results = await Promise.all([
    claimForSale(id, "butik", buyer),
    claimForSale(id, "tradera", tradera, { traderaItemId: 555 }),
  ]);

  const winners = results.filter((r) => r !== null);
  assert.equal(winners.length, 1, "exakt en anropare får sälja möbeln");
  assert.equal(winners[0]!.state, "sold");
  assert.equal((await store().get(id))!.state, "sold");
});

test("DUBBELFÖRSÄLJNING: tio samtidiga anspråk, fortfarande exakt ett", async () => {
  const id = await liveProduct();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => claimForSale(id, i % 2 ? "tradera" : "butik", buyer)),
  );
  assert.equal(results.filter((r) => r !== null).length, 1);
});

test("en Tradera-försäljning vinner över en påbörjad kassa hos oss", async () => {
  const id = await liveProduct();
  const held = await reserve(id, 3000, buyer);
  assert.ok(held);

  // Möbeln såldes på Tradera medan köparen stod i vår kassa. Den är faktiskt borta.
  const sold = await claimForSale(id, "tradera", tradera, { traderaItemId: 555 });
  assert.ok(sold, "reserved ska inte skydda mot en riktig försäljning i andra kanalen");
  assert.equal(sold.soldChannel, "tradera");

  // Och vår egen kassa kan då inte längre fullfölja — köparen måste få veta det före betalningen.
  assert.equal(await claimForSale(id, "butik", buyer, { requireToken: held.token }), null);
});

test("utgången reservation släpps av städningen och möbeln blir köpbar igen", async () => {
  const id = await liveProduct();
  const held = await reserve(id, 900, buyer);
  assert.ok(held);

  // Backdatera deadline: köparen stängde fliken för en kvart sedan.
  const rec = (await store().get(id))!;
  await store().put({ ...rec, reservedUntil: new Date(Date.now() - 1000).toISOString() });

  assert.equal(await sweepExpiredReservations(), 1);
  const after = (await store().get(id))!;
  assert.equal(after.state, "live");
  assert.equal(after.reservationToken, null, "token ska dö med reservationen");
  assert.ok(await reserve(id, 900, buyer), "möbeln ska gå att reservera på nytt");
});

test("städningen rör inte en reservation som fortfarande gäller", async () => {
  const id = await liveProduct();
  await reserve(id, 100, buyer);
  assert.equal(await sweepExpiredReservations(), 0);
  assert.equal((await store().get(id))!.state, "reserved");
});

test("hela vägen fram: såld -> levererad -> returnerad", async () => {
  const id = await liveProduct();
  const held = await reserve(id, 4000, buyer);
  await claimForSale(id, "butik", buyer, { requireToken: held!.token });
  assert.ok(await markDelivered(id, seller));
  assert.ok(await markReturned(id, seller));
  assert.equal((await store().get(id))!.state, "returned");
  // Och inget går bakåt därifrån.
  assert.equal(await markDelivered(id, seller), null);
});

test("varje övergång hamnar i huvudboken, i ordning", async () => {
  const id = await liveProduct();
  const held = await reserve(id, 500, buyer);
  await claimForSale(id, "butik", buyer, { requireToken: held!.token });
  const log = await store().events(id);
  assert.deepEqual(
    log.map((e) => `${e.from ?? "-"}->${e.to}`),
    ["-->draft", "draft->live", "live->reserved", "reserved->sold"],
  );
  assert.equal(log.at(-1)!.note, "Såld i Butik.");
});

test("ensureRecord är idempotent — en ompublicering skapar ingen andra post", async () => {
  const id = freshId();
  const a = await ensureRecord(id, "j", "loopa", new Date().toISOString());
  await publish(id, seller);
  const b = await ensureRecord(id, "j", "loopa", new Date().toISOString());
  assert.equal(b.state, "live", "den befintliga posten ska returneras, inte ett nytt utkast");
  assert.equal(a.id, b.id);
});

// ─── Grinden in i butiken ───────────────────────────────────────────────────

const baseProduct = {
  id: "LP-1", source: "loopa" as const, title: "IKEA Ektorp soffa", brand: "IKEA", model: "Ektorp",
  categorySlug: "soffor", color: null, material: null,
  dimensions: { widthMm: 2180, depthMm: 880, heightMm: 880, seatHeightMm: null, estimated: false },
  priceSek: 2500, retailPriceSek: null, imageUrl: "/x.jpg",
  condition: { grade: "B" as const, canonical: "Mycket bra skick" as const, label: "L", rationale: "R", defectCount: 1, inspectedAt: "2026-08-01", reviewed: true },
  state: "live" as const, listedAt: "2026-08-01", externalUrl: null, auction: null,
  region: "Stockholm", homeDeliveryAvailable: true, returnsAccepted: true, jobId: "j", identity: null,
};

test("en färdig möbel släpps in i butiken", () => {
  assert.deepEqual(shopReadiness(baseProduct), { ready: true, missing: [] });
});

test("de 67 jobben utan annons hålls utanför rutnätet, med skälet utskrivet", () => {
  // Ett besiktigat jobb som aldrig fick en annons: inget märke, ingen kategori, inget pris.
  const bare = { ...baseProduct, brand: null, model: null, categorySlug: "ovrigt", priceSek: null, imageUrl: null,
    dimensions: { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null, estimated: false } };
  const r = shopReadiness(bare);
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ["pris", "märke eller modell", "kategori", "bild eller mått"]);
});

test("utan foto räcker måtten — möbeln ritas ur dem", () => {
  const noPhoto = { ...baseProduct, imageUrl: null };
  assert.equal(shopReadiness(noPhoto).ready, true);
});
