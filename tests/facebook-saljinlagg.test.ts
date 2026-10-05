// ─── Säljinlägget ("Sälj något") i en köp/sälj-grupp, mot attrappen ────────────────────────
//
// Köp/sälj-grupperna har inget textinlägg — bara Facebooks annonsformulär i en dialog. Det här
// provar att kön tar den vägen: dialogen fylls med Loopas kanoniska uppgifter, steget "Dela på fler
// platser" begränsas till målgruppen (andra förvalda grupper bockas ur, Marketplace stängs av),
// torrkörningen stannar före Publicera, skarpt läge publicerar exakt en gång.
//
// Allt körs mot tests/facebookAttrapp.ts — aldrig mot facebook.com. FACEBOOK_MODE=mock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsalj-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsalj-butik-"));
process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbsalj-fb-"));
process.env.FACEBOOK_PROFILE_DIR = path.join(process.env.FACEBOOK_DATA_DIR, "profile");
process.env.FACEBOOK_MODE = "mock";
process.env.FACEBOOK_ENABLED = "1";
process.env.FACEBOOK_DRY_RUN = "true";
process.env.FACEBOOK_AUTO_JOIN = "0";
process.env.FACEBOOK_MIN_SECONDS_BETWEEN_WRITES = "0";
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
process.on("exit", () => {
  for (const d of [process.env.LOOPA_JOBS_DIR!, process.env.BUTIK_DATA_DIR!, process.env.FACEBOOK_DATA_DIR!]) rmSync(d, { recursive: true, force: true });
});

