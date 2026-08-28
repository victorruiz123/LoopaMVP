// Ett kommando från film till fixtur i baslinjen.
//
//   npm run fixture:add -- --latest --label soffa-bla
//   npm run fixture:add -- --job <uuid> --label stol-ek
//   npm run fixture:add -- video.mp4 --label byra-furu --brand IKEA --model Malm
//
// Gör tre saker som förut var tre kommandon och en handpåläggning:
//   1. skaffar en färdig körning (ur ett jobb, eller genom att köra filmen)
//   2. spelar in den som fixtur med distinct_item_id satt
//   3. fyller expected-blocket och skriver in den i baseline.json
//
// Om filmens väg: bildruteuttaget lever i webbläsaren (HTMLVideoElement finns inte i Node), så
// videoläget behöver Playwright. Saknas det säger skriptet exakt vad man ska göra i stället — det
// vanliga fallet på en inspelningsdag är ändå att filmen precis körts i appen, och då räcker --latest.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compare, invalidity, jobState, noiseLine, waitForJob, type RunResult } from "./compareFrames.js";

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const positional = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));

const label = flag("label");
if (!label) {
  console.error("Ange --label <namn>. Namnet är möbelns identitet — flera körningar av SAMMA möbel");
  console.error("ska dela label, annars räknas de som oberoende fall i statistiken.");
  process.exit(1);
}

const root = path.join(import.meta.dirname, "..");
const run = (script: string, extra: string[]) =>
  execFileSync("npx", ["tsx", path.join(import.meta.dirname, script), ...extra], { cwd: root, stdio: "inherit" });
const capture = (script: string, extra: string[]) =>
  execFileSync("npx", ["tsx", path.join(import.meta.dirname, script), ...extra], { cwd: root, encoding: "utf-8" });

const video = positional.find((p) => /\.(mp4|mov|webm|m4v)$/i.test(p));

async function jobFromVideo(file: string, buckets?: number): Promise<string> {
  if (!existsSync(file)) {
    console.error(`Hittar inte ${file}`);
    process.exit(1);
  }
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Videoläget behöver Playwright, som inte är installerat här.\n");
    console.error("  npm i -D playwright && npx playwright install chromium\n");
    console.error("Eller kör filmen i appen (https://localhost:5190) och använd:");
    console.error(`  npm run fixture:add -- --latest --label ${label}`);
    process.exit(1);
  }
  const brand = flag("brand");
  const model = flag("model");
  if (!model) {
    console.error("Videoläget behöver --model (och gärna --brand) — det är vad prismotorn söker på.");
    process.exit(1);
  }
  console.log(`Kör ${path.basename(file)} genom appen…`);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 } })).newPage();
  page.on("console", (m) => m.text().includes("[videoFrames]") && console.log("  " + m.text()));
  await page.goto(`https://localhost:5190/${buckets ? `?buckets=${buckets}` : ""}`, { waitUntil: "networkidle" });
  await page.locator(".form-row-tappable").click();
  await page.waitForTimeout(400);
  await page.getByPlaceholder("Sök märke").fill(brand ?? "");
  await page.waitForTimeout(300);
  if (brand) {
    const hit = page.getByRole("button", { name: new RegExp(`^${brand}$`, "i") }).first();
    if (await hit.count()) await hit.click();
    else await page.locator(".brand-use-typed").click();
    await page.waitForTimeout(400);
  } else {
    await page.locator(".sheet-close").click();
  }
  await page.locator("#model-input").fill(model);
  await page.getByRole("button", { name: "Fortsätt till filmning" }).click();
  await page.waitForTimeout(300);
  await page.locator('input[type=file][accept="video/*"]').setInputFiles(file);
  await page.waitForSelector(".price-big-card", { timeout: 180_000 });
  const jobId = await page.evaluate(async () => {
    const res = await fetch("/api/jobs");
    const jobs = await res.json();
    return jobs[0]?.id as string;
  });
  await browser.close();
  console.log(`  jobb ${jobId}`);
  return jobId;
}

/**
 * Senaste körningen som faktiskt BLEV KLAR.
 *
 * `record.ts --latest` tar det nyaste jobbet oavsett utfall, och på en inspelningsdag är det ofta ett
 * som föll — man filmar om just för att det gick fel. Ett jobb utan debug.json har ingen
 * post-verifierad fyndlista att frysa, så det kan aldrig bli en fixtur.
 */
