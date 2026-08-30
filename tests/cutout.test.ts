// ─── cutout.ts: omslaget — säljarens möbel, urklippt och lagd på vitt ────────
//
// Prövar den halva som INTE frågar en modell: bild in, mask in, produktbild ut.
// Silhuetten kommer från Gemini och kan inte mätas här; det som kan mätas är vad
// som händer med den — att möbeln hamnar mitt i rutan, att bakgrunden blir vit,
// att luften runt om stämmer, och att en mask som inte kan vara en möbel stoppas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { COVER_SIZE, composeCutout } from "../server/src/pipeline/cutout.js";

// sharp ligger i server/node_modules, och testerna körs från roten som inte har det. Upplösningen
// startas därför från filen som själv importerar det — samma modul, samma installation.
const sharp = createRequire(new URL("../server/src/pipeline/cutout.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

const W = 400;
const H = 600;
/** Möbeln i provbilden: en röd kloss mot en brokig bakgrund. */
const OBJECT = { left: 120, top: 150, width: 160, height: 300 };

/** En bild med något som inte är vitt runtom, så ett urklipp går att se skillnad på. */
async function photo(): Promise<Buffer> {
  return await sharp({ create: { width: W, height: H, channels: 3, background: { r: 40, g: 120, b: 60 } } })
    .composite([
      {
        input: {
          create: { width: OBJECT.width, height: OBJECT.height, channels: 3, background: { r: 200, g: 30, b: 30 } },
        },
        left: OBJECT.left,
        top: OBJECT.top,
      },
    ])
    .jpeg()
    .toBuffer();
}

/** Masken som modellen skulle ha svarat med: vitt inom rutan, i rutans storlek. */
async function mask(box: { width: number; height: number }, fill: "white" | "black" = "white"): Promise<Buffer> {
  const shade = fill === "white" ? 255 : 0;
  return await sharp({
    create: { width: box.width, height: box.height, channels: 3, background: { r: shade, g: shade, b: shade } },
  })
    .png()
    .toBuffer();
}

/** Rutan runt allt som inte är vitt i omslaget — möbeln plus dess skugga. */
async function inkBounds(cover: Buffer) {
  const { data, info } = await sharp(cover).raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test("omslaget blir en kvadrat med vit bakgrund", async () => {
  const cover = await composeCutout(await photo(), await mask(OBJECT), OBJECT, W, H);
  assert.ok(cover, "urklippet skulle gjorts");
  const meta = await sharp(cover).metadata();
  assert.equal(meta.width, COVER_SIZE);
  assert.equal(meta.height, COVER_SIZE);

  // Hörnen är det som var bakgrund i fotot. De ska vara vita, inte gröna.
  const { data } = await sharp(cover).extract({ left: 0, top: 0, width: 12, height: 12 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 250 && data[1] > 250 && data[2] > 250, `hörnet var ${data[0]},${data[1]},${data[2]}`);
});

test("möbeln står mitt i rutan, med luft runt om", async () => {
  const cover = await composeCutout(await photo(), await mask(OBJECT), OBJECT, W, H);
  assert.ok(cover);
  const b = await inkBounds(cover);

  // Lika mycket vitt till vänster som till höger — skuggan är lika bred som möbeln och rubbar inte det.
  const rightMargin = COVER_SIZE - 1 - b.maxX;
  assert.ok(Math.abs(b.minX - rightMargin) <= 3, `vänster ${b.minX}, höger ${rightMargin}`);

  // Och luft kvar på alla sidor: möbeln får aldrig gå ut i kanten.
  assert.ok(b.minX > 40, `för trångt till vänster: ${b.minX}`);
  assert.ok(b.minY > 40, `för trångt upptill: ${b.minY}`);
  assert.ok(COVER_SIZE - 1 - b.maxY > 20, `för trångt nedtill: ${COVER_SIZE - 1 - b.maxY}`);
});

test("en mask som täcker hela bilden är inte en möbel", async () => {
  const whole = { left: 0, top: 0, width: W, height: H };
  assert.equal(await composeCutout(await photo(), await mask(whole), whole, W, H), null);
});

test("en mask som täcker nästan ingenting är inte en möbel", async () => {
  const speck = { left: 10, top: 10, width: 20, height: 20 };
  assert.equal(await composeCutout(await photo(), await mask(speck), speck, W, H), null);
});

test("en svart mask ger inget urklipp alls", async () => {
  assert.equal(await composeCutout(await photo(), await mask(OBJECT, "black"), OBJECT, W, H), null);
});
