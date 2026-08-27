// Turns a completed localhost run into a RECORDED fixture.
//
//   npm run condition:record -- --latest --furniture stol-ek
//   npm run condition:record -- --job <uuid> --furniture fatolj-gron --run 2
//
// Then `npm run condition:baseline` fills the fixture's expected block, and
// `npm run condition:test` starts asserting it.
//
// The freeze point is the POST-verification, PRE-dedup defect list — exactly what
// dedupeDamages receives — so a replay exercises dedup and grade for real without
// ever calling Gemini again. That list is debug.json's verifiedDefects.
//
// Reads only JSON and source text: no sharp, no @google/genai, no API key.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}

const root = path.join(import.meta.dirname, "..");
const jobsDir = path.join(root, "server", "data", "jobs");
const fixturesDir = path.join(import.meta.dirname, "fixtures");

const furniture = flag("furniture");
if (!furniture) {
  console.error("Ange --furniture <namn>. Flera körningar av SAMMA möbel ska dela namn — stabilitetstestet grupperar på det.");
  process.exit(1);
}

function latestJobId(): string {
  if (!existsSync(jobsDir)) {
    console.error(`Hittar inga körningar i ${jobsDir}. Kör en analys i webbappen först.`);
    process.exit(1);
  }
  const entries = readdirSync(jobsDir)
    .map((id) => ({ id, mtime: statSync(path.join(jobsDir, id)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) {
    console.error("Jobbkatalogen är tom.");
    process.exit(1);
  }
  return entries[0].id;
}

const jobId = flag("job") ?? (args.includes("--latest") ? latestJobId() : null);
if (!jobId) {
  console.error("Ange --job <id> eller --latest.");
  process.exit(1);
}

const jobDir = path.join(jobsDir, jobId);
for (const file of ["job.json", "debug.json"]) {
  if (!existsSync(path.join(jobDir, file))) {
    console.error(`${file} saknas i ${jobDir} — är körningen klar?`);
    process.exit(1);
  }
}

const job = JSON.parse(readFileSync(path.join(jobDir, "job.json"), "utf-8"));
const trace = JSON.parse(readFileSync(path.join(jobDir, "debug.json"), "utf-8"));

if (!job.result) {
  console.error(`Jobbet ${jobId} har inget resultat (status: ${job.progress?.stage}, fel: ${job.error ?? "inget"}).`);
  process.exit(1);
}
if (!Array.isArray(trace.verifiedDefects)) {
  console.error("debug.json saknar verifiedDefects — körningen gjordes med en äldre version av run.ts. Kör analysen igen.");
  process.exit(1);
}

/**
 * Hash of the exact prompt generation that produced this result. Extracted from inspect.ts as TEXT so
 * this script stays dependency-free; a mismatch later means the fixture predates a prompt change.
 */
function promptHash(): string {
  // A run made under an older prompt must NOT be stamped with today's hash — that is exactly the
  // confusion the hash exists to prevent. --prompt-from <git-ref> reads inspect.ts as it stood then.
  // TODO(loopa-condition): stubbat från vips-buy-sell-hub — sökvägen pekade på modulens plats i det
  // repot (experiments/condition-grading/...) och kördes med cwd två nivåer upp. Här är modulen
  // repots rot, så sökvägen är relativ till den.
  const rel = "server/src/pipeline/inspect.ts";
  const ref = flag("prompt-from");
  const src = ref
    ? execFileSync("git", ["show", `${ref}:${rel}`], { cwd: root, encoding: "utf-8" })
    : readFileSync(path.join(root, "server", "src", "pipeline", "inspect.ts"), "utf-8");
  const region = (startMarker: string, endMarker: string): string => {
    const from = src.indexOf(startMarker);
    if (from < 0) throw new Error(`Hittade inte "${startMarker}" i inspect.ts — har konstanten bytt namn?`);
    const to = src.indexOf(endMarker, from + startMarker.length);
    if (to < 0) throw new Error(`Hittade inte slutet på "${startMarker}" i inspect.ts.`);
    return src.slice(from, to + endMarker.length);
  };
  const h = createHash("sha256");
  h.update(region("const TAXONOMY_BLOCK = `", "`;"));
  // Present only in the prompt generations that had a separate cues block; skipped when absent.
  if (src.includes("const SOFT_WEAR_CUES = `")) h.update(region("const SOFT_WEAR_CUES = `", "`;"));
  h.update(region("const SYSTEM_PROMPT = `", "`;"));
  h.update(region("const RESPONSE_SCHEMA = {", "\n};"));
  return h.digest("hex").slice(0, 16);
}

/** The model that actually answered. Any fallback must survive into the fixture so the suite can fail on it. */
function modelUsed(): string | null {
  const calls: { modelUsed: string }[] = trace.geminiCalls ?? [];
  if (calls.length === 0) return null;
  const models = [...new Set(calls.map((c) => c.modelUsed))];
  if (models.length === 1) return models[0];
  const primarySrc = readFileSync(path.join(root, "server", "src", "gemini.ts"), "utf-8");
  const primary = primarySrc.match(/export const GEMINI_MODEL = "([^"]+)"/)?.[1];
  return models.find((m) => m !== primary) ?? models[0];
}

const slug = furniture.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const existing = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.startsWith(`${slug}-run`))
  : [];
const runIndex = Number(flag("run") ?? existing.length + 1);
const id = `${slug}-run${runIndex}`;
const outPath = path.join(fixturesDir, `${id}.json`);

if (existsSync(outPath) && !args.includes("--force")) {
  console.error(`${id}.json finns redan. Ange --run <n> för en ny körning, eller --force för att skriva över.`);
  process.exit(1);
}

const fixture = {
  id,
  description: `Inspelad körning av ${furniture} (körning ${runIndex}), jobb ${jobId}.`,
  source: "recorded",
  furniture: slug,
  runIndex,
  modelUsed: modelUsed(),
  promptHash: promptHash(),
  recordedAt: job.result.createdAt ?? new Date().toISOString(),
  lockPartLocations: false,
  expectedToChangeIn: null,
  input: {
    coverage: job.result.coverage,
    damages: trace.verifiedDefects,
    overallCondition: job.result.overallCondition,
  },
  expected: null,
  intended: null,
};

writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");

const calls = trace.geminiCalls ?? [];
console.log(`Skrev ${path.relative(process.cwd(), outPath)}`);
console.log(`  möbel:      ${slug} (körning ${runIndex})`);
console.log(`  jobb:       ${jobId}`);
console.log(`  modell:     ${fixture.modelUsed}`);
console.log(`  promptHash: ${fixture.promptHash}`);
console.log(`  fynd:       ${trace.verifiedDefects.length} före dedup → ${trace.dedupAfter} efter`);
console.log(`  betyg:      ${job.result.grade?.grade ?? "-"} (${job.result.grade?.canonicalCondition ?? "-"})`);
console.log(`  anrop:      ${calls.length}, varav ${calls.filter((c: { cached: boolean }) => c.cached).length} från cache`);
console.log(`\nKör nu: npm run condition:baseline   (fyller expected-blocket)`);
