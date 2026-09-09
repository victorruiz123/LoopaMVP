// ─── Omslagsbilden: bilden säljaren blir ombedd att komponera efter varvet ───
//
// Den finns för att bildrutor ur ett varv är tagna uppifrån — telefonen hålls i
// brösthöjd och lutas ner — vilket syns direkt när möbeln läggs mot en
// studiobakgrund fotograferad i ögonhöjd. Två kamerahöjder i samma bild.
//
// Testerna nedan bevakar de två reglerna som gör att den kan finnas utan att
// kosta något: den går inte in i inspektionsanropet (latens), och den flyttar
// inga index (bevisbilder).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tillBedomning } from "../server/src/pipeline/run.js";
import type { CapturedImage } from "../server/src/types.js";

function bild(id: string, role?: "cover"): CapturedImage {
  return {
    id,
    viewLabel: null,
    source: role ? "manual" : "video",
    width: 1280,
    height: 960,
    path: `${id}.jpg`,
    capturedAt: "2026-09-09T00:00:00.000Z",
    ...(role ? { role } : {}),
  };
}

test("omslagsbilden går inte in i besiktningen", () => {
  const varv = [bild("a"), bild("b"), bild("c")];
  const alla = [...varv, bild("omslag", "cover")];

  // Latensen: inspektionsanropet ska se sex vyer, inte sju. Bildrutorna går i ETT
  // anrop där varje extra bild är sekunder säljaren står och väntar.
  assert.deepEqual(tillBedomning(alla).map((i) => i.id), ["a", "b", "c"]);

  // Ett jobb utan omslagsbild rörs inte alls — samma lista in som ut.
  assert.deepEqual(tillBedomning(varv), varv);
});

test("bedömningslistan är ett PREFIX av hela listan", () => {
  /**
   * Det här är regeln som gör filtreringen ofarlig, och den är lätt att råka bryta.
   *
   * Modellen pekar ut bevis som `image_index` in i den lista den FICK, och
   * `inspection.coverImageIndex` gör detsamma. Så länge bedömningslistan är ett
   * prefix betyder index k samma bild i båda listorna. Läggs omslagsbilden först
   * i stället för sist glider varje index ett steg, och bevisbilder hamnar på fel
   * foto — ett fel som syns först på kortet, långt från koden som orsakade det.
   */
  const alla = [bild("a"), bild("b"), bild("omslag", "cover")];
  const bedomda = tillBedomning(alla);
  for (let i = 0; i < bedomda.length; i++) {
    assert.equal(bedomda[i].id, alla[i].id, `index ${i} pekar inte på samma bild i båda listorna`);
  }
});

test("ett jobb som BARA bär en omslagsbild bedöms på den", () => {
  // Kan inte hända via appen, som alltid filmar först. En klient som ändå skickar
  // en enda bild med rollen satt ska få en besiktning, inte ett tomt anrop.
  const bara = [bild("omslag", "cover")];
  assert.deepEqual(tillBedomning(bara), bara);
});
