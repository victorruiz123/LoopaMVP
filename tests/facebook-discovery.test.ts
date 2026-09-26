// ─── Upptäckten, valideringen, ansökningarna och vakten — mot attrappen ──────
//
// Sökningen ska ge grupper som finns på sidan (inga påhittade adresser), valideringen ska läsa regler
// och medlemskap ur gruppsidan, ansökan ska klicka högst en gång per grupp och aldrig svara på en
// fråga med något som inte står i operatörsprofilen, och vakten ska se när en väntande ansökan blivit
// ett medlemskap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbdisc-fb-"));
process.env.FACEBOOK_PROFILE_DIR = path.join(process.env.FACEBOOK_DATA_DIR, "profile");
process.env.FACEBOOK_MODE = "mock";
process.env.FACEBOOK_ENABLED = "1";
process.env.FACEBOOK_DRY_RUN = "true";
process.env.FACEBOOK_AUTO_JOIN = "0";
process.env.FACEBOOK_MIN_SECONDS_BETWEEN_WRITES = "0";
process.env.FACEBOOK_MIN_MEMBERS_TO_JOIN = "300";
process.on("exit", () => rmSync(process.env.FACEBOOK_DATA_DIR!, { recursive: true, force: true }));

const { startaFbAttrapp } = await import("./facebookAttrapp.js");
const store = await import("../server/src/integrations/facebook/store.js");
const { runDiscovery, validateGroups } = await import("../server/src/integrations/facebook/discovery.js");
const { runAutoJoin, recheckMemberships } = await import("../server/src/integrations/facebook/joining.js");
const { patchGroup } = await import("../server/src/integrations/facebook/admin.js");
const { withFacebookBrowser, checkSession } = await import("../server/src/integrations/facebook/session.js");

test("sessionskontrollen: inloggad profil -> CONNECTED, utloggad -> DISCONNECTED", async () => {
  const inne = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = inne.bas;
  try {
    const s = await withFacebookBrowser("test", ({ page }) => checkSession(page));
    assert.equal(s.status, "CONNECTED");
    assert.equal((await store.readSession())?.status, "CONNECTED");
  } finally {
    await inne.stang();
  }
  const ute = await startaFbAttrapp({ loggedIn: false });
  process.env.FACEBOOK_BASE_URL = ute.bas;
  try {
    const s = await withFacebookBrowser("test", ({ page }) => checkSession(page));
    assert.equal(s.status, "DISCONNECTED");
    assert.match(s.detail, /facebook:login/);
  } finally {
    await ute.stang();
    await store.writeSession({ status: "CONNECTED", checkedAt: new Date().toISOString(), url: null, detail: "test" });
  }
});

test("sökningen skriver bara grupper som stod i resultatet, kategoriserade och rangordnade", async () => {
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  try {
    const r = await runDiscovery({ queries: ["möbler Stockholm"], force: true });
    assert.equal(r.stoppedBy, null);
    assert.deepEqual(attrapp.lage.searches, ["möbler Stockholm"]);
    assert.equal(r.newGroups, 2, "två gruppnamn innehåller möbler eller Stockholm");
    const groups = await store.allGroups();
    const ids = groups.map((g) => g.id).sort();
    assert.deepEqual(ids, ["111", "333"]);
    const mobler = groups.find((g) => g.id === "111")!;
    assert.equal(mobler.category, "FURNITURE_BUY_SELL");
    assert.equal(mobler.memberCount, 4200);
    assert.equal(mobler.visibility, "PUBLIC");
    assert.equal(mobler.canonicalUrl, "https://www.facebook.com/groups/111/");
    assert.ok(mobler.relevanceScore > groups.find((g) => g.id === "333")!.relevanceScore, "möbelgruppen först");
    assert.equal(mobler.membershipStatus, "UNKNOWN");
    assert.equal(mobler.adsStatus, "UNCLEAR", "reglerna är inte lästa än — inget är tillåtet");
    assert.deepEqual(mobler.discoveredVia, ["möbler Stockholm"]);

    const igen = await runDiscovery({ queries: ["möbler Stockholm"], force: true });
    assert.equal(igen.newGroups, 0);
    assert.equal((await store.allGroups()).length, 2, "samma träffar igen ger inga dubbletter");
    assert.equal((await store.readDiscoveryState()).runs.length, 2);
  } finally {
    await attrapp.stang();
  }
});

