// ─── Identifieringen genom hela kedjan: jobbet på disk, uppgifterna, det ärliga tomma utfallet, kostnadstaket, valet ─────
//
// Här körs den riktiga runIdentify (och finalizeWithModel, findMoreCandidates) med Gemini ersatt av stubbar, och med livslängden
// krympt från 120 s till 0,4 s (tests/helpers/fastDeadline.ts). Det som prövas är det som händer med JOBBET:
//   - ett svar blir en lista, med kvittot i jobbet och uppgiften "identify" som klar — och INGET specsanrop görs före valet: modellberoende
//     forskning startar bara på den modell säljaren bekräftat;
//   - tar livslängden slut — för att anropet hänger sig, för att dess budget går ut, eller för att tjänsten är nere — blir jobbet ett
//     ärligt tomt val med rätt skäl (`identityResult`), snabbt, och ingen annan modell gissar i stället;
//   - "troliga" och "möjliga" kandidater med belägg når säljaren (som just det), en kandidat utan belägg gör det aldrig;
//   - kostnadstaket: identifieringens sökfrågor begränsas av omgångens budget, och ett omval som inte ryms startas inte;
//   - säljaren hinner före: ett sent svar skriver aldrig över den bekräftade modellen, och en uppgift som föll tar inte skicket med sig;
//   - "hitta nya" efter ett tomt utfall startar en NY livslängd.

import "./helpers/fastDeadline.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "loopa-identify-flow-"));
process.env.LOOPA_JOBS_DIR = path.join(root, "jobs");
process.env.LOOPA_KANDIDATBILDER_DIR = path.join(root, "kandidatbilder");
process.env.LOOPA_MATTMINNE_DIR = path.join(root, "mattminne");
process.env.GEMINI_API_KEY ??= "test-key";
process.env.SELLER_RESEARCH_BUDGET_MS ??= "24000";
process.env.SELLER_OVERALL_DEADLINE_MS ??= "60000";
// Generatorns tidsgräns är en timer som inte rensas när anropet hinner före (listing.ts); utan den här kortare lever testprocessen 40 s efter sista testet.
process.env.LISTING_TIMEOUT_MS ??= "1500";
delete process.env.LOOPA_ATTEMPT_BUDGET_SEK;
delete process.env.LOOPA_USD_SEK;

import { InteractionError, type InteractionErrorKind, type InteractionOutcome, type InteractionRequest } from "../server/src/research/geminiInteractions.js";
import type { PageFetchResult } from "../server/src/research/verify.js";
import type { ConditionJob, ModelCandidate } from "../server/src/types.js";
import { fakeTrace } from "./helpers/fakeGemini.js";
import { FAST } from "./helpers/fastDeadline.js";

const { testHooks } = await import("../server/src/research/pipeline.js");
const { createJob, getJob, persist } = await import("../server/src/jobStore.js");
const { runIdentify, finalizeWithModel, findMoreCandidates } = await import("../server/src/pipeline/identify.js");
const { initialTasks, missingForPublish } = await import("../server/src/pipeline/tasks.js");
const { recordCost } = await import("../server/src/cost/jobCost.js");

const SRC = "https://www.ikea.com/se/sv/p/ingemar-barstol-s79012345/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cand = (model: string, confidence: "strong" | "likely" | "possible" = "strong", over: Record<string, unknown> = {}) => ({
  brand: "IKEA",
  model,
  variant: null,
  productType: "barstol",
  confidence,
  evidence: ["lågt ryggstöd med bred bricka", "metallskydd på fotstödet"],
  distinguishingDetail: null,
  sourceUrl: SRC,
  discontinued: null,
  ...over,
});
const identifyJson = (candidates: unknown[], over: Record<string, unknown> = {}) => ({
  category: "barstol",
  observations: ["svart trä", "lågt ryggstöd"],
  candidates,
  exactMatch: true,
  uncertaintyNote: null,
  summary: "Sökte och jämförde.",
  ...over,
});

