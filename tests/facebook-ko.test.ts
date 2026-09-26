// ─── Facebook-kön mot attrappen: utlösaren, torrkörningen, idempotensen och kraschen ──────
//
// Det som får gå fel tyst här är det farligaste i hela integrationen: två Marketplace-annonser för
// samma möbel, ett inlägg som trycks fast torrkörningen var på, eller ett omförsök efter att Publicera
// redan tryckts. Varje test nedan motsvarar en av de reglerna.
//
// Allt körs mot tests/facebookAttrapp.ts — aldrig mot facebook.com. FACEBOOK_MODE=mock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbko-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbko-butik-"));
process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbko-fb-"));
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
const { enqueueForListing, onListingLive, processQueue, recoverInterrupted, sweepLiveListings } = await import("../server/src/integrations/facebook/queue.js");
const { detectInterrupt, sessionStatusFor } = await import("../server/src/integrations/facebook/checkpoint.js");
const { newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { refreshEligibility } = await import("../server/src/integrations/facebook/membership.js");
const { facebookLimits } = await import("../server/src/integrations/facebook/config.js");
const butik = await import("../server/src/butik/store.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const JOBS = process.env.LOOPA_JOBS_DIR;

/** En medlemsgrupp som är postbar och påslagen — det kön ska distribuera till. */
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
  // Adressen pekar på attrappen medan testet kör; ersätts per test nedan.
  return store.putGroup(g);
}

// ─── ren idempotens ─────────────────────────────────────────────────────────

test("en Marketplace-post per Loopa-ID och en grupp-post per Loopa-ID + grupp — alltid", async () => {
  const a = await store.enqueueMarketplace("LP-IDEM-0001", "job-a", true);
  const b = await store.enqueueMarketplace("LP-IDEM-0001", "job-a", true);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal((await store.allMarketplace()).filter((p) => p.listingId === "LP-IDEM-0001").length, 1);

  await store.updateMarketplace("LP-IDEM-0001", (c) => ({ ...c, status: "PUBLISHED" }));
  const c = await store.enqueueMarketplace("LP-IDEM-0001", "job-a", true);
  assert.equal(c.created, false, "en publicerad annons köas aldrig om av sig själv");

  const g1 = await store.enqueueGroupPublication("LP-IDEM-0001", "111", "job-a", true);
  const g2 = await store.enqueueGroupPublication("LP-IDEM-0001", "111", "job-a", true);
  const g3 = await store.enqueueGroupPublication("LP-IDEM-0001", "222", "job-a", true);
  assert.deepEqual([g1.created, g2.created, g3.created], [true, false, true]);
});

test("återhämtningen vid uppstart: före Publicera köas om, efter Publicera kräver en människa", async () => {
  await store.enqueueMarketplace("LP-KRASCH-0001", "job-k", false);
  await store.updateMarketplace("LP-KRASCH-0001", (c) => ({ ...c, status: "PREPARING", phase: "before_publish", attempts: 1 }));
  await store.enqueueMarketplace("LP-KRASCH-0002", "job-k", false);
  await store.updateMarketplace("LP-KRASCH-0002", (c) => ({ ...c, status: "PREPARING", phase: "publish_clicked", attempts: 1 }));
  await store.enqueueMarketplace("LP-KRASCH-0003", "job-k", false);
  await store.updateMarketplace("LP-KRASCH-0003", (c) => ({ ...c, status: "PREPARING", phase: "before_publish", attempts: 3 }));
  await store.enqueueGroupPublication("LP-KRASCH-0001", "999", "job-k", false);
  await store.updateGroupPublication("LP-KRASCH-0001", "999", (c) => ({ ...c, status: "PREPARING", phase: "publish_clicked", attempts: 1 }));

  const r = await recoverInterrupted();
  assert.equal(r.requeued, 1);
  assert.equal(r.manual, 2);
  assert.equal((await store.getMarketplace("LP-KRASCH-0001"))?.status, "QUEUED", "säkert omförsök");
  assert.equal((await store.getMarketplace("LP-KRASCH-0002"))?.status, "NEEDS_MANUAL_ACTION", "kan redan ligga ute — aldrig ett blint omförsök");
  assert.equal((await store.getMarketplace("LP-KRASCH-0003"))?.status, "FAILED", "tredje avbrottet ger upp");
  assert.equal((await store.getGroupPublication("LP-KRASCH-0001", "999"))?.status, "NEEDS_MANUAL_ACTION");
  const actions = await store.listManualActions();
  assert.equal(actions.filter((a) => a.kind === "UNVERIFIED_WRITE").length, 2);
  // Rensa så de inte stör kön nedan.
  await store.updateMarketplace("LP-KRASCH-0001", (c) => ({ ...c, status: "FAILED" }));
});

test("avbrotten upptäcks på adress, text och CAPTCHA-ram — och ger rätt sessionsläge", () => {
  assert.equal(detectInterrupt("https://www.facebook.com/checkpoint/1234/", "")?.kind, "CHECKPOINT");
  assert.equal(detectInterrupt("https://www.facebook.com/login/?next=x", "")?.kind, "LOGIN_REQUIRED");
  assert.equal(detectInterrupt("https://www.facebook.com/groups/1/", "Bekräfta din identitet för att fortsätta")?.kind, "CHECKPOINT");
  assert.equal(detectInterrupt("https://www.facebook.com/groups/1/", "Du är tillfälligt blockerad från att använda den här funktionen")?.kind, "RESTRICTED");
  assert.equal(detectInterrupt("https://www.facebook.com/groups/1/", "Vi har upptäckt misstänkt aktivitet")?.kind, "SUSPICIOUS_ACTIVITY");
  assert.equal(detectInterrupt("https://www.facebook.com/groups/1/", "Vanlig gruppsida", true)?.kind, "CAPTCHA");
  assert.equal(detectInterrupt("https://www.facebook.com/groups/1/", "Möbler säljes · Offentlig grupp · 1,2 tn medlemmar"), null);
  assert.equal(sessionStatusFor("LOGIN_REQUIRED"), "DISCONNECTED");
  assert.equal(sessionStatusFor("RESTRICTED"), "RESTRICTED");
  assert.equal(sessionStatusFor("CAPTCHA"), "CHECKPOINT");
});

// ─── utlösaren ──────────────────────────────────────────────────────────────

test("möbeln blir live i butiken -> Marketplace och varje postbar grupp köas, en gång", async () => {
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await medlemsgrupp("111", "Möbler säljes & köpes Stockholm");
  const av = butik.onPublished((record) => onListingLive(record.id, record.jobId));
  try {
    await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
    await butik.publish(loopaId, { kind: "admin", userId: "a" });
    // Lyssnaren är fire-and-forget; vänta in BÅDA skrivningarna (Marketplace först, grupperna sedan).
    for (let i = 0; i < 60 && !((await store.getMarketplace(loopaId)) && (await store.groupPublicationsFor(loopaId)).length > 0); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    av();
  }
  const mp = await store.getMarketplace(loopaId);
  assert.equal(mp?.status, "QUEUED");
  assert.equal(mp?.dryRun, true, "förvalet är torrkörning");
  const gp = await store.groupPublicationsFor(loopaId);
  assert.deepEqual(gp.map((p) => p.groupId), ["111"]);

  const igen = await enqueueForListing(loopaId, job.id);
  assert.equal(igen.marketplace, "exists");
  assert.equal(igen.groupsCreated, 0);
  assert.equal(igen.groupsExisting, 1);

  const sweep = await sweepLiveListings();
  assert.equal(sweep.examined, 1);
  assert.equal(sweep.enqueued, 0, "svepningen skapar inga dubbletter");
});

test("servern kopplar utlösaren till butikens live-övergång", () => {
  const src = readFileSync(path.resolve("server/src/server.ts"), "utf-8");
  assert.ok(src.includes("onPublished((record) => onListingLive(record.id, record.jobId))"));
  assert.ok(src.includes("startFacebookWorkers()"));
});

// ─── torrkörningen mot attrappen ────────────────────────────────────────────

test("torrkörningen fyller i Marketplace och skrivrutan hela vägen och stannar före Publicera", async () => {
  const attrapp = await startaFbAttrapp();
  attrapp.groups["111"].member = true;
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await store.updateGroup("111", (g) => ({ ...g, canonicalUrl: `${attrapp.bas}/groups/111/` }));
  try {
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "WOULD_PUBLISH", JSON.stringify(mp?.steps.slice(-5)));
    assert.equal(attrapp.lage.marketplace.length, 0, "ingen Marketplace-annons skapades");
    assert.ok(mp?.steps.some((s) => /TORRKÖRNING KLAR/.test(s.name)));
    assert.ok(mp?.steps.some((s) => /Kategori: Möbler/.test(s.name)), "kategorin lästes tillbaka (Marketplace har inga möbelunderkategorier)");
    assert.ok(mp?.steps.some((s) => /Skick: Använd – i gott skick/.test(s.name)), "skicket lästes tillbaka (B -> i gott skick)");
    assert.ok(mp?.steps.some((s) => /Publicera-knappen syns och är aktiv/.test(s.name)), "formuläret nådde sista knappen");
    assert.equal(mp?.contentSnapshot?.category, "Möbler");
    assert.ok(mp?.screenshot, "en skärmbild togs");

    const gp = await store.getGroupPublication(loopaId, "111");
    assert.equal(gp?.status, "WOULD_PUBLISH", JSON.stringify(gp?.steps.slice(-5)));
    assert.equal(attrapp.lage.posts.length, 0, "inget inlägg publicerades");
    assert.ok(gp?.steps.some((s) => /2 bilder uppladdade/.test(s.name)));
    assert.ok(gp?.steps.some((s) => /utkastet kastat/.test(s.name)));
    assert.match(gp?.contentSnapshot?.text ?? "", /Fler bilder och köp via Loopa/);
  } finally {
    await attrapp.stang();
  }
});

test("skarpt läge mot attrappen: Publicera trycks, adressen läses, och ett andra varv gör ingenting", async () => {
  const attrapp = await startaFbAttrapp();
  attrapp.groups["111"].member = true;
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS);
  const loopaId = loopaIdFor(job.id);
  await store.updateGroup("111", (g) => ({ ...g, canonicalUrl: `${attrapp.bas}/groups/111/` }));
  await store.updateMarketplace(loopaId, (c) => ({ ...c, status: "QUEUED", phase: null }));
  await store.updateGroupPublication(loopaId, "111", (c) => ({ ...c, status: "QUEUED", phase: null }));
  try {
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "PUBLISHED", JSON.stringify(mp?.steps.slice(-5)));
    assert.equal(mp?.phase, "verified");
    assert.match(mp?.facebookUrl ?? "", /\/marketplace\/item\/777/);
    assert.equal(mp?.facebookListingId, "777");
    assert.equal(attrapp.lage.marketplace.length, 1);
    const fält = attrapp.lage.marketplace[0].fields;
    assert.equal(fält.title, "Sweef Cloud 3-sits soffa", "produktsidans titel");
    assert.equal(fält.price, "6500");
    assert.equal(fält.category, "Möbler");
    assert.equal(fält.condition, "Använd – i gott skick");
    assert.match(fält.description, /https:\/\/loopa\.nu\/butik\/objekt\//);
    assert.equal(attrapp.lage.marketplace[0].files.length, 2);

    const gp = await store.getGroupPublication(loopaId, "111");
    assert.equal(gp?.status, "PUBLISHED", JSON.stringify(gp?.steps.slice(-5)));
    assert.match(gp?.facebookPostUrl ?? "", /\/groups\/111\/posts\/9999/);
    assert.equal(attrapp.lage.posts.length, 1);
    assert.ok(attrapp.lage.posts[0].text.startsWith("Sweef Cloud 3-sits soffa säljes"), attrapp.lage.posts[0].text.slice(0, 80));
    assert.deepEqual(attrapp.lage.posts[0].files, ["img_0.jpg", "img_1.jpg"]);
    assert.ok((await store.getGroup("111"))?.lastPostedAt, "gruppens senast-postat sattes");

    const igen = await processQueue({ max: 5 });
    assert.deepEqual(igen.marketplace, []);
    assert.deepEqual(igen.groups, []);
    assert.equal(attrapp.lage.marketplace.length, 1, "aldrig två annonser");
    assert.equal(attrapp.lage.posts.length, 1, "aldrig två inlägg");
  } finally {
    process.env.FACEBOOK_DRY_RUN = "true";
    await attrapp.stang();
  }
});

