// ─── Medlemskapets tillståndsmaskin, ansökningarnas idempotens och frågornas sanning ─────
//
// Tre saker får inte hända: att samma ansökan skickas om, att roboten svarar på en medlemsfråga med
// något som inte står i operatörsprofilen, och att en grupp får annonser innan den är medlem med
// regler som tillåter det.

import { test } from "node:test";
import assert from "node:assert/strict";

const { MEMBERSHIP_TRANSITIONS, canTransition, NON_JOINABLE, applyMembership, MembershipTransitionError, computeJoinEligibility, computePostEligibility, refreshEligibility, distributionTargets, shouldRecheckMembership, autoJoinActive } =
  await import("../server/src/integrations/facebook/membership.js");
const { newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { answerQuestion, answerAll, allAnswerable } = await import("../server/src/integrations/facebook/questions.js");
const { facebookLimits } = await import("../server/src/integrations/facebook/config.js");
import type { FacebookGroup, MembershipStatus, OperatorProfile } from "../server/src/integrations/facebook/types.js";

function grupp(patch: Partial<FacebookGroup> = {}): FacebookGroup {
  return {
    ...newGroup({ key: "g1", name: "Möbler säljes Stockholm", canonicalUrl: "https://www.facebook.com/groups/g1/", category: "FURNITURE_BUY_SELL", memberCount: 5000 }),
    relevanceScore: 90,
    adsStatus: "LIKELY_ALLOWED",
    rulesLastCheckedAt: "2026-09-23T08:00:00.000Z",
    rulesText: "Gruppregler: skriv pris.",
    composerKind: "post",
    ...patch,
  };
}

// ─── tillståndsmaskinen ─────────────────────────────────────────────────────

test("övergångstabellen tillåter bara det den räknar upp", () => {
  assert.equal(canTransition("NOT_MEMBER", "JOIN_REQUESTED"), true);
  assert.equal(canTransition("JOIN_REQUESTED", "PENDING_APPROVAL"), true);
  assert.equal(canTransition("PENDING_APPROVAL", "MEMBER"), true);
  assert.equal(canTransition("PENDING_APPROVAL", "JOIN_REJECTED"), true);
  assert.equal(canTransition("MEMBER", "MEMBER"), true, "samma läge igen är en kontroll, inte ett fel");
  assert.equal(canTransition("MEMBER", "JOIN_REQUESTED"), false, "en medlem ansöker inte igen");
  assert.equal(canTransition("JOIN_REJECTED", "JOIN_REQUESTED"), false, "en avslagen ansökan skickas inte om av sig själv");
  assert.equal(canTransition("JOIN_BLOCKED", "PENDING_APPROVAL"), false);
  for (const from of Object.keys(MEMBERSHIP_TRANSITIONS) as MembershipStatus[]) {
    for (const to of MEMBERSHIP_TRANSITIONS[from]) assert.ok(canTransition(from, to), `${from} -> ${to}`);
  }
});

test("applyMembership skriver historik och tidsstämplar, och kastar på otillåtna övergångar", () => {
  const t0 = "2026-09-23T09:00:00.000Z";
  let g = applyMembership(grupp(), "NOT_MEMBER", "Gå med-knappen syns.", { at: t0 });
  g = applyMembership(g, "JOIN_REQUESTED", "Klickade.", { at: "2026-09-23T09:01:00.000Z", countAttempt: true });
  g = applyMembership(g, "PENDING_APPROVAL", "Väntar.", { at: "2026-09-23T09:02:00.000Z" });
  g = applyMembership(g, "PENDING_APPROVAL", "Fortfarande.", { at: "2026-09-23T15:00:00.000Z" });
  g = applyMembership(g, "MEMBER", "Godkänd.", { at: "2026-09-24T08:00:00.000Z" });
  assert.equal(g.joinAttempts, 1);
  assert.equal(g.joinRequestedAt, "2026-09-23T09:01:00.000Z");
  assert.equal(g.joinedAt, "2026-09-24T08:00:00.000Z");
  assert.equal(g.membershipLastCheckedAt, "2026-09-24T08:00:00.000Z");
  assert.deepEqual(g.history.map((h) => h.to), ["NOT_MEMBER", "JOIN_REQUESTED", "PENDING_APPROVAL", "MEMBER"], "samma läge igen ger ingen ny rad");
  assert.throws(() => applyMembership(g, "JOIN_REQUESTED", "x"), MembershipTransitionError);
});

// ─── ansökningarnas idempotens ──────────────────────────────────────────────

test("en grupp som redan är medlem, väntar eller väntar på en människa får aldrig ett nytt klick", () => {
  const limits = facebookLimits();
  for (const status of NON_JOINABLE) {
    const e = computeJoinEligibility(grupp({ membershipStatus: status }), limits);
    assert.equal(e.eligible, false, status);
    assert.ok(e.reasons.some((r) => r.includes(status)), status);
  }
  assert.equal(computeJoinEligibility(grupp({ membershipStatus: "NOT_MEMBER" }), limits).eligible, true);
  assert.equal(computeJoinEligibility(grupp({ membershipStatus: "UNKNOWN" }), limits).eligible, true);
});

test("ansökan kräver relevans, storlek, kategori och regler utan förbud", () => {
  const limits = { minRelevanceToJoin: 60, minMembersToJoin: 300 };
  assert.match(computeJoinEligibility(grupp({ relevanceScore: 30 }), limits).reasons.join(), /relevans 30/);
  assert.match(computeJoinEligibility(grupp({ memberCount: 120 }), limits).reasons.join(), /120 medlemmar/);
  assert.match(computeJoinEligibility(grupp({ category: "OTHER" }), limits).reasons.join(), /OTHER/);
  assert.match(computeJoinEligibility(grupp({ adsStatus: "PROHIBITED" }), limits).reasons.join(), /förbjuder/);
  assert.match(computeJoinEligibility(grupp({ rulesText: "Endast på inbjudan." }), limits).reasons.join(), /inbjudan/);
  assert.equal(computeJoinEligibility(grupp({ memberCount: null }), limits).eligible, true, "okänt medlemsantal stoppar inte");
});

// ─── postbarheten ───────────────────────────────────────────────────────────

test("postbar kräver MEMBER + tillåtande regler + en skrivruta (text eller Sälj något) + lästa regler", () => {
  assert.equal(computePostEligibility(grupp({ membershipStatus: "MEMBER" })).eligible, true);
  assert.match(computePostEligibility(grupp({ membershipStatus: "PENDING_APPROVAL" })).reasons.join(), /inte medlem/);
  assert.match(computePostEligibility(grupp({ membershipStatus: "MEMBER", adsStatus: "UNCLEAR" })).reasons.join(), /UNCLEAR/);
  assert.match(computePostEligibility(grupp({ membershipStatus: "MEMBER", adsStatus: "PROHIBITED" })).reasons.join(), /PROHIBITED/);
  assert.equal(computePostEligibility(grupp({ membershipStatus: "MEMBER", composerKind: "listing" })).eligible, true, "Sälj något-rutan är postbar sedan 2026-09-26");
  assert.match(computePostEligibility(grupp({ membershipStatus: "MEMBER", composerKind: "none" })).reasons.join(), /ingen skrivruta/);
  assert.match(computePostEligibility(grupp({ membershipStatus: "MEMBER", rulesLastCheckedAt: null })).reasons.join(), /inte lästs/);
});

test("distributionen slås på automatiskt när gruppen blir postbar — men adminens nej står", () => {
  const limits = facebookLimits();
  const auto = refreshEligibility(grupp({ membershipStatus: "MEMBER" }), limits);
  assert.equal(auto.enabledForDistribution, true);
  assert.equal(auto.enabledForDistributionSetBy, "auto");

  const adminNej = refreshEligibility(grupp({ membershipStatus: "MEMBER", enabledForDistribution: false, enabledForDistributionSetBy: "admin" }), limits);
  assert.equal(adminNej.enabledForDistribution, false, "adminens nej fryser brytaren");

  const adminJaMenInteMedlem = refreshEligibility(grupp({ membershipStatus: "PENDING_APPROVAL", enabledForDistribution: true, enabledForDistributionSetBy: "admin" }), limits);
  assert.equal(adminJaMenInteMedlem.enabledForDistribution, false, "ett ja gäller bara en grupp som faktiskt går att publicera i");

  const blevOpostbar = refreshEligibility({ ...auto, adsStatus: "PROHIBITED" }, limits);
  assert.equal(blevOpostbar.enabledForDistribution, false, "nya regler stänger av");
});

test("distributionsmålen: medlem + postbar + påslagen, bäst först, högst maxGroups", () => {
  const limits = facebookLimits();
  const a = refreshEligibility(grupp({ id: "a", membershipStatus: "MEMBER", relevanceScore: 70 }), limits);
  const b = refreshEligibility(grupp({ id: "b", membershipStatus: "MEMBER", relevanceScore: 95 }), limits);
  const c = refreshEligibility(grupp({ id: "c", membershipStatus: "PENDING_APPROVAL", relevanceScore: 99 }), limits);
  const d = refreshEligibility(grupp({ id: "d", membershipStatus: "MEMBER", relevanceScore: 80, enabledForDistribution: false, enabledForDistributionSetBy: "admin" }), limits);
  assert.deepEqual(distributionTargets([a, b, c, d], 10).map((g) => g.id), ["b", "a"]);
  assert.deepEqual(distributionTargets([a, b, c, d], 1).map((g) => g.id), ["b"]);
});

test("vakten tittar bara på väntande ansökningar, och inte oftare än intervallet", () => {
  const nu = new Date("2026-09-23T12:00:00Z");
  assert.equal(shouldRecheckMembership(grupp({ membershipStatus: "PENDING_APPROVAL", membershipLastCheckedAt: null }), 360, nu), true);
  assert.equal(shouldRecheckMembership(grupp({ membershipStatus: "PENDING_APPROVAL", membershipLastCheckedAt: "2026-09-23T11:00:00Z" }), 360, nu), false);
  assert.equal(shouldRecheckMembership(grupp({ membershipStatus: "PENDING_APPROVAL", membershipLastCheckedAt: "2026-09-23T05:00:00Z" }), 360, nu), true);
  assert.equal(shouldRecheckMembership(grupp({ membershipStatus: "MEMBER", membershipLastCheckedAt: null }), 360, nu), false);
  assert.equal(autoJoinActive(true, { autoJoinPaused: false }), true);
  assert.equal(autoJoinActive(true, { autoJoinPaused: true }), false);
  assert.equal(autoJoinActive(false, { autoJoinPaused: false }), false);
});

// ─── medlemsfrågorna ────────────────────────────────────────────────────────

const TOM: OperatorProfile = { displayName: "", city: "", region: "", interests: "", businessAffiliation: "", defaultJoinReason: "" };
const PROFIL: OperatorProfile = {
  displayName: "Victor",
  city: "Stockholm",
  region: "Stockholms län",
  interests: "Begagnade möbler och inredning",
  businessAffiliation: "Jag arbetar med Loopa, en tjänst som säljer begagnade möbler åt privatpersoner i Stockholm.",
  defaultJoinReason: "Jag vill sälja och köpa begagnade möbler i Stockholm.",
};

test("en tom profil svarar aldrig på något — varje fråga blir obesvarad", () => {
  const frågor = [
    { text: "Varför vill du gå med?", kind: "text" as const },
    { text: "Bor du i Stockholm?", kind: "choice" as const, options: ["Ja", "Nej"] },
    { text: "Är du ett företag?", kind: "text" as const },
    { text: "Vad heter du?", kind: "text" as const },
  ];
  const svar = answerAll(frågor, TOM, true);
  assert.ok(svar.every((s) => !s.answerable && s.answer === null));
  assert.equal(allAnswerable(svar), false);
});

test("konfigurerade sanningar besvaras — och bara de", () => {
  assert.equal(answerQuestion({ text: "Varför vill du gå med?", kind: "text" }, PROFIL, true).answer, PROFIL.defaultJoinReason);
  assert.equal(answerQuestion({ text: "Bor du i Stockholm?", kind: "choice", options: ["Ja", "Nej"] }, PROFIL, true).answer, "Ja");
  assert.equal(answerQuestion({ text: "Bor du i Göteborg?", kind: "choice", options: ["Ja", "Nej"] }, PROFIL, true).answer, "Nej", "en annan ort får ett ärligt nej — aldrig ett ja för att komma in");
  assert.equal(answerQuestion({ text: "Var bor du?", kind: "text" }, PROFIL, true).answer, "Stockholm");
  assert.equal(answerQuestion({ text: "Vad heter du?", kind: "text" }, PROFIL, true).answer, "Victor");
  assert.equal(answerQuestion({ text: "Är du ett företag eller privatperson?", kind: "text" }, PROFIL, true).answer, PROFIL.businessAffiliation, "företagsrelationen skrivs ut som den är");
  assert.equal(answerQuestion({ text: "Hur gammal är du?", kind: "text" }, PROFIL, true).answerable, false, "ålder finns inte i profilen och hittas inte på");
  assert.equal(answerQuestion({ text: "Vem bjöd in dig?", kind: "text" }, PROFIL, true).answerable, false);
});

test("regelgodkännandet ges bara när reglerna faktiskt lästs och tillåter", () => {
  const q = { text: "Godkänner du gruppens regler?", kind: "agree_rules" as const, options: ["Jag godkänner"] };
  assert.equal(answerQuestion(q, PROFIL, false).answerable, false);
  assert.equal(answerQuestion(q, PROFIL, true).answer, "Jag godkänner");
  assert.equal(answerQuestion({ text: "Jag har läst och förstått reglerna", kind: "unknown" }, PROFIL, true).answer, "Ja");
});

test("en enda obesvarbar fråga stoppar hela formuläret", () => {
  const svar = answerAll([{ text: "Varför vill du gå med?", kind: "text" }, { text: "Vilket år är du född?", kind: "text" }], PROFIL, true);
  assert.equal(svar[0].answerable, true);
  assert.equal(svar[1].answerable, false);
  assert.equal(allAnswerable(svar), false, "då skickas ingenting");
});
