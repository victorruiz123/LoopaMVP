/**
 * Ett anrop mot Gemini 3 genom Interactions API — bilder + instruktion + Google Search + URL context
 * + JSON-schema i SAMMA anrop, STRÖMMAT.
 *
 * VARFÖR STRÖMMAT. Det första skarpa körningen (2026-10-11) visade tre saker som det icke-strömmade
 * anropet gjorde omöjliga att se eller styra:
 *
 *   1. Identifieringen tog 205 s och föll sedan med 400 "Model generated too many tool calls". Inget
 *      svar kom tillbaka, så loggen visste varken vilka sökningar modellen gjort eller vilka sidor
 *      den öppnat. En omkörning med samma bilder gjorde 57 sökningar på 187 s (≈ 0,84 USD) innan den
 *      svarade rätt.
 *   2. Tidsgränsen på 90 s verkställdes inte. UPPMÄTT mot en lokal server som aldrig svarar (SDK 2.19.0,
 *      Node 24): ett icke-strömmat `create()` med `fetchOptions.signal` avbröts på 5 s men INTE på 15 s
 *      — samma kod, oberoende av kroppens storlek och av nätverket. Det stämmer med det som hände: ett
 *      4-sekundersprov mot Googles tjänst avbröts i tid, det riktiga anropet (som väntade 187 s på
 *      svarshuvudet) avbröts aldrig. Mest sannolika orsak, EJ separat bekräftad: SDK:n klonar Request
 *      (`request.clone()` i `_do`) och klonens signal följer originalets genom en svag referens som
 *      hinner skräpsamlas medan anropet väntar på huvudet. En ström påverkas inte: efter att huvudet
 *      kommit håller det öppna svaret signalen vid liv (mätt: avbrott efter 28 s, med minnesbelastning,
 *      stängde anslutningen direkt), och SDK:ns egna `timeout` avbryter en pågående ström INTE alls.
 *      Se `consume` och `opening`: budgeten verkställs på strömmen och på själva öppnandet av den, utan
 *      att lita på att SDK:n reagerar.
 *   3. Ingen tid per steg: hur lång tid sökningarna tog mot modellens tänkande gick inte att säga.
 *
 * Strömmen ger varje steg när det sker — sökfrågorna, de öppnade adresserna, tänkandet — så ett anrop
 * som havererar lämnar ändå ett spår, och en budget (tid, antal sökfrågor) kan verkställas medan
 * anropet pågår i stället för att upptäckas efteråt.
 *
 * Det här lagret vet ingenting om möbler. Det bygger anropet, kör det inom budget, och packar upp
 * svaret till text, JSON och ett spår.
 *
 * ETT ANROP, ETT FÖRSÖK. Här fanns tidigare ett omförsök med strängare budget, en säkring som startade ett reducerat andra försök bredvid
 * det första, en reservmodell och ett snabbspår — och varje försök var betalt arbete. Det är borta (2026-10-24): kostnaden per omgång är
 * begränsad (cost/ledger.ts) och ett andra försök med samma sökverktyg är en andra räkning för samma fråga. Ett fall hanteras av anroparen
 * (research/pipeline.ts: ETT omförsök, bara vid överbelastning eller nätverksfel — där anropet aldrig kom igång).
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, GoogleGenAI } from "@google/genai";
import { estimateCostUsd, RESEARCH_MODEL, type ThinkingLevel } from "./config.js";
import { reportUsage } from "../cost/hooks.js";
import { abortedOutputTokens, tokenUsd } from "../cost/ledger.js";
import type { ResearchImage, ResearchTimings, ResearchTrace, ResearchUsage, TimelineEntry } from "./types.js";

/** Ett verktyg: namnet, eller google_search med uttryckliga söktyper (web_search, image_search). */
export type ToolSpec = "google_search" | "url_context" | { type: "google_search"; search_types: string[] };
const DEFAULT_TOOLS: ToolSpec[] = ["google_search", "url_context"];
const toolName = (t: ToolSpec) => (typeof t === "string" ? t : `google_search[${t.search_types.join("+")}]`);

