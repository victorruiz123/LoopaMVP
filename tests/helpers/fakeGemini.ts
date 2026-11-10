/**
 * Ett falskt Interactions-API för tester: ger strömmar i exakt den form Googles tjänst ger dem
 * (step.start / step.delta / step.stop / interaction.completed), och fel i de former de faktiskt
 * kommer — inklusive "Model generated too many tool calls" både som fel vid anslutning och som
 * händelse mitt i strömmen.
 *
 * Händelseformerna är de uppmätta ur en riktig körning 2026-10-11 (se server/src/research/
 * geminiInteractions.ts): google_search_call bär sina frågor i en step.delta, resultatsteget bär
 * call_id, och interaction.completed bär usage med grounding_tool_count.
 */

import type { InteractionsClient } from "../../server/src/research/geminiInteractions.js";
import type { ResearchTrace } from "../../server/src/research/types.js";

export type Ev = Record<string, unknown>;

let counter = 0;
const id = () => `call_${++counter}`;

/** En sökning: anrop (med frågor) + resultat. */
export function searchEvents(startIndex: number, queries: string[]): Ev[] {
  const callId = id();
  return [
    { event_type: "step.start", index: startIndex, step: { id: callId, type: "google_search_call", search_type: "web_search", signature: "" } },
    { event_type: "step.delta", index: startIndex, delta: { type: "google_search_call", arguments: { queries }, signature: "x" } },
    { event_type: "step.stop", index: startIndex },
    { event_type: "step.start", index: startIndex + 1, step: { call_id: callId, type: "google_search_result", signature: "" } },
    { event_type: "step.delta", index: startIndex + 1, delta: { type: "google_search_result", signature: "x" } },
    { event_type: "step.stop", index: startIndex + 1 },
  ];
}

/** En sidhämtning: anrop med adresser + resultat med status per adress. */
export function urlEvents(startIndex: number, urls: Array<{ url: string; status: string }>): Ev[] {
  const callId = id();
  return [
    { event_type: "step.start", index: startIndex, step: { id: callId, type: "url_context_call", signature: "" } },
    { event_type: "step.delta", index: startIndex, delta: { type: "url_context_call", arguments: { urls: urls.map((u) => u.url) }, signature: "x" } },
    { event_type: "step.stop", index: startIndex },
    { event_type: "step.start", index: startIndex + 1, step: { call_id: callId, type: "url_context_result", signature: "" } },
    { event_type: "step.delta", index: startIndex + 1, delta: { type: "url_context_result", result: urls, signature: "x" } },
    { event_type: "step.stop", index: startIndex + 1 },
  ];
}

export function thoughtEvents(index: number, text: string): Ev[] {
  return [
    { event_type: "step.start", index, step: { type: "thought" } },
    { event_type: "step.delta", index, delta: { type: "thought_summary", content: { type: "text", text } } },
    { event_type: "step.stop", index },
  ];
}

export function answerEvents(index: number, text: string, citations: string[] = []): Ev[] {
  const mid = Math.floor(text.length / 2);
  return [
    { event_type: "step.start", index, step: { type: "model_output" } },
    { event_type: "step.delta", index, delta: { type: "text", text: text.slice(0, mid) } },
    { event_type: "step.delta", index, delta: { type: "text", text: text.slice(mid) } },
    ...(citations.length
      ? [{ event_type: "step.delta", index, delta: { type: "text_annotation_delta", annotations: citations.map((url) => ({ type: "url_citation", url, title: "t" })) } }]
      : []),
    { event_type: "step.stop", index },
  ];
}

export interface UsageSpec {
  input?: number;
  output?: number;
  thought?: number;
  toolUse?: number;
  searches?: number;
}

export function completedEvent(usage: UsageSpec = {}, status = "completed"): Ev {
  const total = (usage.input ?? 8000) + (usage.output ?? 900) + (usage.thought ?? 2500) + (usage.toolUse ?? 0);
  return {
    event_type: "interaction.completed",
    interaction: {
      status,
      usage: {
        total_input_tokens: usage.input ?? 8000,
        total_output_tokens: usage.output ?? 900,
        total_thought_tokens: usage.thought ?? 2500,
        total_tool_use_tokens: usage.toolUse ?? 0,
        total_tokens: total,
        grounding_tool_count: [{ type: "google_search", count: usage.searches ?? 3, search_query_count: usage.searches ?? 3 }],
      },
    },
  };
}