const SPEC = {
  identity: { brand: "IKEA", model: "INGEMAR", variant: null, category: "barstol", confidence: "high", matchesPhotos: true, note: null, discontinued: true },
  dimensions: [{ type: "overall_width", label: "Bredd", value: 42, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: SRC, quote: "Bredd: 42 cm" }],
  materials: [{ component: "Stomme", material: "Massiv björk", detail: null, appliesTo: null, sourceUrl: SRC, quote: null }],
  otherFacts: [],
  retailPriceSek: null,
  retailPriceSourceUrl: null,
  conflicts: [],
  missing: [],
  sourcesUsed: [{ url: SRC, title: "INGEMAR", kind: "manufacturer" }],
  summary: "x",
};

type IdentifyBehaviour = (req: InteractionRequest) => Promise<InteractionOutcome>;
const answer = (json: unknown): IdentifyBehaviour => async () => ({ json, text: "", trace: fakeTrace({ estimatedCostUsd: 0.2, searchQueries: ["ikea ingemar barstol"] }) });
const failWith = (kind: InteractionErrorKind): IdentifyBehaviour => async () => {
  const e = new InteractionError(`fel: ${kind}`, kind);
  e.trace = fakeTrace({ stoppedBy: "error", error: { kind, message: kind }, estimatedCostUsd: 0.01 });
  throw e;
};
/** Som den riktiga körarens ström: ger upp när budgeten tar slut. */
const runsOutOfBudget: IdentifyBehaviour = async (req) => {
  await sleep(req.timeoutMs);
  const e = new InteractionError("budgeten tog slut", "timeout");
  e.trace = fakeTrace({ stoppedBy: "time_budget", estimatedCostUsd: 0.3, searchQueries: ["sits impulse", "sits brandon"], toolCalls: 9 });
  throw e;
};
/** Hänger sig: ignorerar både budget och signal. Det är vaktens fall. */
const hangs: IdentifyBehaviour = () => new Promise(() => {});

const plan: { identify: IdentifyBehaviour; specs: IdentifyBehaviour | null } = { identify: answer(identifyJson([cand("INGEMAR")])), specs: null };
const calls: Array<{ purpose: string; modell: string | null; jobb: string | undefined; req: InteractionRequest }> = [];
let generatorCalls = 0;
const realFetch = globalThis.fetch;

before(() => {
  testHooks.run = async (req) => {
    const modell = /INGEMAR/.test(req.prompt) ? "INGEMAR" : null;
    calls.push({ purpose: req.purpose, modell, jobb: req.label, req });
    if (req.purpose === "identify") return plan.identify(req);
    if (req.purpose === "specs") {
      if (plan.specs) return plan.specs(req);
      return { json: { ...SPEC, identity: { ...SPEC.identity, model: modell ?? "INGEMAR" } }, text: "", trace: fakeTrace({ purpose: "specs", estimatedCostUsd: 0.3 }) };
    }
    // Allt annat: hänger tills det avbryts.
    return new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new InteractionError("avbruten", "aborted")), { once: true }));
  };
  testHooks.fetchPage = async (): Promise<PageFetchResult> => null;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body && /"contents"/.test(String(init.body))) {
      generatorCalls++;
      const structured = {
        identity: { brand: "IKEA", exactProduct: "INGEMAR", variant: null, category: "barstol", confidence: "high", uncertain: false, uncertaintyNote: null },
        attributes: [{ key: "farg", label: "Färg", value: "Svart" }],
        condition: { grade: "B", label: "Gott skick", defects: [], reasoning: "x", uncertain: false, uncertaintyNote: null },
        pricing: { available: true, retailPriceSek: null, suggestedPriceSek: 300, priceRangeMinSek: 200, priceRangeMaxSek: 400, rationale: "x" },
        listing: { title: "IKEA INGEMAR barstol", description: "Barstol i svart.", conditionText: "Gott skick." },
        missingNotes: [],
      };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] }));
    }
    return new Response("finns inte", { status: 404, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
});