test("valideringen läser regler, skrivruta och medlemskap ur gruppsidan — och flyttar adressen till attrappen", async () => {
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  // Övriga grupper in via en bredare sökning, så alla fyra finns. 222 får förbjudande regler i det här provet.
  attrapp.groups["222"].rules = "Gruppregler: Ingen reklam. Inga företag. Endast privatpersoner.";
  await runDiscovery({ queries: ["xyz-ingen-träff"], force: true });
  for (const g of await store.allGroups()) await store.updateGroup(g.id, (x) => ({ ...x, canonicalUrl: `${attrapp.bas}/groups/${x.id}/` }));
  try {
    const r = await validateGroups({ groupIds: ["111", "222", "333", "444"] });
    assert.equal(r.stoppedBy, null);
    assert.deepEqual(r.validated.sort(), ["111", "222", "333", "444"]);
    const g111 = (await store.getGroup("111"))!;
    assert.equal(g111.adsStatus, "LIKELY_ALLOWED", g111.rulesEvidence.join());
    assert.equal(g111.composerKind, "post");
    assert.equal(g111.membershipStatus, "NOT_MEMBER");
    assert.ok(g111.rulesLastCheckedAt);
    assert.match(g111.rulesText ?? "", /Bara möbler/);
    assert.equal(g111.joinEligible, true, g111.joinReasons.join("; "));
    assert.equal(g111.postEligible, false, "inte medlem än");

    const g222 = (await store.getGroup("222"))!;
    assert.equal(g222.adsStatus, "PROHIBITED");
    assert.ok(g222.rulesEvidence.some((e) => /Ingen reklam/i.test(e)));
    assert.equal(g222.joinEligible, false, "inget att vinna på en förbjuden grupp");

    const g444 = (await store.getGroup("444"))!;
    assert.equal(g444.composerKind, "listing");
    assert.ok(g444.relevanceScore < 30, "Göteborg");
  } finally {
    await attrapp.stang();
  }
});

test("ansökan: ett klick, MEMBER direkt, och aldrig ett klick till", async () => {
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  for (const g of await store.allGroups()) await store.updateGroup(g.id, (x) => ({ ...x, canonicalUrl: `${attrapp.bas}/groups/${x.id}/` }));
  try {
    const r = await runAutoJoin({ groupIds: ["111"] });
    assert.equal(r.stoppedBy, null);
    assert.equal(r.attempted.length, 1);
    assert.equal(r.attempted[0].after, "MEMBER");
    assert.deepEqual(attrapp.lage.joinClicks, ["111"]);
    const g = (await store.getGroup("111"))!;
    assert.equal(g.membershipStatus, "MEMBER");
    assert.equal(g.joinAttempts, 1);
    assert.ok(g.joinedAt);
    assert.deepEqual(g.history.map((h) => h.to).slice(-2), ["JOIN_REQUESTED", "MEMBER"]);
    assert.equal(g.postEligible, true, g.postReasons.join("; "));
    assert.equal(g.enabledForDistribution, true, "medlem + tillåtande regler slår på distributionen");

    const igen = await runAutoJoin({ groupIds: ["111"] });
    assert.equal(igen.attempted.length, 0);
    assert.match(igen.skipped.join(), /MEMBER/);
    assert.deepEqual(attrapp.lage.joinClicks, ["111"], "inget nytt klick");
  } finally {
    await attrapp.stang();
  }
});