/** En komplett lyckad körning: n sökningar, tänkande, ett JSON-svar. */
export function successfulRun(json: unknown, opts: { queries?: string[][]; urls?: Array<Array<{ url: string; status: string }>>; usage?: UsageSpec; citations?: string[] } = {}): Ev[] {
  const events: Ev[] = [
    { event_type: "interaction.created", interaction: { object: "interaction", model: "fake" } },
    { event_type: "interaction.status_update", status: "in_progress" },
  ];
  let index = 0;
  for (const q of opts.queries ?? [["a b c"]]) {
    events.push(...searchEvents(index, q));
    index += 2;
  }
  for (const u of opts.urls ?? []) {
    events.push(...urlEvents(index, u));
    index += 2;
  }
  events.push(...thoughtEvents(index++, "Jämför ryggen."));
  events.push(...answerEvents(index, JSON.stringify(json), opts.citations));
  events.push(completedEvent({ searches: (opts.queries ?? [["x"]]).flat().length, ...opts.usage }));
  return events;
}

export interface Script {
  /** Händelser strömmen ger. */
  events?: Ev[];
  /** Kasta vid anslutningen, som SDK:n gör för ett HTTP-fel. */
  throwOnCreate?: Error;
  /** Hänger efter händelserna i stället för att ta slut — för tidsbudgeten. */
  hang?: boolean;
  /** `create()` löser aldrig upp sig: svarshuvudet kommer inte. SDK:ns avbrott hjälper inte där. */
  neverOpens?: boolean;
  /** Fördröjning före varje händelse. */
  delayMs?: number;
}

export interface Call {
  params: Record<string, any>;
  options: Record<string, any> | undefined;
}

/**
 * En klient som svarar med nästa skript för varje `create`. Tar skripten slut är det ett fel i testet,
 * inte i koden — det kastas ett tydligt undantag.
 */
export function scriptedClient(scripts: Script[]): { client: InteractionsClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: InteractionsClient = {
    interactions: {
      create: async (params: unknown, options?: unknown) => {
        calls.push({ params: params as Call["params"], options: options as Call["options"] });
        const script = scripts[calls.length - 1];
        if (!script) throw new Error(`fakeGemini: inget skript för anrop nummer ${calls.length}`);
        if (script.throwOnCreate) throw script.throwOnCreate;
        if (script.neverOpens) return new Promise<never>(() => {});
        async function* gen() {
          for (const ev of script.events ?? []) {
            if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
            yield ev;
          }
          if (script.hang) await new Promise<never>(() => {});
        }
        return gen();
      },
    },
  };
  return { client, calls };
}

/** Ett fel som SDK:n kastar för ett HTTP-svar: meddelandet bär statusen. */
export function httpError(status: number, message: string): Error {
  const e = new Error(`${status} ${message}`);
  e.name = "APIError";
  return e;
}

export const TOOL_LIMIT_MESSAGE =
  "Model generated too many tool calls. Please retry the request. If the issue persists, include this error message in the retry prompt to allow the model to call a valid number of tools.";

/** Ett minimalt ResearchTrace för tester som stubbar bort anropet helt. */
export function fakeTrace(over: Partial<ResearchTrace> = {}): ResearchTrace {
  return {
    model: "fake-model",
    purpose: "identify",
    label: null,
    latencyMs: 1000,
    attempts: 1,
    reduced: false,
    searchQueries: [],
    fetchedUrls: [],
    citations: [],
    usage: { inputTokens: 8000, outputTokens: 900, thoughtTokens: 2500, totalTokens: 11400, searchQueries: 0 },
    estimatedCostUsd: 0.02,
    finishStatus: "completed",
    thoughtSummary: null,
    timeline: [],
    timings: { firstEventMs: 100, totalMs: 1000, searchMs: 0, urlFetchMs: 0, modelMs: 1000 },
    toolCalls: 0,
    stoppedBy: "completed",
    error: null,
    settings: { thinkingLevel: "medium", tools: ["google_search", "url_context"], structured: true, images: 1, imageKb: 10, maxSearchQueries: null },
    failures: [],
    ...over,
  };
}
