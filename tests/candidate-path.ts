// MÄTNING: kandidatvägen — den väg säljaren faktiskt går.
//
//   npx tsx tests/candidate-path.ts <payload.json> [antal] [--expect NAMN] [--manual]
//
// Säljaren skriver bara märket. Systemet föreslår upp till fyra modeller, säljaren pekar på en, och
// FÖRST då byggs specifikationerna. Den vägen heter `resolve_seller_selected`.
//
// Mätningarna 28-29 augusti 2026 gick i stället in med modellnamnet direkt (`resolve_manual`) därför
// att det var en rad kortare att skriva. Över 48 körningar fick manual-vägen källor i 67 % av fallen
// och kandidatvägen i 33 % — samma mediantid, dubbla träffsäkerheten. Det som mättes var alltså inte
// det som kördes. Därför är kandidatvägen standard här och manual-vägen ett uttalat flaggval.
//
// Kräver en igång server (npm run server:dev) och kostar riktiga Gemini-anrop.

import { readFileSync } from "node:fs";
import type { ListingResult, ModelCandidate } from "../server/src/types.js";

const BASE = process.env.CONDITION_BASE ?? "http://localhost:8799";

/**
 * Maskinkontot. /api kräver identitet sedan auth-grinden kom på plats, och harnesset har inget
 * Supabase-konto — det loggar in med CONDITION_SERVICE_KEY och äger sina egna jobb.
 */
const SERVICE_KEY = process.env.CONDITION_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error("CONDITION_SERVICE_KEY saknas. Sätt samma värde som i server/.env och kör om.");
  process.exit(1);
}
const AUTH = { "x-api-key": SERVICE_KEY };
const POLL_MS = 1000;
const CANDIDATE_TIMEOUT_MS = 120_000;
const LISTING_TIMEOUT_MS = 180_000;

type Job = {
  jobId: string;
  candidates?: ModelCandidate[] | null;
  identityStatus?: string | null;
  identityError?: string | null;
  identityResearch?: { sources?: unknown[] } | null;
  pendingListing?: ListingResult | null;
  result?: { listing?: ListingResult | null } | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJob(id: string): Promise<Job> {
  const res = await fetch(`${BASE}/api/jobs/${id}`, { headers: AUTH });
  if (!res.ok) throw new Error(`GET /api/jobs/${id} svarade ${res.status}`);
  return (await res.json()) as Job;
}

/** Väntar på ett villkor, eller ger upp. Returnerar null vid timeout så anroparen kan rapportera det. */
async function waitFor<T>(pick: (j: Job) => T | null | undefined, id: string, timeoutMs: number): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = pick(await getJob(id));
    if (hit) return hit;
    await sleep(POLL_MS);
  }
  return null;
}

const listingOf = (j: Job): ListingResult | null => {
  const l = j.result?.listing ?? j.pendingListing ?? null;
  return l && l.status !== "pending" ? l : null;
};

const dimensionsOf = (l: ListingResult): string[] =>
  (l.result?.attributes ?? [])
    .filter((a) => /mått|bredd|djup|höjd|sitthöjd|längd|diameter/i.test(a.label))
    .map((a) => `${a.label} ${a.value}`);

type Run = {
  n: number;
  path: string;
  candidates: number;
  picked: string;
  expectedHit: boolean | null;
  phase1Sources: number;
  sources: number;
  reusedPrior: boolean | null;
  form: string;
  dimensions: number;
  status: string;
  ms: number;
};