test("en väntande ansökan blir PENDING_APPROVAL, vakten ser godkännandet — men nya förbjudande regler håller distributionen av", async () => {
  // Attrappens förval för 222 är neutrala regler; valideringsprovet ovan satte förbud bara i sin egen instans.
  // Ansökan läser reglerna på nytt före klicket (LIKELY_ALLOWED) — annars hade en förbjuden grupp hoppats över.
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  for (const g of await store.allGroups()) await store.updateGroup(g.id, (x) => ({ ...x, canonicalUrl: `${attrapp.bas}/groups/${x.id}/` }));
  try {
    const r = await runAutoJoin({ groupIds: ["222"] });
    assert.equal(r.attempted[0]?.after, "PENDING_APPROVAL", JSON.stringify(r));
    assert.deepEqual(attrapp.lage.joinClicks, ["222"]);

    const still = await recheckMemberships({ groupIds: ["222"] });
    assert.equal(still.checked[0]?.after, "PENDING_APPROVAL");
    assert.deepEqual(attrapp.lage.joinClicks, ["222"], "vakten klickar aldrig");

    // Administratören godkänner — och skriver samtidigt om reglerna. Vakten läser båda.
    attrapp.groups["222"].member = true;
    attrapp.groups["222"].rules = "Gruppregler: Ingen reklam. Inga företag. Endast privatpersoner.";
    const nu = await recheckMemberships({ groupIds: ["222"] });
    assert.equal(nu.checked[0]?.after, "MEMBER");
    const g = (await store.getGroup("222"))!;
    assert.equal(g.membershipStatus, "MEMBER");
    assert.equal(g.postEligible, false);
    assert.equal(g.enabledForDistribution, false);
    assert.match(g.postReasons.join(), /PROHIBITED/);
  } finally {
    await attrapp.stang();
  }
});

test("medlemsfrågor utan profil: ingenting skickas, frågorna sparas; med profil: sanna svar skickas", async () => {
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  for (const g of await store.allGroups()) await store.updateGroup(g.id, (x) => ({ ...x, canonicalUrl: `${attrapp.bas}/groups/${x.id}/` }));
  try {
    const r = await runAutoJoin({ groupIds: ["333"] });
    assert.equal(r.attempted[0]?.after, "QUESTIONS_REQUIRED", JSON.stringify(r));
    assert.deepEqual(attrapp.lage.joinAnswers, [], "inget halvfyllt formulär skickades");
    const g = (await store.getGroup("333"))!;
    assert.ok(g.questions.length >= 2);
    assert.ok(g.questions.some((q) => /Varför vill du gå med/.test(q.text) && !q.answerable));
    assert.ok(g.questions.some((q) => /Bor du i Stockholm/.test(q.text) && !q.answerable));

    // Adminen fyller i profilen och nollställer medlemskapet.
    await store.writeSettings({ operatorProfile: { city: "Stockholm", defaultJoinReason: "Jag vill sälja och köpa begagnade möbler i Stockholm." } }, "admin-1");
    await patchGroup("333", { resetMembership: true }, "admin-1");
    const r2 = await runAutoJoin({ groupIds: ["333"] });
    assert.equal(r2.attempted[0]?.after, "PENDING_APPROVAL", JSON.stringify(r2));
    assert.equal(attrapp.lage.joinAnswers.length, 1);
    assert.equal(attrapp.lage.joinAnswers[0].answers.q1, "Jag vill sälja och köpa begagnade möbler i Stockholm.");
    assert.equal(attrapp.lage.joinAnswers[0].answers.q2, "Ja");
    assert.equal(attrapp.lage.joinAnswers[0].answers.rules, "true", "reglerna var lästa (validerade) och tillåter — då godkänns de");
    assert.deepEqual(attrapp.lage.joinClicks, ["333", "333"], "två klick, för två uttryckliga försök efter en nollställning");
  } finally {
    await attrapp.stang();
  }
});

test("en kontrollpunkt mitt i sökningen stoppar upptäckten och skriver en åtgärd", async () => {
  const attrapp = await startaFbAttrapp({ checkpointOn: "search" });
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  try {
    const before = (await store.listManualActions()).length;
    const r = await runDiscovery({ queries: ["loppis Stockholm", "köp sälj Nacka"], force: true });
    assert.match(r.stoppedBy ?? "", /identitet/i);
    assert.equal(r.queries.length, 0, "första sökningen föll, andra kördes aldrig");
    assert.equal((await store.listManualActions()).length, before + 1);
    assert.equal((await store.readSession())?.status, "CHECKPOINT");
  } finally {
    await attrapp.stang();
  }
});
