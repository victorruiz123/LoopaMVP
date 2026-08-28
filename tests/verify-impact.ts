// MÄTNING: hur ofta ändrar verifieringssteget utfallet?
//
//   npx tsx tests/verify-impact.ts
//
// Noll Gemini-anrop. Verifieringen märker allt den gör, så en inspelad fixturs
// post-verifierade lista går att rulla tillbaka exakt:
//
//   - tillagda fynd    id `add_*` / "Hittad av andra besiktaren."  -> fanns inte före
//   - avslagna fynd    verification === "REJECTED"                 -> fanns, räknades inte
//   - ogranskade       "Kunde inte beskäras…"                      -> orörda av steget
//   - granskade        allt annat                                  -> stod kvar
//
// Utan-verify-listan är därför fixturens lista MINUS de tillagda, med resten satt
// till CONFIRMED — exakt vad run.ts publicerar som delresultat innan granskningen.
// Att mätningen inte rör nätet gör den oberoende av hur Gemini mår i dag.

import { describeCorpus, loadFixtures, runFixture } from "./snapshot.js";
import type { Damage } from "../server/src/types.js";

const ADDED_BY_VERIFY = "Hittad av andra besiktaren.";
const UNCROPPABLE = "Kunde inte beskäras";

const addedByVerify = (d: Damage) => d.verificationReason === ADDED_BY_VERIFY || d.id.startsWith("add_");

/** Listan som fanns INNAN granskningen: samma fynd, alla stående, inga tillägg. */
function preVerify(damages: Damage[]): Damage[] {
  return damages
    .filter((d) => !addedByVerify(d))
    .map((d): Damage => ({ ...d, verification: "CONFIRMED", verificationReason: "Granskningen pågår." }));
}

const rows: Array<Record<string, string | number>> = [];
let gradeChanged = 0;
let sameGradeDifferentList = 0;
let identical = 0;
let uncroppableRuns = 0;

for (const f of loadFixtures()) {
  const withVerify = runFixture(f.input);
  const without = runFixture({ ...f.input, damages: preVerify(f.input.damages) });

  const added = f.input.damages.filter(addedByVerify);
  const rejected = f.input.damages.filter((d) => d.verification === "REJECTED");
  const uncroppable = f.input.damages.filter((d) => (d.verificationReason ?? "").startsWith(UNCROPPABLE));
  if (uncroppable.length) uncroppableRuns++;

  const gradeDiff = withVerify.grade.grade !== without.grade.grade;
  const countDiff = withVerify.deduped.length !== without.deduped.length;
  if (gradeDiff) gradeChanged++;
  else if (countDiff || added.length || rejected.length) sameGradeDifferentList++;
  else identical++;

  rows.push({
    fixtur: f.id,
    källa: f.source,
    "betyg m": withVerify.grade.grade,
    "betyg u": without.grade.grade,
    "fynd m": withVerify.deduped.length,
    "fynd u": without.deduped.length,
    "verify la till": added.length,
    "verify avslog": rejected.length,
    ogranskade: uncroppable.length,
    utfall: gradeDiff ? "BETYG ÄNDRAT" : countDiff || added.length || rejected.length ? "samma betyg, annan lista" : "identiskt",
  });
}

const cols = Object.keys(rows[0]);
const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[cols[i]])).join("  ");
console.log(line(cols));
console.log(cols.map((c) => "-".repeat(width[c])).join("  "));
for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));

// Grupperna redovisas var för sig, och aldrig ihopslagna till en kvalitetssiffra.
//
// De syntetiska fixturernas verification-tillstånd är HANDSKRIVNA — de har aldrig varit genom ett
// riktigt verify-anrop. Att räkna dem som "verify ändrade ingenting" vore att låta ett antagande se
// ut som en mätning. Och flera körningar av samma möbel är flera datapunkter om EN möbel.
const fixtures = loadFixtures();
const recordedRows = rows.filter((r) => r.källa === "recorded");
const items = new Set(fixtures.filter((f) => f.source === "recorded").map((f) => f.distinct_item_id));
const recGradeChanged = recordedRows.filter((r) => r.utfall === "BETYG ÄNDRAT").length;
const recListChanged = recordedRows.filter((r) => r.utfall === "samma betyg, annan lista").length;

console.log(`\nUnderlag: ${describeCorpus(fixtures)}`);
console.log(`\nINSPELADE: ${recordedRows.length} körningar över ${items.size} distinkta möbler`);
console.log(`  BETYG ändrat av verify:            ${recGradeChanged}`);
console.log(`  samma betyg, annan fyndlista:      ${recListChanged}`);
console.log(`  helt oförändrat av verify:         ${recordedRows.length - recGradeChanged - recListChanged}`);
console.log(`  körningar med ogranskade fynd:     ${uncroppableRuns}`);
console.log(`  betygsspann i underlaget:          ${[...new Set(recordedRows.map((r) => r["betyg m"]))].sort().join(", ")}`);
const frameCounts = new Set(fixtures.filter((f) => f.source === "recorded").map((f) => f.frame_count));
if (frameCounts.size > 1) {
  console.log(`\n  ⚠ Underlaget blandar ${frameCounts.size} olika antal bildrutor` +
    ` (${[...frameCounts].map((c) => c ?? "okänt").join(", ")}). Siffrorna ovan är slagna över alla.` +
    `\n    Dela upp dem innan de används för att jämföra bildruteantal mot varandra.`);
}

const syntheticRows = rows.filter((r) => r.källa === "synthetic");
console.log(`\nSYNTETISKA: ${syntheticRows.length} fixturer — verification-tillstånden är handskrivna,`);
console.log(`  så de säger ingenting om vad ett riktigt verify-anrop gör. Räknas inte ovan.`);
console.log(`\nTOTALT ${rows.length} fixturer · betyg ändrat ${gradeChanged} · lista ändrad ${sameGradeDifferentList} · orört ${identical}`);

// Verifieringen sätter bara `verification` och `verificationReason` — den rör aldrig
// severity, impact, type eller part. Dess enda vägar till betyget är alltså att
// AVSLÅ ett fynd eller att LÄGGA TILL ett.
const severityTouched = loadFixtures().some((f) =>
  f.input.damages.some((d) => d.verification === "REJECTED" && d.severity === undefined),
);
console.log(`  verify ändrade severity någonstans: ${severityTouched ? "ja" : "nej (steget kan inte)"}`);
