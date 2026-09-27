// ─── Säker lokal uppstart: paus MÅSTE hindra svepningen från att skriva ────────────────────
//
// LP-74PJ-NBK8 (2026-09-27): en lokalt speglad annons blev en RIKTIG Facebook-skrivning bara för att
// bakgrundsservern startade med FACEBOOK_ENABLED=1 FACEBOOK_DRY_RUN=false — ingen människa tryckte
// "Godkänn och lägg ut". sweepLiveListings (queue.ts) känner inte av OM en människa godkänt, bara att
// möbeln är live lokalt och saknar en Facebook-post, och samma varv kör den direkt (processQueue).
//
// Fixet är INTE en ny mekanism: marketplacePaused/groupPublishingPaused fanns redan i settings.json
// och lästes redan av både enqueueForListing OCH processQueue. Gapet var att de bara gick att sätta
// genom en körande admin-panel — en kapplöpning mot svepningens 3-minutersfördröjning vid uppstart.
// `npm run facebook -- pause` (cli.ts) skriver samma inställningar direkt till disk, INNAN servern ens
// startar, så kapplöpningen försvinner. Det här testet bevisar båda hälfterna: pausad skriver
// ingenting alls (och rör inte det som redan låg i kö), opausad fungerar precis som förut.
//
// Ingen webbläsare, ingen attrapp: allt nedan stannar före withFacebookBrowser, så det finns inget att
// mocka mot — settings-kontrollen sker innan något Facebook-relaterat ens övervägs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsafe-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsafe-butik-"));
process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsafe-fb-"));
process.env.FACEBOOK_PROFILE_DIR = path.join(process.env.FACEBOOK_DATA_DIR, "profile");
process.env.FACEBOOK_MODE = "mock";
process.env.FACEBOOK_ENABLED = "1";
// Skarpt läge, precis som händelsen 2026-09-27 — pausen ska hindra allt ändå. Ingen browser öppnas i
// de här testerna (se filkommentaren), så "skarpt" har ingen praktisk effekt förutom att bevisa att
// pausen inte förlitar sig på torrkörningen som sitt egentliga skydd.
process.env.FACEBOOK_DRY_RUN = "false";
process.env.FACEBOOK_AUTO_JOIN = "0";
process.env.FACEBOOK_MIN_SECONDS_BETWEEN_WRITES = "0";
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
process.on("exit", () => {
  for (const d of [process.env.LOOPA_JOBS_DIR!, process.env.BUTIK_DATA_DIR!, process.env.FACEBOOK_DATA_DIR!]) rmSync(d, { recursive: true, force: true });
});

