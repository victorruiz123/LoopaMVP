// ─── pipeline/bild: produktbildssystemet — allt utom modellen ────────────────
//
// Segmenteringen kan inte prövas här: den kräver en 973 MB-fil som inte ligger i
// git, och ett svar från den är en bedömning och inte ett facit. Allt ANNAT kan
// prövas, och det är där felen faktiskt har suttit — kanten, öarna, tröskeln,
// beskärningen och kvalitetsdomen. Testerna matar därför in en känd mask och
// mäter vad kedjan gör med den.
//
// Det viktigaste testet i filen är `dekontaminera rör aldrig möbelns inre`.
// Loopa lovar att bilden visar möbeln som den är, inklusive varje skada. Det
// löftet hålls av en gräns i kant.ts, och en gräns som bara kontrolleras av att
// koden är rätt är ett löfte tills någon ändrar i koden.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dekontaminera, mjukTroskel, rensaOar, styrtFilter, BAND_HOG } from "../server/src/pipeline/bild/kant.js";
import { komponera, ramFor, RUTA } from "../server/src/pipeline/bild/komposition.js";
import { bedom } from "../server/src/pipeline/bild/kvalitet.js";
import { harGodkantOmslag } from "../server/src/pipeline/bild/omslag.js";

const sharp = createRequire(new URL("../server/src/pipeline/bild/kant.ts", import.meta.url))(
  "sharp",
) as typeof import("../server/node_modules/sharp");

const B = 200;
const H = 300;
/** Möbeln i provbilden: en röd kloss. Allt utanför den är "rum". */
const KLOSS = { x0: 60, y0: 80, x1: 140, y1: 250 };

function inuti(x: number, y: number): boolean {
  return x >= KLOSS.x0 && x < KLOSS.x1 && y >= KLOSS.y0 && y < KLOSS.y1;
}

/** Röd kloss mot blå bakgrund, som rå RGB. En hård kant filtret ska kunna hitta. */
function bild(): Buffer {
  const rgb = Buffer.alloc(B * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < B; x++) {
      const i = (y * B + x) * 3;
      if (inuti(x, y)) { rgb[i] = 200; rgb[i + 1] = 40; rgb[i + 2] = 40; }
      else { rgb[i] = 30; rgb[i + 1] = 60; rgb[i + 2] = 180; }
    }
  }
  return rgb;
}

/**
 * Masken som en modell faktiskt lämnar den: SUDDIG, och några pixlar fel.
 *
 * Det är det styrda filtrets uppgift. En modell svarar i 1024 px på en bild som är dubbelt så bred,
 * och uppskalningen gör varje kant till en ramp över några pixlar plus ett litet läggfel. Filtret
 * ska göra rampen till en kant på rätt pixel.
 *
 * Vad det INTE ska göra är att flytta masken långt — ett styrt filter förfinar lokalt, inom sin
 * radie. En mask som sitter tolv pixlar fel är ett segmenteringsfel, inte ett kantfel, och att
 * kräva att filtret lagar det vore att pröva fel modul.
 */
function suddigMask(): Float32Array {
  const a = new Float32Array(B * H);
  const R = 5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < B; x++) {
      // Medelvärde i en liten ruta = en ramp över kanten. Plus två pixlars läggfel åt höger.
      let n = 0;
      let summa = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          n++;
          if (inuti(x - 2 + dx, y + dy)) summa++;
        }
      }
      a[y * B + x] = summa / n;
    }
  }
  return a;
}

function ramMask(): Float32Array {
  const a = new Float32Array(B * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < B; x++) a[y * B + x] = inuti(x, y) ? 1 : 0;
  return a;
}

