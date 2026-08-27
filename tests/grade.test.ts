// ─── grade.ts: the deterministic A-F rubric ──────────────────────────────────
//
// gradeCondition is pure and API-free, so it is tested exhaustively with
// synthetic inputs: every branch of gradeFromDefects and
// gradeFromOverallCondition, the max() combination of the two tracks, the >=3
// count thresholds, the two OverallCondition booleans, and CANONICAL_MAP.
//
// Each test pins the track it is NOT exercising to its neutral value (wear
// "minimal" -> A, or zero damages -> A) so a failure names one branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCondition } from "../server/src/pipeline/grade.js";
import type { ConditionGrade, Damage, OverallCondition, Severity } from "../server/src/types.js";

let seq = 0;

function dmg(p: Partial<Damage> = {}): Damage {
  seq += 1;
  return {
    id: `t_${seq}`,
    type: p.type ?? "scratch",
    part: p.part ?? `del_${seq}`,
    semanticLocation: p.semanticLocation ?? `plats_${seq}`,
    severity: p.severity ?? "S1",
    impact: p.impact ?? "cosmetic",
    description: p.description ?? "",
    confidence: p.confidence ?? 90,
    verification: p.verification ?? "CONFIRMED",
    verificationReason: "",
    evidence: p.evidence ?? [],
    recaptureRequested: false,
    sellerAction: p.sellerAction ?? null,
    sellerAdded: false,
  };
}

function oc(p: Partial<OverallCondition> = {}): OverallCondition {
  return {
    overallWearLevel: p.overallWearLevel ?? "minimal",
    affectedExtent: p.affectedExtent ?? "isolated",
    functionalityAffected: p.functionalityAffected ?? false,
    structuralIntegrityOk: p.structuralIntegrityOk ?? true,
    clearlyUsedAppearance: p.clearlyUsedAppearance ?? false,
    observations: [],
  };
}

/** Wear pinned to minimal (-> A) so the defect track alone decides. */
function fromDefects(damages: Damage[]): ConditionGrade {
  return gradeCondition(damages, oc()).grade;
}

/** No damages (-> A) so the holistic track alone decides. */
function fromWear(p: Partial<OverallCondition>): ConditionGrade {
  return gradeCondition([], oc(p)).grade;
}

function nOf(count: number, severity: Severity): Damage[] {
  return Array.from({ length: count }, () => dmg({ severity }));
}

// ── defect track ────────────────────────────────────────────────────────────

test("defekter: inga bekräftade skador ger A", () => {
  assert.equal(fromDefects([]), "A");
});

test("defekter: endast REJECTED räknas inte och ger A", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", verification: "REJECTED" })]), "A");
});

test("defekter: UNCERTAIN räknas inte heller", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", verification: "UNCERTAIN" })]), "A");
});

test("defekter: 1x S1 kosmetisk ger B", () => {
  assert.equal(fromDefects(nOf(1, "S1")), "B");
});

test("defekter: 2x S1 ligger kvar på B (under C-tröskeln)", () => {
  assert.equal(fromDefects(nOf(2, "S1")), "B");
});

test("defekter: 3x S1 tippar över cMultiCountThreshold och ger C", () => {
  assert.equal(fromDefects(nOf(3, "S1")), "C");
});

test("defekter: 1x S2 ger C via cMinSeverity", () => {
  assert.equal(fromDefects(nOf(1, "S2")), "C");
});

test("defekter: 2x S2 ligger kvar på C (under D-tröskeln)", () => {
  assert.equal(fromDefects(nOf(2, "S2")), "C");
});

test("defekter: 3x S2 tippar över dMultiCountThreshold och ger D", () => {
  assert.equal(fromDefects(nOf(3, "S2")), "D");
});

test("defekter: 1x S3 ger D via dMinSeverity", () => {
  assert.equal(fromDefects(nOf(1, "S3")), "D");
});

