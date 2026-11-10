// ─── Identifieringens hårda tidsgräns och sållningen av vad som visas ───────────────────────────────
//
// Krav: säljaren får aldrig vänta mer än 60 s på identifieringen — modellanrop, sökning, verktyg, omförsök och efterbehandling
// ligger under EN klocka (research/deadline.ts) — och vid gränsen finns inget försvarbart svar: inga påhittade kandidater, inget
// gissat svar från en svagare modell, ingen väntan i det oändliga. Här prövas klockans samspel med identifieringen med falska
// körare och kort tid (tests/helpers/fastDeadline.ts krymper 57 s till 0,4 s); att den håller i hela kedjan genom jobbet
// prövas i tests/identify-flow.test.ts. Det som INTE prövas här är hur bra Gemini är på att känna igen en möbel.

import "./helpers/fastDeadline.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { InteractionError, type InteractionErrorKind, type InteractionOutcome, type InteractionRequest, type InteractionRunner } from "../server/src/research/geminiInteractions.js";
import { Deadline, isDeadlineExceeded } from "../server/src/research/deadline.js";
import { IDENTIFY_DEADLINE_MS, IDENTIFY_MAX_ROUNDS, IDENTIFY_MIN_CALL_MS, IDENTIFY_RESERVE_MS, IDENTIFY_ROUND_QUERIES, IDENTIFY_THINKING, ROUND_STRAY_QUERIES } from "../server/src/research/config.js";
import { gateCandidates, identifyFurniture, identifyRequest, parseIdentify } from "../server/src/research/pipeline.js";
import { fakeTrace } from "./helpers/fakeGemini.js";
import { FAST } from "./helpers/fastDeadline.js";