after(async () => {
  testHooks.run = null;
  testHooks.fetchPage = null;
  globalThis.fetch = realFetch;
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
});

function reset(identify: IdentifyBehaviour) {
  calls.length = 0;
  generatorCalls = 0;
  plan.identify = identify;
  plan.specs = null;
}

async function newJob(): Promise<ConditionJob> {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  writeFileSync(
    path.join(process.env.LOOPA_JOBS_DIR!, job.id, "originals", "img_0.jpg"),
    Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
      "base64",
    ),
  );
  job.images = [{ id: "a", viewLabel: null, source: "manual", width: 1, height: 1, path: "img_0.jpg", capturedAt: new Date().toISOString() }];
  // Skickbedömningen körs inte i testet: ett jobb i feltillstånd gör att fas 2 inte väntar på den.
  job.progress = { stage: "error", message: "test" };
  job.identityStatus = "identifying";
  job.tasks = initialTasks({ skipGrading: false, identify: "run" });
  await persist(job);
  return job;
}

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 4_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(20);
  }
  return false;
};
const identifyCalls = () => calls.filter((c) => c.purpose === "identify").length;
/** Antal FULLA specsanrop för en modell i ett visst jobb (ett tidigare test kan ha bakgrundsanrop kvar). */
const spec = (jobId: string, modell: string) => calls.filter((c) => c.purpose === "specs" && c.modell === modell && c.jobb === jobId.slice(0, 8)).length;
const specsFor = (jobId: string) => calls.filter((c) => c.purpose === "specs" && c.jobb === jobId.slice(0, 8)).length;

// ─── Ett svar ───────────────────────────────────────────────────────────────

test("ett svar: listan, utfallet 'candidates', kvittot i jobbet, uppgiften klar — och ingen specsforskning före valet", async () => {
  reset(answer(identifyJson([cand("INGEMAR")])));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.equal(j.identityStatus, "needs_selection");
  assert.deepEqual(j.candidates?.map((c) => c.model), ["INGEMAR"]);
  assert.equal(j.identityResult, "candidates");
  assert.equal(j.identityError ?? null, null);
  assert.equal(j.identityTrace?.deadline?.limitMs, FAST.deadlineMs);
  assert.equal(j.identityTrace?.deadline?.hit, false);
  assert.equal(j.tasks?.identify?.status, "completed");
  assert.equal(j.tasks?.specs?.status, "pending", "specarna väntar på en bekräftad modell");
  assert.equal(identifyCalls(), 1, "ETT anrop: ingen andra omgång, inget snabbspår");
  await sleep(150);
  assert.equal(specsFor(job.id), 0, "ingen förvärmning, ingen spekulativ forskning på en modell säljaren inte bekräftat");
});

test("identifieringen är omgångar om ETT sökanrop vardera med båda verktygen, och säkerhetsbudgeten är ett tak — inte ett arbetssätt", async () => {
  reset(answer(identifyJson([cand("INGEMAR")])));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const req = calls.find((c) => c.purpose === "identify")!.req;
  // Varje omgång är ETT sökanrop med ett angivet antal frågor — den form modellen följer — och gränsen sägs som den tekniska fakta den är. Koden kör fler omgångar.
  assert.match(req.systemInstruction, /EXACTLY ONE google_search call, holding at most 5 different queries/);
  assert.match(req.systemInstruction, /delivers NOTHING/);
  assert.doesNotMatch(req.systemInstruction, /EXACTLY ONE SEARCH CALL/);
  assert.ok(req.maxSearchQueries! > 5, `skyddstaket ${req.maxSearchQueries} ligger över det prompten ber om`);
  assert.ok(req.maxOutputTokens && req.maxOutputTokens >= 24_000, "Googles eget tak på utdata ligger väl över ett normalt svar");
  assert.equal(req.tools, undefined, "sökning OCH sidhämtning: en produktsida som visar möbeln är det starkaste belägget");
});

