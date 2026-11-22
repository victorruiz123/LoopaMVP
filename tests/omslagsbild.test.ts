// ─── Omslagsbilden i fotoflödet ───
//
// Omslagsbilden är den första bilden fotoguiden ber om: tagen i möbelns egen höjd, snett framifrån.
// Förut hölls den UTANFÖR besiktningen (`tillBedomning`) och måste då ligga SIST i listan, så att
// bedömningslistan var ett prefix av hela listan — annars gled varje `image_index` ett steg och
// bevisbilder hamnade på fel foto.
//
// Det är borta. Omslaget besiktigas som alla andra bilder och ligger på index 0, och det finns EN lista i
// EN ordning. Testerna nedan bevakar det som då måste stämma:
//
//   - modellen får samma lista som omslagsvalet indexerar mot (`coverImageIndex`),
//   - rollen `cover` vinner omslagsvalet, men bara om bilden duger,
//   - en bild som inte duger faller tillbaka på modellens förslag.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describeImages } from "../server/src/pipeline/inspect.js";
import { coverFirst, pickCoverImageId } from "../server/src/pipeline/cover.js";
import type { CapturedImage } from "../server/src/types.js";

// Samma sharp som koden under test (se tests/imageIngest.test.ts): en `import "sharp"` från testet hamnar på en annan installation.
const sharp = createRequire(new URL("../server/src/pipeline/cover.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "omslag-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Brus: medelvärde ≈128 och hög spridning, alltså en bild som duger enligt dugligetsspärren i cover.ts. */
async function dugligBild(name: string): Promise<void> {
  const raw = randomBytes(64 * 64 * 3);
  await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toFile(path.join(dir, name));
}

/** Helsvart: medelluminans 0, alltså en bild som inte duger. */
async function svartBild(name: string): Promise<void> {
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg()
    .toFile(path.join(dir, name));
}

function bild(id: string, extra: Partial<CapturedImage> = {}): CapturedImage {
  return {
    id,
    viewLabel: null,
    source: "manual",
    width: 64,
    height: 64,
    path: `${id}.jpg`,
    capturedAt: "2026-11-21T00:00:00.000Z",
    ...extra,
  };
}

test("omslagsbilden är en vanlig bild i listan modellen får, på index 0", () => {
  const alla = [
    bild("omslag", { role: "cover", viewLabel: "Omslagsbild" }),
    bild("fram", { viewLabel: "Framifrån" }),
    bild("vanster", { viewLabel: "Vänster sida" }),
  ];
  // Indexet i texten är det modellen svarar med (`image_index`). Det måste vara indexet i `alla`.
  assert.equal(
    describeImages(alla),
    "Bild 0: omslagsbild (Omslagsbild), Bild 1: foto (Framifrån), Bild 2: foto (Vänster sida)",
  );
});

test("gamla jobb med bildrutor ur en film beskrivs fortfarande som video-vyer", () => {
  // Omkörning av ett jobb skapat före fotoguiden (`source: "video"`) ska inte plötsligt kallas foto.
  assert.equal(describeImages([bild("a", { source: "video" })]), "Bild 0: video-vy");
});

test("rollen cover vinner omslagsvalet, även mot modellens förslag", async () => {
  await dugligBild("omslag.jpg");
  await dugligBild("b.jpg");
  const alla = [bild("omslag", { role: "cover" }), bild("b")];
  // Modellen pekar på bild 1, men vi BAD om omslaget och det duger.
  assert.equal(await pickCoverImageId(alla, dir, 1), "omslag");
});

test("coverImageIndex pekar in i samma lista som inspektionen fick", async () => {
  await dugligBild("fram.jpg");
  await dugligBild("vanster.jpg");
  // Inget omslag med rollen satt: modellens val avgör, och index 1 är den andra bilden i HELA listan.
  // (Före ändringen filtrerades omslaget bort ur inspektionslistan, så index betydde olika saker.)
  const alla = [bild("fram"), bild("vanster")];
  assert.equal(await pickCoverImageId(alla, dir, 1), "vanster");
});

test("ett svart omslag duger inte och faller tillbaka på modellens förslag", async () => {
  await svartBild("svart-omslag.jpg");
  await dugligBild("fram2.jpg");
  await dugligBild("vanster2.jpg");
  const alla = [
    bild("svart-omslag", { role: "cover" }),
    bild("fram2"),
    bild("vanster2"),
  ];
  // Avsikten räcker inte: en beställd men svart bild blir inte annonsens ansikte.
  assert.equal(await pickCoverImageId(alla, dir, 2), "vanster2");
});

test("utan duglig bild och utan förslag blir första bilden omslag — ett omslag måste det bli", async () => {
  await svartBild("s1.jpg");
  await svartBild("s2.jpg");
  assert.equal(await pickCoverImageId([bild("s1"), bild("s2")], dir, null), "s1");
});

test("ett jobb som BARA bär en omslagsbild bedöms och får omslag på den", async () => {
  await dugligBild("ensam.jpg");
  const bara = [bild("ensam", { role: "cover" })];
  assert.equal(describeImages(bara), "Bild 0: omslagsbild");
  assert.equal(await pickCoverImageId(bara, dir, null), "ensam");
});

test("coverFirst lägger omslaget först och behåller resten i ordning", () => {
  const alla = [bild("a"), bild("b"), bild("c")];
  assert.deepEqual(coverFirst(alla, "c").map((i) => i.id), ["c", "a", "b"]);
  assert.deepEqual(coverFirst(alla, null), alla);
  assert.deepEqual(coverFirst(alla, "finns-inte"), alla);
});
