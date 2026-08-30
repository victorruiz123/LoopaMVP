// ─── verifyPayload.ts: crop numbering for the verification call ──────────────
//
// The regression these tests exist for: numbering used to come from a damage's
// position in the candidate list while the image list only grew on a successful
// crop. One failed crop shifted every following image by one, so each verdict
// after the failure landed on the WRONG damage — silently, since the response
// still parsed cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerifyPayload, mergeReviewedDuplicates, type CropAttempt } from "../server/src/pipeline/verifyPayload.js";
import { markFromCrop } from "../server/src/imageUtils.js";
import type { CapturedImage, Damage, DamageType, VerificationState } from "../server/src/types.js";

const IMGS: CapturedImage[] = Array.from({ length: 7 }, (_, i) => ({
  id: `img_${i}`,
  viewLabel: null,
  source: "video",
  width: 720,
  height: 1280,
  path: `img_${i}.jpg`,
  capturedAt: "2026-08-26T00:00:00.000Z",
}));

let seq = 0;

function dmg(part: string): Damage {
  seq += 1;
  return {
    id: `v_${seq}`,
    type: "scratch",
    part,
    semanticLocation: "främre kanten",
    severity: "S2",
    impact: "cosmetic",
    description: `beskrivning ${part}`,
    confidence: 50,
    verification: "UNCERTAIN",
    verificationReason: "",
    evidence: [{ imageId: "img_0", mark: { kind: "box", x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }],
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
  };
}

function attempt(part: string, cropped: boolean): CropAttempt {
  const damage = dmg(part);
  return {
    damage,
    cropRelPath: cropped ? `crops/${damage.id}.jpg` : null,
    // Utsnittets läge i bilden. null här: numreringen bryr sig inte om var utsnittet togs — det gör
    // bara omräkningen av ett extra märke, som testas för sig i markFromCrop nedan.
    rect: null,
  };
}

test("alla utsnitt lyckas: numren är 1..n i ordning", () => {
  const { numbered, uncroppable } = buildVerifyPayload([
    attempt("sitsen", true),
    attempt("ryggstödet", true),
    attempt("vänster ben", true),
  ], IMGS);
  assert.deepEqual(numbered.map((n) => n.index), [1, 2, 3]);
  assert.deepEqual(numbered.map((n) => n.damage.part), ["sitsen", "ryggstödet", "vänster ben"]);
  assert.equal(uncroppable.length, 0);
});

test("BUGG 2a: en misslyckad beskärning mitt i listan förskjuter inte de följande", () => {
  const { numbered, uncroppable } = buildVerifyPayload([
    attempt("sitsen", true),
    attempt("ryggstödet", false), // beskärningen kastar
    attempt("vänster ben", true),
  ], IMGS);
  assert.deepEqual(numbered.map((n) => n.index), [1, 2]);
  // Utsnitt 2 MÅSTE vara vänster ben — förr blev det ryggstödets verdikt här.
  assert.equal(numbered[1].damage.part, "vänster ben");
  assert.deepEqual(uncroppable.map((d) => d.part), ["ryggstödet"]);
});

test("BUGG 2a: misslyckas det FÖRSTA utsnittet numreras resten ändå från 1", () => {
  const { numbered, uncroppable } = buildVerifyPayload([
    attempt("sitsen", false),
    attempt("ryggstödet", true),
    attempt("vänster ben", true),
  ], IMGS);
  assert.deepEqual(numbered.map((n) => n.index), [1, 2]);
  assert.deepEqual(numbered.map((n) => n.damage.part), ["ryggstödet", "vänster ben"]);
  assert.deepEqual(uncroppable.map((d) => d.part), ["sitsen"]);
});

test("crop_index k pekar alltid på numbered[k-1]", () => {
  const { numbered } = buildVerifyPayload([
    attempt("a", true), attempt("b", false), attempt("c", true), attempt("d", false), attempt("e", true),
  ], IMGS);
  for (const n of numbered) {
    assert.equal(numbered[n.index - 1].damage.id, n.damage.id);
  }
  assert.deepEqual(numbered.map((n) => n.damage.part), ["a", "c", "e"]);
});

test("etiketten bär sitt eget nummer, delen och vilken bild den kommer ur", () => {
  const { numbered } = buildVerifyPayload([attempt("sitsen", false), attempt("ryggstödet", true)], IMGS);
  assert.match(numbered[0].label, /^Utsnitt för Fynd 1:/);
  assert.match(numbered[0].label, /del="ryggstödet"/);
  assert.match(numbered[0].label, /förstorat ur Bild \d/);
});

test("alla beskärningar misslyckas: inget att skicka", () => {
  const { numbered, uncroppable } = buildVerifyPayload([attempt("a", false), attempt("b", false)], IMGS);
  assert.equal(numbered.length, 0);
  assert.equal(uncroppable.length, 2);
});

test("tom input ger tom payload", () => {
  const { numbered, uncroppable } = buildVerifyPayload([], IMGS);
  assert.equal(numbered.length, 0);
  assert.equal(uncroppable.length, 0);
});

test("varje skada hamnar i exakt en av listorna", () => {
  const attempts = [attempt("a", true), attempt("b", false), attempt("c", true)];
  const { numbered, uncroppable } = buildVerifyPayload(attempts, IMGS);
  const seen = [...numbered.map((n) => n.damage.id), ...uncroppable.map((d) => d.id)];
  assert.equal(seen.length, attempts.length);
  assert.equal(new Set(seen).size, attempts.length);
});

// ─── mergeReviewedDuplicates: granskningens egen dubblettjakt ────────────────
//
// Granskningen ser alla utsnitt i ETT anrop och är därför den enda i kedjan som
// kan jämföra hur skadorna faktiskt SER ut — ordmatchningen i dedup.ts jämför
// bara vad de kallas. Domen kommer med i ett anrop som ändå görs, så den kostar
// ingen extra tid.
//
// Två spärrar mot en felaktig hopslagning, eftersom modellen ser ett förstorat
// utsnitt utan sammanhang och två ben ser likadana ut i närbild: lägesord och
// skadefamilj måste hålla, och utsnitten måste komma ur olika bildrutor.

function rev(p: {
  type?: DamageType;
  part: string;
  loc?: string;
  imageId: string;
  verification?: VerificationState;
  reason?: string;
}): Damage {
  seq += 1;
  return {
    id: `r_${seq}`,
    type: p.type ?? "scuff",
    part: p.part,
    semanticLocation: p.loc ?? "kanten",
    severity: "S1",
    impact: "cosmetic",
    description: "",
    confidence: 80,
    verification: p.verification ?? "CONFIRMED",
    verificationReason: p.reason ?? "",
    evidence: [{ imageId: p.imageId, mark: { kind: "box", x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }],
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
  };
}

test("samma skada ur två bildrutor blir ett fynd med båda bevisen", () => {
  const out = mergeReviewedDuplicates(
    [rev({ part: "vänster framben", imageId: "img_0" }), rev({ part: "främre vänstra benet", imageId: "img_1" })],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2, "skadan ska kunna märkas ut i båda bildrutorna");
});

test("en kedja av dubbletter blir EN skada, inte två par", () => {
  const out = mergeReviewedDuplicates(
    [
      rev({ part: "ryggstöd", imageId: "img_0" }),
      rev({ part: "ryggstödet", imageId: "img_1" }),
      rev({ part: "ryggstöd", imageId: "img_2" }),
    ],
    new Map([[2, 1], [3, 2]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 3);
});

test("lägesord i konflikt väger tyngre än modellens dubblettdom", () => {
  // Två skav i närbild ser likadana ut. Vänster ben och höger ben är ändå två ben.
  const out = mergeReviewedDuplicates(
    [rev({ part: "vänster framben", imageId: "img_0" }), rev({ part: "höger framben", imageId: "img_1" })],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 2);
});

test("olika skadefamilj slås inte ihop på en dubblettdom", () => {
  const out = mergeReviewedDuplicates(
    [rev({ type: "stain", part: "sitsen", imageId: "img_0" }), rev({ type: "scratch", part: "sitsen", imageId: "img_1" })],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 2);
});

test("två utsnitt ur SAMMA bildruta är inte 'sedd ur flera håll'", () => {
  // Den dubbelrapporteringen hör hemma i dedup.ts IoU-pass, där koordinaterna
  // går att jämföra — här finns bara modellens ord på att de liknar varandra.
  const out = mergeReviewedDuplicates(
    [rev({ part: "sitsen", imageId: "img_0" }), rev({ part: "sitsen", imageId: "img_0" })],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 2);
});

test("ett underkänt utsnitt fäller inte en skada som godkänts i en annan bildruta", () => {
  const out = mergeReviewedDuplicates(
    [
      rev({ part: "ryggstöd", imageId: "img_0", verification: "REJECTED", reason: "suddigt utsnitt" }),
      rev({ part: "ryggstöd", imageId: "img_1", verification: "CONFIRMED", reason: "tydlig nötning" }),
    ],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].verification, "CONFIRMED");
  assert.equal(out[0].verificationReason, "tydlig nötning");
});

test("underkänns alla utsnitt faller skadan", () => {
  const out = mergeReviewedDuplicates(
    [
      rev({ part: "ryggstöd", imageId: "img_0", verification: "REJECTED", reason: "reflex" }),
      rev({ part: "ryggstöd", imageId: "img_1", verification: "REJECTED", reason: "skugga" }),
    ],
    new Map([[2, 1]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].verification, "REJECTED");
});

test("en dubblettpekare utanför listan ignoreras", () => {
  const input = [rev({ part: "sitsen", imageId: "img_0" }), rev({ part: "sitsen", imageId: "img_1" })];
  const out = mergeReviewedDuplicates(input, new Map([[2, 7], [9, 1]]));
  assert.equal(out.length, 2);
});

test("utan dubbletter lämnas listan orörd", () => {
  const input = [rev({ part: "sitsen", imageId: "img_0" }), rev({ part: "ryggstöd", imageId: "img_1" })];
  const out = mergeReviewedDuplicates(input, new Map());
  assert.deepEqual(out.map((d) => d.id), input.map((d) => d.id));
});

// ─── markFromCrop: en ruta i utsnittet uttryckt i bildens koordinater ────────
//
// Granskningen pekar ut extra märken i UTSNITTETS koordinater. Räknas de om fel
// hamnar markeringen någon annanstans på möbeln än skadan — ett fel som inte
// syns i något svar, bara på kortet.

test("markFromCrop: mitten av utsnittet är mitten av utsnittets yta i bilden", () => {
  const box = markFromCrop({ x0: 0.2, y0: 0.1, x1: 0.6, y1: 0.5 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.2 });
  assert.equal(Math.round(box.x * 1000) / 1000, 0.4);
  assert.equal(Math.round(box.y * 1000) / 1000, 0.3);
  assert.equal(Math.round(box.w * 1000) / 1000, 0.04);
  assert.equal(Math.round(box.h * 1000) / 1000, 0.08);
});

test("markFromCrop: ett utsnitt som täcker hela bilden lämnar rutan orörd", () => {
  const box = markFromCrop({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x: 0.25, y: 0.75, w: 0.1, h: 0.1 });
  assert.deepEqual(box, { x: 0.25, y: 0.75, w: 0.1, h: 0.1 });
});

test("markFromCrop: rutan hålls innanför bilden", () => {
  const box = markFromCrop({ x0: 0.9, y0: 0.9, x1: 1, y1: 1 }, { x: 1.4, y: 1.4, w: 0.5, h: 0.5 });
  assert.ok(box.x <= 1 && box.y <= 1, "ett läge utanför utsnittet får inte hamna utanför bilden");
});