test("defekter: 1x S4 kosmetisk ger E (inte F — F kräver funktion/struktur)", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", impact: "cosmetic" })]), "E");
});

test("defekter: S4 + functional ger F", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", impact: "functional" })]), "F");
});

test("defekter: S4 + structural ger F", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", impact: "structural" })]), "F");
});

test("defekter: KLIPPAN — en enda S1 märkt structural golvar möbeln till E", () => {
  assert.equal(fromDefects([dmg({ severity: "S1", impact: "structural" })]), "E");
});

test("defekter: S1 märkt functional är däremot inert och ger B", () => {
  // hasFunctional förekommer bara i F-grenen (som kräver S4) och som reason-text i D.
  assert.equal(fromDefects([dmg({ severity: "S1", impact: "functional" })]), "B");
});

test("defekter: S2 märkt functional ger C, inte D", () => {
  assert.equal(fromDefects([dmg({ severity: "S2", impact: "functional" })]), "C");
});

// ── holistiska spåret ───────────────────────────────────────────────────────

test("slitage: wearToGrade mappar alla fem nivåerna", () => {
  assert.equal(fromWear({ overallWearLevel: "minimal" }), "A");
  assert.equal(fromWear({ overallWearLevel: "light" }), "B");
  assert.equal(fromWear({ overallWearLevel: "moderate" }), "C");
  assert.equal(fromWear({ overallWearLevel: "heavy" }), "D");
  assert.equal(fromWear({ overallWearLevel: "severe" }), "E");
});

test("slitage: functionalityAffected lyfter minimal till D", () => {
  assert.equal(fromWear({ overallWearLevel: "minimal", functionalityAffected: true }), "D");
});

test("slitage: functionalityAffected sänker aldrig ett redan sämre betyg", () => {
  assert.equal(fromWear({ overallWearLevel: "severe", functionalityAffected: true }), "E");
});

test("slitage: !structuralIntegrityOk lyfter minimal till E", () => {
  assert.equal(fromWear({ overallWearLevel: "minimal", structuralIntegrityOk: false }), "E");
});

test("slitage: båda booleanerna tillsammans landar på E", () => {
  assert.equal(
    fromWear({ overallWearLevel: "minimal", functionalityAffected: true, structuralIntegrityOk: false }),
    "E",
  );
});

test("slitage: saknad overallCondition behandlas som A", () => {
  assert.equal(gradeCondition([], null).grade, "A");
});

// ── max() mellan spåren ─────────────────────────────────────────────────────

test("max: slitaget dominerar när det är sämre än defekterna", () => {
  const r = gradeCondition(nOf(1, "S2"), oc({ overallWearLevel: "heavy" })); // C vs D
  assert.equal(r.grade, "D");
});

test("max: defekterna dominerar när de är sämre än slitaget", () => {
  const r = gradeCondition([dmg({ severity: "S4" })], oc({ overallWearLevel: "minimal" })); // E vs A
  assert.equal(r.grade, "E");
});

test("max: lika spår ger det gemensamma betyget", () => {
  const r = gradeCondition(nOf(1, "S2"), oc({ overallWearLevel: "moderate" })); // C vs C
  assert.equal(r.grade, "C");
});

test("max: ett rent helhetsintryck kan ALDRIG förbättra ett defektbetyg", () => {
  const r = gradeCondition(nOf(3, "S2"), oc({ overallWearLevel: "minimal" })); // D vs A
  assert.equal(r.grade, "D");
});

test("max: inga defekter men kraftigt slitage ger ändå D", () => {
  assert.equal(gradeCondition([], oc({ overallWearLevel: "heavy" })).grade, "D");
});

// ── CANONICAL_MAP ───────────────────────────────────────────────────────────

