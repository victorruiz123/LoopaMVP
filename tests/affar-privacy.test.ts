// ─── Att en affärsskanning inte blir en annons ──────────────────────────────
//
// En skanning inuti ett affärsrum är beställd av en köpare för EN affär. Den är inte en annons, och
// två system i den här servern skulle ta den för en om ingen hindrade dem:
//
//   butik/inventory.ts  skriver in varje jobb med betyg, pris och märke i butikslagret
//   publicCard.ts       ger varje jobb med en annons ett publikt kort på /c/LP-XXXX-XXXX
//
// Samma gräns går åt andra hållet: köparens annonsanalys är PUBLIK — jobb-id:t är hela nyckeln,
// eftersom köparen inte har ett konto ännu — och den vägen får därför bara svara för annonshärledda
// jobb. `analysisJob` är den enda grinden, och den bär både lägesvägen och bildvägen.
//
// Båda skrevs innan Trygg affär fanns och båda gör rätt för sitt eget syfte. Testerna nedan är det
// som håller dem isär, och de ska fällas om någon tar bort `dealId`-kontrollen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { jobToProduct } from "../server/src/butik/normalize.js";
import { publicCardFor } from "../server/src/publicCard.js";
import type { ConditionJob } from "../server/src/types.js";
import { rm } from "node:fs/promises";

/** Ett färdigbesiktigat jobb som uppfyller ALLA villkor butiken ställer på en vara. */
function sellableJob(over: Partial<ConditionJob> = {}): ConditionJob {
  const listing = {
    identity: { brand: "IKEA", exactProduct: "Ektorp", variant: null, category: "Soffa", confidence: "high" as const, uncertain: false, uncertaintyNote: null },
    attributes: [
      { key: "width", label: "Bredd", value: "218 cm", sourceUrl: null },
      { key: "depth", label: "Djup", value: "88 cm", sourceUrl: null },
      { key: "height", label: "Höjd", value: "88 cm", sourceUrl: null },
    ],
    pricing: { retailPriceSek: 6000, suggestedPriceSek: 2000, priceRangeMinSek: null, priceRangeMaxSek: null, rationale: null },
    listing: { title: "IKEA Ektorp soffa", description: "Fin soffa", conditionText: "Bra skick" },
    sources: [],
  };
  return {
    id: "job-1",
    createdAt: "2026-09-01T10:00:00Z",
    progress: { stage: "done", message: "" },
    error: null,
    productContext: null,
    identity: { brand: "IKEA", model: "Ektorp" },
    result: {
      jobId: "job-1", createdAt: "2026-09-01T10:00:00Z",
      identity: { brand: "IKEA", model: "Ektorp" },
      price: { status: "ok", low: 1800, default: 2000, high: 2400, currency: "SEK", confidence: null, note: null, matchCount: 5, variant: null, variantMethod: null, damageDeduction: null, damageLines: [], unavailableReason: null, requestedAt: "", latencyMs: 0 },
      reviewPending: false, reviewed: true,
      listing: { status: "ok", unavailableReason: null, result: listing as never, latencyMs: 0 },
      coverage: "INSPECTED_CLEAR", coverageNote: null,
      grade: { grade: "B", canonicalCondition: "Mycket bra skick", label: "Mycket gott skick", rationale: "R", reasons: [] },
      damages: [], overallCondition: null, images: [], coverImageId: null,
      productImage: { url: "https://x/y.jpg", sourceUrl: null }, coverCutout: null,
      modelUsed: "m", tokensUsed: 0, costUsd: 0, geminiCallCount: 0, latencyMs: 0,
    },
    ...over,
  } as ConditionJob;
}

test("KONTROLL: ett vanligt säljarjobb ÄR en butiksvara och HAR ett publikt kort", () => {
  // Utan den här raden bevisar testerna nedan ingenting — de skulle passera även om projektionen
  // vore trasig för alla jobb.
  const job = sellableJob();
  assert.ok(jobToProduct(job, "live"), "ett vanligt jobb ska bli en vara");
  assert.ok(publicCardFor(job), "ett vanligt jobb ska ha ett publikt kort");
});

test("en affärsskanning blir ALDRIG en butiksvara", () => {
  // Samma jobb, enda skillnaden är att det tillhör en affär.
  const job = sellableJob({ dealId: "deal-1" });
  assert.equal(jobToProduct(job, "live"), null, "butiken får inte visa någons privata affär till försäljning");
});

test("en affärsskanning får ALDRIG ett publikt kort", () => {
  const job = sellableJob({ dealId: "deal-1" });
  assert.equal(publicCardFor(job), null, "/c/LP-XXXX ska inte lämna ut möbel, mått och skador ur en privat affär");
});

test("kontrollen sitter i projektionen, inte i tillståndet", () => {
  // Ett affärsjobb ska falla bort oavsett vilket butikstillstånd anroparen ber om — annars beror
  // integriteten på att varje anropare kommer ihåg att skicka rätt argument.
  for (const state of ["draft", "live", "reserved", "sold", "delivered", "returned"] as const) {
    assert.equal(jobToProduct(sellableJob({ dealId: "d" }), state), null, `föll igenom som ${state}`);
  }
});

test("ett tomt dealId är inget dealId", () => {
  // null och undefined är vanliga säljarjobb; tom sträng är också det, och ska inte tyst göra ett
  // jobb privat bara för att någon skrev ut ett fält utan värde.
  assert.ok(jobToProduct(sellableJob({ dealId: null }), "live"));
  assert.ok(jobToProduct(sellableJob({ dealId: undefined }), "live"));
  assert.ok(jobToProduct(sellableJob({ dealId: "" }), "live"));
});


// ─── åt andra hållet: den publika analysvägen når inte en säljares jobb ──────

const { analysisJob } = await import("../server/src/affar/analysis.js");
const { persist, jobDir } = await import("../server/src/jobStore.js");

test("analysisJob svarar bara för annonshärledda jobb", async () => {
  // Vägen är publik: den som gissar ett jobb-id ska inte få en säljares filmning. Gäller BÅDE
  // /api/affar/analys/:id och bildvägen under den — de går genom samma grind.
  const seller = sellableJob({ id: "priv-saljare" });
  await persist(seller);
  assert.equal(await analysisJob("priv-saljare"), null, "en säljares jobb får inte lämnas ut");

  const derived = sellableJob({ id: "priv-annons", adDerived: true });
  await persist(derived);
  assert.ok(await analysisJob("priv-annons"), "köparens eget analysjobb ska däremot gå att läsa");

  await rm(jobDir("priv-saljare"), { recursive: true, force: true });
  await rm(jobDir("priv-annons"), { recursive: true, force: true });
});
