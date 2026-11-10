// ─── Googles omdirigeringsadresser lösta till de riktiga sidorna ─────────────────────────────────────────────────────────
//
// Sökverktyget ger varje källa som `vertexaisearch.cloud.google.com/grounding-api-redirect/…`. Koden kasserade alla — så referensbilderna aldrig fick en
// enda produktsida att leta bild på ("Ingen produktbild hittades" på varje kandidat), och ett mått med en sådan källa kunde aldrig kontrolleras mot
// sidan. Här prövas lösningen utan nätverk: en falsk `fetch` som svarar som Google gör (302 med Location).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { collectRedirects, resolveGroundingRedirects, withResolvedUrls } from "../server/src/research/redirects.js";
import { fakeTrace } from "./helpers/fakeGemini.js";
import type { InteractionOutcome } from "../server/src/research/geminiInteractions.js";

const G = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const outcome = (): InteractionOutcome => ({
  json: {
    candidates: [{ model: "STRANDMON", sourceUrl: G("a"), productPages: [G("b"), "https://www.ikea.com/se/sv/p/direkt-1/"] }],
    note: "ingen url här",
  },
  text: "",
  trace: fakeTrace({
    citations: [
      { url: G("a"), title: "ikea.com" },
      { url: G("c"), title: "dimensions.com" },
    ],
    fetchedUrls: [{ url: G("b"), status: "success" }],
  }),
});

test("alla omdirigeringar ett anrop bär hittas: citat, lästa sidor och varje sträng i modellens JSON — och bara de", () => {
  assert.deepEqual(collectRedirects(outcome()).sort(), [G("a"), G("b"), G("c")].sort());
  assert.deepEqual(collectRedirects({ json: { x: "https://www.ikea.com/p/1" }, trace: fakeTrace({}) }), []);
});

test("lösta adresser byts ut i spåret OCH i JSON:en; ovärderade lämnas; dubbletter slås ihop", async () => {
  const map = new Map([
    [G("a"), "https://www.ikea.com/se/sv/p/strandmon/"],
    [G("b"), "https://www.ikea.com/se/sv/p/strandmon/"],
  ]);
  const out = await withResolvedUrls(outcome(), async () => map);
  const j = out.json as { candidates: Array<{ sourceUrl: string; productPages: string[] }> };
  assert.equal(j.candidates[0].sourceUrl, "https://www.ikea.com/se/sv/p/strandmon/");
  assert.deepEqual(j.candidates[0].productPages, ["https://www.ikea.com/se/sv/p/strandmon/", "https://www.ikea.com/se/sv/p/direkt-1/"]);
  assert.deepEqual(out.trace.citations.map((c) => c.url), ["https://www.ikea.com/se/sv/p/strandmon/", G("c")], "den olösta behålls, de två lösta blir en");
  assert.deepEqual(out.trace.fetchedUrls.map((f) => f.url), ["https://www.ikea.com/se/sv/p/strandmon/"]);
});

test("ingen lösning lämnar svaret oförändrat (samma objekt): ett fall i nätet får aldrig förstöra ett svar", async () => {
  const o = outcome();
  assert.equal(await withResolvedUrls(o, async () => new Map()), o);
  // Utan omdirigeringar anropas lösaren aldrig.
  const plain = { json: { a: 1 }, text: "", trace: fakeTrace({}) };
  assert.equal(await withResolvedUrls(plain, async () => { throw new Error("ska inte anropas"); }), plain);
});

test("lösaren följer Location men hämtar aldrig sidan, och en 200, ett nätfel eller en ny omdirigering ger ingen adress", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: { redirect?: string }) => {
    seen.push(`${url} ${init?.redirect}`);
    if (url === G("ok")) return new Response(null, { status: 302, headers: { location: "https://www.ikea.com/se/sv/p/x/" } });
    if (url === G("rel")) return new Response(null, { status: 302, headers: { location: "/se/sv/p/y/" } });
    if (url === G("loop")) return new Response(null, { status: 302, headers: { location: G("ok") } });
    if (url === G("body")) return new Response("hej", { status: 200 });
    throw new Error("nätfel");
  }) as unknown as typeof fetch;
  const map = await resolveGroundingRedirects([G("ok"), G("rel"), G("loop"), G("body"), G("err"), "https://www.ikea.com/redan/riktig"]);
  assert.equal(map.get(G("ok")), "https://www.ikea.com/se/sv/p/x/");
  assert.equal(map.has(G("rel")), false, "en relativ Location räknas mot omdirigeringens egen värd och är då fortfarande en omdirigering: kastas");
  assert.equal(map.has(G("loop")), false);
  assert.equal(map.has(G("body")), false);
  assert.equal(map.has(G("err")), false);
  assert.ok(seen.every((s) => s.endsWith("manual")), "ingen sida hämtas — bara Location läses");
  assert.ok(!seen.some((s) => s.includes("ikea.com/redan")), "en redan riktig adress rörs inte");
});
