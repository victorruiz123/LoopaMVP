// ─── Strömmat anrop med budgetar: det den första skarpa körningen visade saknades ──────────────────
//
// 2026-10-11 tog identifieringen 205 s och föll med "Model generated too many tool calls". Tre saker
// gick inte att se eller styra: vilka sökningar modellen gjorde, att tidsgränsen på 90 s aldrig
// verkställdes (SDK:ns AbortSignal-kedja höll inte).
// Testerna nedan kör runnern mot ett falskt Interactions-API som ger strömmar i den form tjänsten
// ger dem, och låser fast: att tiden verkställs PÅ STRÖMMEN, att sökfrågor räknas medan de sker,
// att ett anrop är ETT försök (inget omförsök, ingen säkring, ingen reservmodell — varje försök är betalt arbete, se
// cost/ledger.ts), och att spåret på disk aldrig bär bilder eller nycklar.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classify,
  computeTimings,
  consume,
  InteractionError,
  persistTrace,
  runInteraction,
  testHooks,
  usageFrom,
} from "../server/src/research/geminiInteractions.js";
import {
  answerEvents,
  completedEvent,
  fakeTrace,
  httpError,
  scriptedClient,
  searchEvents,
  successfulRun,
  thoughtEvents,
  TOOL_LIMIT_MESSAGE,
  urlEvents,
  type Ev,
} from "./helpers/fakeGemini.js";

const traceDir = mkdtempSync(path.join(tmpdir(), "loopa-traces-"));
process.env.LOOPA_RESEARCH_TRACE_DIR = traceDir;
after(() => {
  testHooks.client = null;
  rmSync(traceDir, { recursive: true, force: true });
});
beforeEach(() => {
  testHooks.client = null;
});

