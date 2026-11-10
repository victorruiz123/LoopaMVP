// ─── Produktforskningen: hela kedjan utan nätverk ───────────────────────────────────────────────
//
// Gemini stubbas bort med färdiga utfall (JSON + spår) och sidhämtningen med en liten sidtext. Det som
// testas är allt som ligger RUNT modellen: att identifieringen är ETT anrop under en klocka (tidsgränsen prövas i
// tests/identify-deadline.test.ts), att kandidater sållas, att okända adresser avvisas, att annonsen slår
// ihop forskningens rader med generatorns utan att ett belagt mått ger vika — och att prompterna
// aldrig nämner en enda modell. Ingenting här mäter hur bra Gemini är på att känna igen en möbel; det
// kräver en skarp körning (scripts/research-probe.ts).

process.env.LOOPA_FACTS_CACHE = "0"; // testerna får inte läsa eller skriva driftens faktaminne

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InteractionOutcome, InteractionRequest, InteractionRunner } from "../server/src/research/geminiInteractions.js";
import {
  identifyFurniture,
  parseIdentify,
  researchSpecs,
  testHooks,
  toListingAttributes,
  toModelCandidates,
  toSourceRefs,
} from "../server/src/research/pipeline.js";
import { IDENTIFY_MAX_ROUNDS, IDENTIFY_ROUND_QUERIES, ROUND_STRAY_QUERIES } from "../server/src/research/config.js";
import { buildIdentifyPrompt, buildSpecPrompt, identifySystemInstruction, specSystemInstruction } from "../server/src/research/prompts.js";
import { byggAnnons, mergeResearchAttributes, startUrlsFor } from "../server/src/pipeline/annons.js";
import type { ListingAttribute } from "../server/src/types.js";
import { fakeTrace } from "./helpers/fakeGemini.js";

const IKEA = "https://www.ikea.com/se/sv/p/produkt-stol-bjork-grå-s49984122/";
const MANUAL = "https://www.ikea.com/se/sv/manuals/produkt-stol__AA-123.pdf";
const LISTING = "https://www.blocket.se/annons/stockholm/ikea-stolar-123";
const IMG = { mimeType: "image/jpeg", base64: "/9j/4AAQSkZJRg==" };

const outcome = (json: unknown, trace: Partial<ReturnType<typeof fakeTrace>> = {}): InteractionOutcome => ({
  json,
  text: JSON.stringify(json),
  trace: fakeTrace(trace),
});

const cand = (model: string, confidence: "strong" | "likely" | "possible" = "possible", over: Record<string, unknown> = {}) => ({
  brand: "IKEA",
  model,
  variant: null,
  productType: "matstol",
  confidence,
  evidence: confidence === "possible" ? [] : ["rak rygg med slåar", "grå tygsits"],
  distinguishingDetail: null,
  sourceUrl: null,
  discontinued: null,
  ...over,
});

const identifyJson = (candidates: unknown[], over: Record<string, unknown> = {}) => ({
  category: "matstol",
  observations: ["rak rygg", "grå sits"],
  candidates,
  exactMatch: false,
  uncertaintyNote: null,
  summary: "Sökte och jämförde.",
  ...over,
});

