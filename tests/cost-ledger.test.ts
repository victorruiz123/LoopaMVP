// ─── Kostnadsboken: taket på 2,00 SEK per omgång, och vad som kan och inte kan verkställas ────────────────────────────
//
// Kravet: högst 2,00 SEK för ALLT betalt i en komplett omgång — identifiering, sökning, specar, skick, annonstext, varianter, prissättning,
// omförsök och anrop som föll. Googles sökavgift (14 USD per 1 000 frågor, ≈0,15 SEK styck) är nästan hela kostnaden, så budgeten blir ett TAK PÅ
// SÖKFRÅGOR per steg, verkställt på strömmen. Här prövas bokföringen (rena funktioner), att varje betalt anrop faktiskt hamnar på jobbet — också
// de som föll eller avbröts — och att inget betalt arbete startas när budgeten inte rymmer det.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "loopa-cost-"));
process.env.LOOPA_JOBS_DIR = path.join(root, "jobs");
process.env.LOOPA_FACTS_CACHE = "0";
process.env.GEMINI_API_KEY ??= "test-key";
delete process.env.LOOPA_ATTEMPT_BUDGET_SEK;
delete process.env.LOOPA_USD_SEK;

import {
  ATTEMPT_BUDGET_SEK,
  CONDITION_RETRY_MIN_SEK,
  PRIORITY_MULTIPLIER,
  SAFETY_MARGIN_SEK,
  SEARCH_USD_PER_QUERY,
  STAGE_RESERVE_SEK,
  USD_SEK,
  abortedOutputTokens,
  budgetStatus,
  byStage,
  canSpend,
  newJobCost,
  remainingSek,
  searchAllowance,
  spentSek,
  tokenUsd,
  totalTokensUsd,
  usdToSek,
  type CostEntry,
  type JobCost,
} from "../server/src/cost/ledger.js";
import { InteractionError, runInteraction, testHooks as runnerHooks } from "../server/src/research/geminiInteractions.js";
import { scriptedClient, successfulRun } from "./helpers/fakeGemini.js";

const { createJob, getJob } = await import("../server/src/jobStore.js");
const { withCostScope, costOf, costSummary, allowanceFor } = await import("../server/src/cost/jobCost.js");
const { reportUsage } = await import("../server/src/cost/hooks.js");

const entry = (stage: CostEntry["stage"], usd: number, over: Partial<CostEntry> = {}): CostEntry => ({
  stage,
  label: stage,
  model: "gemini-3.8-flash",
  at: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  searchQueries: 0,
  usd,
  ok: true,
  ...over,
});
const withEntries = (...entries: CostEntry[]): JobCost => ({ ...newJobCost(), entries });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  runnerHooks.client = null;
});
after(async () => {
  runnerHooks.client = null;
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
});

// ─── Priser och omräkning ───────────────────────────────────────────────────

test("tokenpriset följer prislistan: 0,75 / 3,75 USD per miljon, tänkande räknas som utdata, prioritetsnivån kostar 1,8 gånger", () => {
  assert.equal(tokenUsd("gemini-3.8-flash", { inputTokens: 1_000_000, outputTokens: 0, thoughtTokens: 0 }), 0.75);
  assert.equal(tokenUsd("gemini-3.8-flash", { inputTokens: 0, outputTokens: 500_000, thoughtTokens: 500_000 }), 3.75);
  assert.equal(tokenUsd("gemini-3.8-flash", { inputTokens: 1_000_000, outputTokens: 0, thoughtTokens: 0 }, "priority"), 0.75 * PRIORITY_MULTIPLIER);
  assert.equal(PRIORITY_MULTIPLIER, 1.8);
  assert.equal(tokenUsd("gemini-3.5-flash-lite", { inputTokens: 1_000_000, outputTokens: 1_000_000, thoughtTokens: 0 }), 0.3 + 2.5);
});

test("en total utan uppdelning räknas på den säkra sidan (85 % indata / 15 % utdata)", () => {
  const usd = totalTokensUsd("gemini-3.6-flash", 17_000);
  assert.ok(usd > 0.015 && usd < 0.025, `${usd}`);
});

