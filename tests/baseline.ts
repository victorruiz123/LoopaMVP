// Fills empty `expected` blocks from the CURRENT code and writes baseline.json.
//
//   npm run condition:baseline                  fyll tomma expected-block, skapa baseline.json om den saknas
//   npm run condition:baseline -- --check       jämför mot baseline.json, skriver ingenting
//   npm run condition:baseline -- --rebaseline  skriv om baseline.json till nuläget
//
// Refusing to overwrite by default is the point: an auto-filled snapshot blesses
// whatever the code does right now, so re-baselining has to be a deliberate act
// after a fix, never a side effect of running the script.
//
// A fixture's `expected` block is filled ONCE, when it is null, and is never
// rewritten by this script — not even with --rebaseline. It is the blessed
// before-value that an `intended` block is diffed against, so changing it has to
// be a deliberate hand edit (or a fresh recording that replaces the whole file).

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildObserved, buildSnapshot, runFixture, type Fixture, type Snapshot } from "./snapshot.js";

const rebaseline = process.argv.includes("--rebaseline");
const checkOnly = process.argv.includes("--check");
const dir = path.join(import.meta.dirname, "fixtures");
const baselinePath = path.join(import.meta.dirname, "baseline.json");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

interface Row {
  id: string;
  grade: string | null;
  canonical: string | null;
  damages: string;
  severities: string;
  coverage: string;
  wear: string | null;
  pending: string;
}

const rows: Row[] = [];
const baseline: { generatedAt: string; fixtures: { id: string; snapshot: Snapshot; observed: unknown }[] } = {
  generatedAt: new Date().toISOString(),
  fixtures: [],
};
let filled = 0;

for (const file of files) {
  const abs = path.join(dir, file);
  const f = JSON.parse(readFileSync(abs, "utf-8")) as Fixture;
  const { deduped, grade } = runFixture(f.input);
  const snapshot = buildSnapshot(f.input, deduped, grade, { lockPartLocations: f.lockPartLocations });
  const observed = buildObserved(deduped, grade);

  // Only ever FILLS an empty expected — never rewrites a blessed one.
  if (!checkOnly && f.expected === null) {
    f.expected = snapshot;
    writeFileSync(abs, `${JSON.stringify(f, null, 2)}\n`, "utf-8");
    filled += 1;
  }

  baseline.fixtures.push({ id: f.id, snapshot, observed });
  rows.push({
    id: f.id,
    grade: snapshot.grade,
    canonical: snapshot.canonicalCondition,
    damages: `${snapshot.dedupBefore}->${snapshot.dedupAfter}`,
    severities: Object.entries(snapshot.severityHistogram).map(([k, v]) => `${k}x${v}`).join(" ") || "-",
    coverage: snapshot.coverage,
    wear: snapshot.wearLevel,
    pending: f.expectedToChangeIn ?? "-",
  });
}

if (checkOnly) {
  const prev = JSON.parse(readFileSync(baselinePath, "utf-8")) as typeof baseline;
  const prevById = new Map(prev.fixtures.map((f) => [f.id, f.snapshot]));
  const fields: (keyof Snapshot)[] = [
    "grade", "canonicalCondition", "damageCount", "dedupAfter",
    "severityHistogram", "impactHistogram", "verificationHistogram", "types", "partLocations",
  ];
  let changed = 0;
  console.log(`Jämfört mot baseline.json från ${prev.generatedAt}\n`);
  for (const cur of baseline.fixtures) {
    const before = prevById.get(cur.id);
    if (!before) {
      console.log(`+ ${cur.id}: NY fixtur (fanns inte i baseline)`);
      changed += 1;
      continue;
    }
    const diffs = fields
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(cur.snapshot[k]))
      .map((k) => `    ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(cur.snapshot[k])}`);
    if (diffs.length === 0) continue;
    changed += 1;
    console.log(`~ ${cur.id}`);
    console.log(diffs.join("\n"));
  }
  console.log(
    changed === 0
      ? "\nInga skillnader mot baseline."
      : `\n${changed} av ${baseline.fixtures.length} fixturer ändrade.`,
  );
  process.exit(0);
}

const baselineExists = existsSync(baselinePath);
if (rebaseline || !baselineExists) {
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

const cols: [keyof Row, string][] = [
  ["id", "fixtur"], ["grade", "betyg"], ["canonical", "kanonisk"], ["damages", "skador"],
  ["severities", "severity"], ["wear", "slitage"], ["coverage", "täckning"], ["pending", "ändras i"],
];
const width = (k: keyof Row, label: string) => Math.max(label.length, ...rows.map((r) => String(r[k] ?? "").length));
const widths = cols.map(([k, label]) => width(k, label));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

console.log(line(cols.map(([, label]) => label)));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of rows) console.log(line(cols.map(([k]) => String(r[k] ?? ""))));
const baselineNote = rebaseline || !baselineExists ? "baseline.json skriven" : "baseline.json orörd (kör --rebaseline för att uppdatera)";
console.log(`\n${rows.length} fixturer · ${filled} expected-block ifyllda · ${baselineNote}`);