const IMG = { mimeType: "image/jpeg", base64: "/9j/4AAQSkZJRg==" };
const INPUT = { brand: "Sits", images: [IMG, IMG], label: "t" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cand = (model: string, confidence: "strong" | "likely" | "possible" = "strong", over: Record<string, unknown> = {}) => ({
  brand: "Sits",
  model,
  variant: null,
  productType: "fåtölj",
  confidence,
  evidence: ["breda kantiga armstöd", "korta svarta runda ben"],
  distinguishingDetail: null,
  sourceUrl: null,
  discontinued: null,
  ...over,
});
const identifyJson = (candidates: unknown[], over: Record<string, unknown> = {}) => ({
  category: "fåtölj",
  observations: ["grå klädsel"],
  candidates,
  exactMatch: true,
  uncertaintyNote: null,
  summary: "x",
  ...over,
});
const ok = (json: unknown, trace: Partial<ReturnType<typeof fakeTrace>> = {}): InteractionOutcome => ({ json, text: JSON.stringify(json), trace: fakeTrace(trace) });
const failure = (kind: InteractionErrorKind, trace: Partial<ReturnType<typeof fakeTrace>> = {}): InteractionError => {
  const e = new InteractionError(`fel: ${kind}`, kind);
  e.trace = fakeTrace({ stoppedBy: "error", error: { kind, message: kind }, ...trace });
  return e;
};

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

/** En körare som svarar med nästa utfall i listan och noterar varje anrop. */
function scripted(...results: Array<InteractionOutcome | Error | ((req: InteractionRequest) => Promise<InteractionOutcome>)>) {
  const seen: InteractionRequest[] = [];
  const run: InteractionRunner = async (req) => {
    seen.push(req);
    const next = results[Math.min(seen.length, results.length) - 1];
    if (!next) throw new Error("scripted: inget utfall");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(req);
    return next;
  };
  return { run, seen };
}

// ─── Uppdraget bär klockan ──────────────────────────────────────────────────

test("anropets tid kommer från klockan: tiden kvar minus utrymmet för efterbehandlingen — och krymper när klockan går", () => {
  const clock = fakeClock();
  const deadline = new Deadline(56_000, { now: clock.now });
  const first = identifyRequest(INPUT, { deadline });
  assert.equal(first.timeoutMs, 56_000 - IDENTIFY_RESERVE_MS);
  clock.advance(10_000);
  assert.equal(identifyRequest(INPUT, { deadline }).timeoutMs, 46_000 - IDENTIFY_RESERVE_MS, "ett senare anrop får bara det som är kvar");
  clock.advance(100_000);
  assert.equal(identifyRequest(INPUT, { deadline }).timeoutMs, 0, "aldrig negativt");
  deadline.dispose();
});

test("uppdraget har ett försök: inget eget omförsök, ingen säkring, ingen reservmodell — och djupt (ej low) tänkande", () => {
  const deadline = new Deadline(56_000);
  const req = identifyRequest(INPUT, { deadline });
  assert.equal(req.purpose, "identify");
  // Runnern har ett enda försök (research/geminiInteractions.ts); ett fall hanteras av identifyFurniture, under samma livslängd.
  for (const gone of ["noRetry", "firstAttemptShare", "fallbackModel", "hedgeAtQueries", "retrySearchBudget", "minRetryMs"]) {
    assert.equal(gone in req, false, `${gone} finns inte längre på uppdraget`);
  }
  assert.equal(req.thinkingLevel, IDENTIFY_THINKING);
  assert.notEqual(req.thinkingLevel, "low");
  assert.equal(req.maxSearchQueries, IDENTIFY_ROUND_QUERIES + ROUND_STRAY_QUERIES, "en omgång är ETT sökanrop; strömmen stängs lite över det");
  assert.equal(req.tools, undefined, "båda verktygen: sökning OCH sidhämtning — en produktsida som visar möbeln är det starkaste belägget");
  assert.ok(req.signal, "klockans signal följer med");
  assert.equal(req.images.length, 2);
  deadline.dispose();
});

test("utan en klocka från anroparen får uppdraget produktionens budget, och en anroparsignal skickas vidare", () => {
  const ac = new AbortController();
  const req = identifyRequest(INPUT, { signal: ac.signal });
  assert.equal(req.timeoutMs, IDENTIFY_DEADLINE_MS - IDENTIFY_RESERVE_MS);
  assert.equal(req.signal, ac.signal);
});

test("klockans signal följer med uppdraget och avbryts när tiden är slut — anroparens egen också", async () => {
  const caller = new AbortController();
  const deadline = new Deadline(60);
  const req = identifyRequest(INPUT, { deadline, signal: caller.signal });
  assert.equal(req.signal!.aborted, false);
  await sleep(120);
  assert.equal(req.signal!.aborted, true);
  assert.ok(isDeadlineExceeded(req.signal!.reason), "orsaken går att känna igen som tidsgränsen");

  const d2 = new Deadline(5_000);
  const req2 = identifyRequest(INPUT, { deadline: d2, signal: caller.signal });
  assert.equal(req2.signal!.aborted, false);
  caller.abort();
  assert.equal(req2.signal!.aborted, true, "anroparens avbrott går igenom");
  assert.equal(isDeadlineExceeded(req2.signal!.reason), false, "och är inte tidsgränsen");
  deadline.dispose();
  d2.dispose();
});

// ─── Ett svar inom tiden ────────────────────────────────────────────────────

test("ett avgörande svar: ETT anrop, ingen andra omgång, och kvittot bär klockans utfall", async () => {
  const { run, seen } = scripted(ok(identifyJson([cand("IMPULSE")]), { searchQueries: ["q1", "q2"], toolCalls: 2 }));
  const out = await identifyFurniture(INPUT, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 1);
  assert.equal(out.summary.passes, 1);
  assert.deepEqual(out.candidates.map((c) => c.model), ["IMPULSE"]);
  assert.equal(out.exactMatch, true);
  assert.equal(out.summary.deadline?.limitMs, FAST.deadlineMs);
  assert.equal(out.summary.deadline?.hit, false);
  assert.ok((out.summary.deadline?.elapsedMs ?? 1e9) < FAST.deadlineMs, "klart långt före gränsen");
  assert.equal(out.dropped, undefined, "inget sållades bort");
});

test("en ny omgång startas bara om tiden kvar täcker en omgång som den längsta hittills — annars kastas fem sökfrågor för inget", async () => {
  // Mätt 2026-10-25: två omgångar tog 67 s och 73 s; en tredje som startade med 40 s kvar stoppades av livslängden och gav ingenting (≈0,96 SEK).
  const clock = fakeClock();
  const deadline = new Deadline(180_000, { now: clock.now });
  const usage = { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 5 };
  const round = async () => {
    clock.advance(70_000);
    return ok(identifyJson([cand("IMPULSE", "likely")], { exactMatch: false }), { latencyMs: 70_000, searchQueries: ["a", "b", "c", "d", "e"], usage });
  };
  const { run, seen } = scripted(round, round, round);
  const out = await identifyFurniture(INPUT, { run, deadline });
  deadline.dispose();
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 2, "efter 140 s återstår 40 s, och en omgång tar ≈70 s: ingen tredje");
  assert.deepEqual(out.candidates.map((c) => c.model), ["IMPULSE"]);
  assert.equal(out.summary.passes, 2);
});