test("styrtFilter gör en suddig mask till en kant på rätt pixel", () => {
  const rgb = bild();
  const suddig = suddigMask();
  const skarp = styrtFilter(rgb, suddig, B, H, 10, 1e-4);

  /**
   * KANTENS BREDD OCH LÄGE mäts, inte summan av avvikelsen mot den sanna masken.
   *
   * Den summan var första versionens mått och den underkände ett filter som fungerade: utdata låg
   * 0,03 i bakgrunden i stället för 0,00 och 0,85 i möbeln i stället för 1,00, alltså en global
   * nivåskillnad över miljontals pixlar som dränkte den kantförbättring måttet skulle fånga. Den
   * nivån är dessutom `mjukTroskel`:s uppgift, inte filtrets.
   *
   * Vad filtret LOVAR är två saker, och båda mäts nedan: att rampen blir ett steg, och att steget
   * hamnar på den kant bilden faktiskt har.
   */
  const rad = (a: Float32Array, y: number) => Array.from({ length: B }, (_, x) => a[y * B + x]);
  const bredd = (v: number[]) => v.filter((t) => t > 0.2 && t < 0.8).length;
  const halvvag = (v: number[]) => v.findIndex((t) => t > 0.5);

  const fore = rad(suddig, 150);
  const efter = rad(skarp, 150);

  /**
   * LÄGET är det starka påståendet, och det ska stämma på pixeln.
   *
   * Indata sitter två pixlar fel — det läggfel en uppskalad modellmask alltid bär. Filtret ska inte
   * bara jämna ut rampen utan flytta den till den kant bilden faktiskt har.
   */
  assert.ok(Math.abs(halvvag(efter) - KLOSS.x0) <= 1, `kanten hamnade på ${halvvag(efter)}, inte på ${KLOSS.x0}`);

  // Rampen ska smalna. Mätt över hela raden, alltså båda klossens kanter.
  assert.ok(bredd(efter) <= bredd(fore) * 0.7, `kanten blev inte skarpare: ${bredd(fore)} px ramp -> ${bredd(efter)} px`);

  /**
   * Och övergången ska ske i ETT KLIV, inte i en lutning.
   *
   * Mätt som största skillnaden mellan två grannpixlar över kanten, inte som antalet pixlar i
   * spannet 0,2–0,8. Den räkningen provades först och mätte fel sak: efter filtret ligger
   * bakgrunden på en svagt avtagande nivå (0,29 … 0,16 utanför möbeln i stället för 0), och de
   * pixlarna hamnar i spannet utan att vara någon ramp. Nivån är `mjukTroskel`:s uppgift; kanten är
   * filtrets, och ett kliv från 0,92 till 0,29 mellan två pixlar ÄR en kant.
   */
  let kliv = 0;
  for (let x = KLOSS.x1 - 8; x < KLOSS.x1 + 8; x++) kliv = Math.max(kliv, Math.abs(efter[x] - efter[x + 1]));
  assert.ok(kliv > 0.5, `högerkanten är en lutning, inte ett kliv: största steg ${kliv.toFixed(2)}`);
});

test("rensaOar behåller ett ben som hänger på en svag brygga", () => {
  const a = ramMask();
  // Ett ben under klossen, fäst med en brygga vars alfa ligger UNDER den gamla hårda tröskeln.
  for (let y = 250; y < 290; y++) for (let x = 95; x < 105; x++) a[y * B + x] = 1;
  for (let y = 248; y < 252; y++) for (let x = 95; x < 105; x++) a[y * B + x] = 0.15;

  rensaOar(a, B, H);
  assert.equal(a[270 * B + 100], 1, "benet raderades trots att det sitter fast");
});

test("rensaOar raderar en fristående fläck", () => {
  const a = ramMask();
  // En tavla på väggen: liten, långt bort, inte ihopkopplad.
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) a[y * B + x] = 1;

  rensaOar(a, B, H);
  assert.equal(a[20 * B + 20], 0, "den fristående fläcken blev kvar");
  assert.equal(a[150 * B + 100], 1, "möbeln försvann");
});

test("mjukTroskel behåller övergången i stället för att platta till den", () => {
  const a = Float32Array.from([0.01, 0.2, 0.5, 0.8, 0.99]);
  mjukTroskel(a);
  assert.equal(a[0], 0, "svag bakgrund ska bli helt genomskinlig");
  assert.equal(a[4], 1, "säker möbel ska bli helt täckande");
  // Mitten ska vara kvar som en mjuk ramp — inte snappad till 0 eller 1.
  assert.ok(a[1] > 0 && a[1] < a[2] && a[2] < a[3] && a[3] < 1, `bandet plattades till: ${[...a]}`);
});

test("dekontaminera rör aldrig möbelns inre", () => {
  const rgb = bild();
  const orort = Buffer.from(rgb);
  const a = ramMask();
  // Ett kantband runt klossen, alltså pixlar som är blandningar av möbel och rum.
  for (let y = KLOSS.y0 - 2; y < KLOSS.y0 + 2; y++) for (let x = KLOSS.x0; x < KLOSS.x1; x++) a[y * B + x] = 0.5;

  dekontaminera(rgb, a, B, H, 12);

  let inreAndrade = 0;
  let bandAndrade = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(rgb[i * 3] - orort[i * 3]) + Math.abs(rgb[i * 3 + 1] - orort[i * 3 + 1]) + Math.abs(rgb[i * 3 + 2] - orort[i * 3 + 2]);
    if (d === 0) continue;
    if (a[i] >= BAND_HOG) inreAndrade++;
    else bandAndrade++;
  }
  assert.equal(inreAndrade, 0, "kedjan skrev i pixlar som är helt möbel — då är det inte längre säljarens möbel");
  assert.ok(bandAndrade > 0, "kantbandet lämnades orört, alltså gjorde steget ingenting");
});