test("sökfrågor är nästan hela kostnaden: en fråga kostar 0,014 USD ≈ 0,15 SEK, och gratisnivån räknas inte in", () => {
  assert.equal(SEARCH_USD_PER_QUERY, 0.014);
  assert.ok(Math.abs(usdToSek(SEARCH_USD_PER_QUERY) - 0.154) < 0.001);
  assert.equal(USD_SEK, 11, "spot 9,9–10,05 i oktober 2026 + ≈10 % marginal");
});

test("ett avbrutet anrop räknas uppåt ur tiden i stället för som noll — men aldrig över ett tak", () => {
  assert.equal(abortedOutputTokens(0), 0);
  assert.equal(abortedOutputTokens(50_000), 4_000);
  assert.equal(abortedOutputTokens(10 * 60_000), 8_000);
});

// ─── Tillåtelser ────────────────────────────────────────────────────────────

test("en ny omgång: identifieringen får det som blir kvar när övriga steg fått sin reserv", () => {
  const c = newJobCost();
  const reserves = Object.values(STAGE_RESERVE_SEK).reduce((n, v) => n + v, 0);
  const a = searchAllowance(c, "identify");
  assert.ok(Math.abs(a.availableSek - (ATTEMPT_BUDGET_SEK - reserves - SAFETY_MARGIN_SEK)) < 1e-9, "reserverna och säkerhetsmarginalen dras av före sökfrågorna");
  assert.ok(a.searchQueries >= 14 && a.searchQueries <= 30, `${a.searchQueries}: rymmer förvalets cirka 14 sökfrågor (högst 20) med marginal, men är ett tak`);
});

test("ett steg som redan körts släpper sin reserv: specarna får mer när skicket och identifieringen blev billigare än planerat", () => {
  const cheap = withEntries(entry("condition", 0.01), entry("identify", 0.04, { searchQueries: 2 }));
  const dear = withEntries(entry("condition", 0.01), entry("identify", 0.45, { searchQueries: 24 }));
  assert.ok(searchAllowance(cheap, "specs").searchQueries > searchAllowance(dear, "specs").searchQueries);
  assert.equal(searchAllowance(dear, "specs").searchQueries, 0, "efter en mycket dyr identifiering rymmer säkerhetsbudgeten ingen sökning i specarna: bara de sidor identifieringen redan läst");
});

test("tillåtelsen blir aldrig negativ och går att fråga om också när taket är passerat", () => {
  const over = withEntries(entry("identify", 0.6));
  const a = searchAllowance(over, "specs");
  assert.equal(a.searchQueries, 0);
  assert.ok(a.availableSek < 0);
  assert.equal(canSpend(over, 0.01), false);
});

test("läget: inom, tight (≥80 %) och passerat", () => {
  assert.equal(budgetStatus(withEntries(entry("identify", 0.3))), "within");
  assert.equal(budgetStatus(withEntries(entry("identify", 0.48))), "tight");
  assert.equal(budgetStatus(withEntries(entry("identify", 0.56))), "exceeded");
});

test("summorna per steg följer posterna, och SEK = USD × kursen", () => {
  const c = withEntries(entry("identify", 0.1, { searchQueries: 5 }), entry("identify", 0.02, { searchQueries: 1 }), entry("condition", 0.01));
  const s = byStage(c);
  assert.equal(s.identify.calls, 2);
  assert.equal(s.identify.searchQueries, 6);
  assert.ok(Math.abs(spentSek(c) - 0.13 * 11) < 1e-9);
  assert.ok(Math.abs(remainingSek(c) - (ATTEMPT_BUDGET_SEK - 0.13 * 11)) < 1e-9);
});

test("ett nytt skickförsök startas bara om det ryms: efter en mycket dyr identifiering är säkerhetsbudgeten slut för ett omtag", () => {
  const fresh = newJobCost();
  assert.equal(canSpend(fresh, CONDITION_RETRY_MIN_SEK), true);
  const afterCheapRun = withEntries(entry("identify", 0.06, { searchQueries: 3 }), entry("condition", 0.02));
  assert.equal(canSpend(afterCheapRun, CONDITION_RETRY_MIN_SEK), true, "≈0,9 SEK förbrukat: omtaget ryms");
  const afterDearRun = withEntries(entry("identify", 0.52, { searchQueries: 30 }));
  assert.equal(canSpend(afterDearRun, CONDITION_RETRY_MIN_SEK), false, "≈5,7 SEK förbrukat: 0,3 SEK kvar räcker inte till en besiktning");
  assert.ok(CONDITION_RETRY_MIN_SEK >= 0.25, "minst vad en uppmätt besiktning kostar");
});