test("med gott om tid kvar körs alla omgångar", async () => {
  const clock = fakeClock();
  const deadline = new Deadline(600_000, { now: clock.now });
  const usage = { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 4 };
  const round = async () => {
    clock.advance(30_000);
    return ok(identifyJson([cand("IMPULSE", "likely")], { exactMatch: false }), { latencyMs: 30_000, searchQueries: ["a", "b", "c", "d"], usage });
  };
  const { run, seen } = scripted(round, round, round, round);
  const out = await identifyFurniture(INPUT, { run, deadline });
  deadline.dispose();
  assert.equal(out.kind, "ok");
  assert.equal(seen.length, IDENTIFY_MAX_ROUNDS);
});

test("klockan stannar när identifieringen är klar: signalen avbryts inte i efterhand", async () => {
  let captured: AbortSignal | undefined;
  const { run } = scripted(async (req) => {
    captured = req.signal;
    return ok(identifyJson([cand("IMPULSE")]));
  });
  await identifyFurniture(INPUT, { run });
  await sleep(FAST.deadlineMs + 120);
  assert.equal(captured!.aborted, false, "en färdig körning får inte avbrytas av en klocka som ingen längre väntar på");
});

test("bildförberedelsen räknas in: klockan startar före den, och kvittot säger hur länge den tog", async () => {
  const { run } = scripted(ok(identifyJson([cand("IMPULSE")])));
  const out = await identifyFurniture({ ...INPUT, prepareMs: 150 }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.summary.stages.prepareImagesMs, 150);
  assert.ok((out.summary.deadline?.elapsedMs ?? 0) >= 150, "de 150 ms är en del av klockans tid");
  assert.ok(out.summary.stages.totalMs >= 150);
});

// ─── Sållningen: vad som får nå säljaren ────────────────────────────────────