function latestCompletedJob(): string {
  const jobsDir = path.join(root, "server", "data", "jobs");
  const entries = readdirSync(jobsDir)
    .filter((id) => existsSync(path.join(jobsDir, id, "debug.json")))
    .map((id) => ({ id, mtime: statSync(path.join(jobsDir, id, "debug.json")).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) {
    console.error("Hittar ingen färdig körning. Kör en analys i appen först.");
    process.exit(1);
  }
  return entries[0].id;
}

// ---- L: A/B-läge --------------------------------------------------------------
const compareFrames = flag("compare-frames");
if (compareFrames) {
  if (!video) {
    console.error("--compare-frames kräver en film — poängen är att köra SAMMA film två gånger.");
    process.exit(1);
  }
  const variants = compareFrames.split(",").map((n) => Number.parseInt(n.trim(), 10)).filter(Number.isFinite);
  if (variants.length !== 2) {
    console.error("Ange exakt två antal, t.ex. --compare-frames 6,8");
    process.exit(1);
  }

  /** Kör tills anropen faktiskt går igenom. Ett fallet anrop är inte en datapunkt. */
  async function runVariant(buckets: number, attempt = 1): Promise<RunResult> {
    const startedAt = Date.now();
    const jobId = await jobFromVideo(video!, buckets);
    const result = await waitForJob(jobId);
    const state = await jobState(jobId);
    const bad = invalidity(state);
    if (bad) {
      console.log(`  ${buckets} vyer, försök ${attempt}: OGILTIG — ${bad}`);
      if (attempt >= 3) return { buckets, jobId, frameCount: 0, ms: 0, valid: false, invalidReason: bad, result: null };
      return runVariant(buckets, attempt + 1);
    }
    const frameCount = (state.images ?? state.result?.images ?? []).length;
    console.log(`  ${buckets} vyer: klar, ${frameCount} bildrutor, ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
    return { buckets, jobId, frameCount, ms: Date.now() - startedAt, valid: true, invalidReason: null, result };
  }

  console.log(`\nA/B: ${path.basename(video)} med ${variants.join(" och ")} vyer, i samma sittning.\n`);
  const a = await runVariant(variants[0]);
  const b = await runVariant(variants[1]);
  console.log("  — extra körning för brusnivån —");
  const aAgain = await runVariant(variants[0]);

  console.log("\n=== RESULTAT ===");
  if (!a.valid || !b.valid) {
    console.error(`  Ogiltig jämförelse: ${[a, b].filter((r) => !r.valid).map((r) => `${r.buckets} vyer (${r.invalidReason})`).join(", ")}`);
    console.error("  Kör om när Gemini svarar. Jämför aldrig mot ett fallet anrop.");
    process.exit(1);
  }
  console.log(compare(a, b).join("\n"));
  if (aAgain.valid) console.log(noiseLine(a, aAgain));
  else console.log("  brusnivån kunde inte mätas — den tredje körningen föll.");
  console.log("\n  Skillnader mindre än brusraden är ingen skillnad. Ingen slutsats dras här.");

  for (const r of [a, b]) {
    run("record.ts", ["--job", r.jobId, "--furniture", label]);
    stampFreshFixture(label, r.frameCount);
  }
  console.log(`\nBåda körningarna sparade som fixturer med label ${label}.`);
  run("baseline.ts", []);
  run("baseline.ts", ["--rebaseline"]);
  process.exit(0);
}

/**
 * Sätter distinct_item_id och frame_count på den nyss inspelade fixturen.
 *
 * frame_count fylls från körningen, inte gissas: regressen fryser efter bildruteurvalet och är grön
 * även när fixturen beskriver ett annat antal vyer än appen kör. Står antalet inte i datan syns den
 * skillnaden ingenstans.
 */
function stampFreshFixture(item: string, frameCount: number | null): string {
  const fixturesDir = path.join(import.meta.dirname, "fixtures");
  const fresh = execFileSync("ls", ["-t", fixturesDir]).toString().split("\n")[0];
  const freshPath = path.join(fixturesDir, fresh);
  const fixture = JSON.parse(readFileSync(freshPath, "utf-8"));
  fixture.distinct_item_id ??= fixture.furniture ?? item;
  fixture.frame_count = frameCount;
  fixture.frame_count_source = frameCount === null ? "unknown" : "verified";
  writeFileSync(freshPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
  console.log(`  ${fresh}: distinct_item_id=${fixture.distinct_item_id} frame_count=${frameCount ?? "okänt"}`);
  return fresh;
}

const jobId = video ? await jobFromVideo(video) : args.includes("--latest") ? latestCompletedJob() : flag("job");
if (!jobId) {
  console.error("Ange en film, --latest eller --job <uuid>.");
  process.exit(1);
}
console.log(`Jobb: ${jobId}`);

// Innan något läggs till: är baslinjen ren? Att utöka en baslinje som redan driver är att frysa
// driften.
const preCheck = capture("baseline.ts", ["--check"]);
if (!preCheck.includes("Inga skillnader mot baseline.")) {
  console.error("Baslinjen är inte ren — fixa det först, annars fryser tillägget in en oavsiktlig ändring.\n");
  console.error(preCheck.split("\n").filter((l) => l.startsWith("~") || l.startsWith("+")).slice(0, 10).join("\n"));
  process.exit(1);
}
console.log("Baslinjen är ren.");

console.log("\n— spelar in fixtur —");
run("record.ts", ["--job", jobId, "--furniture", label]);

const fresh = stampFreshFixture(label, (await jobState(jobId)).images?.length ?? null);

console.log("\n— fyller expected —");
run("baseline.ts", []);

// Baslinjen får bara utökas från ett grönt läge. Annars hade `--rebaseline` här välsignat vilken
// drift som helst som råkade ligga i arbetskatalogen, i samma andetag som den lade till en fixtur —
// och skillnaden mellan "vi lade till ett fall" och "vi ändrade betygssättningen" hade försvunnit.
console.log("\n— skriver in i baslinjen —");
run("baseline.ts", ["--rebaseline"]);
const after = capture("baseline.ts", ["--check"]);
process.stdout.write(after.split("\n").slice(-4).join("\n"));
if (!after.includes("Inga skillnader mot baseline.")) {
  console.error("\nBaslinjen är inte ren efter tillägget — undersök innan du litar på den.");
  process.exit(1);
}
console.log(`\nKlar. ${fresh} ligger i baslinjen. Kör npm test för att se den asserteras.`);
