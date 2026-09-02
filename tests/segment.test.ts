// ─── Silhuetten: vilken form som är möbeln ──────────────────────────────────
//
// U2Net letar FRAMTRÄDANDE föremål, inte möbler, och ett vardagsrum har fler än ett. Mätt på en
// skarp bildruta klippte den ut soffan tillsammans med tavlan ovanför den. Testerna nedan låser fast
// regeln som skiljer dem åt — och gränsen för när den inte kan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keepLargestBlob } from "../server/src/pipeline/segment.js";

/** Ritar en rektangel i en gråskalebuffert. 255 = möbel, 0 = bakgrund. */
function rect(buf: Buffer, w: number, x0: number, y0: number, rw: number, rh: number, value = 255): void {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) buf[y * w + x] = value;
}

const W = 40;
const H = 40;

test("den största formen behålls, den mindre suddas", () => {
  // Soffan och tavlan: två skilda former, den ena klart större.
  const g = Buffer.alloc(W * H, 0);
  rect(g, W, 4, 20, 30, 14); // "soffan" 420 px
  rect(g, W, 14, 4, 10, 8); //  "tavlan"  80 px
  keepLargestBlob(g, W, H);

  assert.equal(g[25 * W + 10], 255, "soffan står kvar");
  assert.equal(g[6 * W + 18], 0, "tavlan är borta");
});

test("en enda form rörs inte", () => {
  const g = Buffer.alloc(W * H, 0);
  rect(g, W, 5, 5, 20, 20);
  const before = Buffer.from(g);
  keepLargestBlob(g, W, H);
  assert.deepEqual(g, before);
});

test("en tom mask rörs inte och kraschar inte", () => {
  const g = Buffer.alloc(W * H, 0);
  keepLargestBlob(g, W, H);
  assert.ok(g.every((v) => v === 0));
});

test("former som NUDDAR varandra är en form — och det är regelns gräns", () => {
  // Soffan och soffbordet som överlappar i bild blir en enda yta, och då finns inget att välja
  // mellan. Det är därför ramen från identifieringen behövs ovanpå det här (se cutout.ts).
  const g = Buffer.alloc(W * H, 0);
  rect(g, W, 4, 20, 20, 10);
  rect(g, W, 23, 22, 12, 8); // delar en kolumn med den förra
  keepLargestBlob(g, W, H);
  assert.equal(g[25 * W + 30], 255, "det som sitter ihop följer med");
});

test("bara diagonal kontakt räknas inte som samma form", () => {
  // Fyra grannar, inte åtta: en silhuett som bara hänger ihop i ett hörn är en kant, inte en möbel.
  const g = Buffer.alloc(W * H, 0);
  rect(g, W, 4, 4, 10, 10); // 100 px
  rect(g, W, 14, 14, 6, 6); //  36 px, rör den förra bara i hörnet
  keepLargestBlob(g, W, H);
  assert.equal(g[8 * W + 8], 255);
  assert.equal(g[16 * W + 16], 0, "hörnkontakt binder inte ihop dem");
});

test("svaga pixlar under golvet räknas inte som möbel", () => {
  // Samma golv (40) som alphaBounds i cutout.ts mäter yta med, så formen här är den som mäts där.
  const g = Buffer.alloc(W * H, 0);
  rect(g, W, 4, 4, 20, 20, 30); // stor men svag
  rect(g, W, 28, 28, 6, 6, 255); // liten men stark
  keepLargestBlob(g, W, H);
  assert.equal(g[30 * W + 30], 255, "den starka formen är den enda som finns");
  assert.equal(g[10 * W + 10], 30, "svaga pixlar lämnas som de är — tröskeln sitter i cutout.ts");
});