test("Sits-fallet: 'trolig' och 'möjlig' kandidater MED evidens visas, märkta med sin säkerhet — modellen föreslår, säljaren väljer", async () => {
  // Så som svaret såg ut 2026-10-21: Brandon som trolig, Quattro som möjlig. Förut hölls den möjliga tillbaka; nu visas båda, och skärmen
  // säger att ingen är bekräftad. Det som INTE visas är det som saknar evidens (nästa test).
  const json = identifyJson([cand("BRANDON", "likely"), cand("QUATTRO", "possible", { evidence: ["breda kantiga armstöd"] })], { exactMatch: false });
  const out = await identifyFurniture(INPUT, { run: scripted(ok(json)).run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.candidates.map((c) => [c.model, c.confidence]), [["BRANDON", "likely"], ["QUATTRO", "possible"]]);
  assert.equal(out.exactMatch, false);
  assert.equal(out.dropped, undefined);
});

test("bara 'möjliga' kandidater med evidens: alla visas, och inget kallas bekräftat", async () => {
  const json = identifyJson([cand("BRANDON", "possible"), cand("QUATTRO", "possible")], { exactMatch: false, uncertaintyNote: "Armstödens form går inte att jämföra." });
  const { run, seen } = scripted(ok(json));
  const out = await identifyFurniture(INPUT, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.candidates.map((c) => c.confidence), ["possible", "possible"]);
  assert.equal(out.exactMatch, false, "en möjlig modell är aldrig en exakt träff");
  assert.match(out.uncertaintyNote ?? "", /Armstödens form/);
  assert.ok(seen.length >= 1 && seen.length <= IDENTIFY_MAX_ROUNDS, "ett svar som inte avgör kan få fler omgångar — om tiden räcker — men aldrig fler än taket");
});

test("kandidater utan en enda synlig detalj visas inte — och om ingen har någon blir det noll kandidater, ett fullgott svar", async () => {
  const json = identifyJson([cand("BRANDON", "possible", { evidence: [] }), cand("QUATTRO", "possible", { evidence: [] })], { exactMatch: false, uncertaintyNote: "Inget i bilderna pekar ut en modell." });
  const out = await identifyFurniture(INPUT, { run: scripted(ok(json)).run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.candidates, []);
  assert.deepEqual(out.dropped?.map((d) => [d.model, d.reason]), [["BRANDON", "no_evidence"], ["QUATTRO", "no_evidence"]]);
});

test("en kandidat utan en enda synlig detalj visas inte, och 'exakt' faller med den", async () => {
  const json = identifyJson([cand("IMPULSE", "strong", { evidence: [] }), cand("BRANDON", "likely")], { exactMatch: true });
  const out = await identifyFurniture(INPUT, { run: scripted(ok(json)).run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.candidates.map((c) => c.model), ["BRANDON"]);
  assert.equal(out.exactMatch, false, "modellens 'exakt' gällde en kandidat som inte längre visas");
  assert.deepEqual(out.dropped?.map((d) => [d.model, d.reason, d.position]), [["IMPULSE", "no_evidence", 0]]);
});

test("gateCandidates: stark, trolig och möjlig MED evidens visas, i modellens ordning; exakt bara om den exakta kandidaten visas först", () => {
  const parsed = (cs: unknown[], exactMatch: boolean) => parseIdentify(identifyJson(cs, { exactMatch }), { brand: "Sits" })!;
  const a = gateCandidates(parsed([cand("A", "strong"), cand("B", "likely"), cand("C", "possible"), cand("D", "possible", { evidence: [] })], true));
  assert.deepEqual(a.shown.map((c) => c.model), ["A", "B", "C"]);
  assert.equal(a.exactMatch, true);
  assert.deepEqual(a.dropped.map((d) => d.model), ["D"]);

  const b = gateCandidates(parsed([cand("A", "likely"), cand("B", "likely")], true));
  assert.equal(b.exactMatch, false, "exakt kräver en stark toppkandidat — parseIdentify har redan sagt det");

  const c = gateCandidates(parsed([], false));
  assert.deepEqual(c, { shown: [], exactMatch: false, dropped: [] });
});

// ─── Tiden tar slut ─────────────────────────────────────────────────────────

test("en körare som aldrig svarar: vakten ger ett ärligt utfall strax efter gränsen, och signalen har då stängt anropet", async () => {
  let captured: InteractionRequest | undefined;
  const run: InteractionRunner = (req) => {
    captured = req;
    return new Promise(() => {}); // hänger sig, ignorerar både signal och budget
  };
  const t0 = Date.now();
  const out = await identifyFurniture(INPUT, { run });
  const elapsed = Date.now() - t0;
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "deadline");
  assert.equal(out.summary?.deadline?.hit, true);
  assert.ok(elapsed >= FAST.deadlineMs - 20, `inte före gränsen (${elapsed} ms)`);
  assert.ok(elapsed < FAST.deadlineMs + FAST.watchdogGraceMs + 400, `och inte långt efter den: ${elapsed} ms`);
  assert.equal(captured!.signal!.aborted, true, "anropets ström har fått beskedet att stänga");
  assert.ok(isDeadlineExceeded(captured!.signal!.reason));
});

test("en körare som följer sin budget (som den riktiga gör) svarar 'timeout' före tidsgränsen — vakten behövs inte", async () => {
  const { run, seen } = scripted(async (req) => {
    await sleep(req.timeoutMs); // den riktiga körarens ström stängs när budgeten tar slut
    throw failure("timeout", { stoppedBy: "time_budget" });
  });
  const t0 = Date.now();
  const out = await identifyFurniture(INPUT, { run });
  const elapsed = Date.now() - t0;
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "timeout", "anropet gav upp självt, med reserven kvar för det som följer");
  assert.equal(out.summary?.deadline?.hit, true);
  assert.ok(elapsed < FAST.deadlineMs + 150, `${elapsed} ms`);
  assert.equal(seen.length, 1, "och ingen andra omgång, inget snabbspår, inget omförsök");
});

test("en körare som bara lyssnar på signalen avbryts av klockan — utfallet är tidsgränsen, inte ett avbrott beställt av anroparen", async () => {
  const run: InteractionRunner = (req) =>
    new Promise((_, reject) => {
      req.signal!.addEventListener("abort", () => reject(failure("aborted")), { once: true });
    });
  const t0 = Date.now();
  const out = await identifyFurniture(INPUT, { run });
  const elapsed = Date.now() - t0;
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "deadline");
  assert.equal(out.summary?.deadline?.hit, true);
  assert.ok(elapsed < FAST.deadlineMs + 250, `${elapsed} ms: klockan, inte vakten, avgjorde`);
});