async function runOnce(n: number, payload: unknown, expect: string | null, manual: boolean): Promise<Run> {
  const t0 = Date.now();
  const created = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify(payload),
  });
  const { jobId } = (await created.json()) as { jobId: string };

  // Tom lista med satt identityStatus är ett SLUTLIGT besked — sökningen föll och det finns inga
  // modeller att peka på. Väntar man vidare på den väntar man på något som aldrig kommer; det kostade
  // 120 sekunders tystnad i första mätningen innan det stod klart att jobbet varit färdigt i 90 av dem.
  const settled = await waitFor(
    // "identifying" är pågående — allt annat är ett slutligt besked.
    (j) => (j.candidates?.length ? { cands: j.candidates } : j.identityStatus && j.identityStatus !== "identifying" ? { cands: null } : null),
    jobId,
    CANDIDATE_TIMEOUT_MS,
  );
  const job = await getJob(jobId);
  const cands = settled?.cands ?? null;

  if (!cands) {
    return {
      n, path: "-", candidates: 0, picked: "-", expectedHit: null,
      phase1Sources: job.identityResearch?.sources?.length ?? 0, sources: 0, reusedPrior: null, form: "-", dimensions: 0,
      status: job.identityError ? `fel: ${job.identityError.slice(0, 30)}` : settled ? "0 kandidater" : "timeout",
      ms: Date.now() - t0,
    };
  }

  // Säljaren pekar på den modell som faktiskt är rätt när vi vet vilken den är. Vet vi inte det tas
  // den högst rankade — samma val en säljare gör när alla fyra ser rimliga ut.
  const wanted = expect?.toLowerCase();
  const picked = (wanted && cands.find((c) => c.model.toLowerCase().includes(wanted))) || cands[0];

  const body = manual ? { manualModel: picked.model } : { candidate: picked };
  await fetch(`${BASE}/api/jobs/${jobId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  });

  const listing = await waitFor(listingOf, jobId, LISTING_TIMEOUT_MS);
  const dims = listing ? dimensionsOf(listing) : [];
  return {
    n,
    path: manual ? "resolve_manual" : "resolve_seller_selected",
    candidates: cands.length,
    picked: picked.model,
    expectedHit: wanted ? picked.model.toLowerCase().includes(wanted) : null,
    phase1Sources: job.identityResearch?.sources?.length ?? 0,
    sources: listing?.provenance?.sources ?? listing?.result?.sources?.length ?? 0,
    reusedPrior: listing?.provenance?.reusedPrior ?? null,
    form: listing?.provenance?.researchFormHit ?? "-",
    dimensions: dims.length,
    status: listing?.status ?? "timeout",
    ms: Date.now() - t0,
  };
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "";
const runs = Number(args.filter((a) => !a.startsWith("--"))[1] ?? 6);
const expect = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;
const manual = args.includes("--manual");
if (!file) {
  console.error("Ange en payload: npx tsx tests/candidate-path.ts <payload.json> [antal] [--expect NAMN] [--manual]");
  process.exit(1);
}
const payload = JSON.parse(readFileSync(file, "utf8"));

console.log(`VÄG: ${manual ? "resolve_manual (flaggval)" : "resolve_seller_selected (standard)"} · ${runs} körningar · ${file}`);
const results: Run[] = [];
for (let i = 1; i <= runs; i++) {
  const r = await runOnce(i, payload, expect, manual);
  results.push(r);
  console.log(
    `  ${String(i).padStart(2)}  ${r.status.padEnd(12)} vald=${r.picked.slice(0, 18).padEnd(18)} ` +
      `fas1_källor=${r.phase1Sources} källor=${r.sources} ärvda=${r.reusedPrior === null ? "-" : r.reusedPrior ? "ja" : "nej"} ` +
      `form=${r.form.padEnd(5)} mått=${r.dimensions} ${(r.ms / 1000).toFixed(1)}s`,
  );
}

const done = results.filter((r) => r.status === "ok");
const withSources = done.filter((r) => r.sources > 0);
const reused = done.filter((r) => r.reusedPrior);
const withDims = done.filter((r) => r.dimensions > 0);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "–");

console.log(`\nSAMMANFATTNING (${done.length} av ${results.length} färdiga)`);
console.log(`  källor              ${withSources.length}/${done.length}  ${pct(withSources.length, done.length)}   (baslinje kandidatväg: 33 %)`);
console.log(`  därav ärvda fas 1   ${reused.length}/${withSources.length}  ${pct(reused.length, Math.max(withSources.length, 1))}`);
console.log(`  mått                ${withDims.length}/${done.length}  ${pct(withDims.length, done.length)}`);
console.log(`  mått ur ärvt        ${withDims.filter((r) => r.reusedPrior).length}   ur eget: ${withDims.filter((r) => !r.reusedPrior).length}`);
if (expect) console.log(`  rätt modell i listan ${results.filter((r) => r.expectedHit).length}/${results.length}`);
const times = done.map((r) => r.ms).sort((a, b) => a - b);
if (times.length) console.log(`  median              ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s`);