// ─── Anropen hamnar på jobbet ───────────────────────────────────────────────

test("ett betalt forskningsanrop bokförs på jobbet som sitt steg, med sökfrågor och uppskattad kostnad", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  runnerHooks.client = scriptedClient([{ events: successfulRun({ candidates: [] }, { queries: [["a", "b"], ["c"]] }) }]).client;
  await withCostScope({ jobId: job.id, stage: "identify" }, () =>
    runInteraction({ purpose: "identify", label: "t", systemInstruction: "x", prompt: "y", images: [], thinkingLevel: "medium", timeoutMs: 10_000 }),
  );
  await sleep(50);
  const cost = (await getJob(job.id))!.cost!;
  assert.equal(cost.entries.length, 1);
  const e = cost.entries[0];
  assert.equal(e.stage, "identify");
  assert.equal(e.searchQueries, 3);
  assert.ok(e.usd >= 3 * SEARCH_USD_PER_QUERY, "tre sökfrågor à 0,014 USD ingår alltid");
  assert.equal(e.ok, true);
  assert.equal(e.estimated, undefined);
});

test("ett avbrutet anrop kostar ändå: det bokförs som misslyckat och som en uppskattning, med sökfrågorna som hann ses", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  const ac = new AbortController();
  runnerHooks.client = scriptedClient([{ events: successfulRun({ candidates: [] }, { queries: [["a", "b", "c"]] }).slice(0, 6), hang: true }]).client;
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(
    withCostScope({ jobId: job.id, stage: "specs" }, () =>
      runInteraction({ purpose: "specs", label: "t", systemInstruction: "x", prompt: "y", images: [], thinkingLevel: "medium", timeoutMs: 10_000, signal: ac.signal }),
    ),
    (e: unknown) => e instanceof InteractionError && e.kind === "aborted",
  );
  await sleep(50);
  const e = (await getJob(job.id))!.cost!.entries[0];
  assert.equal(e.stage, "specs");
  assert.equal(e.ok, false);
  assert.equal(e.estimated, true);
  assert.equal(e.searchQueries, 3);
});

test("ett anrop utanför ett jobb bokförs ingenstans (ett mätskript) — och rapporteringen fäller aldrig anropet", () => {
  assert.doesNotThrow(() => reportUsage({ label: "x", model: "m", inputTokens: 1, outputTokens: 1, thoughtTokens: 0, searchQueries: 0, usd: 0.001, ok: true }));
});

test("rapporterat inom ett scope hamnar posten på jobbet med scopets steg, och sammanfattningen visar läget", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  withCostScope({ jobId: job.id, stage: "condition" }, () => {
    reportUsage({ label: "main_inspection", model: "gemini-3.6-flash", inputTokens: 15_000, outputTokens: 900, thoughtTokens: 2_000, searchQueries: 0, usd: tokenUsd("gemini-3.6-flash", { inputTokens: 15_000, outputTokens: 900, thoughtTokens: 2_000 }), ok: true });
  });
  await sleep(50);
  const s = costSummary((await getJob(job.id))!.cost);
  assert.equal(s.status, "within");
  assert.ok(s.spentSek > 0 && s.spentSek < 0.5);
  assert.deepEqual(Object.keys(s.stages), ["condition"]);
});

test("allowanceFor läser jobbets bok: efter en mycket dyr identifiering rymmer säkerhetsbudgeten ingen ny", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  const fresh = await allowanceFor(job.id, "identify");
  assert.ok(fresh.searchQueries >= 15, `${fresh.searchQueries}`);
  withCostScope({ jobId: job.id, stage: "identify" }, () => reportUsage({ label: "identify", model: "gemini-3.8-flash", inputTokens: 8000, outputTokens: 900, thoughtTokens: 2500, searchQueries: 30, usd: 0.5, ok: true }));
  await sleep(50);
  const after = await allowanceFor(job.id, "identify");
  assert.ok(after.searchQueries < 3, `${after.searchQueries}`);
  assert.equal((await costOf(job.id))!.entries.length, 1);
});