test("en kontrollpunkt stoppar arbetaren, skriver NEEDS_MANUAL_ACTION och låser kön tills en människa löst den", async () => {
  const attrapp = await startaFbAttrapp({ checkpointOn: "marketplace" });
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  const job = skrivJobb(JOBS, { id: "bbbbbbbb-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  await store.enqueueMarketplace(loopaId, job.id, true);
  try {
    const r = await processQueue({ max: 5 });
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "NEEDS_MANUAL_ACTION");
    assert.match(mp?.failureReason ?? "", /Avbrott.*identitet/i);
    assert.match(r.stoppedBy ?? "", /identitet/i);
    const action = (await store.listManualActions()).find((a) => a.context.listingId === loopaId);
    assert.equal(action?.kind, "CHECKPOINT");
    assert.ok(action?.screenshot, "skärmbild sparad");
    assert.ok(action?.url?.includes("/marketplace/create/item"));
    assert.equal((await store.readSession())?.status, "CHECKPOINT");

    const låst = await processQueue({ max: 5 });
    assert.match(låst.stoppedBy ?? "", /CHECKPOINT/, "kön står stilla tills sessionen är löst");
    await store.writeSession({ status: "CONNECTED", checkedAt: new Date().toISOString(), url: null, detail: "löst i test" });
  } finally {
    await attrapp.stang();
  }
});

test("en möbel som sålts medan den stod i kö går inte ut", async () => {
  const attrapp = await startaFbAttrapp();
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  const job = skrivJobb(JOBS, { id: "cccccccc-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  await store.enqueueMarketplace(loopaId, job.id, true);
  await butik.claimForSale(loopaId, "butik", { kind: "buyer", userId: "b" });
  try {
    await processQueue({ max: 5 });
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "FAILED");
    assert.match(mp?.failureReason ?? "", /inte till salu/);
    assert.equal(attrapp.lage.visited.filter((v) => v.includes("/marketplace/create")).length, 0, "formuläret öppnades aldrig");
  } finally {
    await attrapp.stang();
  }
});