test("valet efteråt: EN specsforskning på den bekräftade modellen, och faktan ligger på jobbet", async () => {
  reset(answer(identifyJson([cand("INGEMAR")])));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  await finalizeWithModel(job.id, { kind: "seller_selected", selected: (await getJob(job.id))!.candidates![0] as ModelCandidate });
  assert.equal(spec(job.id, "INGEMAR"), 1, "ETT specsanrop, inte ett per kandidat");
  const j = (await getJob(job.id))!;
  assert.equal(j.productFacts?.identity.model, "INGEMAR");
  assert.equal(j.tasks?.specs?.status, "completed");
});

// ─── Livslängden tar slut: ett ärligt tomt val, ingen gissning ──────────────

test("anropet hänger sig: jobbet blir ett ärligt tomt val strax efter gränsen — utan generator, utan specsanrop, utan kandidater", async () => {
  reset(hangs);
  const job = await newJob();
  const t0 = Date.now();
  await runIdentify(job.id, "IKEA", job.images!);
  const elapsed = Date.now() - t0;
  const j = (await getJob(job.id))!;
  assert.equal(j.identityStatus, "needs_selection", "säljaren får tillbaka kontrollen: valskärmen med utvägar");
  assert.deepEqual(j.candidates, []);
  assert.equal(j.identityResult, "timeout");
  assert.match(j.identityError ?? "", /tog för lång tid/);
  assert.match(j.identityError ?? "", /fler bilder/);
  assert.equal(j.identityTrace?.deadline?.hit, true);
  assert.equal(j.tasks?.identify?.status, "failed", "uppgiften föll — skicket påverkas inte");
  assert.ok(elapsed < FAST.deadlineMs + FAST.watchdogGraceMs + 500, `${elapsed} ms: tillbaka inom livslängden och vaktens marginal`);
  assert.equal(generatorCalls, 0, "den gamla generatorn fyller inte i en identifiering som tiden inte räckte till");
  await sleep(100);
  assert.equal(specsFor(job.id), 0);
  assert.equal(identifyCalls(), 1, "inget omförsök, ingen eskalering");
});

test("anropets budget tar slut före gränsen (som den riktiga körarens ström): samma ärliga utfall, och snabbare än vakten", async () => {
  reset(runsOutOfBudget);
  const job = await newJob();
  const t0 = Date.now();
  await runIdentify(job.id, "IKEA", job.images!);
  const elapsed = Date.now() - t0;
  const j = (await getJob(job.id))!;
  assert.deepEqual(j.candidates, []);
  assert.equal(j.identityResult, "timeout");
  assert.ok(elapsed < FAST.deadlineMs + 200, `${elapsed} ms`);
  assert.equal(generatorCalls, 0);
  assert.equal(identifyCalls(), 1);
});

test("tjänsten är nere: ett omförsök, sedan 'unavailable' — och ingen generator som gissar i dess ställe", async () => {
  reset(failWith("overloaded"));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.equal(j.identityStatus, "needs_selection");
  assert.deepEqual(j.candidates, []);
  assert.equal(j.identityResult, "unavailable");
  assert.match(j.identityError ?? "", /inte tillgänglig/);
  assert.equal(j.tasks?.identify?.status, "failed");
  assert.equal(identifyCalls(), 2, "ETT omförsök på samma modell, inte fler");
  assert.equal(generatorCalls, 0, "det här var den gamla vägen: en svagare modell fick försöka, utan tidsgräns");
});

test("krediterna är slut: inget omförsök och samma ärliga besked", async () => {
  reset(failWith("billing"));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.equal(j.identityResult, "unavailable");
  assert.equal(identifyCalls(), 1);
  assert.equal(generatorCalls, 0);
});

// ─── Vad som får nå säljaren ────────────────────────────────────────────────

