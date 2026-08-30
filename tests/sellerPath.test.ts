// AC: den väg SÄLJAREN går ska testas, inte bara den som är lätt att testa.
//
// Hela kvällen 2026-08-29 mättes specifikationssteget med modellnamnet skickat direkt — manual-vägen
// — medan säljaren går via kandidatvalet. De två har olika träffsäkerhet (67 % mot 33 % över 48
// körningar), så det som mättes var inte det som kördes. Samma fel som när regressen var grön för att
// den mätte något annat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSellerRequest, type Resolution } from "../server/src/listing.js";
import type { ModelCandidate } from "../server/src/types.js";

const candidate: ModelCandidate = {
  brand: "IKEA",
  model: "NORDVIKEN",
  variant: "barstol, svart",
  productType: "barstol",
  confidence: "strong",
  distinguishingDetail: null,
};

const prior = {
  researchText: "NORDVIKEN barstol, sitthöjd 62 cm (källa: https://ikea.com/…)",
  sources: [{ title: "ikea.com", url: "https://www.ikea.com/se/sv/p/nordviken/", qualityTier: 1 as const }],
};

test("kandidatvägen skickar säljarens val som resolution", () => {
  const res: Resolution = { kind: "seller_selected", selected: candidate };
  const body = buildSellerRequest({ brand: "IKEA", model: "NORDVIKEN" }, res, prior);
  assert.equal(body.resolution?.kind, "seller_selected");
  assert.equal((body.resolution as { selected: ModelCandidate }).selected.model, "NORDVIKEN");
});

test("identifieringens underlag följer med till specifikationssteget", () => {
  const body = buildSellerRequest({ brand: "IKEA", model: "NORDVIKEN" }, { kind: "seller_selected", selected: candidate }, prior);
  assert.equal(body.priorSources?.length, 1, "källorna ska skickas vidare");
  assert.match(body.priorResearch ?? "", /sitthöjd 62 cm/, "texten ska skickas vidare");
});

test("utan tidigare underlag skickas fälten inte alls", () => {
  const body = buildSellerRequest({ brand: "IKEA", model: "NORDVIKEN" }, { kind: "manual", manualModel: "NORDVIKEN" });
  assert.equal(body.priorResearch, undefined);
  assert.equal(body.priorSources, undefined);
});

test("manual-vägen skickar inget kandidatval", () => {
  const body = buildSellerRequest({ brand: "IKEA", model: "NORDVIKEN" }, { kind: "manual", manualModel: "NORDVIKEN" }, prior);
  assert.equal(body.resolution?.kind, "manual");
  // Underlaget är oberoende av vägen — det ska följa med även här.
  assert.equal(body.priorSources?.length, 1);
});

test("fas 1 skickar varken resolution eller underlag", () => {
  const body = buildSellerRequest({ brand: "IKEA", model: "" });
  assert.equal(body.resolution, undefined);
  assert.equal(body.priorSources, undefined);
  assert.equal(body.brand, "IKEA");
});
