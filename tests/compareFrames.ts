// A/B-mätning av bildruteantal: samma film, två inställningar, samma sittning.
//
//   npm run fixture:add -- film.mp4 --label soffa-bla --brand IKEA --model Söderhamn --compare-frames 6,8
//
// Varför samma sittning: Googles svarstid på identiskt arbete varierade 2,3x under förra mätningen,
// och vi fick 503 på två av fyra försök. Körs varianterna olika dagar jämför man dagsform lika mycket
// som inställning. Därför kör den här dem direkt efter varandra, plus ETT extra par med samma
// inställning — brusnivån. En skillnad mindre än bruset är ingen skillnad.

import type { ConditionResult, Damage } from "../server/src/types.js";

export interface RunResult {
  buckets: number;
  jobId: string;
  frameCount: number;
  ms: number;
  valid: boolean;
  invalidReason: string | null;
  result: ConditionResult | null;
}

const BASE = "http://localhost:8799";

/** 503 och timeout betyder att modellen aldrig svarade — jämför inte mot ett fallet anrop. */
function invalidity(job: { progress: { stage: string }; error: string | null }): string | null {
  if (job.progress.stage !== "error") return null;
  const e = job.error ?? "";
  if (/503|UNAVAILABLE|high demand/i.test(e)) return "Gemini 503 — modellen svarade aldrig";
  if (/aborted|deadline|504|timeout/i.test(e)) return "timeout — modellen svarade aldrig";
  return `körningen föll: ${e.slice(0, 80)}`;
}

export async function waitForJob(jobId: string, timeoutMs = 240_000): Promise<RunResult["result"] | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
    if (job.progress.stage === "error") return null;
    if (job.result && !job.result.reviewPending) return job.result as ConditionResult;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export async function jobState(jobId: string) {
  return (await (await fetch(`${BASE}/api/jobs/${jobId}`)).json()) as {
    progress: { stage: string };
    error: string | null;
    result: ConditionResult | null;
    images?: unknown[];
  };
}

/** Ett fynds identitet över två körningar. Id:n är slumpade per körning, så de duger inte. */
function key(d: Damage): string {
  return `${d.type}|${d.part}|${d.semanticLocation}`.toLowerCase();
}

const HIDDEN_SURFACE = /(bak|rygg|under|nedre|insida|baksid|undersid)/i;

/** Ett fynd som bara EN vy såg är precis det två vyer färre riskerar att missa. */
function singleView(d: Damage): boolean {
  return new Set(d.evidence.map((e) => e.imageId)).size <= 1;
}

export function compare(a: RunResult, b: RunResult): string[] {
  const lines: string[] = [];
  const active = (r: RunResult) => (r.result?.damages ?? []).filter((d) => d.sellerAction !== "rejected");
  const byKey = (r: RunResult) => new Map(active(r).map((d) => [key(d), d]));
  const A = byKey(a);
  const B = byKey(b);

  lines.push(`  ${a.buckets} vyer: betyg ${a.result?.grade?.grade ?? "-"} · ${A.size} fynd · ${(a.ms / 1000).toFixed(1)} s`);
  lines.push(`  ${b.buckets} vyer: betyg ${b.result?.grade?.grade ?? "-"} · ${B.size} fynd · ${(b.ms / 1000).toFixed(1)} s`);

  for (const [label, only, other] of [
    [`bara ${a.buckets} vyer`, A, B],
    [`bara ${b.buckets} vyer`, B, A],
  ] as const) {
    for (const [k, d] of only) {
      if (other.has(k)) continue;
      const flags = [singleView(d) ? "SYNS I EN ENDA VY" : null, HIDDEN_SURFACE.test(`${d.part} ${d.semanticLocation}`) ? "DOLD YTA" : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`    ${label}: ${d.type} på ${d.part} (${d.severity})${flags ? `  <-- ${flags}` : ""}`);
    }
  }
  return lines;
}

export function noiseLine(x: RunResult, y: RunResult): string {
  const n = (r: RunResult) => (r.result?.damages ?? []).filter((d) => d.sellerAction !== "rejected").length;
  const sameGrade = x.result?.grade?.grade === y.result?.grade?.grade;
  return (
    `  brusnivå (två identiska körningar med ${x.buckets} vyer): ` +
    `betyg ${sameGrade ? "lika" : `OLIKA (${x.result?.grade?.grade} vs ${y.result?.grade?.grade})`} · ` +
    `fynd ${n(x)} vs ${n(y)} · tid ${(x.ms / 1000).toFixed(1)} vs ${(y.ms / 1000).toFixed(1)} s`
  );
}

export { invalidity };
