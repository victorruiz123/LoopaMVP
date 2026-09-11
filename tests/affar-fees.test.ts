// ─── Vad en Trygg affär kostar köparen ──────────────────────────────────────
//
// Tre saker prövas, och alla tre är löften till en av parterna:
//
//   1. SÄLJAREN får sitt fulla pris. Ingen provision, inget avdrag.
//   2. LEVERANSEN prissätts av butikens zoner och ingen annanstans. Två fraktpriser för samma
//      sträcka i samma app är två priser användaren kan se samtidigt.
//   3. VARNINGEN informerar men blockerar aldrig. En 500-kronorsstol med 800 kr i avgifter kan
//      fortfarande vara ett vettigt köp — men det är köparens beslut, med talen framme.

import { test } from "node:test";
import assert from "node:assert/strict";
import { feesFor, SERVICE_FEE_SEK } from "../server/src/affar/fees.js";
import { deliveryQuote } from "../server/src/butik/delivery.js";

test("säljarens pris rörs aldrig — avgifterna ligger ovanpå", () => {
  const f = feesFor(4000, "11234");
  assert.equal(f.itemPriceSek, 4000, "det säljaren får");
  assert.equal(f.totalSek, 4000 + f.serviceFeeSek + f.deliveryFeeSek);
});

test("leveransen kommer från butikens zoner, inte en egen taxa", () => {
  for (const pn of ["11234", "16440", "18131"]) {
    assert.equal(feesFor(4000, pn).deliveryFeeSek, deliveryQuote(pn).zone!.feeSek, `zonen gäller för ${pn}`);
  }
});

/**
 * Zonerna kostar numera LIKA — och det är hela poängen.
 *
 * Priset var 495/695/895 efter avstånd, men annonserna lovar ett enda tal ("Hemleveransen kostar
 * 600 kr och är redan inräknad i priset") och kan inte veta postnumret när de skrivs. Testet vaktar
 * att ingen zon glider isär igen: en köpare i Haninge ska betala det annonsen sa.
 */
test("frakten är samma i innerstad, närförort och storstockholm", () => {
  const inner = feesFor(4000, "11234").deliveryFeeSek;
  const nar = feesFor(4000, "16440").deliveryFeeSek;
  const stor = feesFor(4000, "18131").deliveryFeeSek;
  assert.ok(inner === nar && nar === stor, `${inner} = ${nar} = ${stor}`);
});

// Leveranstiden är däremot fortfarande zonens: budfirman behöver längre framförhållning längre ut,
// och det är en operativ sanning som inte försvann av att priset blev ett.
test("leveranstiden skiljer sig fortfarande mellan zonerna", () => {
  assert.ok(deliveryQuote("11234").zone!.leadDays < deliveryQuote("18131").zone!.leadDays);
});

test("serviceavgiften är platt — arbetet är detsamma oavsett möbelns pris", () => {
  assert.equal(feesFor(500, "11234").serviceFeeSek, SERVICE_FEE_SEK);
  assert.equal(feesFor(50_000, "11234").serviceFeeSek, SERVICE_FEE_SEK);
});

test("utanför området finns ingen leveransavgift att ta ut", () => {
  const f = feesFor(4000, "41118");
  assert.equal(f.deliverable, false);
  assert.equal(f.deliveryFeeSek, 0);
  assert.equal(f.deliveryZone, null);
});

test("varningen tänds när avgifterna närmar sig möbelns pris", () => {
  const billig = feesFor(800, "18131"); // 200 + 600 = 800 på en 800-kronorsmöbel
  assert.ok(billig.viabilityNote, "ska upplysa");
  assert.match(billig.viabilityNote!, /800 kr/, "talen står i meningen");
});

test("men den BLOCKERAR aldrig — affären går att göra ändå", () => {
  const f = feesFor(500, "18131");
  assert.ok(f.viabilityNote);
  assert.equal(f.totalSek, 500 + f.serviceFeeSek + f.deliveryFeeSek, "totalen räknas som vanligt");
});

test("på en dyr möbel är avgifterna inget att varna om", () => {
  assert.equal(feesFor(12_000, "11234").viabilityNote, null);
});

test("utan känt pris varnar vi inte — det finns inget att väga mot", () => {
  assert.equal(feesFor(null, "11234").viabilityNote, null);
});
