// "Ingen av dem" — säljaren avfärdar alla fyra förslagen och ber om nya.
//
// Det som gör omvalet till något annat än ett omtag är löftet: INTE samma förslag igen. Prompten blir
// tillsagd det, men en tillsägelse är modellens bedömning — en modell som nyss skrivit fyra namn
// skriver gärna samma fyra en gång till. Löftet hålls därför i kod, och det är den koden som testas
// här: sållningen i kandidatläsningen, att den sker FÖRE taket på fyra, och att ett omval alltid
// svarar med förslag och aldrig med en annons byggd på en modell säljaren just sagt nej till.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCandidates } from "../loopa-landing-page-main/functions/api/_shared/seller-candidates.js";
import { buildSellerRequest, type SellerCall } from "../server/src/listing.js";
import { collectNewCandidates } from "../server/src/pipeline/identify.js";
import type { ModelCandidate } from "../server/src/types.js";

const line = (model: string, confidence = "TROLIG", brand = "IKEA") =>
  `KANDIDAT: ${brand} | ${model} | - | soffa | ${confidence} | detalj | https://www.ikea.com/se/sv/p/${model.toLowerCase()}/`;

const names = (text: string, exclude: string[] = []) => parseCandidates(text, "IKEA", exclude).candidates.map((c) => c.model);

test("avfärdade förslag kommer inte tillbaka", () => {
  const text = [line("SÖDERHAMN"), line("KIVIK"), line("VIMLE"), line("EKTORP")].join("\n");
  assert.deepEqual(names(text), ["SÖDERHAMN", "KIVIK", "VIMLE", "EKTORP"], "utan förbudslista står alla kvar");
  assert.deepEqual(names(text, ["IKEA SÖDERHAMN", "IKEA KIVIK"]), ["VIMLE", "EKTORP"]);
});

test("sållningen sker före taket på fyra", () => {
  // Sex rader där de fyra första är avfärdade. Sållades de efter taket hade de fyra platserna redan
  // gått åt till dem, och säljaren fått noll nya förslag ur en körning som bar två.
  const text = [line("SÖDERHAMN"), line("KIVIK"), line("VIMLE"), line("EKTORP"), line("LANDSKRONA"), line("FRIHETEN")].join("\n");
  const exclude = ["IKEA SÖDERHAMN", "IKEA KIVIK", "IKEA VIMLE", "IKEA EKTORP"];
  assert.deepEqual(names(text, exclude), ["LANDSKRONA", "FRIHETEN"]);
});

test("samma modell med ett tillägg räknas som samma förslag", () => {
  // Modellen stavar sällan namnet likadant två körningar i rad.
  assert.deepEqual(names(line("SÖDERHAMN 3-sits"), ["IKEA SÖDERHAMN"]), []);
  assert.deepEqual(names(line("söderhamn"), ["IKEA SÖDERHAMN"]), [], "versaler ska inte göra den till en ny modell");
  assert.deepEqual(names(line("SÖDERHAMN"), ["SÖDERHAMN"]), [], "märket behöver inte stå med i förbudet");
});

test("två verkligt olika modeller i samma familj överlever", () => {
  assert.deepEqual(names(line("SÖDERHAMN 4-sits"), ["IKEA SÖDERHAMN 3-sits"]), ["SÖDERHAMN 4-sits"]);
});

test("förbudslistan skickas bara när det finns något att förbjuda", () => {
  const first = buildSellerRequest({ brand: "IKEA", model: "" });
  assert.equal(first.excludeModels, undefined, "första omgången har inget att utesluta");
  const again = buildSellerRequest({ brand: "IKEA", model: "" }, undefined, undefined, [], ["IKEA SÖDERHAMN"]);
  assert.deepEqual(again.excludeModels, ["IKEA SÖDERHAMN"]);
});

// ─── Generatorn: ett omval svarar med förslag, aldrig med en annons ────────

type Handler = (c: { request: Request; env: Record<string, string | undefined> }) => Promise<Response>;
let onRequestPost: Handler;

before(async () => {
  ({ onRequestPost } = (await import(
    pathToFileURL(path.resolve("loopa-landing-page-main/functions/api/seller/generate.ts")).href
  )) as { onRequestPost: Handler });
});

