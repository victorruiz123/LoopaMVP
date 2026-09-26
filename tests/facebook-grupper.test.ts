// ─── Facebook-grupperna: adresser, dubbletter, rangordning, regler ──────────
//
// Allt här är rent — ingen webbläsare. Det är de här reglerna som avgör om samma grupp kan hamna två
// gånger i lagret (och därmed få samma annons två gånger), om en Göteborgsgrupp rankas över en
// Stockholmsgrupp, och om "ingen reklam" faktiskt stänger dörren.

import { test } from "node:test";
import assert from "node:assert/strict";

const { groupKeyFromUrl, canonicalGroupUrl, dedupeHits, parseMemberCount, mergeObservation, newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { classifyGroup, detectGeography, rankGroup, compareGroups, memberBonus, CATEGORY_BASE } = await import("../server/src/integrations/facebook/ranking.js");
const { assessRules, adsStatusAllowsPosting, joinBlockedBy, extractRulesSection, rulesStale } = await import("../server/src/integrations/facebook/rules.js");
const { DISCOVERY_QUERIES, nextQueries } = await import("../server/src/integrations/facebook/queries.js");

// ─── adresserna ─────────────────────────────────────────────────────────────

test("fem skrivsätt för samma grupp ger en nyckel", () => {
  const varianter = [
    "https://www.facebook.com/groups/123456/",
    "https://www.facebook.com/groups/123456/about",
    "https://m.facebook.com/groups/123456?ref=share",
    "https://web.facebook.com/groups/123456/permalink/999/",
    "facebook.com/groups/123456",
  ];
  for (const v of varianter) assert.equal(groupKeyFromUrl(v), "123456", v);
  assert.equal(canonicalGroupUrl("https://m.facebook.com/groups/123456?ref=share"), "https://www.facebook.com/groups/123456/");
});

test("sluggar blir gemener, numeriska id behålls, reserverade sökvägar avvisas", () => {
  assert.equal(groupKeyFromUrl("https://www.facebook.com/groups/MoblerStockholm/"), "moblerstockholm");
  assert.equal(groupKeyFromUrl("https://www.facebook.com/groups/feed/"), null);
  assert.equal(groupKeyFromUrl("https://www.facebook.com/groups/discover"), null);
  assert.equal(groupKeyFromUrl("https://www.facebook.com/marketplace/"), null);
  assert.equal(groupKeyFromUrl("https://example.com/groups/123/"), null, "bara Facebook");
  assert.equal(groupKeyFromUrl(""), null);
});

test("dubbletter i sökresultatet slås ihop och medlemsantalet fylls på från vilken träff som helst", () => {
  const hits = dedupeHits([
    { url: "https://www.facebook.com/groups/555/", name: "Köp Sälj Nacka", memberCount: null, visibility: "UNKNOWN", snippet: "", query: "köp sälj Nacka" },
    { url: "https://m.facebook.com/groups/555/?ref=x", name: "Köp Sälj Nacka", memberCount: 3200, visibility: "PUBLIC", snippet: "Offentlig grupp · 3,2 tn medlemmar", query: "köp sälj Stockholm" },
    { url: "https://www.facebook.com/groups/feed/", name: "Flöde", memberCount: null, visibility: "UNKNOWN", snippet: "", query: "x" },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://www.facebook.com/groups/555/");
  assert.equal(hits[0].memberCount, 3200);
  assert.equal(hits[0].visibility, "PUBLIC");
});

test("medlemsantal läses ur Facebooks svenska och engelska former", () => {
  assert.equal(parseMemberCount("Offentlig grupp · 1,2 tn medlemmar"), 1200);
  assert.equal(parseMemberCount("97,4 tn medlemmar"), 97400);
  assert.equal(parseMemberCount("1 152 medlemmar totalt"), 1152);
  assert.equal(parseMemberCount("12K members"), 12000);
  assert.equal(parseMemberCount("ingen siffra här"), null);
});

test("en observation skriver aldrig över ett känt värde med null, och rör inte adminens brytare", () => {
  const g = { ...newGroup({ key: "1", name: "A", canonicalUrl: "https://www.facebook.com/groups/1/", memberCount: 500 }), enabledForDistribution: true, enabledForDistributionSetBy: "admin" as const, membershipStatus: "MEMBER" as const };
  const m = mergeObservation(g, { name: "", memberCount: null, visibility: "UNKNOWN", discoveredVia: ["q2"] });
  assert.equal(m.name, "A");
  assert.equal(m.memberCount, 500);
  assert.equal(m.enabledForDistribution, true);
  assert.equal(m.membershipStatus, "MEMBER");
  assert.deepEqual(m.discoveredVia, ["q2"]);
});

// ─── rangordningen ──────────────────────────────────────────────────────────

test("kategorin läses ur namnet: möbler + köp/sälj vinner, märke slår möbler, ort ensam blir anslagstavla", () => {
  assert.equal(classifyGroup("Möbler bortskänkes / Köpes / Bytes / Säljes i Stockholm").category, "FURNITURE_BUY_SELL");
  assert.equal(classifyGroup("Köp, byt, sälj och skänk på Södermalm").category, "LOCAL_BUY_SELL");
  assert.equal(classifyGroup("Loppis Stockholm").category, "SECONDHAND");
  assert.equal(classifyGroup("IKEA-möbler säljes/köpes i Stockholm").category, "BRAND_COMMUNITY");
  assert.equal(classifyGroup("Danderyds anslagstavla").category, "GENERAL");
  assert.equal(classifyGroup("Hundägare i Sverige").category, "OTHER");
});

test("geografin: Stockholm ×1, en stadsdel ×0,9, en annan stad ×0", () => {
  assert.equal(detectGeography("Köp sälj Stockholm").score, 1);
  assert.equal(detectGeography("Köp sälj Hägersten").score, 0.9);
  assert.equal(detectGeography("Köp sälj Hägersten").geography, "Hägersten");
  assert.equal(detectGeography("Secondhand Göteborg").score, 0);
  assert.equal(detectGeography("Köp sälj hela Sverige").score, 0.3);
});

test("en möbelgrupp i Stockholm rankas över en lokal köp/sälj, som rankas över en Göteborgsgrupp — och skälen står med", () => {
  const bas = { memberCount: 3000, adsStatus: "LIKELY_ALLOWED" as const, composerKind: "post" as const, activityScore: 50 };
  const mobler = rankGroup({ name: "Möbler säljes Stockholm", category: "FURNITURE_BUY_SELL", ...bas });
  const lokal = rankGroup({ name: "Köp sälj Solna", category: "LOCAL_BUY_SELL", ...bas });
  const gbg = rankGroup({ name: "Möbler säljes Göteborg", category: "FURNITURE_BUY_SELL", ...bas });
  assert.ok(mobler.relevanceScore > lokal.relevanceScore, `${mobler.relevanceScore} > ${lokal.relevanceScore}`);
  assert.ok(lokal.relevanceScore > gbg.relevanceScore);
  assert.ok(gbg.relevanceScore < 30, "fel stad ger nästan ingenting");
  assert.ok(mobler.reasons.some((r) => /kategori FURNITURE_BUY_SELL/.test(r)));
  assert.ok(mobler.reasons.some((r) => /geografi/.test(r)));
  assert.ok(mobler.reasons.some((r) => /medlemmar/.test(r)));
});

test("förbjudna regler sänker gruppen kraftigt utan att gömma den; fler medlemmar ger mer, med tak", () => {
  const bas = { name: "Köp sälj Stockholm", category: "LOCAL_BUY_SELL" as const, memberCount: 20000, composerKind: "post" as const, activityScore: 0 };
  const ok = rankGroup({ ...bas, adsStatus: "LIKELY_ALLOWED" });
  const nej = rankGroup({ ...bas, adsStatus: "PROHIBITED" });
  assert.ok(ok.relevanceScore - nej.relevanceScore >= 40);
  assert.ok(nej.relevanceScore >= 0);
  assert.equal(memberBonus(100), 0);
  assert.ok(memberBonus(3000) > memberBonus(500));
  assert.equal(memberBonus(10_000_000), 15, "taket");
  assert.equal(CATEGORY_BASE.FURNITURE_BUY_SELL, 100);
});

test("sorteringen: relevans, sedan medlemmar, sedan namn — deterministiskt", () => {
  const g = (name: string, relevanceScore: number, memberCount: number | null) => ({ ...newGroup({ key: name, name, canonicalUrl: `https://www.facebook.com/groups/${name}/` }), relevanceScore, memberCount });
  const sorted = [g("b", 50, 100), g("a", 50, 100), g("c", 80, 10), g("d", 50, 900)].sort(compareGroups).map((x) => x.name);
  assert.deepEqual(sorted, ["c", "d", "a", "b"]);
});

// ─── reglerna ───────────────────────────────────────────────────────────────

test("ett uttryckligt förbud vinner alltid — även i en köp/sälj-grupp som annars välkomnar annonser", () => {
  for (const text of ["Ingen reklam tack!", "Inga företagsannonser.", "Endast för privatpersoner", "Reklam är förbjudet", "No businesses allowed", "Inga kommersiella inlägg"]) {
    const r = assessRules(`Gruppregler: Köp och sälj gärna. ${text} Företag är välkomna.`, "LOCAL_BUY_SELL", "Köp sälj Stockholm");
    assert.equal(r.adsStatus, "PROHIBITED", text);
    assert.ok(r.evidence.some((e) => e.startsWith("FÖRBUD")), text);
    assert.equal(adsStatusAllowsPosting(r.adsStatus), false);
  }
});

test("uttryckligt tillstånd ger ALLOWED med beläggen utskrivna", () => {
  const r = assessRules("Gruppregler: Företag är välkomna att annonsera.", "LOCAL_BUY_SELL", "Köp sälj Täby");
  assert.equal(r.adsStatus, "ALLOWED");
  assert.ok(r.evidence[0].startsWith("TILLÅTET"));
  assert.equal(adsStatusAllowsPosting("ALLOWED"), true);
});

test("en köp/sälj-grupp med lästa regler som tiger om företag blir LIKELY_ALLOWED — inget annat blir det", () => {
  const regler = "Gruppregler: 1. Skriv pris och ort. 2. Var trevlig. 3. Inga dubbelpostningar. 4. Markera sålt.";
  assert.equal(assessRules(regler, "FURNITURE_BUY_SELL", "Möbler säljes Stockholm").adsStatus, "LIKELY_ALLOWED");
  assert.equal(assessRules(regler, "GENERAL", "Danderyds anslagstavla").adsStatus, "UNCLEAR", "en anslagstavla är ingen annonsplats");
  assert.equal(assessRules(null, "FURNITURE_BUY_SELL", "Möbler säljes Stockholm").adsStatus, "UNCLEAR", "olästa regler är inget tillstånd");
  assert.equal(assessRules("kort", "FURNITURE_BUY_SELL", "Möbler säljes Stockholm").adsStatus, "UNCLEAR", "för lite text räknas som oläst");
  assert.equal(adsStatusAllowsPosting("UNCLEAR"), false);
});

test("regler som stänger medlemskapet upptäcks, och regelavsnittet plockas ur Om-texten", () => {
  assert.match(joinBlockedBy("Gruppen är endast på inbjudan.") ?? "", /inbjudan/i);
  assert.equal(joinBlockedBy("Alla är välkomna."), null);
  const ur = extractRulesSection("Om den här gruppen. Beskrivning här. Gruppregler från administratörerna 1. Var snäll");
  assert.equal(ur.hasRulesSection, true);
  assert.match(ur.rules ?? "", /^Gruppregler/);
  assert.equal(extractRulesSection("Bara en beskrivning").hasRulesSection, false);
});

test("regler äldre än gränsen räknas som gamla, olästa alltid", () => {
  const nu = new Date("2026-09-23T12:00:00Z");
  assert.equal(rulesStale(null, 72, nu), true);
  assert.equal(rulesStale("2026-09-22T12:00:00Z", 72, nu), false);
  assert.equal(rulesStale("2026-09-19T12:00:00Z", 72, nu), true);
});

// ─── sökfrågorna ────────────────────────────────────────────────────────────

test("sökfrågorna täcker spec:ens fyra områden och stadsdelarna, och markören går runt", () => {
  assert.ok(DISCOVERY_QUERIES.includes("möbler Stockholm"));
  assert.ok(DISCOVERY_QUERIES.includes("köp byt sälj Stockholm"));
  assert.ok(DISCOVERY_QUERIES.includes("loppis Stockholm"));
  assert.ok(DISCOVERY_QUERIES.some((q) => /IKEA/.test(q)));
  assert.ok(DISCOVERY_QUERIES.some((q) => /Sweef/.test(q)));
  assert.ok(DISCOVERY_QUERIES.includes("köp sälj Södermalm"));
  assert.ok(DISCOVERY_QUERIES.includes("köp sälj Upplands Väsby"));
  const n = DISCOVERY_QUERIES.length;
  const a = nextQueries(n - 2, 5);
  assert.equal(a.queries.length, 5);
  assert.equal(a.queries[0], DISCOVERY_QUERIES[n - 2]);
  assert.equal(a.queries[2], DISCOVERY_QUERIES[0], "varv runt");
  assert.equal(a.nextCursor, 3);
});
