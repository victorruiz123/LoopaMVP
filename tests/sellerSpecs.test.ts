// MÅTT-raderna får inte gå förlorade mellan sökningen och annonsen.
//
// Sökningen skriver måtten i ett eget avsnitt just för att de annars begravs i löptext, och
// struktureringen är TILLSAGD att varje sådan rad måste bli ett attribut. Mätt på 78 skarpa annonser
// kom ändå sex av de 52 som fått källor tillbaka utan ett enda mått — instruktionen är modellens
// bedömning, och den bedömningen är precis vad formatet fanns till för att slippa. Raderna läses
// därför i kod, och testerna nedan håller den läsningen ärlig.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const RESEARCH_TEXT = `NORDVIKEN barstol i massiv furu (källa: https://www.ikea.com/se/sv/p/nordviken/).
MÅTT: bredd | 40 cm
MÅTT: djup | 45 cm
MÅTT: höjd | 88 cm
MÅTT: sitthöjd | 62 cm
ANDRAHANDSPRISER: 300-500 kr på Blocket (källa: https://www.blocket.se/x).`;

/** Struktureringens svar — med flit UTAN måttattribut, precis det fel som mättes i skarp drift. */
const STRUCTURE_WITHOUT_DIMS = {
  identity: { brand: "IKEA", exactProduct: "NORDVIKEN", confidence: "high" },
  attributes: [{ key: "material", label: "Material", value: "Massiv furu", sourceUrl: "https://www.ikea.com/se/sv/p/nordviken/" }],
  pricing: { suggestedPriceSek: 400, priceRangeMinSek: 300, priceRangeMaxSek: 500, rationale: "Begagnatpriser" },
  listing: { title: "IKEA NORDVIKEN", description: "x", conditionText: "y" },
};

/**
 * Kör handlern med Gemini bortstubbat.
 *
 * `grounded` styr om sökningen svarar med groundingChunks — utan dem är svaret ogrundat, och då ska
 * ingenting ur texten nå specifikationerna.
 */
async function run(body: unknown, opts: { grounded: boolean; researchText?: string; structure?: unknown }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    if (!Array.isArray(b.tools)) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(opts.structure ?? STRUCTURE_WITHOUT_DIMS) }] } }] }),
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: opts.researchText ?? RESEARCH_TEXT }] },
            ...(opts.grounded
              ? { groundingMetadata: { groundingChunks: [{ web: { uri: "https://www.ikea.com/se/sv/p/nordviken/", title: "IKEA" } }] } }
              : {}),
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
        body: JSON.stringify(body),
      }),
      env: { GEMINI_API_KEY: "test-key" },
    });
    return (await res.json()) as {
      result: {
        attributes: Array<{ key: string; label: string; value: string; estimated?: boolean }>
        missingFields: string[]
        missingNotes: string[]
        status: string
      }
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const phase2 = (extra: Record<string, unknown> = {}) => ({
  brand: "IKEA",
  sellerNote: "IKEA NORDVIKEN",
  images: IMAGES,
  resolution: { kind: "seller_selected", selected: { brand: "IKEA", model: "NORDVIKEN", variant: null, productType: null } },
  ...extra,
});

const labels = (r: { result: { attributes: Array<{ label: string }> } }) => r.result.attributes.map((a) => a.label);
/**
 * Bara det som är BELAGT.
 *
 * Annonsen bär numera alltid mått: hittas inga fylls de på med typiska mått för möbeltypen, märkta
 * `estimated` (se seller-typical-dimensions.ts). Testerna nedan handlar om vad som får räknas som
 * belagt, och där ska en uppskattning väga exakt noll — därför sållas den bort här.
 */
const measured = (r: { result: { attributes: Array<{ label: string; estimated?: boolean }> } }) =>
  r.result.attributes.filter((a) => !a.estimated).map((a) => a.label);
const estimated = (r: { result: { attributes: Array<{ label: string; estimated?: boolean }> } }) =>
  r.result.attributes.filter((a) => a.estimated).map((a) => a.label);

test("MÅTT-rader blir attribut även när struktureringen tappar dem", async () => {
  const body = await run(phase2(), { grounded: true });
  assert.deepEqual(labels(body).sort(), ["Bredd", "Djup", "Höjd", "Material", "Sitthöjd"]);
  assert.equal(body.result.attributes.find((a) => a.label === "Bredd")?.value, "40 cm");
  assert.ok(!body.result.missingFields.includes("dimensions"), "annonsen ska inte längre sakna mått");
});

test("struktureringens egna mått rörs inte", async () => {
  const kept = {
    ...STRUCTURE_WITHOUT_DIMS,
    attributes: [{ key: "bredd", label: "Bredd", value: "39,5 cm", sourceUrl: "https://www.ikea.com/se/sv/p/nordviken/" }],
  };
  const body = await run(phase2(), { grounded: true, structure: kept });
  assert.equal(body.result.attributes.find((a) => a.label === "Bredd")?.value, "39,5 cm", "det belagda värdet vinner");
  assert.equal(labels(body).filter((l) => l === "Bredd").length, 1, "bredden får inte stå två gånger");
});

test("ett sammanskrivet måttfält räknas som bredd, djup och höjd", async () => {
  const combined = {
    ...STRUCTURE_WITHOUT_DIMS,
    attributes: [{ key: "matt", label: "Mått", value: "40 x 45 x 88 cm", sourceUrl: null }],
  };
  const body = await run(phase2(), { grounded: true, structure: combined });
  assert.deepEqual(labels(body).sort(), ["Mått", "Sitthöjd"], "bara sitthöjden saknades");
});

test("ogrundad text når aldrig specifikationerna", async () => {
  const body = await run(phase2(), { grounded: false });
  assert.deepEqual(measured(body), ["Material"], "utan källor finns inget belagt att lägga till");
});

test("identifieringens återanvända underlag ger inga mått — det kan gälla en annan modell", async () => {
  // Sökningen faller (ogrundad), och då träder fas 1:s underlag in som research. Dess MÅTT-rader
  // beskriver identifieringens toppkandidat, inte nödvändigtvis den säljaren valde.
  const body = await run(
    phase2({ priorResearch: RESEARCH_TEXT, priorSources: [{ title: "IKEA", url: "https://www.ikea.com/se/sv/p/nordviken/" }] }),
    { grounded: false },
  );
  assert.deepEqual(measured(body), ["Material"]);
});

test("MÅTT: INGA lägger inte till något belagt", async () => {
  const body = await run(phase2(), { grounded: true, researchText: "Inget hittat (källa: https://x.se).\nMÅTT: INGA" });
  assert.deepEqual(measured(body), ["Material"]);
});

test("en rad utan enhet är inget mått", async () => {
  const body = await run(phase2(), { grounded: true, researchText: "Källa: https://x.se\nMÅTT: bredd | ungefär en halvmeter" });
  assert.deepEqual(measured(body), ["Material"]);
});

/**
 * Måtten får aldrig saknas helt.
 *
 * Det säljaren mötte förut var en rad som sa "delvis belagt" och ett måttblock som var tomt — och en
 * annons utan ett enda tal går inte att svara "passar den i hallen?" på. Nu fylls luckan med typiska
 * mått för möbeltypen. De är märkta, de står med "ca", och de räknas fortfarande som saknade.
 */
test("hittar sökningen inga mått fylls de på med typiska mått för möbeltypen", async () => {
  const body = await run(phase2({ sellerNote: "IKEA NORDVIKEN barstol" }), {
    grounded: true,
    researchText: "Massiv furu (källa: https://x.se).\nMÅTT: INGA",
  });
  assert.deepEqual(estimated(body).sort(), ["Bredd", "Djup", "Höjd", "Sitthöjd"], "en barstol känns igen på namnet");
  assert.equal(body.result.attributes.find((a) => a.label === "Sitthöjd")?.value, "ca 65 cm", "barstolens sitthöjd, inte matstolens");
  assert.ok(
    body.result.missingFields.includes("dimensions"),
    "en uppskattning är inget belägg — måtten ska stå kvar som saknade",
  );
  assert.equal(body.result.status, "partial");
  assert.match(body.result.missingNotes.join(" "), /uppskattade utifrån typiska mått för en barstol/);
});

test("LIKNANDE-rader blir uppskattade mått, inte belagda", async () => {
  const body = await run(phase2(), {
    grounded: true,
    researchText: [
      "Ingen produktsida med mått hittades (källa: https://x.se).",
      "MÅTT: INGA",
      "LIKNANDE: bredd | 45 cm",
      "LIKNANDE: djup | 52 cm",
      "LIKNANDE: höjd | 88 cm",
      "LIKNANDE-GRUND: en matstol i massiv furu av samma typ",
    ].join("\n"),
  });
  assert.deepEqual(estimated(body).sort(), ["Bredd", "Djup", "Höjd"], "sökningens egen uppskattning används");
  assert.equal(body.result.attributes.find((a) => a.label === "Bredd")?.value, "ca 45 cm", "'ca' skrivs in i värdet självt");
  assert.ok(body.result.missingFields.includes("dimensions"));
});

test("ett belagt mått slår en uppskattning av samma rad", async () => {
  const body = await run(phase2(), {
    grounded: true,
    researchText: ["Källa: https://x.se", "LIKNANDE: bredd | 45 cm", "MÅTT: bredd | 40 cm"].join("\n"),
  });
  assert.deepEqual(labels(body).filter((l) => l === "Bredd"), ["Bredd"], "bredden får stå en gång");
  assert.equal(body.result.attributes.find((a) => a.label === "Bredd")?.value, "40 cm");
  assert.deepEqual(estimated(body), [], "uppskattningen behövdes inte");
});