test("troliga och möjliga kandidater med belägg visas — som just det, i modellens ordning, utan att något bekräftas åt säljaren", async () => {
  reset(answer(identifyJson([cand("INGEMAR", "likely"), cand("BRANDON", "possible"), cand("QUATTRO", "possible")], { exactMatch: false })));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.deepEqual(j.candidates?.map((c) => [c.model, c.confidence]), [["INGEMAR", "likely"], ["BRANDON", "possible"], ["QUATTRO", "possible"]]);
  assert.equal(j.identityResult, "candidates");
  assert.equal(j.identityStatus, "needs_selection", "säljaren väljer; inget är avgjort");
  assert.equal(j.identity?.model ?? "", "", "ingen modell är bekräftad");
  await sleep(150);
  assert.equal(specsFor(job.id), 0, "forskning på en modell som bara är ett förslag görs inte");
});

test("en kandidat utan belägg visas aldrig, men de med belägg bredvid den gör det", async () => {
  reset(answer(identifyJson([cand("INGEMAR", "likely"), cand("GISSNING", "possible", { evidence: [] })], { exactMatch: false })));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.deepEqual(j.candidates?.map((c) => c.model), ["INGEMAR"]);
  assert.equal(j.identityResult, "candidates");
});

test("bara kandidater utan belägg: noll kandidater, utfallet 'no_match', modellens egen förklaring under väljaren", async () => {
  reset(answer(identifyJson([cand("BRANDON", "possible", { evidence: [] })], { exactMatch: false, uncertaintyNote: "Armstödens form gick inte att jämföra med någon sida." })));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.deepEqual(j.candidates, []);
  assert.equal(j.identityResult, "no_match");
  assert.match(j.identityError ?? "", /Armstödens form/);
  assert.equal(j.tasks?.identify?.status, "completed", "sökningen blev av och gav ett riktigt svar: ingen träff är inget fel");
  assert.equal(generatorCalls, 0);
});

// ─── Kostnadstaket ──────────────────────────────────────────────────────────

test("ett omval som inte ryms i omgångens budget startas inte — säljaren får veta varför och vad hen kan göra i stället", async () => {
  reset(answer(identifyJson([cand("INGEMAR")])));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  // En identifiering som redan kostat nästan hela säkerhetsbudgeten (30 sökfrågor och tokens ≈ 5,5 SEK).
  await recordCost(job.id, { stage: "identify", label: "identify", model: "gemini-3.8-flash", inputTokens: 9000, outputTokens: 1200, thoughtTokens: 3000, searchQueries: 30, usd: 0.5, ok: true });
  const before = identifyCalls();
  const out = await findMoreCandidates(job.id);
  assert.ok("error" in out, JSON.stringify(out));
  assert.match((out as { error: string }).error, /Kostnadstaket/);
  assert.equal(identifyCalls(), before, "inget betalt anrop startades");
  assert.equal((await getJob(job.id))!.identityStatus, "needs_selection", "listan och läget är orörda");
});

test("specsökningen föll och budgeten är slut: säljaren får ändå ett kort — märkt utan mått och material, inget gissat, ingen generator, kostnad noll", async () => {
  reset(answer(identifyJson([cand("INGEMAR")])));
  plan.specs = failWith("overloaded");
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  // Omgången har redan förbrukat det mesta: en identifiering och ett skick som kostat nästan hela budgeten.
  await recordCost(job.id, { stage: "identify", label: "identify", model: "gemini-3.8-flash", inputTokens: 9000, outputTokens: 1200, thoughtTokens: 3000, searchQueries: 30, usd: 0.52, ok: true });
  await finalizeWithModel(job.id, { kind: "seller_selected", selected: (await getJob(job.id))!.candidates![0] as ModelCandidate });
  const j = (await getJob(job.id))!;
  const listing = (j.result?.listing ?? j.pendingListing)!;
  assert.equal(listing.status, "ok", "ett kort finns, inte 'inte tillgänglig'");
  assert.deepEqual(listing.result?.attributes, [], "inga mått, inget material — varken gissade eller hämtade");
  assert.ok(listing.result?.missingFields?.includes("dimensions"));
  assert.match(listing.result?.missingNotes?.[0] ?? "", /Inget är gissat/);
  assert.equal(generatorCalls, 0, "ingen andra betald sökning när budgeten inte rymmer den");
  assert.equal(j.tasks?.specs?.status, "failed");
  assert.ok(j.incomplete, "kortet är märkt ofullständigt");
  assert.deepEqual(missingForPublish(j).filter((m) => m === "annonstext"), [], "annonstexten finns, så kortet går att komplettera och lägga ut");
});