export interface InteractionRequest {
  purpose: string;
  /** Kort etikett för loggar och spårfiler, t.ex. de åtta första tecknen i jobb-id:t. */
  label?: string;
  model?: string;
  systemInstruction: string;
  prompt: string;
  images: ResearchImage[];
  /** null/utelämnad = fri text. */
  schema?: object | null;
  thinkingLevel: ThinkingLevel;
  /** Anropets livslängd i ms — ett skydd mot ett anrop som hänger sig, inte en klocka att tävla mot. */
  timeoutMs: number;
  /**
   * Avbryt när modellen gjort fler sökfrågor än så här. Ett skyddsnät, inte ett arbetssätt: ett avbrutet
   * anrop lämnar inget svar. Arbetssättet är budgeten i prompten; det här fångar att den inte följdes.
   */
  maxSearchQueries?: number;
  /**
   * Googles eget tak på utdata — och därmed på tänkandet — per anrop (`generation_config.max_output_tokens`). Till skillnad från sökfrågetaket,
   * som vi själva verkställer på strömmen, hålls det här av tjänsten: det är det enda token-tak som inte kan överskridas. Ett svar som inte
   * ryms i taket blir avkortat och därmed ofullständigt, så det sätts med god marginal över vad ett normalt svar kräver.
   */
  maxOutputTokens?: number;
  tools?: ToolSpec[];
  /** Text som läggs sist i uppdraget (en promptvariant att pröva i ett mätskript). */
  promptSuffix?: string;
  signal?: AbortSignal;
  /** Anropas för varje steg som börjar eller slutar — den som vill följa körningen live. */
  onProgress?: (entry: TimelineEntry, state: "start" | "update" | "stop") => void;
}

export interface InteractionOutcome {
  /** Modellens slutsvar, tolkat som JSON. null när det inte gick att tolka (eller inget schema). */
  json: unknown | null;
  /** Svaret var avkortat och lagades till det som hann bli komplett (`repairTruncatedJson`): det som saknas i det kan finnas i källorna. */
  recovered?: boolean;
  text: string;
  trace: ResearchTrace;
}

/** Utbytbar i tester: samma signatur, inget nätverk. */
export type InteractionRunner = (req: InteractionRequest) => Promise<InteractionOutcome>;

export type InteractionErrorKind =
  | "timeout"
  | "quota"
  | "billing"
  | "overloaded"
  | "tool_limit"
  | "tool_budget"
  | "http"
  | "network"
  | "empty"
  | "aborted";

export class InteractionError extends Error {
  kind: InteractionErrorKind;
  status: number | null;
  /** Spåret fram till felet. Satt för varje fel som uppstod efter att strömmen öppnats. */
  trace: ResearchTrace | null = null;
  constructor(message: string, kind: InteractionErrorKind, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Minimal form av SDK-klienten som runnern använder — det som testerna byter ut. */
export interface InteractionsClient {
  interactions: { create: (params: unknown, options?: unknown) => Promise<unknown> };
}

/** Sätts bara av tester: ett falskt Interactions-API utan nätverk. Null i drift. */
export const testHooks: { client: InteractionsClient | null } = { client: null };

let client: GoogleGenAI | null = null;
function getClient(): InteractionsClient {
  if (testHooks.client) return testHooks.client;
  if (client) return client as unknown as InteractionsClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new InteractionError("GEMINI_API_KEY is not set", "http", 401);
  // LOOPA_GEMINI_BASE_URL pekar om anropen till en gateway/proxy — och till en lokal attrapp i testerna
  // (tests/research-runner-http.test.ts), som kör den riktiga SDK:n mot riktig HTTP.
  const baseUrl = process.env.LOOPA_GEMINI_BASE_URL?.trim();
  client = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  return client as unknown as InteractionsClient;
}

// ─── Fel ────────────────────────────────────────────────────────────────────

const TOOL_LIMIT = /too many tool calls/i;

export function classify(err: unknown): InteractionError {
  if (err instanceof InteractionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const status = err instanceof ApiError ? err.status : Number((message.match(/\b(4\d\d|5\d\d)\b/) ?? [])[1]) || null;
  if (TOOL_LIMIT.test(message)) return new InteractionError(message.slice(0, 400), "tool_limit", status ?? 400);
  if (/APIUserAbortError|APIConnectionTimeoutError/.test(name) || /abort|timeout|timed out/i.test(message)) {
    return new InteractionError(`gemini aborted: ${message.slice(0, 200)}`, "timeout", status);
  }
  // 402 betyder att förbetalda krediter är slut. Det gäller HELA nyckeln, inte en modell — varken ett
  // omförsök eller en reservmodell hjälper, och det är något någon måste åtgärda, inte vänta ut.
  if (status === 402 || /prepayment credits are depleted|billing/i.test(message)) return new InteractionError(message.slice(0, 300), "billing", 402);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) return new InteractionError(message.slice(0, 300), "quota", status ?? 429);
  if ((status && status >= 500) || /UNAVAILABLE|overloaded/i.test(message)) return new InteractionError(message.slice(0, 300), "overloaded", status ?? 503);
  if (status) return new InteractionError(`gemini ${status}: ${message.slice(0, 300)}`, "http", status);
  return new InteractionError(`gemini network error: ${message.slice(0, 200)}`, "network");
}

export function parseJsonLoose(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fortsätt */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Ett svar som avkortades mitt i JSON-texten, lagat till det som hann bli komplett.
 *
 * VARFÖR. Ett anrop kan sluta "incomplete" mitt i svaret (Googles tak på utdata inklusive tänkande, ett avbrutet svar). Förut blev det
 * "Svaret gick inte att tolka" och ALLT — tretton dokumenterade mått, material, utföranden — kastades. 2026-10-25 hände det Sits Impulse:
 * forskningen hade hittat måtten, och säljaren fick ett kort utan ett enda av dem. Här tas det som hann bli komplett tillvara.
 *
 * HUR. Texten läses tecken för tecken med en stack av öppna `{` och `[`. Vid varje punkt där ett värde just avslutats (ett kommatecken mellan
 * listelement eller toppnivåegenskaper, eller en stängd klammer, utanför en sträng) noteras hur långt texten kan klippas och vilka klamrar som då är öppna. Är texten inte avslutad klipps den
 * vid den sista sådana punkten och de öppna klamrarna stängs. Ett halvfärdigt element i en lista (ett mått som bröts mitt i) faller bort — en hel
 * rad är aldrig halv. Ingenting hittas på: allt i resultatet stod i texten. Returnerar null när det inte finns något komplett att ta vara på.
 */
export function repairTruncatedJson(text: string): unknown | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const src = cleaned.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let safe: { at: number; open: string[] } | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return null; // texten var hel: här finns inget att laga
      safe = { at: i + 1, open: [...stack] };
    } else if (ch === "," && stack.length > 0 && (stack[stack.length - 1] === "[" || stack.length === 1)) {
      // Bara kommatecken som skiljer ELEMENT i en lista eller egenskaper på toppnivån: ett kommatecken inne i ett halvskrivet element är ingen rad.
      safe = { at: i, open: [...stack] };
    }
  }
  if (!safe) return null;
  const closers = safe.open.reverse().map((o) => (o === "{" ? "}" : "]")).join("");
  try {
    return JSON.parse(src.slice(0, safe.at) + closers);
  } catch {
    return null;
  }
}