/** En körare som svarar med nästa utfall och noterar vad den fick. */
function scripted(...results: Array<InteractionOutcome | Error>): { run: InteractionRunner; seen: InteractionRequest[] } {
  const seen: InteractionRequest[] = [];
  const run: InteractionRunner = async (req) => {
    seen.push(req);
    const next = results[seen.length - 1];
    if (!next) throw new Error(`scripted: inget utfall för anrop ${seen.length}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, seen };
}

// ─── Identifiering ──────────────────────────────────────────────────────────

test("ett avgörande svar: ETT anrop, och en kandidat som modellen själv kallar 'möjlig' och inte kan belägga visas inte", async () => {
  const { run, seen } = scripted(
    outcome(identifyJson([cand("ALFA", "strong", { sourceUrl: IKEA }), cand("BETA")], { exactMatch: true }), {
      searchQueries: ["q1", "q2"],
      toolCalls: 2,
      usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 2 },
    }),
  );
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG, IMG], label: "t1" }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 1);
  assert.equal(out.summary.passes, 1);
  assert.equal(out.exactMatch, true);
  assert.deepEqual(out.candidates.map((c) => c.model), ["ALFA"], "BETA var 'möjlig' och utan en enda synlig detalj");
  assert.deepEqual(out.dropped?.map((d) => d.model), ["BETA"]);
  assert.equal(seen[0].label, "t1");
  assert.equal(seen[0].purpose, "identify");
  assert.equal(seen[0].maxSearchQueries, IDENTIFY_ROUND_QUERIES + ROUND_STRAY_QUERIES, "skyddsnätet för omgången är satt: ett sökanrop och utrymme för ett till");
});

test("ett svar som inte avgör får en andra omgång med sina egna fynd i uppgiften — och den kan avgöra", async () => {
  const first = outcome(identifyJson([cand("ALFA"), cand("BETA")], { uncertaintyNote: "Ryggens slåar syns inte tydligt." }), {
    searchQueries: ["vit stol lodräta spjälor", "ikea stol grå sits blocket"],
    toolCalls: 2,
    usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 2 },
  });
  const second = outcome(identifyJson([cand("GAMMA", "strong")], { exactMatch: true }), {
    searchQueries: ["ikea gamma stol"],
    usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 1 },
  });
  const { run, seen } = scripted(first, second);
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 2, "den första omgången avgjorde inte, så en andra körs; den andra avgjorde, så ingen tredje");
  assert.equal(out.summary.passes, 2);
  assert.deepEqual(out.candidates.map((c) => c.model), ["GAMMA"]);
  assert.equal(out.exactMatch, true);
  // Omgång 1 vet inget om omgång 2; omgång 2 får modellens egna fynd och vad som redan sökts.
  assert.doesNotMatch(seen[0].prompt, /EARLIER ROUNDS/);
  assert.match(seen[0].systemInstruction, /round 1 of up to 3/);
  assert.match(seen[1].systemInstruction, /round 2 of up to 3/);
  assert.match(seen[1].prompt, /WHAT YOUR EARLIER ROUNDS ESTABLISHED/);
  assert.match(seen[1].prompt, /"vit stol lodräta spjälor"/, "det som redan sökts står där, så att det inte sökas igen");
  assert.match(seen[1].prompt, /Ryggens slåar syns inte tydligt/, "det som är öppet följer med");
  assert.match(seen[1].prompt, /COMPLETE updated list/);
  assert.equal(out.trace, out.traces[1], "kvittot hör till omgången vars svar visas");
});

test("högst IDENTIFY_MAX_ROUNDS omgångar: svar som aldrig blir starka stannar ändå, och det senaste svaret visas", async () => {
  const usage = { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 1 };
  const answers = Array.from({ length: IDENTIFY_MAX_ROUNDS + 2 }, (_, i) => outcome(identifyJson([cand(`M${i + 1}`, "likely")]), { searchQueries: [`q${i}`], usage }));
  const { run, seen } = scripted(...answers);
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, IDENTIFY_MAX_ROUNDS);
  assert.deepEqual(out.candidates.map((c) => c.model), [`M${IDENTIFY_MAX_ROUNDS}`]);
  assert.equal(out.exactMatch, false, "en trolig modell är aldrig en exakt träff");
});

test("faller en SENARE omgång kastas inte de tidigare: omgång 1:s kandidater levereras, och kvittot hör till den", async () => {
  const { InteractionError } = await import("../server/src/research/geminiInteractions.js");
  const usage = (n: number) => ({ inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: n });
  const cut = new InteractionError("fler än 9 sökfrågor (12)", "tool_budget");
  cut.trace = fakeTrace({ stoppedBy: "tool_budget", error: { kind: "tool_budget", message: "x" }, usage: usage(12) });
  const { run, seen } = scripted(outcome(identifyJson([cand("ALFA", "likely")]), { searchQueries: ["q1"], usage: usage(1) }), cut);
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 2);
  assert.deepEqual(out.candidates.map((c) => [c.model, c.confidence]), [["ALFA", "likely"]]);
  assert.equal(out.summary.passes, 1, "en omgång gav ett svar");
  assert.equal(out.traces.length, 2, "den avbrutna omgången är med i spåren — den kostade pengar");
  assert.notEqual(out.trace.stoppedBy, "tool_budget", "kvittot är omgång 1:s, inte den avbrutnas");
  assert.equal(out.summary.searchQueries, 13, "också den avbrutnas sökfrågor räknas");
});

test("en senare omgång utan kandidater ersätter inte en tidigare med kandidater", async () => {
  const usage = { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 1 };
  const { run } = scripted(
    outcome(identifyJson([cand("ALFA", "likely")]), { searchQueries: ["q1"], usage }),
    outcome(identifyJson([], { uncertaintyNote: "Hittade inget nytt." }), { searchQueries: ["q2"], usage }),
    outcome(identifyJson([], { uncertaintyNote: "Hittade inget nytt." }), { searchQueries: ["q3"], usage }),
  );
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.candidates.map((c) => c.model), ["ALFA"]);
});

test("tillåtelsen ur kostnadsboken delas av omgångarna: när den inte rymmer en ny omgång startas ingen", async () => {
  // Tillåtelsen är 6 sökfrågor; omgång 1 körde fem. En enda kvarvarande fråga är ingen omgång (MIN_ROUND_QUERIES).
  const { run, seen } = scripted(
    outcome(identifyJson([cand("ALFA", "likely")]), { searchQueries: ["a", "b", "c", "d", "e"], usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 1, totalTokens: 3, searchQueries: 5 } }),
    outcome(identifyJson([cand("GAMMA", "strong")], { exactMatch: true })),
  );
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG], maxSearchQueries: 6 }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, 1, "en sjätte sökfråga är ingen omgång");
  assert.deepEqual(out.candidates.map((c) => c.model), ["ALFA"]);
  assert.match(seen[0].systemInstruction, /holding at most 5 different queries/);
});

test("en omgång får aldrig fler sökfrågor än det som är kvar i tillåtelsen", async () => {
  const { run, seen } = scripted(outcome(identifyJson([cand("ALFA", "strong")], { exactMatch: true })));
  await identifyFurniture({ brand: "IKEA", images: [IMG], maxSearchQueries: 3 }, { run });
  assert.match(seen[0].systemInstruction, /holding at most 3 different queries/);
  assert.equal(seen[0].maxSearchQueries, 3, "och strömmen stängs inte senare än tillåtelsen");
});

test("noll kandidater är ett svar, inte ett fel — efter alla omgångar", async () => {
  const empty = () => outcome(identifyJson([], { uncertaintyNote: "Inga modeller stämde med de synliga detaljerna." }));
  const { run, seen } = scripted(empty(), empty(), empty());
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(seen.length, IDENTIFY_MAX_ROUNDS);
  assert.deepEqual(out.candidates, []);
  assert.equal(out.dropped, undefined, "inget sållades: modellen angav inget");
  assert.match(out.uncertaintyNote ?? "", /Inga modeller stämde/);
});

test("faller första omgången blir det 'unavailable' med felets art — som beslutsregeln bygger på", async () => {
  const { InteractionError } = await import("../server/src/research/geminiInteractions.js");
  const billing = new InteractionError("402 prepayment credits are depleted", "billing", 402);
  billing.trace = fakeTrace({ stoppedBy: "error", error: { kind: "billing", message: "x" } });
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run: scripted(billing).run });
  assert.equal(out.kind, "unavailable");
  if (out.kind !== "unavailable") return;
  assert.equal(out.failKind, "billing");
  assert.match(out.reason, /krediter/);
  assert.ok(out.summary, "kvittot följer med även när det föll");

  const tl = new InteractionError(TOOL_LIMIT, "tool_limit", 400);
  assert.equal(((await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run: scripted(tl).run })) as { failKind: string }).failKind, "tool_limit");
});
const TOOL_LIMIT = "Model generated too many tool calls. Please retry the request.";

test("inga bilder är inget att söka på", async () => {
  const out = await identifyFurniture({ brand: "IKEA", images: [] }, { run: scripted().run });
  assert.equal(out.kind, "unavailable");
});

test("svar som inte går att tolka blir 'unavailable' (unparseable), inte ett undantag", async () => {
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run: scripted({ json: null, text: "skräp", trace: fakeTrace() }).run });
  assert.equal(out.kind, "unavailable");
  if (out.kind === "unavailable") assert.equal(out.failKind, "unparseable");
});

test("avfärdade förslag sållas bort, dubbletter slås ihop och en färg är ingen variant", () => {
  const json = identifyJson([
    cand("ALFA", "strong", { variant: "svart / grå" }),
    cand("alfa", "likely"),
    cand("KAUSTBY", "likely"),
    cand("BETA", "possible", { variant: "3-sits" }),
  ]);
  const p = parseIdentify(json, { brand: "IKEA", excludeModels: ["IKEA KAUSTBY"] })!;
  assert.deepEqual(p.candidates.map((c) => c.model), ["ALFA", "BETA"]);
  assert.equal(p.candidates[0].variant, null);
  assert.equal(p.candidates[1].variant, "3-sits");
  assert.equal(p.exactMatch, false, "exakt kräver modellens eget påstående");
});

test("produktsidor och källa: identitet och variant bevaras, men omdirigeringar, bildfiler och begagnatsajter blir aldrig bildkällor", () => {
  const parsed = parseIdentify(
    identifyJson([
      cand("ALFA", "strong", {
        variant: "3-sits",
        sourceUrl: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
        productPages: [
          "https://www.blocket.se/annons/stockholm/ikea-alfa-1",
          "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def",
          "https://imgv2-1-f.scribdassets.com/img/document/1/298x396/x.jpg",
          "https://www.retailer.se/alfa",
          "not a url",
        ],
      }),
    ]),
    { brand: "IKEA" },
  )!;
  const c = parsed.candidates[0];
  assert.equal(c.model, "ALFA", "modellen bevarad");
  assert.equal(c.variant, "3-sits", "varianten bevarad");
  assert.equal(c.sourceUrl, null, "Googles omdirigeringsadress är ingen källa att visa");
  assert.deepEqual(c.productPages, ["https://www.retailer.se/alfa"]);
});

test("'exakt träff' räknas bara med en stark toppkandidat", () => {
  assert.equal(parseIdentify(identifyJson([cand("ALFA", "likely")], { exactMatch: true }), { brand: "IKEA" })!.exactMatch, false);
  assert.equal(parseIdentify(identifyJson([cand("ALFA", "strong")], { exactMatch: true }), { brand: "IKEA" })!.exactMatch, true);
  assert.equal(parseIdentify(identifyJson([cand("ALFA", "strong")], { exactMatch: false }), { brand: "IKEA" })!.exactMatch, false, "exakt kräver modellens eget påstående");
});

// ─── Prompterna ─────────────────────────────────────────────────────────────

test("prompterna nämner ingen modell — varken exempel eller facit", () => {
  const all = [
    identifySystemInstruction({ searchBudget: 10 }),
    specSystemInstruction({ searchBudget: 8 }),
    buildIdentifyPrompt({ brand: "IKEA", imageCount: 3 }),
    buildSpecPrompt({ brand: "IKEA", model: "X", imageCount: 1, confirmedBy: "seller" }),
  ].join("\n");
  // Möbelnamn ur märkets sortiment, inklusive det som är regressionsfallet. Brandnamnet i sig är inte en modell.
  for (const name of ["NORRN", "NÄSINGE", "NASINGE", "EKEDALEN", "TONSTAD", "PINNTORP", "VIHALS", "STEFAN", "SÖDERHAMN", "EKTORP", "KIVIK", "BÖRJE", "LERHAMN"]) {
    assert.ok(!all.toUpperCase().includes(name), `prompten nämner ${name}`);
  }
});

test("identifieringen är forskning, inte en snabb klassificering: hypoteser testas mot motbevis, och de närmaste modellerna jämförs", () => {
  const p = identifySystemInstruction({ searchBudget: 10 });
  assert.match(p, /form hypotheses from the photographs, test them against evidence, and try to disprove them/);
  assert.match(p, /A model name you already suspect is a hypothesis to test, not an answer/);
  assert.match(p, /Take the two to four closest models in the brand's range \(current AND discontinued\)/);
  assert.match(p, /look for evidence AGAINST your leading hypothesis/);
  assert.match(p, /say which difference is still open/);
  assert.match(p, /read any label or text that is visible/);
  // Ett sökanrop per omgång (koden kör flera i följd), och båda verktygen.
  assert.match(p, /EXACTLY ONE google_search call, holding at most 10 different queries/);
  assert.match(p, /open at most three pages with the URL tool/);
  assert.match(p, /manufacturer's category page for this kind of furniture/);
  assert.match(p, /Do not enumerate the brand's model names one query at a time/);
  assert.doesNotMatch(p, /Do not search again|at most TWO search rounds/);
});

test("ett snävare tak ur säkerhetsbudgeten sänker bara siffrorna i prompten, aldrig arbetssättet", () => {
  const p = identifySystemInstruction({ searchBudget: 6 });
  assert.match(p, /holding at most 6 different queries/);
  assert.match(p, /try to disprove them/);
});

test("identifieringsprompten bär det som saknades: budget, begagnatannonser, utgångna modeller, ingen fast kandidatmängd", () => {
  const p = identifySystemInstruction({ searchBudget: 10 });
  // Budgeten räknas i FRÅGOR: prompten och taket i config.ts talar samma språk.
  assert.match(p, /EXACTLY ONE google_search call, holding at most 10 different queries/);
  assert.match(p, /delivers NOTHING/);
  assert.match(p, /Budgets are counted in search QUERIES, not in tool calls/);
  assert.match(p, /Never run a query you have already run/);
  assert.match(p, /In round 1, build the queries from the visible FEATURES/);
  assert.match(p, /productPages/);
  for (const marketplace of ["Blocket", "Tradera", "Facebook Marketplace"]) assert.match(p, new RegExp(marketplace));
  assert.match(p, /discontinued/i);
  assert.match(p, /Return 1 to 4 candidates/);
  assert.match(p, /Never pad the list/);
  assert.match(p, /If it supports none, return no candidates/);
  assert.match(p, /Do not research dimensions, materials or prices/);
  assert.doesNotMatch(p, /exactly 4|exakt fyra|always four/i);
  assert.doesNotMatch(p, /Prefer several targeted searches/, "den formulering som drev 57 sökningar är borta");
});

test("specprompten har budget och en startpunkt, och begagnatannonser är inte specifikationskälla", () => {
  const p = specSystemInstruction({ searchBudget: 8 });
  assert.match(p, /EXACTLY ONE google_search call, holding at most 8 different queries/);
  assert.match(p, /VARIANTS\./);
  assert.match(p, /textile percentages/);
  assert.match(p, /read it completely before you search/);
  assert.match(p, /Used-furniture listings are NOT specification sources/);
  const user = buildSpecPrompt({ brand: "IKEA", model: "X", imageCount: 2, confirmedBy: "seller", startUrls: [IKEA, MANUAL] });
  assert.match(user, new RegExp(IKEA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(user, /check that each page really is about this model/);
  assert.doesNotMatch(buildSpecPrompt({ brand: "IKEA", model: "X", imageCount: 0, confirmedBy: "seller" }), /already found these pages/);
});

test("omvalsprompten säger att de avfärdade är fel och bjuder på äldre modeller", () => {
  const p = buildIdentifyPrompt({ brand: "IKEA", imageCount: 2, excludeModels: ["IKEA ALFA", "IKEA BETA"], alreadySuggested: ["IKEA GAMMA"] });
  assert.match(p, /REJECTED these suggestions: IKEA ALFA, IKEA BETA/);
  assert.match(p, /older and discontinued/);
  assert.match(p, /already on the list[^.]*: IKEA GAMMA/);
});

// ─── Specifikationer ────────────────────────────────────────────────────────

const SPEC_JSON = {
  identity: { brand: "IKEA", model: "PRODUKT", variant: null, category: "matstol", confidence: "high", matchesPhotos: true, note: null, discontinued: true },
  dimensions: [
    { type: "overall_width", label: "Bredd", value: 42, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: IKEA, quote: "Bredd: 42 cm" },
    { type: "seat_height", label: "Sitthöjd", value: 46, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: IKEA, quote: null },
    { type: "overall_height", label: "Höjd", value: 89, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: IKEA, quote: null },
    { type: "backrest_height", label: "Rygghöjd", value: 45, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: MANUAL, quote: null },
    { type: "overall_depth", label: "Djup", value: 54, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: "https://www.fake-shop.se/produkt", quote: null },
    { type: "seat_depth", label: "Sittdjup", value: 44, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: LISTING, quote: "Djup: 44 cm" },
    { type: "weight", label: "Vikt", value: 6.2, valueMax: null, unit: "kg", appliesTo: null, sourceUrl: null, quote: null },
  ],
  materials: [
    { component: "Stomme", material: "Massiv björk", detail: "klarlack", appliesTo: null, sourceUrl: IKEA, quote: null },
    { component: "Sits", material: "Polyuretanskum 35 kg/m³", detail: null, appliesTo: null, sourceUrl: IKEA, quote: null },
    { component: "Klädsel", material: "Isunda: 85 % polyester, 15 % bomull", detail: null, appliesTo: null, sourceUrl: MANUAL, quote: null },
  ],
  otherFacts: [{ label: "Designer", value: "Mikael Warnhammar", sourceUrl: IKEA }],
  retailPriceSek: 799,
  retailPriceSourceUrl: IKEA,
  conflicts: [],
  missing: ["sittdjup"],
  sourcesUsed: [
    { url: IKEA, title: "PRODUKT Stol - IKEA", kind: "manufacturer" },
    { url: MANUAL, title: "Monteringsanvisning", kind: "manual" },
    { url: LISTING, title: "IKEA stolar | Blocket", kind: "other" },
  ],
  summary: "Produktsidan och manualen lästa.",
};

const PAGE = `PRODUKT Stol, björk/Isunda grå. Bredd: 42 cm Djup: 54 cm Höjd: 89 cm Sitthöjd: 46 cm. Stomme: Massiv björk, Klarlack. Sits: Polyuretanskum 35 kg/m³. Designer Mikael Warnhammar. Pris 799 kr`;
const fetchedPages: string[] = [];
/** Produktsidan läses; manualen är en PDF som finns men inte tolkas; allt annat faller. */
const fetchPage = async (url: string) => {
  fetchedPages.push(url);
  return url === IKEA ? PAGE : url === MANUAL ? ("unsupported" as const) : null;
};

test("specsökningen: mått och material verifieras, okända källor sållas, begagnatannonser hämtas aldrig, allt blir attribut", async () => {
  fetchedPages.length = 0;
  // I JSON-läge kommer inga url_citation-annoteringar tillbaka (uppmätt skarpt: citations=0); det som
  // bevisar att en adress besöktes är url_context-hämtningen.
  const trace = { fetchedUrls: [{ url: IKEA, status: "success" }], citations: [], purpose: "specs" };
  const { run, seen } = scripted(outcome(SPEC_JSON, trace));
  const out = await researchSpecs(
    { brand: "IKEA", model: "PRODUKT", images: [IMG], confirmedBy: "seller", startUrls: [IKEA], label: "t2", prepareMs: 12 },
    { run, fetchPage },
  );
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;

  assert.match(seen[0].prompt, /already found these pages/);
  assert.equal(seen[0].label, "t2");
  assert.ok(seen[0].maxSearchQueries && seen[0].maxSearchQueries >= 20);
  assert.match(seen[0].systemInstruction, /EXACTLY ONE google_search call, holding at most \d+ different queries/);

  const byType = Object.fromEntries(out.dimensions.map((d) => [d.type, d]));
  assert.equal(byType.overall_width.verification, "page_confirmed");
  assert.equal(byType.seat_height.verification, "page_confirmed");
  assert.equal(byType.overall_height.verification, "page_confirmed");
  assert.equal(byType.backrest_height.verification, "cited", "manualen är en PDF: finns, men tolkas inte");
  // En okänd butik som inte går att läsa kastas inte längre: uppgiften står kvar som osäker.
  assert.equal(byType.overall_depth.verification, "unverified");
  assert.equal(byType.overall_depth.verified, false);
  assert.equal(byType.weight, undefined, "mått varken med källa eller citat → borta");
  // Annonsen på Blocket: citerad, aldrig bekräftad, och aldrig hämtad av oss.
  assert.equal(byType.seat_depth.verification, "cited");
  assert.equal(byType.seat_depth.verified, false);
  assert.ok(!fetchedPages.includes(LISTING), "vår server hämtar aldrig Blocket");

  assert.equal(out.materials.find((m) => m.component === "Stomme")?.verification, "page_confirmed");
  assert.equal(out.materials.find((m) => m.component === "Klädsel")?.verification, "cited");
  assert.equal(out.retailPrice?.valueSek, 799);
  assert.equal(out.facts[0].verification, "page_confirmed");
  assert.deepEqual(out.missing, ["sittdjup"]);

  assert.equal(out.summary.purpose, "specs");
  assert.equal(out.summary.stages.prepareImagesMs, 12);
  assert.ok(out.summary.stages.verifyMs !== undefined && out.summary.stages.parseMs >= 0);

  const attrs = toListingAttributes(out);
  const bredd = attrs.find((a) => a.key === "bredd");
  assert.equal(bredd?.value, "42 cm");
  assert.equal(bredd?.verified, true);
  assert.equal(bredd?.kind, "dimension");
  const stomme = attrs.find((a) => a.key === "material_stomme");
  assert.equal(stomme?.value, "Massiv björk, klarlack");
  assert.ok(attrs.some((a) => a.label === "Designer"));
  assert.match(out.researchText, /MÅTT: Bredd \| 42 cm \(källa: https:\/\/www\.ikea\.com/);
  assert.match(out.researchText, /\[bekräftad mot sidan\]/);
  assert.equal(toSourceRefs(out.sources)[0].qualityTier, 1);
});

test("faller specsökningen får anroparen felets art och spåret", async () => {
  const { InteractionError } = await import("../server/src/research/geminiInteractions.js");
  const e = new InteractionError("budgeten tog slut", "timeout");
  e.trace = fakeTrace({ stoppedBy: "time_budget" });
  const out = await researchSpecs({ brand: "IKEA", model: "X", images: [], confirmedBy: "seller" }, { run: scripted(e).run });
  assert.equal(out.kind, "unavailable");
  if (out.kind === "unavailable") {
    assert.equal(out.failKind, "timeout");
    assert.ok(out.summary);
  }
  const bad = await researchSpecs({ brand: "IKEA", model: "X", images: [], confirmedBy: "seller" }, { run: scripted({ json: null, text: "nonsense", trace: fakeTrace() }).run });
  assert.equal(bad.kind, "unavailable");
});

test("kandidater blir appens typer: evidens följer med, och källor är riktiga adresser", async () => {
  const { run } = scripted(
    outcome(identifyJson([cand("ALFA", "strong", { sourceUrl: IKEA, discontinued: true, distinguishingDetail: "rak rygg" })], { exactMatch: true }), {
      fetchedUrls: [{ url: IKEA, status: "success" }],
      citations: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "x" }],
    }),
  );
  const out = await identifyFurniture({ brand: "IKEA", images: [IMG] }, { run });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  const candidates = toModelCandidates(out);
  assert.deepEqual(candidates[0].evidence, ["rak rygg med slåar", "grå tygsits"]);
  assert.equal(candidates[0].distinguishingDetail, "rak rygg");
  assert.equal(candidates[0].sourceUrl, IKEA);
  const refs = toSourceRefs(out.sources);
  assert.ok(refs.every((r) => !/vertexaisearch/.test(r.url)), "Googles omdirigeringsadresser är inga källor att visa");
  assert.equal(refs[0].url, IKEA);
});

// ─── Annonsen ───────────────────────────────────────────────────────────────

test("mergeResearchAttributes: forskningens rader vinner, generatorn fyller bara luckor", () => {
  const research: ListingAttribute[] = [
    { key: "bredd", label: "Bredd", value: "42 cm", kind: "dimension", verified: true },
    { key: "material_stomme", label: "Stomme", value: "Massiv björk", kind: "material" },
  ];
  const legacy: ListingAttribute[] = [
    { key: "bredd", label: "Bredd", value: "ca 45 cm", estimated: true },
    { key: "hojd", label: "Höjd", value: "ca 88 cm", estimated: true },
    { key: "matt", label: "Mått", value: "42 x 54 x 89 cm" },
    { key: "material", label: "Material", value: "Trä" },
    { key: "farg", label: "Färg", value: "Grå" },
    { key: "sitthojd", label: "Sitthöjd", value: "46 cm", sellerEdited: true },
  ];
  const out = mergeResearchAttributes(research, legacy);
  assert.deepEqual(out.map((a) => a.label), ["Bredd", "Stomme", "Färg", "Sitthöjd"]);
});

test("startpunkter för specsökningen: kandidatens sida först, tillverkare före butik, aldrig omdirigeringar eller begagnatsajter från källistan", () => {
  const urls = startUrlsFor(
    LISTING,
    [
      { title: "a", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/zzz", qualityTier: 1 },
      { title: "b", url: "https://www.svenssons.se/stol" },
      { title: "c", url: IKEA },
      { title: "d", url: "https://www.tradera.com/item/1" },
      { title: "e", url: "https://blog.example.com/post" },
    ],
    "IKEA",
  );
  assert.deepEqual(urls, [LISTING, IKEA, "https://www.svenssons.se/stol"]);
  assert.deepEqual(startUrlsFor(null, [], "IKEA"), []);
});

let dir: string;
const realFetch = globalThis.fetch;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopa-research-"));
  const originals = path.join(dir, "originals");
  mkdirSync(originals, { recursive: true });
  // En giltig 1x1-JPEG, så bildförberedelsen läser en riktig fil.
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
    "base64",
  );
  writeFileSync(path.join(originals, "img_0.jpg"), jpeg);
  process.env.SELLER_RESEARCH_BUDGET_MS ??= "24000";
  process.env.SELLER_OVERALL_DEADLINE_MS ??= "60000";
  process.env.GEMINI_API_KEY ??= "test-key";
});
after(() => {
  testHooks.run = null;
  testHooks.fetchPage = null;
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const structured = {
  identity: { brand: "IKEA", exactProduct: "PRODUKT", variant: null, category: "matstol", confidence: "high", uncertain: false, uncertaintyNote: null },
  attributes: [
    { key: "material", label: "Material", value: "Björk", sourceUrl: null },
    { key: "farg", label: "Färg", value: "Grå", sourceUrl: null },
  ],
  condition: { grade: "B", label: "Gott skick", defects: [], reasoning: "x", uncertain: false, uncertaintyNote: null },
  pricing: { available: true, retailPriceSek: null, suggestedPriceSek: 300, priceRangeMinSek: 200, priceRangeMaxSek: 400, rationale: "x" },
  listing: { title: "IKEA PRODUKT stol", description: "Fin stol.", conditionText: "Gott skick." },
  missingNotes: [],
};

const frames = [{ id: "a", viewLabel: null, source: "manual" as const, width: 1, height: 1, path: "img_0.jpg", capturedAt: new Date().toISOString() }];
const selected = { brand: "IKEA", model: "PRODUKT", variant: null, productType: "matstol", confidence: "strong" as const, distinguishingDetail: null, sourceUrl: IKEA };

test("byggAnnons: generatorn söker inte själv utan strukturerar ur forskningen, och måtten kommer från forskningen", async () => {
  const sent: Array<{ grounded: boolean; prompt: string }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    sent.push({ grounded: Array.isArray(b.tools), prompt: (b.contents[0].parts as Array<{ text?: string }>).map((p) => p.text ?? "").join("") });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] }));
  }) as unknown as typeof fetch;

  let specReq: InteractionRequest | null = null;
  testHooks.run = async (req) => {
    specReq = req;
    return outcome(SPEC_JSON, { fetchedUrls: [{ url: IKEA, status: "success" }], purpose: "specs" });
  };
  testHooks.fetchPage = fetchPage;

  const call = await byggAnnons({ brand: "IKEA", model: "PRODUKT" }, frames, dir, { kind: "seller_selected", selected });
  assert.equal(call.kind, "ok");
  if (call.kind !== "ok") return;
  assert.equal(sent.length, 1, "bara struktureringsanropet gick till generatorn");
  assert.equal(sent[0].grounded, false);
  assert.match(sent[0].prompt, /MÅTT: Bredd \| 42 cm/);
  assert.equal(specReq!.images.length, 1, "bildrutan skickas med till specsökningen");
  assert.match(specReq!.prompt, /already found these pages/, "kandidatens egen sida är startpunkt");
  assert.equal(specReq!.label, path.basename(dir).slice(0, 8));

  const r = call.listing.result!;
  const labels = r.attributes.map((a) => a.label);
  assert.ok(labels.includes("Bredd") && labels.includes("Sitthöjd") && labels.includes("Stomme") && labels.includes("Klädsel"));
  assert.ok(labels.includes("Färg"), "generatorns färg fyller en lucka");
  assert.ok(!labels.includes("Material"), "generatorns svepande material viker för forskningens per komponent");
  assert.equal(r.attributes.find((a) => a.label === "Bredd")?.verified, true);
  assert.equal(r.pricing.retailPriceSek, 799, "nypriset kommer från forskningen när generatorn saknar det");
  assert.equal(r.sources[0].url, IKEA);
  assert.equal(r.research?.engine, "gemini3");
  assert.equal(r.research?.attempts, 1);
  assert.equal(r.research?.verifiedDimensions, 3);
  assert.ok(!(r.missingFields ?? []).includes("dimensions"));
  assert.ok(!(r.missingFields ?? []).includes("material"));
  assert.equal(r.listing.title, "IKEA PRODUKT stol");
});

test("byggAnnons: faller forskningen går anropet den gamla vägen", async () => {
  let grounded = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    if (Array.isArray(b.tools)) {
      grounded++;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "MÅTT: bredd | 42 cm (källa: https://www.ikea.com/x)" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://www.ikea.com/x", title: "IKEA" } }] } }],
        }),
      );
    }
    const s = { identity: { brand: "IKEA", exactProduct: "PRODUKT", confidence: "high" }, attributes: [], pricing: {}, listing: { title: "t", description: "d", conditionText: "c" } };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(s) }] } }] }));
  }) as unknown as typeof fetch;
  testHooks.run = async () => {
    throw new Error("gemini 429: quota");
  };
  const call = await byggAnnons({ brand: "IKEA", model: "PRODUKT" }, frames, dir, { kind: "manual", manualModel: "PRODUKT" });
  assert.equal(call.kind, "ok");
  assert.equal(grounded, 1, "generatorns egen sökning kördes som reserv");
  if (call.kind === "ok") assert.equal(call.listing.result?.research, undefined);
});

test("byggAnnons: när forskningens källor alla är döda söker generatorn INTE om — verifierat underlag räcker utan adresser", async () => {
  // Mätt 2026-10-20 (NORRNÄS): noll visningsbara källor gjorde att prior_only föll tillbaka på generatorns
  // EGNA grundade sökning — tre Gemini-anrop, 15–17 s, och en andra sökning som kunde motsäga den verifierade.
  const DEAD = "https://dead.example/katalog/norrnas.pdf";
  const spec = {
    ...SPEC_JSON,
    dimensions: [
      { type: "overall_width", label: "Bredd", value: 42, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: DEAD, quote: "B42" },
      { type: "overall_height", label: "Höjd", value: 94, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: DEAD, quote: "H94" },
    ],
    materials: [{ component: "Stomme", material: "Massiv bok", detail: null, appliesTo: null, sourceUrl: DEAD, quote: "massiv bok" }],
    otherFacts: [],
    retailPriceSek: null,
    retailPriceSourceUrl: null,
    sourcesUsed: [{ url: DEAD, title: "Katalog", kind: "catalog" }],
  };
  const sent: Array<{ grounded: boolean; prompt: string }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    sent.push({ grounded: Array.isArray(b.tools), prompt: (b.contents[0].parts as Array<{ text?: string }>).map((p) => p.text ?? "").join("") });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] }));
  }) as unknown as typeof fetch;
  testHooks.run = async () => outcome(spec, { purpose: "specs" });
  testHooks.fetchPage = async () => "gone";

  const call = await byggAnnons({ brand: "IKEA", model: "PRODUKT" }, frames, dir, { kind: "seller_selected", selected: { ...selected, sourceUrl: null } });
  assert.equal(call.kind, "ok");
  if (call.kind !== "ok") return;
  assert.equal(sent.length, 1, `generatorn gjorde ${sent.length} anrop`);
  assert.equal(sent[0].grounded, false, "ingen egen grundad sökning");
  assert.match(sent[0].prompt, /MÅTT: Bredd \| 42 cm/, "underlaget är forskningens");
  const r = call.listing.result!;
  assert.equal(r.sources.length, 0, "inga döda adresser visas som källor");
  assert.equal(r.attributes.find((a) => a.type === "overall_width")?.value, "42 cm", "måtten kom med trots att ingen källa gick att länka");
  assert.equal(r.attributes.find((a) => a.type === "overall_width")?.verification, "unverified");
});

test("summarize: ett fallet försök räknas EN gång, också när dess spår ligger med och listan över fel delas av flera spår", async () => {
  const { summarize } = await import("../server/src/research/pipeline.js");
  const stages = { prepareImagesMs: 0, geminiMs: 0, parseMs: 0, totalMs: 1 };
  const own = { model: "m", kind: "tool_budget", message: "x", ms: 31_000, toolCalls: 4, searchQueries: 14, costUsd: 0.2 };
  const shared = [own];
  // Spåret för det fallna försöket bär sin egen post (så skriver runInteraction in den) — 0,20 USD, inte 0,40.
  const failed = fakeTrace({ latencyMs: 31_000, estimatedCostUsd: 0.2, stoppedBy: "tool_budget", failures: shared });
  assert.equal(summarize("identify", [failed], stages, 1).costUsd, 0.2);
  // Ett lyckat försök som delar listan: det fallna försöket (inte i sammanställningen som spår) räknas, det lyckade också.
  const ok = fakeTrace({ latencyMs: 40_000, estimatedCostUsd: 0.3, failures: shared });
  assert.equal(summarize("identify", [ok], stages, 1).costUsd, 0.5);
  // Båda spåren med: varje försök en gång.
  assert.equal(summarize("identify", [failed, ok], stages, 1).costUsd, 0.5);
  // Ett tidigare fel som inte har ett eget spår i sammanställningen räknas ändå.
  const other = fakeTrace({ latencyMs: 12_000, estimatedCostUsd: 0.1, failures: [{ model: "m", kind: "hedge_unused", message: "x", ms: 9_000, toolCalls: 2, searchQueries: 6, costUsd: 0.07 }] });
  assert.equal(summarize("identify", [other], stages, 1).costUsd, 0.17);
  assert.equal(summarize("identify", [failed], stages, 1).failures.length, 1);
});