test("anroparens egen avbrytning är 'aborted' — inte tidsgränsen", async () => {
  const caller = new AbortController();
  const run: InteractionRunner = (req) =>
    new Promise((_, reject) => {
      req.signal!.addEventListener("abort", () => reject(failure("aborted")), { once: true });
    });
  setTimeout(() => caller.abort(), 40);
  const out = await identifyFurniture(INPUT, { run, signal: caller.signal });
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "aborted");
  assert.equal(out.summary?.deadline?.hit, false, "tidsgränsen nåddes inte; någon annan avbröt");
});

test("arbete som inte hinner bli klart startas inte: med mindre tid kvar än ett anrop behöver görs inget anrop alls", async () => {
  const clock = fakeClock();
  const deadline = new Deadline(56_000, { now: clock.now });
  clock.advance(56_000 - (IDENTIFY_MIN_CALL_MS - 5));
  const { run, seen } = scripted(ok(identifyJson([cand("IMPULSE")])));
  const out = await identifyFurniture(INPUT, { run, deadline });
  assert.equal(seen.length, 0, "ett anrop utan tid kvar kostar pengar och ger ingenting");
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "deadline");
  assert.equal(out.summary?.deadline?.hit, true);
  deadline.dispose();
});

test("ett ärligt tomt utfall vid gränsen: inga kandidater, inget svar från någon annan modell", async () => {
  const { run, seen } = scripted(async (req) => {
    await sleep(req.timeoutMs);
    throw failure("timeout", { stoppedBy: "time_budget", searchQueries: ["sits impulse"], toolCalls: 12 });
  });
  const out = await identifyFurniture(INPUT, { run });
  assert.equal(out.kind, "unavailable");
  assert.equal("candidates" in out, false, "ingenting att visa");
  assert.equal(seen.every((r) => !("fallbackModel" in r)), true, "ingen reservmodell finns att välja");
  assert.equal(seen.length, 1);
});

// ─── Omförsök under samma klocka ────────────────────────────────────────────

