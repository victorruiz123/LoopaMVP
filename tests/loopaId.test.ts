// ─── loopaId.ts: annonsens publika namn ──────────────────────────────────
//
// ID:t lämnar systemet: det trycks i en Tradera-annons som ligger uppe i veckor och skrivs sedan in
// för hand av någon som vill kontrollera skicket. Två egenskaper måste därför hålla, och de testas
// här därför att inget annat kan fånga när de brister.
//
// STABILITET. ID:t är härlett ur jobb-id:t och sparas ingenstans (se loopaId.ts). Ändras hashningen
// pekar varje redan tryckt annons på ett kort som inte längre finns — och felet syns inte i drift
// förrän en köpare söker förgäves. De förväntade värdena nedan är därför fastspikade med flit: den
// som ändrar formeln ska behöva ta ställning till att alla utgivna ID slutar gälla.
//
// AVLÄSNING. Ett ID läses ur tryck och knackas in. O för 0 och I eller l för 1 är samma glyfer i de
// flesta snitt, och ett "hittades inte" på ett korrekt avläst ID vore vårt fel, inte läsarens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loopaIdFor, normalizeLoopaId } from "../server/src/loopaId.js";

const JOB = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

test("samma jobb ger samma ID, i dag och efter en omstart", () => {
  assert.equal(loopaIdFor(JOB), loopaIdFor(JOB));
  assert.equal(loopaIdFor(JOB), "LP-KC4W-4519");
  assert.equal(loopaIdFor("11111111-2222-3333-4444-555555555555"), "LP-J8G8-E75B");
});

test("olika jobb ger olika ID", () => {
  const ids = new Set(Array.from({ length: 2000 }, (_, i) => loopaIdFor(`job-${i}`)));
  assert.equal(ids.size, 2000, "en krock på 2000 kort vore ett alldeles för trångt ID-rum");
});

test("formen är LP-XXXX-XXXX ur ett alfabet utan förväxlingsbara tecken", () => {
  for (let i = 0; i < 500; i++) {
    const id = loopaIdFor(`job-${i}`);
    assert.match(id, /^LP-[0-9A-Z]{4}-[0-9A-Z]{4}$/, `${id} har fel form`);
    assert.doesNotMatch(id.slice(3), /[ILOU]/, `${id} innehåller ett tecken som förväxlas vid avläsning`);
  }
});

test("ett inknackat ID läses oavsett skiftläge, bindestreck och prefix", () => {
  const id = loopaIdFor(JOB);
  assert.equal(normalizeLoopaId(id), id);
  assert.equal(normalizeLoopaId(id.toLowerCase()), id);
  assert.equal(normalizeLoopaId(" lp kc4w 4519 "), id);
  assert.equal(normalizeLoopaId("KC4W4519"), id, "prefixet får utelämnas");
});

test("O läses som 0 och I och L som 1 — glyferna är desamma i tryck", () => {
  assert.equal(normalizeLoopaId("LP-O123-4567"), "LP-0123-4567");
  assert.equal(normalizeLoopaId("LP-I234-567L"), "LP-1234-5671");
});

test("det som inte är ett Loopa-ID avvisas innan jobben slås upp", () => {
  assert.equal(normalizeLoopaId(""), null);
  assert.equal(normalizeLoopaId("LP-123"), null, "för kort");
  assert.equal(normalizeLoopaId("LP-1234-56789"), null, "för långt");
  assert.equal(normalizeLoopaId("LP-1234-567U"), null, "U ingår inte i alfabetet");
  assert.equal(normalizeLoopaId("8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"), null, "ett jobb-id är inte ett Loopa-ID");
});
