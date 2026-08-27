// ─── verifyPayload.ts: crop numbering for the verification call ──────────────
//
// The regression these tests exist for: numbering used to come from a damage's
// position in the candidate list while the image list only grew on a successful
// crop. One failed crop shifted every following image by one, so each verdict
// after the failure landed on the WRONG damage — silently, since the response
// still parsed cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerifyPayload, type CropAttempt } from "../server/src/pipeline/verifyPayload.js";
import type { CapturedImage, Damage } from "../server/src/types.js";

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
  return { damage, cropRelPath: cropped ? `crops/${damage.id}.jpg` : null };
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