// ─── Strömmen ───────────────────────────────────────────────────────────────

/** Löst typat med flit: SDK:ns unionstyper är många och vi läser få fält. */
interface RawEvent {
  event_type?: string;
  index?: number;
  step?: { type?: string; id?: string; call_id?: string; search_type?: string };
  delta?: {
    type?: string;
    text?: string;
    arguments?: { queries?: string[]; urls?: string[] } | string;
    result?: Array<{ url?: string; status?: string }>;
    is_error?: boolean;
    annotations?: Array<{ type?: string; url?: string; title?: string | null }>;
    content?: { type?: string; text?: string };
  };
  status?: string;
  interaction?: { status?: string; usage?: RawUsage };
  error?: { code?: string; message?: string };
}

export interface RawUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
  grounding_tool_count?: Array<{ type?: string; count?: number; search_query_count?: number }>;
}

interface StepState extends TimelineEntry {
  id: string | null;
  callId: string | null;
  text: string;
}

export interface ConsumeControl {
  startedAt: number;
  budgetMs: number;
  maxSearchQueries: number | null;
  onProgress?: InteractionRequest["onProgress"];
  /** Stänger strömmen. Anropas när vi avbryter av egen kraft. */
  cancel?: () => void;
  /** Anroparens egen avbrytning. Läses direkt på strömmen, utan att vänta på att transporten reagerar. */
  signal?: AbortSignal;
}

export interface ConsumeResult {
  steps: StepState[];
  /** All modelltext i strömmen, hopsatt — för visning och när inget annat finns. */
  text: string;
  /**
   * Texten i det SISTA model_output-steget. Det är svaret; en inledande rad före en sökning ("Jag
   * söker…") hör inte dit och får inte rubba JSON-tolkningen. Samma val som SDK:ns `output_text`
   * ("concatenated text from the last model output").
   */
  finalText: string;
  usage: RawUsage | null;
  status: string | null;
  stoppedBy: ResearchTrace["stoppedBy"];
  error: { kind: InteractionErrorKind; message: string } | null;
  citations: Array<{ url: string; title: string | null }>;
  thoughts: string[];
}

const TOOL_CALL_TYPES = new Set(["google_search_call", "url_context_call"]);
const TIMEOUT = Symbol("timeout");
const ABORTED = Symbol("aborted");

