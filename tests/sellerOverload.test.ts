// En överbelastad modell får inte kosta säljaren modellsökningen.
//
// Säljarvägen körde EN modell (gemini-3.5-flash-lite) för båda anropen, utan utväg. Svarade den 503
// "The model is overloaded" föll sökningen, struktureringen med den, båda kandidatförsöken i
// identifieringen — och säljaren landade på en tom valskärm som lade skulden på möbeln: "Vi hittade
// inga modeller att föreslå. Skriv namnet själv." Ingen sökning hade gjorts.
//
// Två saker prövas här. Att en snabb 503 tas om av en ANNAN modell — överbelastning och kvot är per
// modell hos Google, så samma modell igen är garanterat bortkastat. Och att svaret säger vad som
// hände när även den faller: skillnaden mellan "vi sökte och hittade inget" och "ingen sökning blev
// av" är hela beskedet säljaren behöver.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GeminiCallError, modelUnavailable } from "../loopa-landing-page-main/functions/api/_shared/gemini.js";
import { identityNote } from "../server/src/pipeline/identify.js";

process.env.SELLER_RESEARCH_BUDGET_MS ??= "24000";
process.env.SELLER_RESEARCH_RETRY_BUDGET_MS ??= "16000";
process.env.SELLER_OVERALL_DEADLINE_MS ??= "60000";

type Handler = (c: { request: Request; env: Record<string, string | undefined> }) => Promise<Response>;
let onRequestPost: Handler;

before(async () => {
  ({ onRequestPost } = (await import(
    pathToFileURL(path.resolve("loopa-landing-page-main/functions/api/seller/generate.ts")).href
  )) as { onRequestPost: Handler });
});

const IMAGES = [{ mimeType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==" }];
const SELLER_MODEL = "gemini-3.5-flash-lite";

const RESEARCH_TEXT = `SÖDERHAMN 3-sits (källa: https://www.ikea.com/se/sv/p/soderhamn/).
KANDIDAT: IKEA | SÖDERHAMN | - | soffa | TROLIG | låg rygg | https://www.ikea.com/se/sv/p/soderhamn/
KANDIDAT: IKEA | KIVIK | - | soffa | MÖJLIG | djup sits | https://www.ikea.com/se/sv/p/kivik/`;

/** Googles egen 503 när modellen är hårt belastad — ordagrant den text säljaren fick se. */
const OVERLOADED = () =>
  new Response(
    JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }),
    { status: 503 },
  );

/**
 * Kör fas 1 med Gemini bortstubbat, modell för modell.
 *
 * `overloaded` är de modellnamn som ska svara 503. Alla andra svarar normalt — grundad research med
 * kandidatrader, och en tom men giltig strukturering.
 */
async function run(overloaded: string[]): Promise<{ body: any; models: string[] }> {
  const realFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1] ?? "";
    models.push(model);
    if (overloaded.includes(model)) return OVERLOADED();
    const b = JSON.parse(init.body);
    if (!Array.isArray(b.tools)) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: RESEARCH_TEXT }] },
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
        body: JSON.stringify({ brand: "IKEA", sellerNote: "IKEA soffa", images: IMAGES }),
      }),
      env: { GEMINI_API_KEY: "test-key", SELLER_ALWAYS_ASK: "1" },
    });
    return { body: await res.json(), models };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("en överbelastad modell tas om av en annan — kandidaterna når säljaren", async () => {
  const { body, models } = await run([SELLER_MODEL]);
  assert.equal(body.kind, "needs_selection", "sökningen ska ha blivit av ändå");
  assert.deepEqual(body.candidates.map((c: { model: string }) => c.model), ["SÖDERHAMN", "KIVIK"]);
  assert.ok(models.includes(SELLER_MODEL), "förstahandsmodellen ska ha frågats först");
  assert.ok(
    models.some((m) => m !== SELLER_MODEL),
    "och den överbelastade ska ha lämnat plats åt en annan modell",
  );
});

test("faller båda modellerna säger svaret att ingen sökning blev av", async () => {
  const { body } = await run([SELLER_MODEL, "gemini-3.6-flash"]);
  assert.equal(body.ok, true, "säljaren ska aldrig mötas av ett rått fel");
  const warnings: string[] = body.result.warnings ?? [];
  assert.ok(warnings.includes("model_overloaded"), "överbelastningen ska stå kvar i svaret");
  assert.ok(warnings.includes("research_failed"));
  assert.ok(warnings.includes("structure_failed"));
});

test("överbelastning skiljs från timeout — bara den snabba får ett andra försök", () => {
  assert.equal(modelUnavailable(new GeminiCallError("503 overloaded", true, "http", 503)), true);
  assert.equal(modelUnavailable(new GeminiCallError("429 quota", true, "http", 429)), true);
  assert.equal(modelUnavailable(new GeminiCallError("fetch failed", true, "network")), true);
  // De två som redan använt tiden ett omförsök skulle behöva.
  assert.equal(modelUnavailable(new GeminiCallError("aborted (timeout)", true, "timeout")), false);
  assert.equal(modelUnavailable(new GeminiCallError("aborted (deadline)", false, "deadline")), false);
  // Ett trasigt anrop blir inte helt av att skickas till en annan modell.
  assert.equal(modelUnavailable(new GeminiCallError("400 invalid", false, "http", 400)), false);
});

test("beskedet skiljer 'hittade inget' från 'kunde inte söka'", () => {
  assert.match(identityNote(["model_overloaded", "research_failed"]) ?? "", /hårt belastad/);
  assert.match(identityNote(["structure_failed"]) ?? "", /fel i vårt led/);
  // Sökningen blev av och gav inget: då är tomheten ett riktigt svar och ska inte ursäktas bort.
  assert.equal(identityNote(["research_ungrounded"]), null);
  assert.equal(identityNote([]), null);
});