const IMAGES = [{ mimeType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==" }];

/** Kör fas 1 med Gemini bortstubbat. Sökningen svarar grundat med `researchText`. */
async function refresh(researchText: string, excludeModels: string[], alreadySuggested: string[] = []) {
  const realFetch = globalThis.fetch;
  let structureCalls = 0;
  let prompt = "";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    if (Array.isArray(b.tools)) prompt = JSON.stringify(b.contents);
    if (!Array.isArray(b.tools)) {
      structureCalls++;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: researchText }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://www.ikea.com/se/sv/p/soderhamn/", title: "IKEA" } }] },
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  try {
    const res = await onRequestPost({
      request: new Request("http://x/api/seller/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: "IKEA", sellerNote: "soffa", images: IMAGES, excludeModels, alreadySuggested }),
      }),
      env: { GEMINI_API_KEY: "test-key" },
    });
    const body = (await res.json()) as { kind?: string; candidates?: Array<{ model: string }> };
    return { body, structureCalls, prompt };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("ett omval lämnar bara de nya förslagen", async () => {
  const { body } = await refresh([line("SÖDERHAMN", "STARK"), line("VIMLE")].join("\n"), ["IKEA SÖDERHAMN"]);
  assert.equal(body.kind, "needs_selection");
  assert.deepEqual((body.candidates ?? []).map((c) => c.model), ["VIMLE"]);
});

test("ett omval där modellen upprepar sig svarar tomt — aldrig med en annons", async () => {
  // Utan den här spärren hade en stark upprepad kandidat auto-fortsatt som fastställd modell, och
  // säljaren fått en annons byggd på precis den möbel de nyss sagt nej till.
  const { body, structureCalls } = await refresh([line("SÖDERHAMN", "STARK"), line("KIVIK")].join("\n"), [
    "IKEA SÖDERHAMN",
    "IKEA KIVIK",
  ]);
  assert.equal(body.kind, "needs_selection");
  assert.deepEqual(body.candidates, []);
  assert.equal(structureCalls, 0, "struktureringen ska inte ens köras");
});

test("det omgången själv hittat sållas bort — men sägs aldrig vara avfärdat", async () => {
  // Andra sökningen i ett omval: SÖDERHAMN sa säljaren nej till, LANDSKRONA står redan i listan de
  // ska få se. Båda ska ut ur svaret — men bara det första är en möbel som VAR fel, och att påstå
  // det om det andra styr modellen bort från rätt möbelfamilj.
  const { body, prompt } = await refresh(
    [line("SÖDERHAMN"), line("LANDSKRONA"), line("FRIHETEN")].join("\n"),
    ["IKEA SÖDERHAMN"],
    ["IKEA LANDSKRONA"],
  );
  assert.deepEqual((body.candidates ?? []).map((c) => c.model), ["FRIHETEN"]);
  const rejectedBlock = prompt.slice(prompt.indexOf("AVFÄRDAT"), prompt.indexOf("REDAN FÖRESLAGNA"));
  assert.match(rejectedBlock, /IKEA SÖDERHAMN/);
  assert.doesNotMatch(rejectedBlock, /LANDSKRONA/, "en plats som är tagen är inte ett nej från säljaren");
  assert.match(prompt.slice(prompt.indexOf("REDAN FÖRESLAGNA")), /IKEA LANDSKRONA/);
});

// ─── Omgången: fyra NYA förslag, inte ett ─────────────────────────────────
//
// Generatorn sållar bort de avfärdade namnen ur sitt eget svar, och det är rätt — men det som blir
// kvar är då färre än fyra. Ur det enda sparade jobbet med tre omval kom 4 nya namn, sedan 2, sedan
// 1: modellen upprepade sig, och säljaren fick ett enda förslag att välja mellan. Omgången söker
// därför om tills platserna är fyllda, med det den redan hittat tillagt i förbudslistan.

const cand = (model: string, brand = "IKEA"): ModelCandidate => ({
  brand,
  model,
  variant: null,
  productType: "soffa",
  confidence: "likely",
  distinguishingDetail: null,
});

const selection = (models: string[], sources: string[] = ["https://www.ikea.com/"]): SellerCall => ({
  kind: "needs_selection",
  candidates: models.map((m) => cand(m)),
  sources: sources.map((url) => ({ url, title: "IKEA" })),
  researchText: `underlag: ${models.join(", ")}`,
});

/** En sökning som svarar med förutbestämda listor, och som skriver ner varje förbudslista den fick. */
function scripted(replies: SellerCall[]) {
  const asked: Array<{ rejected: string[]; listed: string[] }> = [];
  const search = async (rejected: string[], listed: string[]): Promise<SellerCall> => {
    asked.push({ rejected, listed });
    return replies[Math.min(asked.length - 1, replies.length - 1)];
  };
  return { search, asked };
}

test("omgången söker om tills fyra nya förslag står på skärmen", async () => {
  const rejected = [cand("SÖDERHAMN"), cand("KIVIK"), cand("VIMLE"), cand("EKTORP")];
  // Generatorn lämnar ett nytt namn i taget — precis det som gjorde omvalet till ett enda förslag.
  const { search, asked } = scripted([selection(["LANDSKRONA"]), selection(["FRIHETEN"]), selection(["BACKSÄLEN", "GRÖNLID"])]);

  const round = await collectNewCandidates(rejected, search);

  assert.deepEqual(round.candidates.map((c) => c.model), ["LANDSKRONA", "FRIHETEN", "BACKSÄLEN", "GRÖNLID"]);
  assert.equal(round.searches, 3);
  // Varje ny sökning får veta vad omgången själv redan hittat, annars letar den på samma ställe —
  // men de namnen står för sig: säljaren har inte sagt nej till dem, de har bara tagit sin plats.
  assert.deepEqual(asked[1], { rejected: rejected.map((c) => `IKEA ${c.model}`), listed: ["IKEA LANDSKRONA"] });
  assert.deepEqual(asked[2].listed, ["IKEA LANDSKRONA", "IKEA FRIHETEN"]);
});

test("en sökning räcker när den fyllde alla fyra platserna", async () => {
  const { search } = scripted([selection(["LANDSKRONA", "FRIHETEN", "BACKSÄLEN", "GRÖNLID"])]);
  const round = await collectNewCandidates([cand("SÖDERHAMN")], search);
  assert.equal(round.searches, 1, "det vanliga fallet får inte kosta fler sökningar än förut");
  assert.equal(round.candidates.length, 4);
});

test("ett namn som redan står i listan tas aldrig in två gånger", async () => {
  // Samma modell ur två sökningar, och en som säljaren redan avfärdat trots förbudet.
  const { search } = scripted([selection(["LANDSKRONA"]), selection(["LANDSKRONA", "SÖDERHAMN", "FRIHETEN"])]);
  const round = await collectNewCandidates([cand("SÖDERHAMN")], search);
  assert.deepEqual(round.candidates.map((c) => c.model), ["LANDSKRONA", "FRIHETEN"]);
});

test("källorna från alla sökningar följer med, underlaget bara från den första grundade", async () => {
  const { search } = scripted([
    { kind: "needs_selection", candidates: [cand("LANDSKRONA")], sources: [], researchText: "ogrundad" },
    selection(["FRIHETEN"], ["https://www.ikea.com/friheten/"]),
    selection(["BACKSÄLEN", "GRÖNLID"], ["https://www.ikea.com/backsalen/", "https://www.ikea.com/friheten/"]),
  ]);
  const round = await collectNewCandidates([], search);
  assert.deepEqual(round.sources.map((s) => s.url), ["https://www.ikea.com/friheten/", "https://www.ikea.com/backsalen/"]);
  assert.equal(round.research?.researchText, "underlag: FRIHETEN", "ogrundad text får aldrig bli fas 2:s underlag");
});

test("omgången slutar söka när säljaren skrivit namnet själv", async () => {
  const { search } = scripted([selection(["LANDSKRONA"])]);
  const round = await collectNewCandidates([], search, () => false);
  assert.equal(round.searches, 1, "den pågående sökningen räknas, men ingen ny startas");
  assert.deepEqual(round.candidates.map((c) => c.model), ["LANDSKRONA"]);
});

test("en fallen generator stoppar inte de förslag som redan hittats", async () => {
  const down: SellerCall = { kind: "unavailable", reason: "AI-tjänsten svarade inte." };
  const { search } = scripted([selection(["LANDSKRONA"]), down]);
  const round = await collectNewCandidates([], search);
  assert.deepEqual(round.candidates.map((c) => c.model), ["LANDSKRONA"]);
  assert.equal(round.searches, 2, "ingen tredje väntan när den andra just föll");

  // Men föll den innan något hittats är skälet det enda skärmen har att visa.
  const empty = await collectNewCandidates([], scripted([down]).search);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.error, "AI-tjänsten svarade inte.");
});
