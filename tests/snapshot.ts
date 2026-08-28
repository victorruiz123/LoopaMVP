// Shared fixture loading + snapshot building for the condition-grading suite.
//
// The suite freezes the pipeline at the INPUT to dedupeDamages — a fixture holds
// { coverage, damages, overallCondition } and the suite runs the deterministic
// remainder (dedupeDamages -> gradeCondition) over it. For a recorded fixture that
// list is the post-verification defect set (debug.json's verifiedDefects); for a
// synthetic one it is hand-authored with the verification states set directly. That means zero Gemini calls, zero tokens and no
// network on every run, whether the fixture was hand-written (synthetic) or
// recorded from real images.
//
// Nothing here imports gemini.ts, so the suite also runs with no npm
// dependencies installed at all: grade.ts and dedup.ts only import types.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { dedupeDamages } from "../server/src/pipeline/dedup.js";
import { gradeCondition } from "../server/src/pipeline/grade.js";
import type {
  CoverageState,
  Damage,
  GradeExplanation,
  OverallCondition,
} from "../server/src/types.js";

/** Locale-independent string compare — localeCompare would make snapshots machine-dependent. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FixtureInput {
  coverage: CoverageState;
  damages: Damage[];
  overallCondition: OverallCondition | null;
}

/** The asserted part of a fixture. Everything here must be stable across identical runs. */
export interface Snapshot {
  grade: string | null;
  canonicalCondition: string | null;
  damageCount: number;
  types: string[];
  severityHistogram: Record<string, number>;
  impactHistogram: Record<string, number>;
  verificationHistogram: Record<string, number>;
  coverage: CoverageState;
  wearLevel: string | null;
  affectedExtent: string | null;
  functionalityAffected: boolean | null;
  structuralIntegrityOk: boolean | null;
  dedupBefore: number;
  dedupAfter: number;
  /** Only present when the fixture sets lockPartLocations — see the dedup fixtures. */
  partLocations?: string[];
}

/** Recorded for drift reporting, never asserted: Swedish prose and model-assigned numbers churn. */
export interface Observed {
  label: string | null;
  rationale: string | null;
  meanConfidence: number | null;
  reasons: string[];
}

export interface Fixture {
  id: string;
  description: string;
  source: "synthetic" | "recorded";
  /** Physical object id — several recorded runs of the SAME furniture share it. Null for synthetic. */
  furniture: string | null;
  runIndex: number | null;
  /** Which model actually answered. Recorded fixtures must be the primary model, see fixtures.test.ts. */
  modelUsed: string | null;
  /** sha256 of SYSTEM_PROMPT + response schema at record time — tells prompt generations apart. */
  promptHash: string | null;
  recordedAt: string | null;
  lockPartLocations?: boolean;
  /** Name of a not-yet-applied fix in fixes.ts that will change this fixture's outcome. */
  expectedToChangeIn?: string | null;
  input: FixtureInput;
  /** What the code produces TODAY. */
  expected: Snapshot;
  /** What it should produce once expectedToChangeIn has landed. */
  intended?: Snapshot | null;
}

const DAMAGE_FIELDS = [
  "id", "type", "part", "semanticLocation", "severity", "impact", "description",
  "confidence", "verification", "verificationReason", "evidence",
  "recaptureRequested", "sellerAction", "sellerAdded",
] as const;

function validateFixture(f: Fixture, file: string): void {
  if (!f.id) throw new Error(`${file}: saknar id`);
  if (f.source !== "synthetic" && f.source !== "recorded") throw new Error(`${file}: ogiltig source`);
  for (const d of f.input.damages) {
    for (const field of DAMAGE_FIELDS) {
      if (!(field in d)) throw new Error(`${file}: skada ${d.id ?? "?"} saknar fältet "${field}"`);
    }
  }
}