test("komponera lägger möbeln mot rent vitt, hel och nedtyngd", async () => {
  const rgb = bild();
  const a = ramMask();
  const ram = ramFor(a, B, H)!;
  const ut = await komponera(rgb, a, B, H, ram);
  assert.ok(ut, "ingen produktbild");

  const { data, info } = await sharp(ut!).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, RUTA);
  assert.equal(info.height, RUTA);

  // Hörnen ska vara rent vita — ingen gradient, ingen miljö, ingen kvarvarande bakgrund.
  for (const [x, y] of [[2, 2], [RUTA - 3, 2], [2, RUTA - 3], [RUTA - 3, RUTA - 3]]) {
    const i = (y * RUTA + x) * 3;
    assert.ok(data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250, `hörnet ${x},${y} är inte vitt: ${data[i]},${data[i + 1]},${data[i + 2]}`);
  }

  // Möbeln ska stå NEDTYNGD: tyngdpunkten under mitten, men aldrig kapad av kanten.
  let minY = RUTA;
  let maxY = -1;
  let minX = RUTA;
  let maxX = -1;
  for (let y = 0; y < RUTA; y++) {
    for (let x = 0; x < RUTA; x++) {
      const i = (y * RUTA + x) * 3;
      // Röd kloss: hittas på att röd dominerar. Skuggan är grå och räknas inte.
      if (data[i] > 120 && data[i + 1] < 110 && data[i + 2] < 110) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  assert.ok(maxY > 0, "möbeln syns inte i produktbilden");
  assert.ok(minY > 0 && maxY < RUTA - 1 && minX > 0 && maxX < RUTA - 1, "möbeln går ut i kanten — den har kapats");

  /**
   * NEDERKANTEN mäts, inte mittpunkten.
   *
   * Möbeln ska STÅ på en linje, och den linjen ligger på 89 % av rutan oavsett hur hög möbeln är.
   * En första version av det här testet mätte mittpunkten i stället och underkände en korrekt
   * placerad garderob: en möbel som är nästan lika hög som innerrutan har sin mitt ovanför centrum
   * hur långt ned den än står. Det är just den möbeln placeringen finns för — en låg soffa och en
   * hög garderob ska få SAMMA golv, för det är det som gör ett rutnät av kort till en hylla.
   */
  const golv = RUTA * 0.925;
  assert.ok(Math.abs(maxY - golv) < RUTA * 0.03, `nederkanten står inte på golvet: ${maxY} mot ${golv.toFixed(0)}`);
  assert.ok(RUTA - maxY < minY, `mer luft under än över — möbeln är inte nedtyngd (${RUTA - maxY} under, ${minY} över)`);
  // Marginalen vid sidorna ska vara jämn: möbeln centrerad i x.
  assert.ok(Math.abs(minX - (RUTA - maxX)) < 6, `möbeln är inte centrerad: ${minX} vs ${RUTA - maxX}`);
});

test("bedom godkänner en ren mask och stoppar en som täcker hela bilden", () => {
  const rgb = bild();
  const a = ramMask();
  const ram = ramFor(a, B, H)!;
  const bra = bedom(a, a, rgb, rgb, B, H, ram);
  assert.equal(bra.behoverGranskning, false, `en ren mask flaggades: ${bra.anmarkningar.map((x) => x.kod)}`);
  assert.equal(bra.matt.fargdrift, 0);
  assert.equal(bra.matt.inreOrord, 1);

  const allt = new Float32Array(B * H).fill(1);
  const dom = bedom(allt, allt, rgb, rgb, B, H, ramFor(allt, B, H)!);
  assert.equal(dom.behoverGranskning, true, "en mask över hela bilden ska stoppas — det är rummet, inte möbeln");
  assert.ok(dom.anmarkningar.some((x) => x.kod === "for_stor" || x.kod === "beskuren"));
});

test("bedom stoppar en kedja som ändrat möbelns egna pixlar", () => {
  const rgb = bild();
  const andrad = Buffer.from(rgb);
  // En enda pixel mitt i möbeln — som en bortsuddad repa.
  const i = (150 * B + 100) * 3;
  andrad[i] = 255;

  const a = ramMask();
  const dom = bedom(a, a, rgb, andrad, B, H, ramFor(a, B, H)!);
  assert.equal(dom.behoverGranskning, true, "en ändrad möbelpixel släpptes igenom");
  assert.ok(dom.anmarkningar.some((x) => x.kod === "fargdrift"), "invarianten larmade inte");
});

test("harGodkantOmslag släpper inte igenom omslag utan mätt betyg", () => {
  // Den gamla kedjans urklipp: inget qualityScore, inget needsReview. 45 av butikens 66 live-varor
  // såg ut så, och en tidigare version av funktionen godkände dem alla på `undefined !== true` —
  // varpå butikens sämsta bilder blev omslag på varje kort.
  assert.equal(harGodkantOmslag({ sourceImageId: "a", label: null, provider: "u2net", createdAt: "" }), false);
  assert.equal(harGodkantOmslag(null), false);
  assert.equal(
    harGodkantOmslag({ sourceImageId: "a", label: null, provider: "birefnet-general", createdAt: "", qualityScore: 0.8, needsReview: false }),
    true,
  );
  assert.equal(
    harGodkantOmslag({ sourceImageId: "a", label: null, provider: "birefnet-general", createdAt: "", qualityScore: 0.2, needsReview: true }),
    false,
  );
});