/**
 * Läser strömmen till slut — eller till budgeten tar slut. Exporterad så att testerna kan mata in en
 * sparad händelselista utan nätverk.
 *
 * Avbrottet görs på strömmen, inte på HTTP-anropet: `Promise.race` mot en timer och sedan `return()`
 * på iteratorn. Det fungerar oavsett vad som händer med AbortSignal-kedjan under SDK:n.
 */
export async function consume(source: AsyncIterable<unknown>, ctl: ConsumeControl): Promise<ConsumeResult> {
  const steps = new Map<number, StepState>();
  const byCallId = new Map<string, StepState>();
  const citations: ConsumeResult["citations"] = [];
  const thoughts: string[] = [];
  let text = "";
  let usage: RawUsage | null = null;
  let status: string | null = null;
  let queries = 0;
  let stoppedBy: ResearchTrace["stoppedBy"] = "completed";
  let error: ConsumeResult["error"] = null;
  const now = () => Date.now() - ctl.startedAt;

  /**
   * Resultatsteget bär adresserna och statusen; de läggs på ANROPSsteget så att en rad i tidslinjen
   * säger både vad som begärdes och hur det gick.
   */
  const applyUrlResults = (resultStep: StepState, results: Array<{ url?: string; status?: string }>) => {
    const call = (resultStep.callId && byCallId.get(resultStep.callId)) || resultStep;
    for (const r of results) {
      if (typeof r.url !== "string") continue;
      const known = call.urls?.find((u) => u.url === r.url);
      if (known) known.status = r.status ?? null;
      else call.urls = [...(call.urls ?? []), { url: r.url, status: r.status ?? null }];
    }
    ctl.onProgress?.(call, "update");
  };

  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ctl.budgetMs - now()));
  });

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (!ctl.signal) return;
    if (ctl.signal.aborted) return resolve(ABORTED);
    onAbort = () => resolve(ABORTED);
    ctl.signal.addEventListener("abort", onAbort, { once: true });
  });

  const stop = (why: ResearchTrace["stoppedBy"], err: ConsumeResult["error"] = null) => {
    stoppedBy = why;
    error = err;
    try {
      ctl.cancel?.();
    } catch {
      /* redan stängd */
    }
    // `return()` på en pågående läsning kan hänga; vi väntar inte på den.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  };

  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), deadline, aborted]);
      if (next === ABORTED) {
        stop("error", { kind: "aborted", message: "avbröts av anroparen" });
        break;
      }
      if (next === TIMEOUT) {
        stop("time_budget", { kind: "timeout", message: `budgeten på ${Math.round(ctl.budgetMs / 1000)} s tog slut` });
        break;
      }
      if (next.done) break;
      const ev = next.value as RawEvent;
      switch (ev.event_type) {
        case "step.start": {
          const type = ev.step?.type ?? "unknown";
          const step: StepState = {
            index: ev.index ?? steps.size,
            type,
            startMs: now(),
            endMs: null,
            id: ev.step?.id ?? null,
            callId: ev.step?.call_id ?? null,
            text: "",
          };
          if (ev.step?.search_type) step.note = ev.step.search_type;
          steps.set(step.index, step);
          if (step.id) byCallId.set(step.id, step);
          // Resultatet kan komma redan på step.start (annars i en step.delta) — båda formerna läses.
          const early = (ev.step as { result?: Array<{ url?: string; status?: string }> } | undefined)?.result;
          if (type === "url_context_result" && Array.isArray(early)) applyUrlResults(step, early);
          ctl.onProgress?.(step, "start");
          break;
        }
        case "step.delta": {
          const step = steps.get(ev.index ?? -1);
          const d = ev.delta;
          if (!step || !d) break;
          if (d.type === "google_search_call" && typeof d.arguments === "object" && d.arguments?.queries) {
            const qs = d.arguments.queries.filter((q): q is string => typeof q === "string");
            step.queries = [...(step.queries ?? []), ...qs];
            queries += qs.length;
            ctl.onProgress?.(step, "update");
            if (ctl.maxSearchQueries !== null && queries > ctl.maxSearchQueries) {
              stop("tool_budget", { kind: "tool_budget", message: `fler än ${ctl.maxSearchQueries} sökfrågor (${queries})` });
            }
          } else if (d.type === "url_context_call" && typeof d.arguments === "object" && d.arguments?.urls) {
            step.urls = [...(step.urls ?? []), ...d.arguments.urls.filter((u): u is string => typeof u === "string").map((url) => ({ url, status: null }))];
            ctl.onProgress?.(step, "update");
          } else if (d.type === "url_context_result" && Array.isArray(d.result)) {
            applyUrlResults(step, d.result);
          } else if (d.type === "text" && typeof d.text === "string") {
            step.text += d.text;
            text += d.text;
          } else if (d.type === "text_annotation_delta" && Array.isArray(d.annotations)) {
            for (const a of d.annotations) if (a.type === "url_citation" && typeof a.url === "string") citations.push({ url: a.url, title: a.title ?? null });
          } else if (d.type === "thought_summary" && d.content?.type === "text" && typeof d.content.text === "string") {
            step.text += d.content.text;
            thoughts.push(d.content.text);
          }
          break;
        }
        case "step.stop": {
          const step = steps.get(ev.index ?? -1);
          if (step) {
            step.endMs = now();
            ctl.onProgress?.(step, "stop");
          }
          break;
        }
        case "interaction.status_update":
          if (ev.status) status = ev.status;
          break;
        case "interaction.completed":
          status = ev.interaction?.status ?? status;
          usage = ev.interaction?.usage ?? usage;
          break;
        case "error": {
          const message = ev.error?.message ?? "okänt fel i strömmen";
          stop("error", { kind: TOOL_LIMIT.test(message) ? "tool_limit" : classify(new Error(message)).kind, message: message.slice(0, 400) });
          break;
        }
        default:
          break;
      }
      if (stoppedBy !== "completed") break;
    }
  } catch (err) {
    const e = classify(err);
    stoppedBy = e.kind === "timeout" ? "time_budget" : "error";
    error = { kind: e.kind, message: e.message };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) ctl.signal?.removeEventListener("abort", onAbort);
  }

  if (stoppedBy === "completed" && (status === "failed" || status === "cancelled")) {
    stoppedBy = "error";
    error = { kind: "http", message: `interaction ${status}` };
  }
  const ordered = [...steps.values()].sort((a, b) => a.index - b.index);
  const lastOutput = [...ordered].reverse().find((s) => s.type === "model_output" && s.text.trim());
  return { steps: ordered, text: text.trim(), finalText: (lastOutput?.text ?? text).trim(), usage, status, stoppedBy, error, citations, thoughts };
}

