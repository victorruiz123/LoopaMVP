// MÄTNING: gör säljarens tal skadedetektionen bättre?
//
//   npx tsx tests/voice-notes-impact.ts --latest
//   npx tsx tests/voice-notes-impact.ts --job <id> [--job <id> ...]
//   npx tsx tests/voice-notes-impact.ts --all-voice        (varje jobb som har sellerNotes)
//
// Röstrundan (VOICE-TOUR.md) skickar det säljaren sa som `sellerNotes`, och inspektionsprompten
// lägger det som en ledtråd om VAR den ska titta. Att det BORDE hjälpa är en hypotes; det här är
// mätningen. Samma bildrutor, två körningar: en med talet, en utan. Allt annat lika.
//
// Kräver en igång server (npm run server:dev) och KOSTAR RIKTIGA GEMINI-ANROP — två inspektioner
// per möbel. Kör den medvetet, inte i en slinga.
//
// TVÅ SAKER MÄTNINGEN INTE KAN, sagda rakt ut:
//
//  - **Bruset.** Gemini-cachen slår på (modell + prompt + bildbytes). Med och utan tal är olika
//    prompter, alltså olika cachenycklar — de två armarna kan inte förorena varandra. Men samma arm
//    körd igen träffar cachen och ger ett identiskt svar, så variationen mellan två IDENTISKA
//    körningar går inte att mäta härifrån. En skillnad på ett fynd är därför inte automatiskt en
//    effekt; det är en observation som behöver fler möbler bakom sig.
//  - **Sanningen.** Ingen av armarna vet vad som FAKTISKT finns på möbeln. Fler fynd är inte
//    självklart bättre — det kan vara talet som lockat fram en fabrikation. Därför skrivs
//    fyndlistorna ut i klartext: det som ska läsas är VILKA fynd som tillkom, inte hur många.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { ConditionJob, Damage } from "../server/src/types.js";

const BASE = process.env.CONDITION_BASE ?? "http://localhost:8799";
const JOBS_DIR = path.resolve(import.meta.dirname, "..", "server", "data", "jobs");
const POLL_MS = 2000;
const TIMEOUT_MS = 300_000;

const SERVICE_KEY = process.env.CONDITION_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error("CONDITION_SERVICE_KEY saknas. Sätt samma värde som i server/.env och kör om.");
  process.exit(1);
}
const AUTH = { "x-api-key": SERVICE_KEY };

// ---- jobbval ---------------------------------------------------------------------------------

const args = process.argv.slice(2);

function readJob(id: string): ConditionJob | null {
  try {
    return JSON.parse(readFileSync(path.join(JOBS_DIR, id, "job.json"), "utf-8")) as ConditionJob;
  } catch {
    return null;
  }
}

