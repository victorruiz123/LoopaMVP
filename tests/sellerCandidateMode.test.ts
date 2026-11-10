// ─── Kandidatläget "evidence": generatorn fyller inte upp listan ────────────────────────────────────
//
// Generatorns standardprompt kräver "exakt 4 kandidater" och fyller överblivna platser med modeller som
// "LIKNAR" bilderna — rätt för loopa.nu, där säljaren ser sin egen möbel bland fyra. När forskningen
// föll i den första skarpa körningen blev det fyra välvårdade produktbilder på fel stolar, ur märkets
// nuvarande sortiment, med samma säkerhet som ett riktigt svar. Loopa Condition ber därför om läget
// "evidence". Standardläget, som loopa.nu använder, ska vara exakt oförändrat.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSellerRequest } from "../server/src/listing.js";

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

/** Kör fas 1 med Gemini bortstubbat och returnerar prompten i det grundade anropet. */
async function groundedPrompt(extra: Record<string, unknown>): Promise<string> {
  let prompt = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    if (Array.isArray(b.tools)) prompt = (b.contents[0].parts as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
    const text = "KANDIDAT: IKEA | PRODUKT | - | stol | STARK | rak rygg | https://www.ikea.com/se/sv/p/produkt/";
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://www.ikea.com/x", title: "IKEA" } }] } }],
      }),
    );
  }) as unknown as typeof fetch;
  try {
    await onRequestPost({
      request: new Request("http://x/api/seller/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: "IKEA", sellerNote: "IKEA", images: [{ mimeType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==" }], ...extra }),
      }),
      env: { GEMINI_API_KEY: "test-key", SELLER_ALWAYS_ASK: "1" },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return prompt;
}

test("standardläget är oförändrat: exakt fyra, med fyllnad", async () => {
  const p = await groundedPrompt({});
  assert.match(p, /Lämna ALLTID exakt 4 kandidater/);
  assert.match(p, /LIKNAR den på bilderna mest/);
});

test("kandidatläget 'evidence' fyller inte upp listan och ber om äldre och utgångna modeller", async () => {
  const p = await groundedPrompt({ candidateMode: "evidence" });
  assert.doesNotMatch(p, /ALLTID exakt 4/);
  assert.doesNotMatch(p, /LIKNAR den på bilderna mest/);
  assert.match(p, /Fyll ALDRIG upp listan/);
  assert.match(p, /äldre och utgångna modeller/);
  assert.match(p, /visuellt försvarbara/);
  // Radformatet är detsamma, så parseCandidates läser det som förut.
  assert.match(p, /KANDIDAT: märke \| modellnamn \| variant eller - \| produkttyp/);
});

test("okända värden på flaggan ändrar ingenting", async () => {
  assert.match(await groundedPrompt({ candidateMode: "annat" }), /ALLTID exakt 4/);
});

test("begäran bär flaggan bara när den är satt", () => {
  assert.equal(buildSellerRequest({ brand: "IKEA", model: "" }).candidateMode, undefined);
  assert.equal(buildSellerRequest({ brand: "IKEA", model: "" }, undefined, undefined, [], [], [], undefined, "evidence").candidateMode, "evidence");
});