// ─── Säljaren hinner före ───────────────────────────────────────────────────

test("säljaren skrev modellen själv medan sökningen pågick: det sena svaret skriver aldrig över den, och uppgiften markeras avbruten", async () => {
  reset(async () => {
    await sleep(120);
    return { json: identifyJson([cand("BRANDON")]), text: "", trace: fakeTrace({ estimatedCostUsd: 0.2 }) };
  });
  const job = await newJob();
  const running = runIdentify(job.id, "IKEA", job.images!);
  await sleep(30);
  const mid = (await getJob(job.id))!;
  mid.identityStatus = "resolved";
  mid.identity = { ...(mid.identity ?? { brand: "IKEA" }), model: "INGEMAR" } as ConditionJob["identity"];
  await persist(mid);
  await running;
  const j = (await getJob(job.id))!;
  assert.equal(j.identityStatus, "resolved");
  assert.equal(j.identity?.model, "INGEMAR");
  assert.deepEqual(j.candidates ?? [], [], "det sena förslaget lades inte in");
  assert.equal(j.tasks?.identify?.status, "cancelled");
});

test("en identifiering som föll tar inte skicket med sig: uppgifterna är oberoende och skickets läge står kvar", async () => {
  reset(failWith("billing"));
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  const j = (await getJob(job.id))!;
  assert.equal(j.tasks?.identify?.status, "failed");
  assert.equal(j.tasks?.condition?.status, "running", "skickbedömningen är sin egen uppgift");
});

// ─── Försök igen ────────────────────────────────────────────────────────────

test("'hitta nya' efter ett tomt utfall startar en NY livslängd — och kan lyckas där första försöket inte gjorde det", async () => {
  reset(runsOutOfBudget);
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  assert.equal((await getJob(job.id))!.identityResult, "timeout");

  plan.identify = answer(identifyJson([cand("INGEMAR")]));
  const out = await findMoreCandidates(job.id);
  assert.ok("ok" in out, JSON.stringify(out));
  assert.ok(await waitFor(async () => (await getJob(job.id))?.identityStatus === "needs_selection" && (await getJob(job.id))?.candidateRound === 1, 4_000));
  const j = (await getJob(job.id))!;
  assert.deepEqual(j.candidates?.map((c) => c.model), ["INGEMAR"]);
  assert.equal(j.identityResult, "candidates");
  assert.equal(j.identityTrace?.deadline?.hit, false, "klockan räknades från omtagets start, inte från det första försöket");
  assert.equal(identifyCalls(), 2);
  assert.equal(calls.filter((c) => c.purpose === "identify-fast" || c.purpose === "identify-escalate").length, 0, "inget snabbspår och ingen andra omgång");
});

test("ett omval nollställer utfallet medan det söker: skärmen ska inte visa det gamla tomma läget", async () => {
  reset(hangs);
  const job = await newJob();
  await runIdentify(job.id, "IKEA", job.images!);
  assert.equal((await getJob(job.id))!.identityResult, "timeout");
  const p = findMoreCandidates(job.id);
  await p;
  const mid = (await getJob(job.id))!;
  assert.equal(mid.identityStatus, "identifying");
  assert.equal(mid.identityResult, undefined, "utfallet gäller en körning som är över");
  assert.equal(mid.identityError ?? null, null);
  assert.equal(mid.tasks?.identify?.status, "running", "uppgiften startas om");
  // Låt omtaget löpa ut så att inget hänger kvar efter testet.
  assert.ok(await waitFor(async () => (await getJob(job.id))?.identityStatus === "needs_selection", 4_000));
});