/** Sammanlagd tid som täcks av ett antal intervall — parallella anrop räknas en gång, inte två. */
function unionMs(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of sorted) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) curEnd = b;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

type TimedStep = Pick<TimelineEntry, "type" | "startMs" | "endMs"> & { id?: string | null; callId?: string | null };

/**
 * Tidsfördelningen: hur mycket av väggklockan som gick åt till sökning, sidhämtning och modell.
 *
 * Ett verktygsanrop tar tid från att modellen bestämt sig (anropssteget börjar) till att resultatet är
 * klart (resultatsteget slutar), matchat på anrops-id. Modellens egen tid är resten: tänkande,
 * svarsskrivning och väntan på första händelsen.
 */
export function computeTimings(steps: TimedStep[], totalMs: number, openMs: number | null = null): ResearchTimings {
  const span = (call: string, result: string) => {
    const intervals: Array<[number, number]> = [];
    for (const s of steps) {
      if (s.type !== call) continue;
      const done =
        (s.id ? steps.find((r) => r.type === result && r.callId === s.id) : undefined) ??
        steps.find((r) => r.type === result && r.startMs >= s.startMs);
      const end = done?.endMs ?? done?.startMs ?? s.endMs ?? s.startMs;
      intervals.push([s.startMs, end]);
    }
    return unionMs(intervals);
  };
  const searchMs = span("google_search_call", "google_search_result");
  const urlFetchMs = span("url_context_call", "url_context_result");
  const own = (type: string) =>
    unionMs(steps.filter((s) => s.type === type).map((s): [number, number] => [s.startMs, s.endMs ?? s.startMs]));
  return {
    firstEventMs: steps.length ? steps[0].startMs : null,
    totalMs,
    searchMs,
    urlFetchMs,
    modelMs: Math.max(0, totalMs - searchMs - urlFetchMs),
    openMs,
    thinkMs: own("thought"),
    outputMs: own("model_output"),
    searchRounds: steps.filter((s) => s.type === "google_search_call").length,
  };
}