test("ett tillfälligt fel får ETT omförsök med samma modell och inställning — på det som är kvar av tiden", async () => {
  const clock = fakeClock();
  const deadline = new Deadline(56_000, { now: clock.now });
  let n = 0;
  const { run, seen } = scripted(async () => {
    n++;
    clock.advance(100);
    if (n === 1) throw failure("overloaded", { estimatedCostUsd: 0.05, latencyMs: 100 });
    return ok(identifyJson([cand("IMPULSE")]), { estimatedCostUsd: 0.2 });
  });
  const out = await identifyFurniture(INPUT, { run, deadline });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 2);
  const same = ({ timeoutMs: _t, signal: _s, ...rest }: InteractionRequest) => rest;
  assert.deepEqual(same(seen[1]), same(seen[0]), "samma modell, samma tänkande, samma bilder, samma uppdrag");
  assert.ok(seen[1].timeoutMs < seen[0].timeoutMs, "men bara den tid som är kvar");
  assert.equal(out.traces.length, 2, "båda försöken finns i spåret");
  assert.equal(out.summary.costUsd, 0.25, "och det som föll kostade ändå pengar");
  deadline.dispose();
});

test("faller omförsöket också: exakt två anrop, ett ärligt utfall — inget tredje", async () => {
  const clock = fakeClock();
  const deadline = new Deadline(56_000, { now: clock.now });
  const { run, seen } = scripted(async () => {
    clock.advance(50);
    throw failure("overloaded");
  });
  const out = await identifyFurniture(INPUT, { run, deadline });
  assert.equal(seen.length, 2);
  assert.equal(out.kind, "unavailable");
  if (out.kind === "unavailable") assert.equal(out.failKind, "overloaded");
  deadline.dispose();
});

test("ett tillfälligt fel när tiden nästan är slut ger inget omförsök", async () => {
  const clock = fakeClock();
  const deadline = new Deadline(56_000, { now: clock.now });
  const { run, seen } = scripted(async () => {
    clock.advance(56_000 - (IDENTIFY_MIN_CALL_MS - 5)); // felet kom sent: det är för lite tid kvar för ett helt anrop
    throw failure("network");
  });
  const out = await identifyFurniture(INPUT, { run, deadline });
  assert.equal(seen.length, 1);
  assert.equal(out.kind, "unavailable");
  if (out.kind === "unavailable") assert.equal(out.failKind, "network");
  deadline.dispose();
});

test("en 'timeout' långt före tidsgränsen är en anslutning som tystnade: ett nätfel som får ETT omförsök — och räknas inte som att gränsen nåddes", async () => {
  const { run, seen } = scripted(failure("timeout"));
  const out = await identifyFurniture(INPUT, { run });
  assert.equal(seen.length, 2, "samma regel som ett nätfel: ett omförsök");
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "network", "klockan hade ännu inte gått ut");
  assert.equal(out.summary?.deadline?.hit, false);
});

test("fel som inte går över ger inget omförsök: kvot, krediter, för många sökningar, tomt svar", async () => {
  for (const kind of ["quota", "billing", "tool_budget", "tool_limit", "empty", "http"] as const) {
    const { run, seen } = scripted(failure(kind));
    const out = await identifyFurniture(INPUT, { run });
    assert.equal(out.kind, "unavailable", kind);
    assert.equal(seen.length, 1, `${kind}: ett omförsök skulle bara kosta pengar`);
    if (out.kind === "unavailable") assert.equal(out.failKind, kind);
  }
});

// ─── Det som blir kvar när vakten vunnit ────────────────────────────────────

test("ett arbete som blir klart EFTER att vakten vunnit lämnar inget obevakat löfte efter sig", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const run: InteractionRunner = () => new Promise((_, reject) => setTimeout(() => reject(failure("network")), FAST.deadlineMs + FAST.watchdogGraceMs + 250));
    const out = await identifyFurniture(INPUT, { run });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable") assert.equal(out.failKind, "deadline");
    await sleep(600); // körarens sena fel kommer under tiden
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("inga bilder: ingen klocka startas och inget anrop görs", async () => {
  const { run, seen } = scripted();
  const out = await identifyFurniture({ brand: "Sits", images: [] }, { run });
  assert.equal(out.kind, "unavailable");
  if (out.kind === "unavailable") assert.equal(out.failKind, "no_images");
  assert.equal(seen.length, 0);
});
