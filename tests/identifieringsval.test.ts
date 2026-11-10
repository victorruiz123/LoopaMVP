// ─── Vad som händer med identifieringen när forskningen svarat — eller inte kunnat ─────────────────
//
// Den första skarpa körningen (2026-10-11): forskningens anrop föll efter 205 s, den gamla generatorn
// tog över och gav fyra kandidater ur märkets nuvarande sortiment, ingen av dem rätt. Säljaren såg
// fyra välvårdade produktbilder på fel stolar. Testerna nedan låser fast beslutsregeln som ersätter
// det: forskningens svar — även ett tomt — är svaret; när forskningen inte gav något (tiden tog slut, tjänsten var nere, krediterna
// är slut) blir det ett ärligt besked UTAN kandidater och med rätt skäl — aldrig den gamla generatorn som reserv (sedan tidsgränsen
// på 60 s: den svarar med en svagare modell och utan tidsgräns); och en gissad modell förvärms aldrig för 0,60 USD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { beslutaEfterForskning, noteForEmptyResearch } from "../server/src/pipeline/identifieringsval.js";
import { collectNewCandidates } from "../server/src/pipeline/identify.js";
import type { SellerCall } from "../server/src/listing.js";
import type { IdentifyOutcome } from "../server/src/research/types.js";
import type { ModelCandidate } from "../server/src/types.js";
import { fakeTrace } from "./helpers/fakeGemini.js";

const unavailable = (failKind: string | null): IdentifyOutcome => ({ kind: "unavailable", reason: "x", failKind, trace: fakeTrace(), summary: null });
const ok = (): IdentifyOutcome => ({
  kind: "ok",
  category: null,
  observations: [],
  candidates: [],
  exactMatch: false,
  uncertaintyNote: null,
  sources: [],
  trace: fakeTrace(),
  traces: [fakeTrace()],
  summary: {
    purpose: "identify",
    passes: 1,
    attempts: 1,
    model: "m",
    totalMs: 1,
    searchQueries: 0,
    toolCalls: 0,
    fetchedPages: 0,
    costUsd: 0,
    stoppedBy: "completed",
    failures: [],
    stages: { geminiMs: 1, parseMs: 0, totalMs: 1 },
  },
  researchText: "",
});

test("forskningen svarade: det är svaret, även när listan är tom", () => {
  assert.deepEqual(beslutaEfterForskning(ok()), { use: "research" });
});

test("tjänsten gick inte att nå: ett ärligt besked om det — INTE den gamla generatorn som gissar med en svagare modell", () => {
  for (const kind of ["quota", "overloaded", "network", "http", "billing"]) {
    const d = beslutaEfterForskning(unavailable(kind));
    assert.equal(d.use, "none", kind);
    if (d.use === "none") {
      assert.equal(d.result, "unavailable", kind);
      assert.match(d.note, /inte tillgänglig/);
      assert.match(d.note, /skriv modellnamnet själv/i);
    }
  }
});

test("tiden tog slut, eller sökningen blev för omfattande: ett ärligt besked, inte fyra gissningar ur nuvarande sortiment", () => {
  for (const kind of ["timeout", "deadline", "tool_limit", "tool_budget"]) {
    const d = beslutaEfterForskning(unavailable(kind));
    assert.equal(d.use, "none", kind);
    if (d.use === "none") {
      assert.equal(d.result, "timeout", kind);
      assert.match(d.note, /tog för lång tid/);
      assert.match(d.note, /fler bilder/, "säljaren får veta vad som hjälper");
      assert.match(d.note, /skriv modellnamnet själv/i);
      assert.match(d.note, /inget fel på dina bilder/);
    }
  }
});

test("okända fel och svar som inte gick att tolka ger också ett ärligt besked", () => {
  for (const kind of ["unparseable", "empty", "aborted", "no_images", null]) {
    const d = beslutaEfterForskning(unavailable(kind));
    assert.equal(d.use, "none", String(kind));
    if (d.use === "none") assert.equal(d.result, "unavailable", String(kind));
  }
});

test("modellens egen förklaring under en tom väljare visas bara om den ser ut som en förklaring", () => {
  assert.equal(noteForEmptyResearch("Ingen modell stämde med ryggens utseende."), "Ingen modell stämde med ryggens utseende.");
  assert.equal(noteForEmptyResearch(null), null);
  assert.equal(noteForEmptyResearch("  "), null);
  assert.equal(noteForEmptyResearch("n/a"), null);
  assert.equal((noteForEmptyResearch("x".repeat(500)) ?? "").length, 298);
});


// ─── Omvalsrundan ───────────────────────────────────────────────────────────

const cand = (model: string): ModelCandidate => ({ brand: "IKEA", model, variant: null, productType: "stol", confidence: "possible", distinguishingDetail: null });
const research = (candidates: ModelCandidate[], over: Partial<Extract<SellerCall, { kind: "needs_selection" }>> = {}): SellerCall => ({
  kind: "needs_selection",
  candidates,
  sources: [{ title: "ikea.com", url: "https://www.ikea.com/se/sv/p/x/", qualityTier: 1 }],
  researchText: "KANDIDAT 1: ...",
  engine: "gemini3",
  exactMatch: false,
  ...over,
});
const legacy = (candidates: ModelCandidate[]): SellerCall => ({ kind: "needs_selection", candidates, sources: [], researchText: "" });

test("en omvalsrunda med forskningen är EN sökning — den söker inte om tills fyra platser är fyllda", async () => {
  let calls = 0;
  const round = await collectNewCandidates([cand("AVFÄRDAD")], async () => {
    calls++;
    return research([cand("NY")]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(round.candidates.map((c) => c.model), ["NY"], "en kandidat är ett ärligt svar");
  assert.equal(round.engine, "gemini3");
  assert.equal(round.searches, 1);
  assert.ok(round.research, "underlaget till fas 2 följer med");
});

test("en forskningsrunda bär sitt utfall vidare: ett tomt val vet VARFÖR det är tomt", async () => {
  const round = await collectNewCandidates([], async () => research([], { result: "timeout", note: "Vi hann inte.", sources: [] }));
  assert.deepEqual(round.candidates, []);
  assert.equal(round.result, "timeout");
  assert.equal(round.error, "Vi hann inte.");
});

test("en tom forskningsrunda bär sitt besked och söks inte om", async () => {
  let calls = 0;
  const round = await collectNewCandidates([cand("AVFÄRDAD")], async () => {
    calls++;
    return research([], { note: "Inga andra modeller stämde med bilderna.", sources: [] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(round.candidates, []);
  assert.equal(round.error, "Inga andra modeller stämde med bilderna.");
});

test("avfärdade förslag som ändå kommer tillbaka ur forskningen sållas bort i rundan", async () => {
  const round = await collectNewCandidates([cand("AVFÄRDAD")], async () => research([cand("AVFÄRDAD"), cand("NY")]));
  assert.deepEqual(round.candidates.map((c) => c.model), ["NY"]);
});

test("generatorns runda är oförändrad: den söker om tills platserna är fyllda", async () => {
  let calls = 0;
  const round = await collectNewCandidates([], async () => {
    calls++;
    return legacy(calls === 1 ? [cand("A"), cand("B")] : [cand("C"), cand("D")]);
  });
  assert.equal(calls, 3, "tre sökningar: platserna fylldes, men ingen sökning kom tillbaka grundad");
  assert.deepEqual(round.candidates.map((c) => c.model), ["A", "B", "C", "D"]);
  assert.equal(round.engine, undefined);
});