function jobIdsNewestFirst(): string[] {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR)
    .map((id) => ({ id, mtime: statSync(path.join(JOBS_DIR, id)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => e.id);
}

/** Jobb med tal att mäta på. Ett jobb utan sellerNotes har inget att jämföra mot. */
function withVoice(ids: string[]): { id: string; job: ConditionJob }[] {
  const out: { id: string; job: ConditionJob }[] = [];
  for (const id of ids) {
    const job = readJob(id);
    if (job?.sellerNotes?.trim() && (job.images?.length ?? 0) > 0) out.push({ id, job });
  }
  return out;
}

function chosenJobs(): { id: string; job: ConditionJob }[] {
  const explicit: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--job" && args[i + 1]) explicit.push(args[i + 1]);
  if (explicit.length) return withVoice(explicit);
  const all = withVoice(jobIdsNewestFirst());
  if (args.includes("--all-voice")) return all;
  if (args.includes("--latest")) return all.slice(0, 1);
  return [];
}

// ---- körning ---------------------------------------------------------------------------------

function imagePayload(id: string, job: ConditionJob) {
  const originals = path.join(JOBS_DIR, id, "originals");
  return (job.images ?? []).map((img) => {
    const bytes = readFileSync(path.join(originals, img.path));
    const mime = img.path.endsWith(".png") ? "image/png" : "image/jpeg";
    return {
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
      viewLabel: img.viewLabel,
      source: img.source,
    };
  });
}

async function startRun(images: unknown[], sellerNotes: string | null): Promise<string> {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    // Medvetet UTAN brand: modellsökningen och prissättningen är brus i den här mätningen, och de
    // kostar dessutom anrop. Det som mäts är inspektionen.
    body: JSON.stringify({ images, sellerNotes }),
  });
  if (!res.ok) throw new Error(`POST /api/jobs svarade ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { jobId: string }).jobId;
}

async function awaitResult(id: string): Promise<ConditionJob> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const res = await fetch(`${BASE}/api/jobs/${id}`, { headers: AUTH });
    if (!res.ok) throw new Error(`GET /api/jobs/${id} svarade ${res.status}`);
    const job = (await res.json()) as ConditionJob;
    // reviewPending: delresultatet är publicerat men granskningen kan ännu ändra listan. Vänta ut
    // den — annars jämförs en färdig arm mot en halvfärdig.
    if (job.progress.stage === "done" && !job.result?.reviewPending) return job;
    if (job.progress.stage === "error") throw new Error(job.error ?? "okänt fel");
    if (Date.now() > deadline) throw new Error(`tidsgränsen (${TIMEOUT_MS / 1000}s) passerad i fas ${job.progress.stage}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Ett fynds identitet i jämförelsen: typ + del. Ordalydelsen varierar mellan körningar, typen inte. */
const key = (d: Damage) => `${d.type}@${d.part}`;
const line = (d: Damage) => `${d.type} · ${d.severity} · ${d.part} — ${d.description}`;

// ---- huvudprogram ----------------------------------------------------------------------------

const jobs = chosenJobs();
if (jobs.length === 0) {
  console.error(
    "Inga jobb med sellerNotes hittades.\n" +
      "  --latest      senaste röstrundejobbet\n" +
      "  --job <id>    ett bestämt (flera tillåtna)\n" +
      "  --all-voice   varje jobb som har tal\n" +
      "Filma en runda på /voicetour.html först — jobbet måste ha tal att mäta på.",
  );
  process.exit(1);
}

console.info(`Mäter ${jobs.length} möbel(er). Två inspektioner per möbel, riktiga Gemini-anrop.\n`);

let helped = 0;
let unchanged = 0;
let hurt = 0;

for (const { id, job } of jobs) {
  const notes = job.sellerNotes!.trim();
  const images = imagePayload(id, job);
  console.info(`── ${id.slice(0, 8)} · ${images.length} bilder`);
  console.info(`   sa: "${notes.replace(/\s+/g, " ").slice(0, 140)}${notes.length > 140 ? "…" : ""}"`);

  let a: ConditionJob;
  let b: ConditionJob;
  try {
    // Sekventiellt med flit: parallellt konkurrerar de om samma Gemini-kvot, och en 503 på den ena
    // armen hade gjort jämförelsen omätbar i stället för långsam.
    a = await awaitResult(await startRun(images, notes));
    b = await awaitResult(await startRun(images, null));
  } catch (err) {
    console.error(`   AVBRUTEN: ${err instanceof Error ? err.message : String(err)}\n`);
    continue;
  }

  const withNotes = a.result?.damages ?? [];
  const without = b.result?.damages ?? [];
  const withKeys = new Set(withNotes.map(key));
  const withoutKeys = new Set(without.map(key));
  const onlyWith = withNotes.filter((d) => !withoutKeys.has(key(d)));
  const onlyWithout = without.filter((d) => !withKeys.has(key(d)));

  const gradeA = a.result?.grade?.grade ?? "?";
  const gradeB = b.result?.grade?.grade ?? "?";

  console.info(`   MED tal:  ${withNotes.length} fynd · betyg ${gradeA}`);
  console.info(`   UTAN tal: ${without.length} fynd · betyg ${gradeB}`);
  for (const d of onlyWith) console.info(`   + bara MED tal:  ${line(d)}`);
  for (const d of onlyWithout) console.info(`   - bara UTAN tal: ${line(d)}`);
  if (onlyWith.length === 0 && onlyWithout.length === 0) console.info("   = identiska fyndlistor");
  if (gradeA !== gradeB) console.info(`   ! betyget skiljer: ${gradeB} -> ${gradeA} med talet`);

  if (onlyWith.length > onlyWithout.length) helped++;
  else if (onlyWithout.length > onlyWith.length) hurt++;
  else unchanged++;
  console.info("");
}

console.info("── Summa ──");
console.info(`  fler fynd MED talet:   ${helped}`);
console.info(`  fler fynd UTAN talet:  ${hurt}`);
console.info(`  oavgjort/identiskt:    ${unchanged}`);
console.info(
  "\nLäs fyndlistorna, inte bara siffrorna: ett tillkommet fynd är en vinst bara om det finns på\n" +
    "möbeln. Underlaget är n=" + jobs.length + " — en riktning, inte ett facit.",
);