test("canonicalCondition: alla sex betygen mappar till de fyra publika strängarna", () => {
  const cases: [Damage[], ConditionGrade, string][] = [
    [[], "A", "Nyskick"],
    [nOf(1, "S1"), "B", "Mycket bra skick"],
    [nOf(1, "S2"), "C", "Bra skick"],
    [nOf(1, "S3"), "D", "Okej skick"],
    [[dmg({ severity: "S4", impact: "cosmetic" })], "E", "Okej skick"],
    [[dmg({ severity: "S4", impact: "functional" })], "F", "Okej skick"],
  ];
  for (const [damages, expectedGrade, expectedCanonical] of cases) {
    const r = gradeCondition(damages, oc());
    assert.equal(r.grade, expectedGrade);
    assert.equal(r.canonicalCondition, expectedCanonical, `fel kanonisk sträng för ${expectedGrade}`);
  }
});

test("canonicalCondition: E och F golvas båda till Okej skick, inte till något sämre", () => {
  const e = gradeCondition([dmg({ severity: "S4", impact: "cosmetic" })], oc());
  const f = gradeCondition([dmg({ severity: "S4", impact: "structural" })], oc());
  assert.equal(e.canonicalCondition, "Okej skick");
  assert.equal(f.canonicalCondition, "Okej skick");
  assert.notEqual(e.grade, f.grade);
});

// ── effectiveVerification: säljarens åtgärd vinner över modellens ───────────

test("sellerAction 'rejected' plockar bort en bekräftad S4 och ger A", () => {
  assert.equal(fromDefects([dmg({ severity: "S4", verification: "CONFIRMED", sellerAction: "rejected" })]), "A");
});

test("sellerAction 'confirmed' räknar in en osäker S3 och ger D", () => {
  assert.equal(fromDefects([dmg({ severity: "S3", verification: "UNCERTAIN", sellerAction: "confirmed" })]), "D");
});

test("sellerAction 'corrected' räknas också som bekräftad", () => {
  assert.equal(fromDefects([dmg({ severity: "S3", verification: "UNCERTAIN", sellerAction: "corrected" })]), "D");
});

// ── rationale/label finns men asserteras inte på ordalydelse ────────────────

test("varje betyg får en icke-tom label och rationale", () => {
  for (const damages of [[], nOf(1, "S1"), nOf(3, "S2"), [dmg({ severity: "S4", impact: "structural" })]]) {
    const r = gradeCondition(damages, oc({ overallWearLevel: "moderate" }));
    assert.ok(r.label.length > 0, "label saknas");
    assert.ok(r.rationale.length > 0, "rationale saknas");
    assert.ok(r.reasons.length > 0, "reasons saknas");
  }
});

// ── skyddsräcke: bara en BEDÖMNING får ta bort ett fynd ur betyget ──────────
//
// Regressionsvakt för en katastrofal interaktion: när varje fynd började gå
// till granskning gjorde ett misslyckat granskningsanrop — en 503, en timeout
// — att alla fynd markerades UNCERTAIN. gradeCondition räknar bara CONFIRMED,
// så hela skadelistan tömdes och möbeln fick betyg A. Ett tekniskt haveri får
// aldrig se ut som en felfri möbel.

test("UNCERTAIN håller fynd utanför betyget — därför får inget tekniskt fel sätta det", () => {
  const found = [dmg({ severity: "S3" }), dmg({ severity: "S2" })];
  assert.equal(fromDefects(found), "D", "bekräftade fynd ska ge D");

  const asUncertain = found.map((d) => ({ ...d, verification: "UNCERTAIN" as const }));
  assert.equal(fromDefects(asUncertain), "A", "UNCERTAIN nollar betyget — det är därför inget tekniskt fel får sätta det");

  const asConfirmed = found.map((d) => ({ ...d, verification: "CONFIRMED" as const }));
  assert.equal(fromDefects(asConfirmed), "D", "en ogranskad skada som behåller sin status påverkar betyget som vanligt");
});

test("ett avfärdat fynd tas bort ur betyget — det är den ENDA vägen dit", () => {
  const found = [dmg({ severity: "S3", verification: "REJECTED" })];
  assert.equal(fromDefects(found), "A");
});
