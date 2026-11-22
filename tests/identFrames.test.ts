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

// ─── Fotoguidens ordning ─────────────────────────────────────────────────────
//
// Med fotoguiden är listan inget varv: omslag, framifrån, vänster, baksida, höger, ovanifrån, närbild,
// extra. En spridning över den hamnade på närbilden av en repa — bra för besiktningen, värdelös för att
// avgöra VILKEN modell det är. Därför sorteras de bilderna bort först (server/src/imageRoles.ts).

function foto(id: string, viewLabel: string | null, role?: "cover"): CapturedImage {
  return { id, viewLabel, source: "manual", ...(role ? { role } : {}), width: 1600, height: 1200, path: `${id}.jpg`, capturedAt: "2026-11-21T00:00:00.000Z" };
}

const GUIDENS_ORDNING = [
  foto("omslag", "Omslagsbild", "cover"),
  foto("fram", "Framifrån"),
  foto("vanster", "Vänster sida"),
  foto("bak", "Bakifrån"),
  foto("hoger", "Höger sida"),
  foto("topp", "Ovanifrån"),
  foto("nar1", "Närbild"),
  foto("extra1", "Extra bild"),
];

test("närbilder, extra bilder och ovanifrån väljs aldrig för identifiering", () => {
  const valda = namn(identifieringsBilder(GUIDENS_ORDNING));
  assert.equal(valda.length, 3);
  assert.equal(valda[0], "omslag");
  for (const id of valda) assert.ok(!["topp", "nar1", "extra1"].includes(id), `${id} är en detaljbild`);
  // De två som blir kvar spänner upp möbeln: första och sista av helbilderna.
  assert.deepEqual(valda.slice(1), ["fram", "hoger"]);
});

test("en närbild som ligger mitt i listan hoppas också över", () => {
  const images = [foto("fram", "Framifrån"), foto("nar", "Närbild"), foto("bak", "Bakifrån"), foto("sida", "Vänster sida")];
  assert.ok(!namn(identifieringsBilder(images)).includes("nar"));
});

test("etiketten matchas oberoende av versaler och blanksteg", () => {
  const images = [foto("fram", "Framifrån"), foto("a", "  NÄRBILD "), foto("b", "extra bild 2"), foto("c", "Bakifrån")];
  assert.deepEqual(namn(identifieringsBilder(images)), ["fram", "c"]);
});

test("bara detaljbilder: då väljs bland dem hellre än att svara 'inga bilder'", () => {
  const images = [foto("n1", "Närbild"), foto("n2", "Närbild"), foto("n3", "Extra bild"), foto("n4", "Närbild")];
  assert.equal(identifieringsBilder(images).length, 3);
});

test("omslagsbilden räknas alltid med, även om den skulle bära en detaljetikett", () => {
  const images = [foto("c", "Närbild", "cover"), foto("fram", "Framifrån"), foto("bak", "Bakifrån")];
  assert.equal(identifieringsBilder(images)[0].id, "c");
});

test("jobb före fotoguiden, utan etiketter, väljs som förut", () => {
  // Bildrutor ur en film har `viewLabel: null` — inget av det här får röra dem.
  const gamla = [0, 1, 2, 3, 4, 5].map((n) => bild(n));
  assert.deepEqual(namn(identifieringsBilder(gamla)), ["img_0", "img_3", "img_5"]);
});

test("pickResearchFrames följer samma regel: omslaget först, helbilder spridda, inga detaljbilder", async () => {
  const { pickResearchFrames } = await import("../server/src/research/pipeline.js");
  const valda = namn(pickResearchFrames(GUIDENS_ORDNING, 4));
  assert.equal(valda[0], "omslag");
  for (const id of valda) assert.ok(!["topp", "nar1", "extra1"].includes(id), `${id} är en detaljbild`);
  assert.equal(valda.length, 4);
});
