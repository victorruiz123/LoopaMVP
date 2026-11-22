// ─── Nedskalningen av fotona (web/src/lib/imageResize.ts) ────────────────────
//
// Canvas och createImageBitmap finns inte här, så det som går att pröva är räkningen: längsta sidan ska bli
// högst 2048 px, proportionerna ska bevaras, och en liten bild ska aldrig förstoras. Resten — vridningen,
// felen — kräver en webbläsare och prövas på enhet (se planen, "Riktiga enheter").

import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDE_LONG_EDGE, ImageReadError, fitLongEdge } from "../web/src/lib/imageResize.js";

test("en stor liggande bild skalas så att bredden blir 2048", () => {
  assert.deepEqual(fitLongEdge(4032, 3024), { width: 2048, height: 1536 });
});

test("en stor stående bild skalas så att HÖJDEN blir 2048 — längsta sidan, inte bredden", () => {
  // Förut skalades bara bredden (MAX_UPLOAD_WIDTH), så en stående bild blev högre än den var bred.
  assert.deepEqual(fitLongEdge(3024, 4032), { width: 1536, height: 2048 });
});

test("en bild som redan ryms förstoras aldrig", () => {
  assert.deepEqual(fitLongEdge(1280, 960), { width: 1280, height: 960 });
  assert.deepEqual(fitLongEdge(GUIDE_LONG_EDGE, 100), { width: GUIDE_LONG_EDGE, height: 100 });
});

test("proportionerna bevaras, även för en mycket smal bild", () => {
  const { width, height } = fitLongEdge(8000, 400);
  assert.equal(width, GUIDE_LONG_EDGE);
  assert.ok(Math.abs(width / height - 20) < 0.2, `${width}×${height}`);
});

test("en kvadrat blir en kvadrat", () => {
  assert.deepEqual(fitLongEdge(5000, 5000), { width: 2048, height: 2048 });
});

test("orimliga mått ger ändå minst en pixel — canvas kastar på noll", () => {
  assert.deepEqual(fitLongEdge(0, 0), { width: 1, height: 1 });
  assert.ok(fitLongEdge(10_000, 1).height >= 1);
});

test("taket kan väljas", () => {
  assert.deepEqual(fitLongEdge(4000, 2000, 1000), { width: 1000, height: 500 });
});

test("ImageReadError går att känna igen på sitt namn", () => {
  const e = new ImageReadError();
  assert.equal(e.name, "ImageReadError");
  assert.ok(e instanceof Error);
  assert.ok(e.message.length > 0);
});
