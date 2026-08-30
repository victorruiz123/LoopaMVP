// ─── Utsnittet som visar skadan i listan ─────────────────────────────────────
//
// Rutan är 72 pixlar bred och ska innehålla EN sak: skadan. Går uträkningen fel syns det inte som
// ett fel utan som ett foto — säljaren ser en bit soffa och tror att det är fyndet. Testerna nedan
// låser fast de tre sätt utsnittet kan bli fel på: skadan hamnar utanför sin egen ruta, rutan blir
// halvtom, eller fotot sträcks så att repan blir en annan repa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cropPlacement } from "../web/src/lib/damageCrop.js";
import type { EvidenceMark } from "../web/src/types.js";

/** Bildrutorna som faktiskt laddas upp: högst 1280 px bred, liggande eller stående. */
const LIGGANDE = { width: 1280, height: 960 };
const STAENDE = { width: 960, height: 1280 };

/**
 * Var i rutan ett normaliserat bildläge hamnar, i procent av rutan.
 *
 * Rutan är 0–100 i båda led. Ligger märkets kanter innanför det syns hela märket; sticker de utanför
 * är en del av skadan bortklippt.
 */
function inBox(
  place: ReturnType<typeof cropPlacement>,
  point: { x: number; y: number },
): { x: number; y: number } {
  return { x: place.leftPct + point.x * place.widthPct, y: place.topPct + point.y * place.heightPct };
}

const box = (x: number, y: number, w: number, h: number): EvidenceMark => ({ kind: "box", x, y, w, h });

/** Flyttalens eget slarv, inget annat. */
const EPS = 1e-9;

/** Utsnittet får aldrig lämna en tom kant: bilden ska täcka rutans alla fyra sidor. */
function assertCovers(place: ReturnType<typeof cropPlacement>, what: string): void {
  assert.ok(place.leftPct <= 0.001, `${what}: tom kant till vänster (${place.leftPct.toFixed(2)}%)`);
  assert.ok(place.topPct <= 0.001, `${what}: tom kant upptill (${place.topPct.toFixed(2)}%)`);
  assert.ok(place.leftPct + place.widthPct >= 99.999, `${what}: tom kant till höger`);
  assert.ok(place.topPct + place.heightPct >= 99.999, `${what}: tom kant nedtill`);
}

test("skadan hamnar mitt i rutan, och hela skadan syns", () => {
  const mark = box(0.4, 0.4, 0.1, 0.1);
  const place = cropPlacement(mark, LIGGANDE);

  const mitt = inBox(place, { x: 0.45, y: 0.45 });
  assert.ok(Math.abs(mitt.x - 50) < 0.001, `märkets mitt ska ligga i rutans mitt, låg på ${mitt.x}`);
  assert.ok(Math.abs(mitt.y - 50) < 0.001, `märkets mitt ska ligga i rutans mitt, låg på ${mitt.y}`);

  // Och marginalen runt om ska synas — annars är utsnittet så snävt att skadan saknar sammanhang.
  const hörn = inBox(place, { x: 0.4, y: 0.4 });
  assert.ok(hörn.x > 0 && hörn.x < 50, "märkets vänsterkant ska ligga innanför rutan");
  assert.ok(hörn.y > 0 && hörn.y < 50, "märkets överkant ska ligga innanför rutan");
  assertCovers(place, "mitt i bilden");
});

/**
 * Ett stående foto och ett liggande ger olika utsnitt av samma märke — det är hela poängen med att
 * räkna med bildens proportion. Det som INTE får skilja sig är att båda fyller rutan.
 */
test("både liggande och stående foto fyller rutan helt", () => {
  for (const [namn, bild] of [
    ["liggande", LIGGANDE],
    ["stående", STAENDE],
  ] as const) {
    const place = cropPlacement(box(0.3, 0.55, 0.2, 0.08), bild);
    assertCovers(place, namn);
    // Proportionen är bildens egen, aldrig rutans: sträcks fotot blir en repa en annan repa.
    assert.ok(
      Math.abs(place.widthPct / place.heightPct - bild.width / bild.height) < 1e-9,
      `${namn}: bilden får inte sträckas`,
    );
  }
});

/**
 * Ett fynd i hörnet.
 *
 * Marginalen runt märket sticker då utanför bilden. Utsnittet skjuts in i stället för att klippas —
 * annars hade hörnfyndet ritats mer förstorat än ett mitt i bilden, och rutan fått en tom kant där
 * bilden tog slut.
 */
test("ett fynd i bildens hörn ramas fortfarande in", () => {
  for (const mark of [box(0, 0, 0.06, 0.06), box(0.94, 0.94, 0.06, 0.06)]) {
    const place = cropPlacement(mark, LIGGANDE);
    assertCovers(place, "hörnfynd");
    const start = inBox(place, { x: mark.x, y: mark.y });
    const slut = inBox(place, { x: mark.x + (mark.w ?? 0), y: mark.y + (mark.h ?? 0) });
    // Marginalen krymper till noll i hörnet — märket ligger då an mot rutans kant, och det är en
    // exakt likhet som flyttalen bara nästan träffar. Toleransen är räknefel, inte synlig plats.
    assert.ok(start.x >= -EPS && start.y >= -EPS, "märkets början ska synas i rutan");
    assert.ok(slut.x <= 100 + EPS && slut.y <= 100 + EPS, "märkets slut ska synas i rutan");
  }
});

/**
 * Ett lodrätt streck är noll pixlar brett.
 *
 * Utan ett golv på utsnittets bredd blir förstoringen en division med noll, och rutan svart. Den
 * sortens märke kommer från repor och sprickor — alltså de fynd bilden behövs mest för.
 */
test("ett streck utan bredd ger ett utsnitt, inte en svart ruta", () => {
  const lodrätt: EvidenceMark = { kind: "line", x: 0.5, y: 0.3, x2: 0.5, y2: 0.7 };
  const place = cropPlacement(lodrätt, LIGGANDE);

  for (const [namn, tal] of Object.entries(place)) {
    assert.ok(Number.isFinite(tal), `${namn} ska vara ett tal, var ${tal}`);
  }
  assertCovers(place, "lodrätt streck");
  const mitt = inBox(place, { x: 0.5, y: 0.5 });
  assert.ok(Math.abs(mitt.x - 50) < 0.001, "strecket ska stå mitt i rutan");
  assert.ok(Math.abs(mitt.y - 50) < 0.001, "strecket ska stå mitt i rutan");
});
