// ─── Runnern genom den RIKTIGA SDK:n mot riktig HTTP ─────────────────────────────────────────────────
//
// research-runner.test.ts kör mot en falsk klient — en async-generator. Det prövar logiken men inte
// mötet med SDK:ns egen Stream-klass, dess felobjekt eller dess avbrott. Här startas en liten lokal
// HTTP-server som talar Server-Sent Events i den form tjänsten gav i en riktig körning, och den
// riktiga @google/genai pekas dit (LOOPA_GEMINI_BASE_URL). Det är inte Googles tjänst — formen på
// händelserna och felen är det vi sett och det SDK:ns typer säger — men det är den riktiga SDK:n och
// riktiga sockets, och det är där tidsgränsen i den första skarpa körningen föll bort:
//
//   UPPMÄTT (SDK 2.19.0, Node 24, server som aldrig svarar): ett icke-strömmat anrop med AbortSignal
//   avbröts på 5 s men inte på 15 s; en ström avbröts på 28 s och stängde anslutningen direkt; SDK:ns
//   egen `timeout` avbröt ett öppnande men aldrig en pågående ström. Testerna låser att runnern håller
//   sin budget oavsett.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const traceDir = mkdtempSync(path.join(tmpdir(), "loopa-http-traces-"));
process.env.LOOPA_RESEARCH_TRACE_DIR = traceDir;
process.env.GEMINI_API_KEY = "test-key-not-real";

let server: http.Server;
const seen: Array<{ scenario: string; model: string; thinking: string; prompt: string; stream: boolean }> = [];
const closed: Record<string, number> = {};
const counters: Record<string, number> = {};

const TOOL_LIMIT = "Model generated too many tool calls. Please retry the request. If the issue persists, include this error message in the retry prompt to allow the model to call a valid number of tools.";

function sse(res: http.ServerResponse, ev: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function searchSteps(res: http.ServerResponse, index: number, queries: string[]) {
  const id = `c${index}`;
  sse(res, { event_type: "step.start", index, step: { id, type: "google_search_call", search_type: "web_search" } });
  sse(res, { event_type: "step.delta", index, delta: { type: "google_search_call", arguments: { queries } } });
  sse(res, { event_type: "step.stop", index });
  sse(res, { event_type: "step.start", index: index + 1, step: { call_id: id, type: "google_search_result" } });
  sse(res, { event_type: "step.stop", index: index + 1 });
}

function finish(res: http.ServerResponse, json: unknown) {
  sse(res, { event_type: "step.start", index: 10, step: { type: "model_output" } });
  sse(res, { event_type: "step.delta", index: 10, delta: { type: "text", text: JSON.stringify(json) } });
  sse(res, { event_type: "step.stop", index: 10 });
  sse(res, {
    event_type: "interaction.completed",
    interaction: {
      status: "completed",
      usage: { total_input_tokens: 5000, total_output_tokens: 300, total_thought_tokens: 900, total_tokens: 6200, grounding_tool_count: [{ type: "google_search", count: 1, search_query_count: 2 }] },
    },
  });
  res.end();
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const prompt: string = body.input?.[0]?.text ?? "";
      const scenario = /SCENARIO:([\w-]+)/.exec(prompt)?.[1] ?? "ok";
      counters[scenario] = (counters[scenario] ?? 0) + 1;
      const n = counters[scenario];
      seen.push({ scenario, model: body.model, thinking: body.generation_config?.thinking_level, prompt, stream: body.stream === true });
      res.on("close", () => (closed[`${scenario}#${n}`] = Date.now()));

      const sendError = (status: number, message: string, code: string) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: status, message, status: code } }));
      };
      switch (scenario) {
        case "no-headers":
          return; // aldrig ett svar
        case "billing":
          return sendError(402, "Your prepayment credits are depleted. Please go to AI Studio.", "RESOURCE_EXHAUSTED");
        case "overloaded":
          if (n === 1) return sendError(503, "The model is overloaded. Please try again later.", "UNAVAILABLE");
          break;
        case "tool-limit":
          if (n === 1) return sendError(400, TOOL_LIMIT, "INVALID_ARGUMENT");
          break;
        default:
          break;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sse(res, { event_type: "interaction.created", interaction: { object: "interaction", model: body.model } });
      sse(res, { event_type: "interaction.status_update", status: "in_progress" });
      if (scenario === "hang-after-search") {
        searchSteps(res, 0, ["white chair vertical slats"]);
        return; // och sedan tystnad
      }
      if (scenario === "runaway") {
        for (let i = 0; i < 12; i++) searchSteps(res, i * 2, [`query ${i} a`, `query ${i} b`]);
        return;
      }
      searchSteps(res, 0, ["white chair vertical slats", "chair blocket"]);
      sse(res, { event_type: "step.start", index: 4, step: { type: "thought" } });
      sse(res, { event_type: "step.delta", index: 4, delta: { type: "thought_summary", content: { type: "text", text: "Jämför ryggen." } } });
      sse(res, { event_type: "step.stop", index: 4 });
      finish(res, { candidates: [], answer: scenario });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LOOPA_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(traceDir, { recursive: true, force: true });
});