const { skrivJobb } = await import("./facebookFixtur.js");
const store = await import("../server/src/integrations/facebook/store.js");
const { enqueueForListing, sweepLiveListings, processQueue } = await import("../server/src/integrations/facebook/queue.js");
const { newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { refreshEligibility } = await import("../server/src/integrations/facebook/membership.js");
const { facebookLimits } = await import("../server/src/integrations/facebook/config.js");
const butik = await import("../server/src/butik/store.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const JOBS = process.env.LOOPA_JOBS_DIR;

/** En medlemsgrupp som är postbar och påslagen — det svepningen annars skulle distribuera till. */
async function medlemsgrupp(id: string, name: string) {
  const g = refreshEligibility(
    {
      ...newGroup({ key: id, name, canonicalUrl: `https://www.facebook.com/groups/${id}/`, category: "FURNITURE_BUY_SELL", memberCount: 4200, visibility: "PUBLIC" }),
      relevanceScore: 90,
      adsStatus: "LIKELY_ALLOWED",
      rulesLastCheckedAt: new Date().toISOString(),
      rulesText: "Gruppregler: skriv pris och ort.",
      composerKind: "post",
      membershipStatus: "MEMBER",
    },
    facebookLimits(),
  );
  return store.putGroup(g);
}

async function liveMobel(jobIdSuffix: string) {
  const job = skrivJobb(JOBS, { id: `2000000${jobIdSuffix}-2222-4333-8444-555555555555` });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  return { job, loopaId };
}

test("pausad: en live möbel utan Facebook-täckning ger noll skrivningar — varken svepningen, köandet eller körningen gör något", async () => {
  await medlemsgrupp("safe1", "Möbler säljes Stockholm");
  await store.writeSettings({ marketplacePaused: true, groupPublishingPaused: true }, "test");
  const { job, loopaId } = await liveMobel("1");

  // Precis det händelsen gjorde: en bakgrundssvepning hittar en live möbel utan Facebook-post.
  const sweep = await sweepLiveListings();
  assert.equal(sweep.enqueued, 0, "pausad: svepningen köar ingenting");
  assert.equal(await store.getMarketplace(loopaId), null, "ingen Marketplace-post skapades");
  assert.equal((await store.groupPublicationsFor(loopaId)).length, 0, "ingen grupp-post skapades");

  // Samma sak via den uttryckliga vägen (godkann/onListingLive anropar samma funktion).
  const enq = await enqueueForListing(loopaId, job.id);
  assert.equal(enq.marketplace, "skipped");
  assert.match(enq.marketplaceReason ?? "", /pausat/i);
  assert.equal(enq.groupsCreated, 0);
  assert.equal(enq.groupsSkipped.length, 0, "grupploopen körs inte ens — pausen stoppar innan urvalet");

  // Och skulle något ändå ligga i kö (det gör det inte här) rör inte körningen det heller.
  const run = await processQueue({ max: 5 });
  assert.deepEqual(run.marketplace, []);
  assert.deepEqual(run.groups, []);

  await store.writeSettings({ marketplacePaused: false, groupPublishingPaused: false }, "test");
  // Städa: möbeln står fortfarande live utan Facebook-täckning — annars plockar nästa opausade test
  // (svepningens återhämtningsprov) upp den också, och räknar fel.
  await butik.claimForSale(loopaId, "butik", { kind: "buyer", userId: "b" });
});

test("pausad: en post som redan låg QUEUED innan pausen rörs inte — inget tas bort, inget körs", async () => {
  await store.writeSettings({ marketplacePaused: false, groupPublishingPaused: false }, "test");
  const { created } = await store.enqueueMarketplace("LP-SAFE-0001", "job-safe", false);
  assert.equal(created, true);
  await medlemsgrupp("safe2", "Retro möbler Stockholm");
  const { created: gCreated } = await store.enqueueGroupPublication("LP-SAFE-0001", "safe2", "job-safe", false);
  assert.equal(gCreated, true);

  await store.writeSettings({ marketplacePaused: true, groupPublishingPaused: true }, "test");
  const run = await processQueue({ max: 5 });
  assert.deepEqual(run.marketplace, [], "pausen stoppar även poster som redan låg i kö");
  assert.deepEqual(run.groups, []);
  assert.equal((await store.getMarketplace("LP-SAFE-0001"))?.status, "QUEUED", "posten ligger kvar orörd, inte borttagen eller ändrad");
  assert.equal((await store.getMarketplace("LP-SAFE-0001"))?.attempts, 0);
  assert.equal((await store.getGroupPublication("LP-SAFE-0001", "safe2"))?.status, "QUEUED");

  await store.writeSettings({ marketplacePaused: false, groupPublishingPaused: false }, "test");
});

test("opausad: svepningen köar som förut — återhämtningsmekanismen är intakt, inte bara avstängd", async () => {
  await store.writeSettings({ marketplacePaused: false, groupPublishingPaused: false }, "test");
  await medlemsgrupp("safe3", "Köp och sälj Stockholm");
  const { loopaId } = await liveMobel("3");

  const sweep = await sweepLiveListings();
  assert.equal(sweep.enqueued, 1, "opausad: svepningen hittar och köar den täckningslösa möbeln som vanligt");
  assert.equal((await store.getMarketplace(loopaId))?.status, "QUEUED");
  assert.ok((await store.groupPublicationsFor(loopaId)).length > 0, "gruppurvalet köas också, precis som förut");

  // Städa: inget får stå QUEUED kvar och plockas upp av ett senare, obesläktat processQueue-varv.
  await store.updateMarketplace(loopaId, (c) => ({ ...c, status: "FAILED" }));
  for (const p of await store.groupPublicationsFor(loopaId)) {
    await store.updateGroupPublication(loopaId, p.groupId, (c) => ({ ...c, status: "FAILED" }));
  }
});