const { startaFbAttrapp } = await import("./facebookAttrapp.js");
const { skrivJobb } = await import("./facebookFixtur.js");
const store = await import("../server/src/integrations/facebook/store.js");
const { enqueueForListing, processQueue } = await import("../server/src/integrations/facebook/queue.js");
const { newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { computePostEligibility, distributionTargets, refreshEligibility } = await import("../server/src/integrations/facebook/membership.js");
const { facebookLimits } = await import("../server/src/integrations/facebook/config.js");
const { groupListingCopy, groupListingSnapshot } = await import("../server/src/integrations/facebook/mapping.js");
const butik = await import("../server/src/butik/store.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const JOBS = process.env.LOOPA_JOBS_DIR;

/** En köp/sälj-grupp där kontot är medlem och bara "Sälj något" finns — som de riktiga Stockholmsgrupperna. */
function saljgrupp(bas: string) {
  return refreshEligibility(
    {
      // Stockholm, inte Göteborg: urvalet per möbel (membership.ts) hoppar över grupper i en annan stad.
      ...newGroup({ key: "444", name: "Secondhand Stockholm", canonicalUrl: `${bas}/groups/444/`, category: "FURNITURE_BUY_SELL", memberCount: 8100, visibility: "PUBLIC", geography: "Stockholm" }),
      relevanceScore: 85,
      adsStatus: "LIKELY_ALLOWED",
      rulesLastCheckedAt: new Date().toISOString(),
      rulesText: "Gruppregler: Köp och sälj i Göteborg.",
      composerKind: "listing",
      membershipStatus: "MEMBER",
    },
    facebookLimits(),
  );
}

test("en medlemsgrupp med bara Sälj något är postbar och blir ett distributionsmål", () => {
  const g = saljgrupp("http://127.0.0.1:1");
  assert.equal(computePostEligibility(g).eligible, true, g.postReasons.join("; "));
  assert.equal(g.enabledForDistribution, true, "brytaren slås på automatiskt");
  assert.deepEqual(distributionTargets([g], 10).map((x) => x.id), ["444"]);
  const utan = refreshEligibility({ ...g, composerKind: "none" }, facebookLimits());
  assert.equal(utan.postEligible, false, "en grupp helt utan ruta är fortfarande opostbar");
});

test("säljinläggets text är Marketplace-texten: egen rubrik, eget pris, Loopa-adressen sist", async () => {
  const job = skrivJobb(JOBS, { id: "dddddddd-2222-4333-8444-555555555555" });
  const { facebookListingFor } = await import("../server/src/integrations/facebook/mapping.js");
  const r = await facebookListingFor(job);
  assert.ok(r.ok);
  if (!r.ok) return;
  const copy = groupListingCopy(r.listing);
  assert.equal(copy.title, "Sweef Cloud 3-sits soffa i grå sammet");
  assert.match(copy.description, /Pris: 6\s500 kr/, "Intl skriver tusentalsavgränsaren som hårt mellanslag");
  assert.ok(copy.description.trimEnd().endsWith(r.listing.canonicalUrl), "adressen står sist");
  const snap = groupListingSnapshot(r.listing);
  assert.equal(snap.kind, "listing");
  assert.equal(snap.title, "Sweef Cloud 3-sits soffa i grå sammet");
  assert.equal(snap.price, 6500);
});

test("torrkörningen fyller Sälj något-dialogen, begränsar målgruppen och stannar före Publicera", async () => {
  const attrapp = await startaFbAttrapp();
  attrapp.groups["444"].member = true;
  attrapp.groups["444"].name = "Secondhand Stockholm";
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await store.putGroup(saljgrupp(attrapp.bas));
  await store.writeSettings({ marketplacePaused: true }, "test");
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  try {
    const kö = await enqueueForListing(loopaId, job.id);
    assert.equal(kö.groupsCreated, 1, kö.reason ?? "");
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const gp = await store.getGroupPublication(loopaId, "444");
    assert.equal(gp?.status, "WOULD_PUBLISH", JSON.stringify(gp?.steps.slice(-6)));
    assert.equal(gp?.composer, "listing");
    assert.equal(gp?.contentSnapshot?.kind, "listing");
    assert.equal(gp?.contentSnapshot?.title, "Sweef Cloud 3-sits soffa i grå sammet");
    assert.equal(attrapp.lage.listings.length, 0, "inget säljinlägg publicerades");
    const namn = gp?.steps.map((s) => s.name) ?? [];
    assert.ok(namn.some((n) => /Vara till salu valt/.test(n)), namn.join(" | "));
    assert.ok(namn.some((n) => /2 bilder uppladdade/.test(n)));
    assert.ok(namn.some((n) => /Pris: 6500 kr \(fältet visar 6\s500 kr\)/.test(n)), `valutan lästes tillbaka: ${namn.filter((n) => /Pris/.test(n)).join(" | ")}`);
    assert.ok(namn.some((n) => /Skick: Använd – i gott skick/.test(n)));
    assert.ok(namn.some((n) => /Dela på fler platser/.test(n)));
    assert.ok(namn.some((n) => /Marketplace var påslaget i säljinlägget och stängdes av/.test(n)), "Marketplace stängdes av");
    assert.ok(namn.some((n) => /Bockade ur 1 förvalda grupper/.test(n)), "den andra förvalda gruppen bockades ur");
    assert.ok(namn.some((n) => /TORRKÖRNING KLAR/.test(n)));
    assert.ok(namn.some((n) => /utkastet kastat/.test(n)));
    assert.ok(gp?.screenshot, "en skärmbild togs");
  } finally {
    await attrapp.stang();
  }
});

test("skarpt läge: Publicera trycks en gång, bara målgruppen får säljinlägget, och ett andra varv gör ingenting", async () => {
  const attrapp = await startaFbAttrapp();
  attrapp.groups["444"].member = true;
  attrapp.groups["444"].name = "Secondhand Stockholm";
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await store.putGroup(saljgrupp(attrapp.bas));
  await store.updateGroupPublication(loopaId, "444", (c) => ({ ...c, status: "QUEUED", phase: null }));
  try {
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const gp = await store.getGroupPublication(loopaId, "444");
    assert.equal(gp?.status, "PUBLISHED", JSON.stringify(gp?.steps.slice(-6)));
    assert.equal(gp?.phase, "verified");
    assert.equal(gp?.composer, "listing");
    assert.match(gp?.facebookPostUrl ?? "", /\/commerce\/listing\/8888\/$/, "säljinläggets kort länkar till /commerce/listing/, inte /posts/");
    assert.equal(gp?.facebookListingId, "8888");
    assert.equal(attrapp.lage.listings.length, 1);
    const [l] = attrapp.lage.listings;
    assert.equal(l.groupId, "444");
    assert.equal(l.fields.title, "Sweef Cloud 3-sits soffa i grå sammet", "annonsrubriken, samma som Tradera och Blocket");
    assert.equal(l.fields.price, "6500");
    assert.equal(l.fields.condition, "Använd – i gott skick");
    assert.match(l.fields.description, /https:\/\/loopa\.nu\/butik\/objekt\//);
    assert.equal(l.fields.location, "Stockholm");
    assert.equal(l.fields.marketplace, "false", "Marketplace har sin egen kö — aldrig via gruppens formulär");
    assert.equal(l.fields.groups, "Secondhand Stockholm", "exakt en grupp");
    assert.deepEqual(l.files, ["img_0.jpg", "img_1.jpg"]);
    assert.ok((await store.getGroup("444"))?.lastPostedAt);

    const igen = await processQueue({ max: 5 });
    assert.deepEqual(igen.groups, []);
    assert.equal(attrapp.lage.listings.length, 1, "aldrig två säljinlägg");
  } finally {
    process.env.FACEBOOK_DRY_RUN = "true";
    await attrapp.stang();
  }
});

// Dubbletterna 2026-10-02–04: ett kövarv tar minuter men startas varje minut, och varv två körde samma
// köpost igen. Fem möbler hamnade två gånger i samma grupp.
test("två kövarv samtidigt: säljinlägget publiceras EN gång", async () => {
  const attrapp = await startaFbAttrapp();
  attrapp.groups["444"].member = true;
  attrapp.groups["444"].name = "Secondhand Stockholm";
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS, { id: "22222222-3333-4444-8555-666666666666" });
  const loopaId = loopaIdFor(job.id);
  await store.putGroup(saljgrupp(attrapp.bas));
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  await store.enqueueGroupPublication(loopaId, "444", job.id, false);
  const fore = attrapp.lage.listings.length;
  try {
    const [a, b] = await Promise.all([processQueue({ max: 5 }), processQueue({ max: 5 })]);
    assert.ok([a.stoppedBy, b.stoppedBy].includes("Ett kövarv pågår redan."), "det andra varvet väntar inte in det första");
    assert.equal(attrapp.lage.listings.length - fore, 1, "aldrig två säljinlägg i samma grupp");
    assert.equal((await store.getGroupPublication(loopaId, "444"))?.status, "PUBLISHED");
  } finally {
    process.env.FACEBOOK_DRY_RUN = "true";
    await attrapp.stang();
  }
});

test("anspråket: en köpost kan bara tas en gång, och aldrig ur något annat läge än kö", async () => {
  const id = "LP-TEST-CLAIM";
  await store.enqueueGroupPublication(id, "444", "jobb", false);
  const tagna = await Promise.all([store.claimGroupPublication(id, "444"), store.claimGroupPublication(id, "444")]);
  assert.equal(tagna.filter(Boolean).length, 1, "exakt ett anspråk lyckas");
  assert.equal(tagna.find(Boolean)?.status, "PREPARING");
  assert.equal(tagna.find(Boolean)?.attempts, 1);
  await store.updateGroupPublication(id, "444", (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", phase: "publish_clicked" }));
  assert.equal(await store.claimGroupPublication(id, "444"), null, "en post som väntar på en människa körs aldrig om");

  await store.enqueueMarketplace(id, "jobb", false);
  const mp = await Promise.all([store.claimMarketplace(id), store.claimMarketplace(id)]);
  assert.equal(mp.filter(Boolean).length, 1);
});

test("går Marketplace-brytaren inte att stänga av publiceras ingenting", async () => {
  // Attrappen låter brytaren alltid gå att stänga av; det här provar att föraren FALLER när den inte
  // hittar målgruppen alls — samma skyddsgren: ingenting publiceras när målgruppen inte kan säkras.
  const attrapp = await startaFbAttrapp();
  attrapp.groups["444"].member = true;
  attrapp.groups["444"].name = "Ett helt annat gruppnamn";
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await store.putGroup(saljgrupp(attrapp.bas));
  await store.updateGroupPublication(loopaId, "444", (c) => ({ ...c, status: "QUEUED", phase: null, attempts: 0 }));
  try {
    await processQueue({ max: 5 });
    const gp = await store.getGroupPublication(loopaId, "444");
    assert.equal(gp?.status, "FAILED", JSON.stringify(gp?.steps.slice(-4)));
    assert.match(gp?.failureReason ?? "", /Målgruppen .* syns inte/);
    assert.equal(attrapp.lage.listings.length, 0, "ingenting publicerades");
  } finally {
    process.env.FACEBOOK_DRY_RUN = "true";
    await attrapp.stang();
  }
});