export function loadFixtures(): Fixture[] {
  const dir = path.join(import.meta.dirname, "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort(cmp)
    .map((file) => {
      const f = JSON.parse(readFileSync(path.join(dir, file), "utf-8")) as Fixture;
      validateFixture(f, file);
      return f;
    });
}

/**
 * The primary model name, read as TEXT out of gemini.ts rather than imported — importing it would
 * pull in @google/genai and make the whole suite need node_modules.
 */
export function primaryModelFromSource(): string {
  const src = readFileSync(path.join(import.meta.dirname, "..", "server", "src", "gemini.ts"), "utf-8");
  const m = src.match(/export const GEMINI_MODEL = "([^"]+)"/);
  if (!m) throw new Error("Kunde inte läsa GEMINI_MODEL ur gemini.ts — har konstanten bytt form?");
  return m[1];
}

/** Sort by content, never by id: inspect.ts builds ids with Math.random(), so they differ per run. */
export function canonicalSortDamages(damages: Damage[]): Damage[] {
  return [...damages].sort(
    (a, b) =>
      cmp(a.type, b.type) ||
      cmp(a.part, b.part) ||
      cmp(a.semanticLocation, b.semanticLocation) ||
      cmp(a.severity, b.severity),
  );
}

function histogram(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort(cmp)) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function runFixture(input: FixtureInput): { deduped: Damage[]; grade: GradeExplanation } {
  const deduped = dedupeDamages(input.damages);
  return { deduped, grade: gradeCondition(deduped, input.overallCondition) };
}

export function buildSnapshot(
  input: FixtureInput,
  deduped: Damage[],
  grade: GradeExplanation,
  opts: { lockPartLocations?: boolean } = {},
): Snapshot {
  const sorted = canonicalSortDamages(deduped);
  const oc = input.overallCondition;
  const snapshot: Snapshot = {
    grade: grade.grade,
    canonicalCondition: grade.canonicalCondition,
    damageCount: sorted.length,
    types: sorted.map((d) => d.type),
    severityHistogram: histogram(sorted.map((d) => d.severity)),
    impactHistogram: histogram(sorted.map((d) => d.impact)),
    verificationHistogram: histogram(sorted.map((d) => d.verification)),
    coverage: input.coverage,
    wearLevel: oc ? oc.overallWearLevel : null,
    affectedExtent: oc ? oc.affectedExtent : null,
    functionalityAffected: oc ? oc.functionalityAffected : null,
    structuralIntegrityOk: oc ? oc.structuralIntegrityOk : null,
    dedupBefore: input.damages.length,
    dedupAfter: sorted.length,
  };
  if (opts.lockPartLocations) {
    snapshot.partLocations = sorted.map((d) => `${d.part}::${d.semanticLocation}`);
  }
  return snapshot;
}

export function buildObserved(deduped: Damage[], grade: GradeExplanation): Observed {
  return {
    label: grade.label,
    rationale: grade.rationale,
    meanConfidence: deduped.length
      ? Math.round(deduped.reduce((s, d) => s + d.confidence, 0) / deduped.length)
      : null,
    reasons: grade.reasons,
  };
}

/** En rad som beskriver underlaget. Delad, så regressen och verify-impact aldrig kan glida isär. */
export function describeCorpus(fixtures: Fixture[]): string {
  const rec = fixtures.filter((f) => f.source === "recorded");
  const items = new Set(rec.map((f) => f.distinct_item_id));
  const byCount = new Map<string, number>();
  for (const f of rec) {
    const key = f.frame_count === null ? "okänt antal" : `${f.frame_count} bildrutor`;
    byCount.set(key, (byCount.get(key) ?? 0) + 1);
  }
  const spread = [...byCount.entries()].sort().map(([k, n]) => `${n} med ${k}`).join(" · ");
  return (
    `${rec.length} inspelade körningar över ${items.size} distinkta möbler (${spread})` +
    ` · ${fixtures.length - rec.length} syntetiska (handskrivna, räknas aldrig som mätning)`
  );
}