const IMG = { mimeType: "image/jpeg", base64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" };
const req = (scenario: string, over: Record<string, unknown> = {}) => ({
  purpose: "identify",
  label: `http-${scenario}`.slice(0, 12),
  systemInstruction: "sys",
  prompt: `SCENARIO:${scenario} Brand: IKEA`,
  images: [IMG],
  schema: { type: "object" },
  thinkingLevel: "medium" as const,
  timeoutMs: 4_000,
  ...over,
});

async function load() {
  return import("../server/src/research/geminiInteractions.js");
}

test("riktig SDK, riktig ström: steg, frågor, svar och användning kommer fram", async () => {
  const { runInteraction } = await load();
  const out = await runInteraction(req("ok"));
  assert.deepEqual(out.json, { candidates: [], answer: "ok" });
  assert.deepEqual(out.trace.searchQueries, ["white chair vertical slats", "chair blocket"]);
  assert.equal(out.trace.usage.searchQueries, 2, "fakturerade frågor ur search_query_count");
  assert.equal(out.trace.usage.inputTokens, 5000);
  assert.equal(out.trace.thoughtSummary, "Jämför ryggen.");
  assert.equal(out.trace.attempts, 1);
  const first = seen.find((s) => s.scenario === "ok")!;
  assert.equal(first.stream, true);
  assert.equal(first.model, "gemini-3.8-flash");
});

test("ett anrop som hänger efter en sökning avbryts på budgeten, och anslutningen stängs hos servern", async () => {
  const { runInteraction, InteractionError } = await load();
  const t0 = Date.now();
  await assert.rejects(
    () => runInteraction(req("hang-after-search", { timeoutMs: 1_500 })),
    (e: unknown) => e instanceof InteractionError && e.kind === "timeout" && (e.trace?.searchQueries.length ?? 0) === 1,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1_100 && elapsed < 2_500, `avbröts efter ${elapsed} ms`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(closed["hang-after-search#1"], "servern såg anslutningen stängas — vi lämnade den inte hängande");
});

test("ett svarshuvud som aldrig kommer: budgeten gäller redan vid öppnandet", async () => {
  const { runInteraction, InteractionError } = await load();
  const t0 = Date.now();
  await assert.rejects(
    () => runInteraction(req("no-headers", { timeoutMs: 1_200 })),
    (e: unknown) => e instanceof InteractionError && e.kind === "timeout",
  );
  assert.ok(Date.now() - t0 < 2_500, `gav upp efter ${Date.now() - t0} ms`);
});

test("en runaway-ström (24 frågor) avbryts vid sökfrågegränsen medan den pågår", async () => {
  const { runInteraction, InteractionError } = await load();
  await assert.rejects(
    () => runInteraction(req("runaway", { maxSearchQueries: 6 })),
    (e: unknown) => e instanceof InteractionError && e.kind === "tool_budget" && (e.trace?.searchQueries.length ?? 99) <= 8,
  );
});

test("'too many tool calls' som ett riktigt HTTP 400 är ett tool_limit-fel med spår — genom den riktiga SDK:ns felobjekt, och ETT anrop", async () => {
  const { runInteraction, InteractionError } = await load();
  await assert.rejects(
    () => runInteraction(req("tool-limit", { thinkingLevel: "high" })),
    (e: unknown) => e instanceof InteractionError && e.kind === "tool_limit" && e.status === 400 && e.trace !== null,
  );
  const calls = seen.filter((s) => s.scenario === "tool-limit");
  assert.equal(calls.length, 1, "inget omförsök: det hade varit en andra räkning");
  assert.equal(calls[0].thinking, "high");
});

test("HTTP 503 är ett overloaded-fel med spår — inget byte av modell, ett anrop", async () => {
  const { runInteraction, InteractionError } = await load();
  await assert.rejects(
    () => runInteraction(req("overloaded", { model: "primary-model" })),
    (e: unknown) => e instanceof InteractionError && e.kind === "overloaded",
  );
  const calls = seen.filter((s) => s.scenario === "overloaded");
  assert.deepEqual(calls.map((c) => c.model), ["primary-model"]);
});

test("HTTP 402 — krediterna slut — är ett billing-fel som aldrig provas om", async () => {
  const { runInteraction, InteractionError } = await load();
  await assert.rejects(
    () => runInteraction(req("billing")),
    (e: unknown) => e instanceof InteractionError && e.kind === "billing",
  );
  assert.equal(seen.filter((s) => s.scenario === "billing").length, 1);
});
