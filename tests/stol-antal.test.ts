// ─── stolPris.ts: styckpris, buntpris och vem som frågas ─────────────────────
//
// Två fel som ser likadana ut i gränssnittet och är motsatta i sak: en enskild stol som får en
// buntprislapp ur korpusen (styckDivisor), och en bunt om sex som får ett styckpris för att
// säljaren aldrig fick frågan. Det som testas här är räkningen och gränserna runt den — Gemini-
// anropet självt är ett nätverksanrop, medan taket, faktorspannet och skalningen är våra.

import { test } from "node:test";
import assert from "node:assert/strict";
import { kanVaraStol, rimligFaktor, skalaTillAntal, MAX_ANTAL_STOLAR } from "../server/src/stolPris.js";
import type { PriceEstimate } from "../server/src/types.js";

const PRIS: PriceEstimate = {
  status: "ok",
  low: 400,
  default: 600,
  high: 900,
  currency: "SEK",
  confidence: "medium",
  note: null,
  matchCount: 12,
  variant: ["matstol"],
  variantMethod: "model_name",
  damageDeduction: null,
  damageLines: [],
  unavailableReason: null,
  requestedAt: "2026-09-11T10:00:00.000Z",
  latencyMs: 900,
};

test("kandidatens möbeltyp avgör före modellnamnet — 'Stefan' säger ingenting själv", () => {
  assert.equal(kanVaraStol({ brand: "IKEA", model: "Stefan" }, null), false);
  assert.equal(kanVaraStol({ brand: "IKEA", model: "Stefan" }, null, "matstol"), true);
  // Prismotorns egen variant går först av alla: den är typen den faktiskt filtrerade annonserna på.
  assert.equal(kanVaraStol({ brand: "IKEA", model: "Stefan" }, ["barstol"], "soffa"), true);
  assert.equal(kanVaraStol({ brand: "Ekornes", model: "Stressless" }, null, "soffa"), false);
  // Ingen källa får rösta ner en annan. Motorn kan ha filtrerat på "matgrupp" — säger kandidaten
  // stol frågas Gemini ändå, för ett falskt ja kostar ett anrop och ett falskt nej ett buntpris.
  assert.equal(kanVaraStol({ brand: "IKEA", model: "Stefan" }, ["matgrupp"], "matstol"), true);
  assert.equal(kanVaraStol({ brand: "IKEA", model: "Ingolf barstol" }, ["matgrupp"], null), true);
});

test("hela spannet skalas med antalet, och styckpriset sparas undan", () => {
  const bunt = skalaTillAntal(PRIS, 6, 0.85);
  assert.equal(bunt.default, 3060); // 600 × 6 × 0,85
  assert.equal(bunt.low, 2040);
  assert.equal(bunt.high, 4590);
  assert.equal(bunt.stolAntal, 6);
  assert.equal(bunt.styckPris, 600, "utan styckpriset går buntens tal inte att läsa");
});

test("tomma ändar av spannet förblir tomma i stället för att bli nollor", () => {
  const bunt = skalaTillAntal({ ...PRIS, low: null, high: null }, 4, 1);
  assert.equal(bunt.low, null);
  assert.equal(bunt.high, null);
  assert.equal(bunt.default, 2400);
});

test("faktorn avvisas utanför spannet — en bunt är en justering, inte ett annat pris", () => {
  assert.equal(rimligFaktor(0.85), 0.85);
  assert.equal(rimligFaktor(1), 1);
  assert.equal(rimligFaktor(0.4), null, "en halvering per stol är inte en mängdrabatt");
  assert.equal(rimligFaktor(2), null, "ett set är inte värt dubbelt sina delar");
  assert.equal(rimligFaktor("sex"), null);
  assert.equal(rimligFaktor(undefined), null);
});

test("taket är tolv — matgrupper slutar där, och felskrivningar börjar", () => {
  assert.equal(MAX_ANTAL_STOLAR, 12);
});
