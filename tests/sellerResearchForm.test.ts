// Fas 2:s sökning: PLAIN form först, och inga bildrutor.
//
// Två ändringar med samma mål — färre grundade sökningar per annons, för det är dem hela väntan i
// "Bygger annonsen" består av. Båda handlar om vad som SKICKAS, alltså är det nyttolasten som ska
// testas, inte svaret. Gemini stubbas därför bort helt: testet fångar varje utgående anrop och läser
// vad som faktiskt stod i det.
//
// Bakgrunden till båda: mätt över 48 körningar får den form som INTE skickar variant och produkttyp
// källor i 67 % av fallen mot 33 % för den som gör det, och commit 0639e24 visade att fler bildrutor
// fäller den grundade sökningen (kandidater i 2 fall av 10 mot 8 av 10).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Måste sättas före importen — generatorns budgetar är konstanter som läses vid modulladdning.
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

const IMAGES = Array.from({ length: 6 }, () => ({ mimeType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==" }));

/** Ett utgående Gemini-anrop, uppdelat i det testet bryr sig om. */
interface Sent {
  grounded: boolean;
  prompt: string;
  imageParts: number;
}

/**
 * Kör handlern med Gemini bortstubbat.
 *
 * `groundedHits` säger vilka av de grundade anropen som ska svara MED källor — så en körning där
 * sökningen aldrig tänder går att spela upp exakt.
 */
async function run(body: unknown, groundedHits: (n: number) => boolean): Promise<Sent[]> {
  const sent: Sent[] = [];
  let groundedSeen = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    const parts = b.contents[0].parts as Array<Record<string, unknown>>;
    const grounded = Array.isArray(b.tools);
    sent.push({
      grounded,
      prompt: parts.map((p) => (typeof p.text === "string" ? p.text : "")).join(""),
      imageParts: parts.filter((p) => p.inlineData).length,
    });
    if (!grounded) {
      // Struktureringen: ett minimalt men giltigt svar, så vägen fram till den mäts som i skarp drift.
      const json = JSON.stringify({ listing: { title: "Mio Saturday", description: "x", conditionText: "y" } });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }] }));
    }
    const hit = groundedHits(++groundedSeen);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "Saturday hörnsoffa, bredd 358 cm (källa: https://mio.se/x)" }] },
            ...(hit ? { groundingMetadata: { groundingChunks: [{ web: { uri: "https://mio.se/x", title: "Mio" } }] } } : {}),
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  try {
    await onRequestPost({
      request: new Request("http://x/api/seller/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env: { GEMINI_API_KEY: "test-key" },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

const phase2 = (variant: string | null, productType: string | null) => ({
  brand: "Mio",
  sellerNote: "Mio Saturday",
  images: IMAGES,
  resolution: { kind: "seller_selected", selected: { brand: "Mio", model: "Saturday", variant, productType } },
});

test("fas 2 söker utan variant och produkttyp — plain form först", async () => {
  const sent = await run(phase2("höger schäslong", "hörnsoffa"), () => true);
  const research = sent.filter((s) => s.grounded);

  assert.equal(research.length, 1, "en träff på första försöket ska inte kosta fler sökningar");
  assert.match(research[0].prompt, /Modell: "Saturday"/);
  assert.doesNotMatch(research[0].prompt, /Variant:/, "variant ska inte med i förstahandsformen");
  assert.doesNotMatch(research[0].prompt, /Produkttyp:/, "produkttyp ska inte med i förstahandsformen");
});

test("fas 2 skickar INGA bildrutor till sökningen, men struktureringen behåller sina", async () => {
  const sent = await run(phase2("höger schäslong", "hörnsoffa"), () => true);

  for (const s of sent.filter((x) => x.grounded)) {
    assert.equal(s.imageParts, 0, "specsökningen slås upp på namnet, inte på fotot");
  }
  const structure = sent.find((s) => !s.grounded);
  assert.ok(structure, "struktureringen ska ha körts");
  assert.equal(structure.imageParts, 6, "skicket bedöms ur bilderna — de får aldrig falla bort här");
});

test("faller plain form igenom provas den RIKA formen sist", async () => {
  const sent = await run(phase2("höger schäslong", "hörnsoffa"), () => false);
  const research = sent.filter((s) => s.grounded);

  assert.equal(research.length, 3, "plain, plain-omförsök, sedan rik form");
  assert.doesNotMatch(research[0].prompt, /Produkttyp:/);
  assert.doesNotMatch(research[1].prompt, /Produkttyp:/);
  assert.match(research[2].prompt, /Variant: "höger schäslong"/, "reserven bär variant");
  assert.match(research[2].prompt, /Produkttyp: hörnsoffa/, "reserven bär produkttyp");
});

test("ingen rik reserv när den skulle bli en identisk prompt", async () => {
  // Varianten sållas bort av usableVariant (kommatecken = färgbeskrivning) och produkttyp saknas —
  // då är den rika formen ord för ord samma fråga, och ett omförsök är en bränd budget.
  const sent = await run(phase2("beige, rörformat stål", null), () => false);

  assert.equal(sent.filter((s) => s.grounded).length, 2, "bara plain och dess omförsök");
});

test("fas 1 behåller sina bildrutor — där är det bilderna modellen ska kännas igen ur", async () => {
  const sent = await run({ brand: "Mio", sellerNote: "Mio", images: IMAGES }, () => true);
  const research = sent.filter((s) => s.grounded);

  assert.ok(research.length >= 1);
  assert.equal(research[0].imageParts, 3, "identifieringen söker på bilderna, upp till RESEARCH_IMAGE_CAP");
});
