// ─── listing.ts: bildrutorna identifieringen får se ──────────────────────────
//
// Fas 1 är säljarens rena väntan ("Letar upp modellen…"), och nyttolasten är en stor del av den.
// Generatorns sökning tar tre bilder; sex skickades, tre användes — och det var de tre FÖRSTA, som
// ligger i filmningsordning och därför är samma ögonblick av varvet tre gånger.
//
// Testerna håller fast vid urvalsregeln: omslagsbilden först när den finns, resten spridda över
// varvet, aldrig fler än tre.

import { test } from "node:test";
import assert from "node:assert/strict";
import { identifieringsBilder } from "../server/src/listing.js";
import type { CapturedImage } from "../server/src/types.js";

function bild(n: number, role?: "cover"): CapturedImage {
  return {
    id: `img_${n}`,
    viewLabel: null,
    source: "video",
    ...(role ? { role } : {}),
    width: 1280,
    height: 720,
    path: `img_${n}.jpg`,
  };
}

const namn = (list: CapturedImage[]) => list.map((i) => i.id);

test("tre bildrutor, aldrig fler", () => {
  assert.equal(identifieringsBilder([0, 1, 2, 3, 4, 5].map((n) => bild(n))).length, 3);
});

test("varvet spänns upp: första och sista bildrutan är med", () => {
  const valda = namn(identifieringsBilder([0, 1, 2, 3, 4, 5].map((n) => bild(n))));
  assert.deepEqual(valda, ["img_0", "img_3", "img_5"]);
});

test("omslagsbilden går först och tar en av platserna", () => {
  const images = [...[0, 1, 2, 3, 4].map((n) => bild(n)), bild(9, "cover")];
  const valda = namn(identifieringsBilder(images));
  assert.equal(valda[0], "img_9");
  assert.equal(valda.length, 3);
  // De två som blir kvar spänner fortfarande upp varvet.
  assert.deepEqual(valda.slice(1), ["img_0", "img_4"]);
});

test("färre bildrutor än platser ger alla, i sin ordning", () => {
  assert.deepEqual(namn(identifieringsBilder([0, 1].map((n) => bild(n)))), ["img_0", "img_1"]);
});

test("bara en omslagsbild och en bildruta: båda med", () => {
  assert.deepEqual(namn(identifieringsBilder([bild(0), bild(9, "cover")])), ["img_9", "img_0"]);
});

test("en enda bildruta duger", () => {
  assert.deepEqual(namn(identifieringsBilder([bild(0)])), ["img_0"]);
});

test("inga bildrutor ger inga bilder — anroparen svarar 'inga bildrutor att skicka'", () => {
  assert.deepEqual(identifieringsBilder([]), []);
});