const IMG = { mimeType: "image/jpeg", base64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" };
const baseReq = {
  purpose: "identify",
  label: "test0001",
  systemInstruction: "sys",
  prompt: "Brand: IKEA",
  images: [IMG, IMG],
  schema: { type: "object" },
  thinkingLevel: "medium" as const,
  timeoutMs: 5_000,
};
const JSON_OK = { candidates: [], answer: true };

async function* stream(events: Ev[], hang = false) {
  for (const e of events) yield e;
  if (hang) await new Promise<never>(() => {});
}
const ctl = (over: Partial<Parameters<typeof consume>[1]> = {}) => ({ startedAt: Date.now(), budgetMs: 5_000, maxSearchQueries: null, ...over });

// ─── consume ────────────────────────────────────────────────────────────────

test("ett lyckat anrop blir steg, frågor, adresser med status, text och användning", async () => {
  const events = successfulRun(JSON_OK, {
    queries: [["white chair vertical slats grey seat"], ["chair blocket vit stol spjälor"]],
    urls: [[{ url: "https://www.ikea.com/se/sv/p/x/", status: "success" }, { url: "https://dead.example/x", status: "error" }]],
    usage: { input: 9000, output: 1000, thought: 3000, toolUse: 1500, searches: 2 },
    citations: ["https://www.ikea.com/se/sv/p/x/"],
  });
  const out = await consume(stream(events), ctl());
  assert.equal(out.stoppedBy, "completed");
  assert.equal(out.error, null);
  assert.equal(out.status, "completed");
  assert.deepEqual(out.steps.filter((s) => s.queries).flatMap((s) => s.queries), ["white chair vertical slats grey seat", "chair blocket vit stol spjälor"]);
  const urlStep = out.steps.find((s) => s.type === "url_context_call")!;
  assert.deepEqual(urlStep.urls, [
    { url: "https://www.ikea.com/se/sv/p/x/", status: "success" },
    { url: "https://dead.example/x", status: "error" },
  ]);
  assert.equal(JSON.parse(out.text).answer, true);
  assert.deepEqual(out.citations.map((c) => c.url), ["https://www.ikea.com/se/sv/p/x/"]);
  assert.equal(out.thoughts[0], "Jämför ryggen.");
  assert.equal(out.steps.every((s) => s.endMs !== null), true);

  const usage = usageFrom(out.usage, 2);
  assert.equal(usage.inputTokens, 10_500, "verktygstokens räknas som indata");
  assert.equal(usage.outputTokens, 1000);
  assert.equal(usage.thoughtTokens, 3000);
  assert.equal(usage.searchQueries, 2);
});

test("tidsbudgeten verkställs på strömmen, även när strömmen aldrig ger något mer", async () => {
  const t0 = Date.now();
  const out = await consume(stream([...searchEvents(0, ["a"])], true), ctl({ budgetMs: 300 }));
  const elapsed = Date.now() - t0;
  assert.equal(out.stoppedBy, "time_budget");
  assert.equal(out.error?.kind, "timeout");
  assert.ok(elapsed >= 250 && elapsed < 1500, `avbröts efter ${elapsed} ms`);
  assert.equal(out.steps.length, 2, "det som hunnit hända finns kvar i spåret");
});

test("sökfrågor räknas medan de sker, och gränsen avbryter anropet", async () => {
  let cancelled = false;
  const events: Ev[] = [...searchEvents(0, ["q1", "q2", "q3"]), ...searchEvents(2, ["q4", "q5"]), ...searchEvents(4, ["q6"]), ...searchEvents(6, ["q7"])];
  const out = await consume(stream(events, true), ctl({ maxSearchQueries: 5, cancel: () => (cancelled = true) }));
  assert.equal(out.stoppedBy, "tool_budget");
  assert.equal(out.error?.kind, "tool_budget");
  assert.ok(cancelled, "strömmen stängdes");
  const queries = out.steps.flatMap((s) => s.queries ?? []);
  assert.equal(queries.length, 6, "avbröts när den sjätte frågan syntes, inte efteråt");
});

test("ett fel mitt i strömmen läses som fel, och 'too many tool calls' får sin egen art", async () => {
  const events: Ev[] = [...searchEvents(0, ["a"]), { event_type: "error", error: { code: "400", message: TOOL_LIMIT_MESSAGE } }];
  const out = await consume(stream(events, true), ctl());
  assert.equal(out.stoppedBy, "error");
  assert.equal(out.error?.kind, "tool_limit");
  assert.match(out.error!.message, /too many tool calls/);
});

test("ett anrop som avslutas som 'failed' är ett fel", async () => {
  const out = await consume(stream([{ event_type: "interaction.status_update", status: "failed" }]), ctl());
  assert.equal(out.stoppedBy, "error");
});

// ─── tider ──────────────────────────────────────────────────────────────────

test("tidsfördelningen: parallella sökningar räknas en gång, sidhämtning och modell hålls isär", () => {
  const steps = [
    { type: "google_search_call", id: "a", startMs: 1000, endMs: 1100 },
    { type: "google_search_call", id: "b", startMs: 1050, endMs: 1150 },
    { type: "google_search_result", callId: "a", startMs: 1100, endMs: 3000 },
    { type: "google_search_result", callId: "b", startMs: 1150, endMs: 3500 },
    { type: "url_context_call", id: "c", startMs: 4000, endMs: 4100 },
    { type: "url_context_result", callId: "c", startMs: 4100, endMs: 6000 },
    { type: "model_output", startMs: 7000, endMs: 9000 },
  ];
  const t = computeTimings(steps, 10_000);
  assert.equal(t.searchMs, 2500, "1000→3500, inte 2000 + 2450");
  assert.equal(t.urlFetchMs, 2000);
  assert.equal(t.modelMs, 10_000 - 2500 - 2000);
  assert.equal(t.firstEventMs, 1000);
});

// ─── felklassning ───────────────────────────────────────────────────────────

test("felen får rätt art: krediter, kvot, överbelastning, tool-gräns, timeout", () => {
  assert.equal(classify(httpError(402, "Your prepayment credits are depleted. Please go to AI Studio")).kind, "billing");
  assert.equal(classify(new Error("402 API error occurred: {}")).kind, "billing");
  assert.equal(classify(httpError(429, "RESOURCE_EXHAUSTED quota")).kind, "quota");
  assert.equal(classify(httpError(503, "The model is overloaded")).kind, "overloaded");
  assert.equal(classify(httpError(400, TOOL_LIMIT_MESSAGE)).kind, "tool_limit");
  assert.equal(classify(Object.assign(new Error("Request aborted by client"), { name: "APIUserAbortError" })).kind, "timeout");
  assert.equal(classify(new Error("fetch failed")).kind, "network");
});

// ─── runInteraction ─────────────────────────────────────────────────────────

test("begäran är byggd som tjänsten kräver: ström, ingen lagring, schema, tänkande, bildupplösning, verktyg", async () => {
  const { client, calls } = scriptedClient([{ events: successfulRun(JSON_OK) }]);
  testHooks.client = client;
  const out = await runInteraction({ ...baseReq, images: [{ ...IMG, resolution: "high" }, IMG] });
  assert.deepEqual(out.json, JSON_OK);
  const p = calls[0].params;
  assert.equal(p.stream, true);
  assert.equal(p.store, false);
  assert.equal(p.model, "gemini-3.8-flash");
  assert.deepEqual(p.tools, [{ type: "google_search" }, { type: "url_context" }]);
  assert.equal(p.generation_config.thinking_level, "medium");
  assert.equal(p.generation_config.thinking_summaries, "auto");
  assert.equal(p.response_format.mime_type, "application/json");
  assert.equal(p.system_instruction, "sys");
  assert.equal(p.input[0].type, "text");
  assert.equal(p.input[1].type, "image");
  assert.equal(p.input[1].resolution, "high");
  assert.equal(p.input[2].resolution, undefined);
  assert.equal(out.trace.attempts, 1);
  assert.equal(out.trace.reduced, false);
  assert.equal(out.trace.toolCalls, 1);
  assert.equal(out.trace.settings.images, 2);
});

test("search_types går med till verktyget när de begärs", async () => {
  const { client, calls } = scriptedClient([{ events: successfulRun(JSON_OK) }]);
  testHooks.client = client;
  await runInteraction({ ...baseReq, tools: [{ type: "google_search", search_types: ["web_search", "image_search"] }] });
  assert.deepEqual(calls[0].params.tools, [{ type: "google_search", search_types: ["web_search", "image_search"] }]);
});

test("'too many tool calls' vid anslutningen är ett fel med sin art — och ETT anrop: inget omförsök med strängare uppdrag", async () => {
  const { client, calls } = scriptedClient([{ throwOnCreate: httpError(400, TOOL_LIMIT_MESSAGE) }, { events: successfulRun(JSON_OK) }]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction({ ...baseReq, thinkingLevel: "high" }),
    (e: unknown) => e instanceof InteractionError && e.kind === "tool_limit" && e.trace !== null,
  );
  assert.equal(calls.length, 1, "ett försök, inte två: det andra hade varit en andra räkning för samma fråga");
  assert.equal(calls[0].params.generation_config.thinking_level, "high");
});

test("'too many tool calls' mitt i strömmen behandlas likadant: felet kastas med spåret fram till dess", async () => {
  const { client, calls } = scriptedClient([
    { events: [...searchEvents(0, ["a"]), { event_type: "error", error: { code: "400", message: TOOL_LIMIT_MESSAGE } }] },
    { events: successfulRun(JSON_OK) },
  ]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction(baseReq),
    (e: unknown) => {
      if (!(e instanceof InteractionError) || e.kind !== "tool_limit" || !e.trace) return false;
      assert.equal(e.trace.toolCalls, 1, "misslyckandets spår följer med: en sökning hann göras");
      assert.equal(e.trace.searchQueries.length, 1);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("vår egen sökfrågegräns avbryter ett skenande anrop: tool_budget, ett anrop, och spåret säger vilken gräns som gällde", async () => {
  const runaway: Ev[] = [];
  for (let i = 0; i < 10; i++) runaway.push(...searchEvents(i * 2, [`query ${i}`]));
  const { client, calls } = scriptedClient([{ events: runaway, hang: true } as never, { events: successfulRun(JSON_OK, { queries: [["one"]] }) }]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction({ ...baseReq, maxSearchQueries: 4 }),
    (e: unknown) => {
      if (!(e instanceof InteractionError) || e.kind !== "tool_budget" || !e.trace) return false;
      assert.equal(e.trace.settings.maxSearchQueries, 4);
      assert.equal(e.trace.stoppedBy, "tool_budget");
      assert.equal(e.trace.attempts, 1);
      assert.equal(e.trace.reduced, false);
      return true;
    },
  );
  assert.equal(calls.length, 1, "inget omförsök: ett omförsök är en andra räkning");
});

test("ett avbrutet anrop rapporterar ingen användning: indata uppskattas, sökfrågorna är exakta, kostnaden är en nedre gräns", async () => {
  const runaway: Ev[] = [];
  for (let i = 0; i < 10; i++) runaway.push(...searchEvents(i * 2, [`query ${i}`]));
  const { client } = scriptedClient([{ events: runaway, hang: true } as never]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction({ ...baseReq, maxSearchQueries: 4 }),
    (e: unknown) => {
      if (!(e instanceof InteractionError) || !e.trace) return false;
      const u = e.trace.usage;
      // Förut stod det "in=0 ut=0 cost≈$0.448": tokens som såg ut att vara noll, inte okända.
      assert.equal(u.tokensEstimated, true);
      assert.ok(u.inputTokens > 0, "bilder och prompt är uppskattade");
      assert.equal(u.searchQueries, e.trace.searchQueries.length, "sökfrågorna är räknade ur tidslinjen, inte uppskattade");
      assert.ok(e.trace.estimatedCostUsd > 0);
      return true;
    },
  );
});

test("en tidsbudget som tog slut medan modellen sökte ger ett timeout-fel med spåret — inget omförsök", async () => {
  const { client, calls } = scriptedClient([{ events: searchEvents(0, ["a"]), hang: true } as never, { events: successfulRun(JSON_OK) }]);
  testHooks.client = client;
  const t0 = Date.now();
  await assert.rejects(
    () => runInteraction({ ...baseReq, timeoutMs: 600 }),
    (e: unknown) => e instanceof InteractionError && e.kind === "timeout" && e.trace?.stoppedBy === "time_budget" && e.trace.searchQueries.length === 1,
  );
  assert.ok(Date.now() - t0 < 1_500, "inom livslängden");
  assert.equal(calls.length, 1);
});

test("ett anrop som hänger utan att ha gjort något ger ett timeout-fel efter sin livslängd", async () => {
  const { client, calls } = scriptedClient([{ events: [], hang: true } as never]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction({ ...baseReq, timeoutMs: 600 }),
    (e: unknown) => e instanceof InteractionError && e.kind === "timeout",
  );
  assert.equal(calls.length, 1);
});

test("kvot och överbelastning kastas som sina arter — det finns ingen reservmodell att byta till", async () => {
  for (const [status, text, kind] of [[429, "RESOURCE_EXHAUSTED quota", "quota"], [503, "UNAVAILABLE overloaded", "overloaded"]] as const) {
    const { client, calls } = scriptedClient([{ throwOnCreate: httpError(status, text) }, { events: successfulRun(JSON_OK) }]);
    testHooks.client = client;
    await assert.rejects(
      () => runInteraction({ ...baseReq, model: "primary-model" }),
      (e: unknown) => e instanceof InteractionError && e.kind === kind && e.trace !== null,
    );
    assert.equal(calls.length, 1, kind);
    assert.equal(calls[0].params.model, "primary-model");
  }
});

test("slut på krediter (402) är ett fel med sin art, och inget anrop till", async () => {
  const { client, calls } = scriptedClient([{ throwOnCreate: httpError(402, "Your prepayment credits are depleted.") }]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction(baseReq),
    (e: unknown) => e instanceof InteractionError && e.kind === "billing" && e.trace !== null,
  );
  assert.equal(calls.length, 1);
});

test("ett fall är ett fall: ett anrop, ett fel — aldrig ett andra försök", async () => {
  const { client, calls } = scriptedClient([{ throwOnCreate: httpError(400, TOOL_LIMIT_MESSAGE) }, { throwOnCreate: httpError(400, TOOL_LIMIT_MESSAGE) }]);
  testHooks.client = client;
  await assert.rejects(() => runInteraction(baseReq), (e: unknown) => e instanceof InteractionError && e.kind === "tool_limit");
  assert.equal(calls.length, 1);
});

test("ett svar utan text är ett fel, med spåret kvar", async () => {
  const { client } = scriptedClient([{ events: [...searchEvents(0, ["a"]), completedEvent()] }]);
  testHooks.client = client;
  await assert.rejects(
    () => runInteraction(baseReq),
    (e: unknown) => e instanceof InteractionError && e.kind === "empty" && (e.trace?.searchQueries.length ?? 0) === 1,
  );
});

test("svaret utan schema lämnas som text, inte tolkat", async () => {
  const { client, calls } = scriptedClient([{ events: [...thoughtEvents(0, "t"), ...answerEvents(1, "fritt svar"), completedEvent()] }]);
  testHooks.client = client;
  const out = await runInteraction({ ...baseReq, schema: null });
  assert.equal(out.text, "fritt svar");
  assert.equal(out.json, null);
  assert.equal(calls[0].params.response_format, undefined);
});

test("spåret på disk bär sökfrågor, adresser och tider — aldrig bilder, nyckel eller prompt", async () => {
  // Spåren skrivs utan att väntas in; låt de från tidigare tester landa innan vi städar.
  await new Promise((r) => setTimeout(r, 300));
  for (const f of readdirSync(traceDir)) rmSync(path.join(traceDir, f), { recursive: true, force: true });
  process.env.GEMINI_API_KEY = "AIzaSyTESTKEY-should-never-be-written";
  const { client } = scriptedClient([
    { events: successfulRun(JSON_OK, { queries: [["white chair slats"]], urls: [[{ url: "https://www.ikea.com/x", status: "success" }]] }) },
  ]);
  testHooks.client = client;
  await runInteraction({ ...baseReq, label: "abcd1234", prompt: "Seller note: private details here" });
  // persistTrace körs utan att väntas in: ge den en stund.
  await new Promise((r) => setTimeout(r, 150));
  const files = readdirSync(traceDir).filter((f) => f.includes("abcd1234"));
  assert.equal(files.length, 1);
  assert.match(files[0], /abcd1234-identify-a1\.json$/);
  const raw = readFileSync(path.join(traceDir, files[0]), "utf8");
  const saved = JSON.parse(raw);
  assert.deepEqual(saved.trace.searchQueries, ["white chair slats"]);
  assert.equal(saved.trace.fetchedUrls[0].url, "https://www.ikea.com/x");
  assert.ok(saved.trace.timings.totalMs >= 0);
  assert.ok(saved.output.includes("answer"));
  assert.ok(!raw.includes(IMG.base64), "ingen bilddata");
  assert.ok(!raw.includes("AIzaSy"), "ingen API-nyckel");
  assert.ok(!raw.includes("private details"), "ingen prompt");
  delete process.env.GEMINI_API_KEY;
});

test("persistTrace tål att katalogen inte går att skriva — ett loggfel fäller aldrig anropet", async () => {
  const old = process.env.LOOPA_RESEARCH_TRACE_DIR;
  process.env.LOOPA_RESEARCH_TRACE_DIR = path.join(traceDir, "finns-som-fil", "x");
  writeFileSync(path.join(traceDir, "finns-som-fil"), "x");
  await persistTrace(fakeTrace());
  process.env.LOOPA_RESEARCH_TRACE_DIR = old;
});

test("LOOPA_RESEARCH_TRACE=0 stänger av spåren", async () => {
  await new Promise((r) => setTimeout(r, 300));
  for (const f of readdirSync(traceDir)) rmSync(path.join(traceDir, f), { recursive: true, force: true });
  process.env.LOOPA_RESEARCH_TRACE = "0";
  await persistTrace(fakeTrace());
  delete process.env.LOOPA_RESEARCH_TRACE;
  assert.equal(readdirSync(traceDir).length, 0);
});

test("urlEvents och searchEvents i hjälparen följer den uppmätta formen", () => {
  const e = searchEvents(0, ["q"]);
  assert.equal((e[0] as any).step.type, "google_search_call");
  assert.equal((e[3] as any).step.call_id, (e[0] as any).step.id);
  assert.equal((urlEvents(0, [{ url: "https://a", status: "success" }])[4] as any).delta.result[0].status, "success");
});

// ─── Detaljer i strömläsningen som inte gick att pröva skarpt ───────────────────────────────────────

test("svaret är det SISTA model_output-steget — en inledande rad före sökningen stör inte JSON-tolkningen", async () => {
  const events: Ev[] = [
    ...answerEvents(0, "Jag söker efter modellen {först}."),
    ...searchEvents(1, ["a"]),
    ...answerEvents(3, JSON.stringify({ candidates: [], answer: true })),
    completedEvent(),
  ];
  const { client } = scriptedClient([{ events }]);
  testHooks.client = client;
  const out = await runInteraction(baseReq);
  assert.deepEqual(out.json, { candidates: [], answer: true });
});

test("sidhämtningens resultat läses både när de kommer på step.start och på step.delta", async () => {
  const early: Ev[] = [
    { event_type: "step.start", index: 0, step: { id: "u1", type: "url_context_call" } },
    { event_type: "step.delta", index: 0, delta: { type: "url_context_call", arguments: { urls: ["https://a.example/1", "https://b.example/2"] } } },
    { event_type: "step.stop", index: 0 },
    // Resultatet i själva step.start-objektet:
    { event_type: "step.start", index: 1, step: { call_id: "u1", type: "url_context_result", result: [{ url: "https://a.example/1", status: "success" }] } },
    { event_type: "step.stop", index: 1 },
    // Och resten i en delta:
    { event_type: "step.start", index: 2, step: { call_id: "u1", type: "url_context_result" } },
    { event_type: "step.delta", index: 2, delta: { type: "url_context_result", result: [{ url: "https://b.example/2", status: "paywall" }] } },
    { event_type: "step.stop", index: 2 },
  ];
  const out = await consume(stream(early), ctl());
  const call = out.steps.find((s) => s.type === "url_context_call")!;
  assert.deepEqual(call.urls, [
    { url: "https://a.example/1", status: "success" },
    { url: "https://b.example/2", status: "paywall" },
  ]);
});

test("verktygstokens räknas som indata bara när total_tokens visar att de ligger vid sidan av", () => {
  // Vid sidan av: total = in + ut + tänk + verktyg.
  const separate = usageFrom({ total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 200, total_tool_use_tokens: 500, total_tokens: 1800 }, 0);
  assert.equal(separate.inputTokens, 1500);
  // Redan inräknade: total = in + ut + tänk.
  const included = usageFrom({ total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 200, total_tool_use_tokens: 500, total_tokens: 1300 }, 0);
  assert.equal(included.inputTokens, 1000);
  // Inget besked alls: hellre överskatta kostnaden än underskatta den.
  assert.equal(usageFrom({ total_input_tokens: 1000, total_tool_use_tokens: 500 }, 0).inputTokens, 1500);
});

test("fakturerade sökfrågor räknas ur search_query_count, inte ur antalet anrop", () => {
  const u = usageFrom({ grounding_tool_count: [{ type: "google_search", count: 2, search_query_count: 7 }, { type: "google_maps", count: 3 }] }, 1);
  assert.equal(u.searchQueries, 7);
  assert.equal(usageFrom({}, 4).searchQueries, 4, "utan besked räknas tidslinjens frågor");
});

test("en avbrytning som anroparen beställt provas inte om, och är inte en timeout", async () => {
  const controller = new AbortController();
  const { client, calls } = scriptedClient([{ events: searchEvents(0, ["a"]), hang: true } as never, { events: successfulRun(JSON_OK) }]);
  testHooks.client = client;
  setTimeout(() => controller.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(
    () => runInteraction({ ...baseReq, timeoutMs: 5_000, signal: controller.signal }),
    (e: unknown) => e instanceof InteractionError && e.kind === "aborted",
  );
  assert.ok(Date.now() - t0 < 1_000, "avbrytningen märks direkt på strömmen, inte först när budgeten tar slut");
  assert.equal(calls.length, 1, "en beställd avbrytning ger inget nytt anrop");
});

test("ett anrop vars svarshuvud aldrig kommer avbryts på budgeten — inte på SDK:ns goda vilja", async () => {
  const { client, calls } = scriptedClient([{ neverOpens: true }]);
  testHooks.client = client;
  const t0 = Date.now();
  await assert.rejects(
    () => runInteraction({ ...baseReq, timeoutMs: 600 }),
    (e: unknown) => e instanceof InteractionError && e.kind === "timeout" && e.trace !== null,
  );
  assert.ok(Date.now() - t0 < 1_500, `gav upp efter ${Date.now() - t0} ms`);
  assert.equal(calls.length, 1);
});
