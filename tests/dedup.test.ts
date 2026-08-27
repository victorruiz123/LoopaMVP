// ─── dedup.ts: the local safety net after the main inspection call ───────────
//
// Pass 1 merges same-image, same-type findings whose boxes overlap (IoU).
// Pass 2 merges same-type findings that share a part label, across images.
//
// The pass-2 tests are the discriminating pair for fix 2b: identical
// semanticLocation MUST keep merging, different semanticLocation must NOT.
// Today only the first holds; the second is gated on APPLIED_FIXES.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeDamages } from "../server/src/pipeline/dedup.js";
import type { Damage, DamageEvidence } from "../server/src/types.js";
import { APPLIED_FIXES } from "./fixes.js";

let seq = 0;

function box(imageId: string, x: number, y: number, w = 0.2, h = 0.2): DamageEvidence {
  return { imageId, mark: { kind: "box", x, y, w, h } };
}

function dmg(p: Partial<Damage> = {}): Damage {
  seq += 1;
  return {
    id: `d_${seq}`,
    type: p.type ?? "scratch",
    part: p.part ?? "sitsens ovansida",
    semanticLocation: p.semanticLocation ?? "främre kanten",
    severity: p.severity ?? "S1",
    impact: p.impact ?? "cosmetic",
    description: p.description ?? "",
    confidence: p.confidence ?? 80,
    verification: p.verification ?? "CONFIRMED",
    verificationReason: "",
    evidence: p.evidence ?? [box("img_0", 0.1, 0.1)],
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
  };
}

// ── pass 1: IoU inom samma bild ─────────────────────────────────────────────

test("pass 1: överlappande boxar, samma bild och typ, slås ihop", () => {
  // Olika part gör att pass 2 inte kan ta åt sig äran.
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.15, 0.15)] }),
  ]);
  assert.equal(out.length, 1);
});

test("pass 1: boxar utan överlapp slås inte ihop", () => {
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.0, 0.0, 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.8, 0.8, 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

test("pass 1: boxar jämförs aldrig över bildgränser", () => {
  // Identiska koordinater men olika bilder — inget gemensamt koordinatsystem.
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

// ── pass 2: typ + del ───────────────────────────────────────────────────────

test("pass 2: samma typ, del OCH plats i tre olika bilder slås ihop till en", () => {
  // Modellen missade att konsolidera samma fysiska repa sedd från tre håll.
  const out = dedupeDamages([
    dmg({ evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ evidence: [box("img_1", 0.4, 0.2)] }),
    dmg({ evidence: [box("img_2", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 3, "alla tre bevisen ska följa med");
});

test("pass 2: olika typ på samma del slås aldrig ihop", () => {
  const out = dedupeDamages([
    dmg({ type: "scratch", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ type: "stain", evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

test("pass 2 [BUGG 2b]: samma del men olika semanticLocation", () => {
  // Systemprompten säger uttryckligen att två skador på samma del men olika
  // ställen är SKILDA defekter. Nyckeln är type+part och ignorerar platsen,
  // så idag slås de ihop ändå.
  const out = dedupeDamages([
    dmg({ semanticLocation: "främre vänstra kanten", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ semanticLocation: "bakre högra hörnet", evidence: [box("img_1", 0.7, 0.7)] }),
    dmg({ semanticLocation: "mitten", evidence: [box("img_2", 0.4, 0.4)] }),
  ]);
  const expected = APPLIED_FIXES.has("2b") ? 3 : 1;
  assert.equal(out.length, expected);
});

// ── mergeGroup ──────────────────────────────────────────────────────────────

test("merge: den allvarligaste skadan blir primär", () => {
  const out = dedupeDamages([
    dmg({ severity: "S1", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ severity: "S3", evidence: [box("img_1", 0.1, 0.1)] }),
    dmg({ severity: "S2", evidence: [box("img_2", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "S3");
});

test("merge: confidence blir gruppens medelvärde", () => {
  const out = dedupeDamages([
    dmg({ confidence: 80, evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ confidence: 60, evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out[0].confidence, 70);
});

test("merge: identiska bevis i samma bild dubbleras inte", () => {
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 1);
});

test("dedup lämnar en ensam skada orörd", () => {
  const one = dmg();
  const out = dedupeDamages([one]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, one.id);
});

test("dedup klarar tom input", () => {
  assert.deepEqual(dedupeDamages([]), []);
});
