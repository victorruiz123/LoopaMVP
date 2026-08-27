// ─── Fixture suite: frozen inspection output -> dedup -> grade ───────────────
//
// Runs every fixture through the deterministic remainder of the pipeline and
// compares against its recorded snapshot. Zero Gemini calls, zero tokens.
//
// A fixture that documents a known-wrong behaviour carries BOTH `expected`
// (today) and `intended` (after the named fix). Which one is authoritative is
// decided by APPLIED_FIXES in fixes.ts, so landing a fix turns the suite green
// instead of red.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  loadFixtures,
  primaryModelFromSource,
  runFixture,
  type Fixture,
} from "./snapshot.js";
import { APPLIED_FIXES } from "./fixes.js";

const fixtures = loadFixtures();
const PRIMARY_MODEL = primaryModelFromSource();

function targetSnapshot(f: Fixture) {
  const pending = f.expectedToChangeIn;
  if (pending && APPLIED_FIXES.has(pending)) {
    assert.ok(f.intended, `${f.id}: expectedToChangeIn="${pending}" men intended saknas`);
    return f.intended!;
  }
  return f.expected;
}

test("fixtursviten är inte tom", () => {
  assert.ok(fixtures.length > 0, "inga fixturer hittades");
});

test("fixtur-id:n är unika", () => {
  const ids = fixtures.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "dubbletter bland fixtur-id");
});

for (const f of fixtures) {
  test(`fixtur ${f.id}: ${f.description}`, () => {
    const { deduped, grade } = runFixture(f.input);
    const snapshot = buildSnapshot(f.input, deduped, grade, { lockPartLocations: f.lockPartLocations });
    assert.deepStrictEqual(snapshot, targetSnapshot(f));
  });
}

// ── metadata-grindar ────────────────────────────────────────────────────────

for (const f of fixtures.filter((x) => x.source === "recorded")) {
  test(`fixtur ${f.id}: inspelad med primärmodellen`, () => {
    // Utan den här grinden går ett modellbyte inte att skilja från en
    // promptändring när fas 3 flyttar betygen.
    assert.equal(
      f.modelUsed,
      PRIMARY_MODEL,
      `spelades in med "${f.modelUsed}" i stället för "${PRIMARY_MODEL}" — fallback-modellen svarade, spela in på nytt`,
    );
  });

  test(`fixtur ${f.id}: har promptHash`, () => {
    assert.ok(f.promptHash, "inspelade fixturer måste bära promptHash, annars går prompt-generationer inte isär");
  });
}

for (const f of fixtures.filter((x) => x.source === "synthetic")) {
  test(`fixtur ${f.id}: syntetisk, utan modellmetadata`, () => {
    assert.equal(f.modelUsed, null);
    assert.equal(f.promptHash, null);
  });
}

// ── fixturer som ska ändras av en kommande fix måste faktiskt diskriminera ──

for (const f of fixtures.filter((x) => x.expectedToChangeIn)) {
  test(`fixtur ${f.id}: skiljer före/efter fix "${f.expectedToChangeIn}"`, () => {
    assert.ok(f.intended, "intended saknas");
    assert.notDeepStrictEqual(
      f.expected,
      f.intended,
      "expected och intended är identiska — fixturen mäter ingenting",
    );
  });
}

// ── stabilitet mellan flera körningar av samma möbel ────────────────────────

// Grouped by furniture AND promptHash: two runs of the same video under DIFFERENT prompts are not a
// stability question, they are a before/after comparison. Only same input + same prompt must agree.
const byFurniture = new Map<string, Fixture[]>();
for (const f of fixtures) {
  if (f.source !== "recorded" || !f.furniture) continue;
  const key = `${f.furniture}@${f.promptHash ?? "okänd"}`;
  byFurniture.set(key, [...(byFurniture.get(key) ?? []), f]);
}

for (const [furniture, runs] of byFurniture) {
  if (runs.length < 2) continue;
  test(`möbel ${furniture}: betyget är stabilt över ${runs.length} körningar`, () => {
    const grades = runs.map((r) => r.expected.grade);
    assert.equal(
      new Set(grades).size,
      1,
      `betyget varierar mellan körningar: ${runs.map((r) => `${r.id}=${r.expected.grade}`).join(", ")}`,
    );
  });
}