export function usageFrom(raw: RawUsage | null, timelineQueries: number): ResearchUsage {
  const u = raw ?? {};
  const grounded = (u.grounding_tool_count ?? []).filter((g) => g.type === "google_search");
  const billedQueries = grounded.reduce((n, g) => n + (g.search_query_count ?? g.count ?? 0), 0);
  // Verktygstokens (sökresultat, hämtade sidor) faktureras som indata. Om de redan ligger i
  // total_input_tokens vet vi inte på förhand — total_tokens avgör: summan som ligger närmast den är rätt.
  const input = u.total_input_tokens ?? 0;
  const out = (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
  const tool = u.total_tool_use_tokens ?? 0;
  const total = u.total_tokens ?? 0;
  const toolSeparate = tool > 0 && total > 0 && Math.abs(total - (input + out + tool)) <= Math.abs(total - (input + out));
  return {
    inputTokens: input + (toolSeparate || total === 0 ? tool : 0),
    outputTokens: u.total_output_tokens ?? 0,
    thoughtTokens: u.total_thought_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    searchQueries: billedQueries || timelineQueries,
  };
}

function buildTrace(
  req: InteractionRequest,
  model: string,
  startedAt: number,
  result: ConsumeResult,
  imageKb: number,
  maxQueries: number | null,
  openMs: number | null = null,
): ResearchTrace {
  const totalMs = Date.now() - startedAt;
  const timeline: TimelineEntry[] = result.steps.map(({ id: _id, callId: _callId, text: stepText, ...entry }) => ({
    ...entry,
    ...(entry.type === "model_output" ? { chars: stepText.length } : {}),
  }));
  const timelineQueries = timeline.reduce((n, s) => n + (s.queries?.length ?? 0), 0);
  const usage = usageFrom(result.usage, timelineQueries);
  // Ett avbrutet anrop rapporterar ingen användning. Då uppskattas åtminstone det vi själva skickade, så att
  // kostnaden inte ser ut som noll tokens — och det sägs rakt ut att den är en nedre gräns.
  if (!result.usage) {
    usage.inputTokens = estimateInputTokens(req);
    usage.tokensEstimated = true;
  }
  const fetched = timeline.filter((s) => s.type === "url_context_call").flatMap((s) => s.urls ?? []);
  const dedupe = <T extends { url: string }>(xs: T[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => !seen.has(x.url) && seen.add(x.url));
  };
  return {
    model,
    purpose: req.purpose,
    label: req.label ?? null,
    latencyMs: totalMs,
    // Ett anrop är ett försök. Fälten finns kvar i kvittot (jobben sparar det) men bär inget mer än det.
    attempts: 1,
    reduced: false,
    searchQueries: timeline.flatMap((s) => s.queries ?? []),
    fetchedUrls: dedupe(fetched.map((u) => ({ url: u.url, status: u.status ?? "unknown" }))),
    citations: dedupe(result.citations),
    usage,
    estimatedCostUsd: estimateCostUsd(model, usage),
    finishStatus: result.status ?? "unknown",
    thoughtSummary: result.thoughts.length ? result.thoughts.join("\n").slice(0, 4000) : null,
    timeline,
    timings: computeTimings(result.steps, totalMs, openMs),
    toolCalls: timeline.filter((s) => TOOL_CALL_TYPES.has(s.type)).length,
    stoppedBy: result.stoppedBy,
    error: result.error,
    settings: {
      thinkingLevel: req.thinkingLevel,
      tools: (req.tools ?? DEFAULT_TOOLS).map(toolName),
      structured: !!req.schema,
      images: req.images.length,
      imageKb,
      maxSearchQueries: maxQueries,
    },
    failures: [],
  };
}

/**
 * Ett anrops kostnad till kostnadsboken (cost/ledger.ts) — varje försök, också de som föll eller avbröts: de kostar ändå.
 * Ett avbrutet anrop rapporterar ingen användning; då räknas utdata uppåt ur tiden i stället för som noll.
 */
function reportTraceUsage(trace: ResearchTrace, ok: boolean): void {
  const u = trace.usage;
  const estimated = !!u.tokensEstimated;
  const extraOut = estimated ? abortedOutputTokens(trace.latencyMs) : 0;
  const usd = estimateCostUsd(trace.model, u) + (extraOut ? tokenUsd(trace.model, { inputTokens: 0, outputTokens: extraOut, thoughtTokens: 0 }) : 0);
  reportUsage({
    stage: trace.purpose === "identify" ? "identify" : trace.purpose === "specs" ? "specs" : undefined,
    label: trace.purpose,
    model: trace.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens + extraOut,
    thoughtTokens: u.thoughtTokens,
    searchQueries: u.searchQueries,
    usd: Math.round(usd * 10_000) / 10_000,
    ...(estimated ? { estimated: true } : {}),
    ok,
  });
}

/** Tokens per bild efter media_resolution (Gemini 3 räknar per upplösningsnivå, inte per pixel). */
const IMAGE_TOKENS: Record<string, number> = { low: 280, medium: 560, high: 1120, ultra_high: 2240 };
export function estimateInputTokens(req: Pick<InteractionRequest, "images" | "prompt" | "systemInstruction">): number {
  const images = req.images.reduce((n, i) => n + (IMAGE_TOKENS[i.resolution ?? "high"] ?? 1120), 0);
  return images + Math.ceil(((req.prompt?.length ?? 0) + (req.systemInstruction?.length ?? 0)) / 3.5);
}

function buildInput(req: InteractionRequest) {
  return [
    { type: "text" as const, text: req.prompt + (req.promptSuffix ?? "") },
    ...req.images.map((img) => ({
      type: "image" as const,
      data: img.base64,
      mime_type: img.mimeType,
      ...(img.resolution ? { resolution: img.resolution } : {}),
    })),
  ];
}

async function runOnce(req: InteractionRequest, model: string, budgetMs: number): Promise<InteractionOutcome> {
  const startedAt = Date.now();
  const ai = getClient();
  const imageKb = Math.round(req.images.reduce((n, i) => n + (i.base64.length * 3) / 4, 0) / 1024);
  const tools = (req.tools ?? DEFAULT_TOOLS).map((t) => (typeof t === "string" ? { type: t } : t)) as Array<{ type: "google_search" | "url_context"; search_types?: string[] }>;
  const thinkingLevel = req.thinkingLevel;
  const maxQueries = req.maxSearchQueries ?? null;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // Anroparens avbrytning stänger strömmen och läses direkt på den.
  const external = req.signal;
  external?.addEventListener("abort", onAbort, { once: true });
  let result: ConsumeResult | null = null;
  let openMs: number | null = null;
  try {
    let stream;
    let opening: Promise<unknown> | null = null;
    try {
      opening = ai.interactions.create(
        {
          model,
          input: buildInput(req),
          system_instruction: req.systemInstruction,
          tools,
          ...(req.schema
            ? { response_format: { type: "text" as const, mime_type: "application/json", schema: req.schema as Record<string, unknown> } }
            : {}),
          generation_config: {
            thinking_level: thinkingLevel,
            thinking_summaries: "auto",
            ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          },
          stream: true,
          store: false,
        },
        // Ingen `timeout` här: SDK:n hoppar över den så fort en signal finns, och budgeten verkställs i
        // `consume`. Signalen finns kvar för att kunna stänga anslutningen när vi avbryter.
        { maxRetries: 0, fetchOptions: { signal: controller.signal } },
      );
      // Öppnandet av strömmen väntar på svarshuvudet, och där hjälper varken signalen eller SDK:ns
      // timeout alltid (se rubriken). Budgeten gäller därför redan här, med ett eget lopp.
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      const tooSlow = new Promise<never>((_, reject) => {
        openTimer = setTimeout(() => reject(new InteractionError(`strömmen öppnades inte inom ${Math.round(budgetMs / 1000)} s`, "timeout")), budgetMs);
      });
      try {
        stream = await Promise.race([opening, tooSlow]);
        openMs = Date.now() - startedAt;
      } finally {
        if (openTimer) clearTimeout(openTimer);
      }
    } catch (err) {
      // Försök stänga anslutningen; SDK:n kan ignorera det, men då ger vi åtminstone upp på vår sida.
      controller.abort();
      closeIfItOpensLate(opening);
      const e = classify(err);
      e.trace = buildTrace(req, model, startedAt, emptyResult(e), imageKb, maxQueries);
      // Ett anrop som aldrig öppnades fakturerades inte (Google debiterar inte 4xx/5xx) — det står med som en post på noll.
      reportUsage({ stage: req.purpose === "identify" ? "identify" : req.purpose === "specs" ? "specs" : undefined, label: req.purpose, model, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, searchQueries: 0, usd: 0, ok: false, note: e.kind });
      console.warn(`[research] ${req.label ? `${req.label} ` : ""}${req.purpose} model=${model} föll innan strömmen öppnades (${e.kind}): ${e.message.slice(0, 160)}`);
      void persistTrace(e.trace);
      throw e;
    }
    result = await consume(stream as unknown as AsyncIterable<unknown>, {
      startedAt,
      budgetMs,
      maxSearchQueries: maxQueries,
      onProgress: req.onProgress,
      cancel: () => controller.abort(),
      signal: external,
    });
  } finally {
    external?.removeEventListener("abort", onAbort);
  }

  // En avbrytning som ANROPAREN beställt (jobbet avbröts) är inte en timeout, och ska inte provas om.
  if (result.error && external?.aborted && result.error.kind === "timeout") result.error = { kind: "aborted", message: "avbröts av anroparen" };
  const trace = buildTrace(req, model, startedAt, result, imageKb, maxQueries, openMs);
  const t = trace.timings;
  console.info(
    `[research] ${req.label ? `${req.label} ` : ""}${req.purpose} model=${model} ` +
      `stopp=${trace.stoppedBy} ms=${trace.latencyMs} (modell ${t.modelMs}, sök ${t.searchMs}, sidor ${t.urlFetchMs}; öppnad ${t.openMs ?? "?"}, första händelse ${t.firstEventMs ?? "?"}, tänk ${t.thinkMs ?? 0}, ${t.searchRounds ?? 0} sökrundor, svar ${t.outputMs ?? 0}) ` +
      `sökfrågor=${trace.usage.searchQueries} verktyg=${trace.toolCalls} hämtade=${trace.fetchedUrls.length} ` +
      `in=${trace.usage.tokensEstimated ? "~" : ""}${trace.usage.inputTokens} ut=${trace.usage.outputTokens} tänk=${trace.usage.thoughtTokens} cost${trace.usage.tokensEstimated ? "≥" : "≈"}${trace.estimatedCostUsd}`,
  );

  if (result.error) {
    const e = new InteractionError(result.error.message, result.error.kind);
    e.trace = trace;
    reportTraceUsage(trace, false);
    void persistTrace(trace);
    throw e;
  }
  const out = result.finalText || result.text;
  if (!out) {
    const e = new InteractionError("Gemini returned no text", "empty");
    e.trace = trace;
    reportTraceUsage(trace, false);
    void persistTrace(trace);
    throw e;
  }
  reportTraceUsage(trace, true);
  void persistTrace(trace, out);
  if (!req.schema) return { json: null, text: out, trace };
  const parsed = parseJsonLoose(out);
  if (parsed !== null) return { json: parsed, text: out, trace };
  const repaired = repairTruncatedJson(out);
  if (repaired !== null) console.warn(`[research] ${req.label ? `${req.label} ` : ""}${req.purpose}: svaret var avkortat (${trace.finishStatus}) — lagat till det som hann bli komplett`);
  return { json: repaired, text: out, trace, ...(repaired !== null ? { recovered: true } : {}) };
}

/**
 * Ett öppnande som förlorade loppet mot budgeten kan ändå komma tillbaka senare. Då får strömmen inte
 * bli kvar öppen och läsas av ingen: stäng den. Fel i det senare öppnandet är ointressanta.
 */
function closeIfItOpensLate(opening: Promise<unknown> | null): void {
  if (!opening) return;
  opening.then(
    (late) => {
      try {
        const iterator = (late as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator]?.();
        void Promise.resolve(iterator?.return?.()).catch(() => {});
      } catch {
        /* inget att stänga */
      }
    },
    () => {},
  );
}

function emptyResult(err: InteractionError): ConsumeResult {
  return { steps: [], text: "", finalText: "", usage: null, status: null, stoppedBy: "error", error: { kind: err.kind, message: err.message }, citations: [], thoughts: [] };
}

/**
 * Ett anrop: ETT försök mot huvudmodellen, med hela livslängden. Inget omförsök, ingen säkring, ingen reservmodell — se rubriken.
 * Faller anropet kastas felet med sitt spår, och anroparen avgör vad som händer härnäst.
 */
export const runInteraction: InteractionRunner = (req) => runOnce(req, req.model ?? RESEARCH_MODEL, req.timeoutMs);

// ─── Spår på disk ───────────────────────────────────────────────────────────

const traceDir = (): string => process.env.LOOPA_RESEARCH_TRACE_DIR || path.resolve(import.meta.dirname, "..", "..", "data", "research-traces");
const TRACE_KEEP_MS = 14 * 24 * 3600 * 1000;
let swept = false;

export const traceEnabled = (): boolean => process.env.LOOPA_RESEARCH_TRACE !== "0";

/**
 * Sparar spåret som en JSON-fil. Innehåller sökfrågor, adresser, tider och tokens — aldrig bilder,
 * aldrig API-nyckel, aldrig säljarens uppgifter. Slutsvaret (kandidatlistan) följer med, för det är
 * det man vill jämföra mot spåret.
 */
export async function persistTrace(trace: ResearchTrace, output?: string): Promise<void> {
  if (!traceEnabled()) return;
  try {
    const TRACE_DIR = traceDir();
    await mkdir(TRACE_DIR, { recursive: true });
    if (!swept) {
      swept = true;
      for (const f of await readdir(TRACE_DIR).catch(() => [] as string[])) {
        const p = path.join(TRACE_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > TRACE_KEEP_MS) await unlink(p).catch(() => {});
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${trace.label ?? "adhoc"}-${trace.purpose}-a${trace.attempts}.json`.replace(/[^\w.-]+/g, "_");
    await writeFile(path.join(TRACE_DIR, name), JSON.stringify({ trace, output: output ?? null }, null, 1), "utf8");
  } catch (err) {
    console.warn(`[research] kunde inte spara spåret: ${err instanceof Error ? err.message : String(err)}`);
  }
}
