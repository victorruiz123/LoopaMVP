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

// LP-2FJW-W00Y (2026-09-26): en olöst manuell åtgärd kvar sedan en TIDIGARE annons spärrade båda de
// enda medlemsgrupperna för en helt annan annons — noll grupp-poster skapades, och ingenting sa varför.
test("en olöst manuell åtgärd på en grupp spärrar den för varje annons tills den löses — och köandet säger varför", async () => {
  await medlemsgrupp("555", "Blockerad grupp A Stockholm");
  await medlemsgrupp("666", "Blockerad grupp B Stockholm");
  const a1 = await store.recordManualAction({ kind: "OTHER", reason: "Gammal olöst historik från en annan annons.", url: null, screenshot: null, lastCompletedStep: null, context: { worker: "group-post", listingId: "LP-GAMMAL-0001", groupId: "555" } });
  const a2 = await store.recordManualAction({ kind: "OTHER", reason: "Gammal olöst historik från en annan annons.", url: null, screenshot: null, lastCompletedStep: null, context: { worker: "group-post", listingId: "LP-GAMMAL-0001", groupId: "666" } });

  const job = skrivJobb(JOBS, { id: "99999999-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });

  const spärrat = await enqueueForListing(loopaId, job.id);
  // Andra medlemsgrupper (t.ex. "111" från ett tidigare test i den här filen) kan legitimt väljas också
  // — det testet handlar bara om att de TVÅ SPÄRRADE aldrig blir det, oavsett resten av poolen.
  const spärradeSkäl = spärrat.groupsSkipped.filter((s) => s.id === "555" || s.id === "666");
  assert.deepEqual(spärradeSkäl.map((s) => s.id).sort(), ["555", "666"], "båda spärrade grupperna syns bland de bortvalda");
  assert.ok(spärradeSkäl.every((s) => /olöst manuell åtgärd/.test(s.reason)), spärradeSkäl.map((s) => s.reason).join(" | "));
  assert.equal(await store.getGroupPublication(loopaId, "555"), null, "den spärrade gruppen fick ingen post");
  assert.equal(await store.getGroupPublication(loopaId, "666"), null);

  // Löser en människa åtgärderna (t.ex. efter att ha bekräftat att de gamla annonserna faktiskt gick ut) —
  // grupperna väljs igen, för en möbel som aldrig var inblandad i den gamla historien.
  await store.resolveManualAction(a1.id, "test: bekräftat för hand");
  await store.resolveManualAction(a2.id, "test: bekräftat för hand");
  await enqueueForListing(loopaId, job.id);
  assert.ok(await store.getGroupPublication(loopaId, "555"), "sedan åtgärden lösts köas gruppen");
  assert.ok(await store.getGroupPublication(loopaId, "666"));

  // Städa: en QUEUED post som blir kvar plockas annars upp av ett senare, obesläktat processQueue-varv.
  for (const p of await store.groupPublicationsFor(loopaId)) {
    await store.updateGroupPublication(loopaId, p.groupId, (c) => ({ ...c, status: "FAILED" }));
  }
});

// Samma LP-2FJW-W00Y-fynd, sett från panelen: `groups`/`groupsTotal` är tomma (ingenting köades), och
// innan den här ändringen fanns INGENSTANS att se att urvalet faktiskt övervägt och bortvalt en grupp.
test("panelens listingChannelStatus visar VARFÖR noll grupper valdes — inte bara att det blev noll", async () => {
  const { listingChannelStatus } = await import("../server/src/integrations/facebook/admin.js");
  await medlemsgrupp("777", "Ännu en blockerad grupp Stockholm");
  await store.writeSettings({ maxGroupsPerListing: 50 }, "test");
  const action = await store.recordManualAction({ kind: "OTHER", reason: "Olöst.", url: null, screenshot: null, lastCompletedStep: null, context: { worker: "group-post", listingId: "LP-ANNAN-0001", groupId: "777" } });
  const job = skrivJobb(JOBS, { id: "88888888-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });

  const status = await listingChannelStatus(loopaId);
  assert.equal(status.groupsTotal, 0, "inga persisterade grupp-poster — annonsen har aldrig köats");
  assert.ok(status.groupSelection, "urvalet räknas om live, även utan en enda persisterad post");
  assert.ok(!status.groupSelection!.selected.some((s) => s.id === "777"), "den spärrade gruppen är inte bland de valda");
  const skäl777 = status.groupSelection!.skipped.find((s) => s.id === "777");
  assert.ok(skäl777, "den spärrade gruppen syns bland de bortvalda, inte bara osynlig");
  assert.match(skäl777!.reason, /olöst manuell åtgärd/);

  await store.resolveManualAction(action.id, "test");
  const efter = await listingChannelStatus(loopaId);
  assert.ok(efter.groupSelection!.selected.some((s) => s.id === "777"), "sedan åtgärden lösts väljs gruppen igen, utan att något köats om för hand");
  await store.writeSettings({ maxGroupsPerListing: null }, "test");
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
    assert.equal(fält.title, "Sweef Cloud 3-sits soffa i grå sammet", "annonsrubriken, samma som Tradera och Blocket");
    assert.equal(fält.price, "6500");
    assert.equal(fält.category, "Möbler");
    assert.equal(fält.condition, "Använd – i gott skick");
    assert.match(fält.description, /https:\/\/loopa\.nu\/butik\/objekt\//);
    assert.equal(attrapp.lage.marketplace[0].files.length, 2);

    const gp = await store.getGroupPublication(loopaId, "111");
    assert.equal(gp?.status, "PUBLISHED", JSON.stringify(gp?.steps.slice(-5)));
    assert.match(gp?.facebookPostUrl ?? "", /\/groups\/111\/posts\/9999/);
    assert.equal(attrapp.lage.posts.length, 1);
    assert.ok(attrapp.lage.posts[0].text.startsWith("Sweef Cloud 3-sits soffa i grå sammet säljes"), attrapp.lage.posts[0].text.slice(0, 80));
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

// ─── regression: LP-2FJW-W00Y, 2026-09-26 ──────────────────────────────────
//
// Publicera trycktes, annonsen skapades — men gick i Facebooks granskning direkt, och varken sidan
// efter klicket eller "Dina annonser" länkade till /marketplace/item/<id>/ än, bara till
// /commerce/listing/<id>/ (samma mönster grupp-säljinlägget redan hade lärt sig, se
// facebook-saljinlagg.test.ts). Innan fixen i marketplace.ts gav det NEEDS_MANUAL_ACTION trots en
// lyckad skrivning.
test("skarpt läge: en annons som går i granskning direkt hittas ändå via /commerce/listing/ (LP-2FJW-W00Y)", async () => {
  const attrapp = await startaFbAttrapp({ marketplaceUnderReview: true });
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS, { id: "ffffffff-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  await store.enqueueMarketplace(loopaId, job.id, false);
  try {
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "PUBLISHED", JSON.stringify(mp?.steps.slice(-6)));
    assert.equal(mp?.phase, "verified", "adressen hittades — ingen NEEDS_MANUAL_ACTION för en lyckad skrivning");
    assert.match(mp?.facebookUrl ?? "", /\/commerce\/listing\/6543\/$/, "länken under granskning, inte /marketplace/item/");
    assert.equal(mp?.facebookListingId, "6543", "id:t läses ur commerce/listing-adressen också");
    assert.equal(mp?.moderation, "FACEBOOK_REVIEW");
    assert.equal(attrapp.lage.marketplace.length, 1, "skrivningen skedde en gång");

    const igen = await processQueue({ max: 5 });
    assert.deepEqual(igen.marketplace, [], "redan PUBLISHED — inget nytt varv");
    assert.equal(attrapp.lage.marketplace.length, 1, "aldrig två annonser");
  } finally {
    process.env.FACEBOOK_DRY_RUN = "true";
    await attrapp.stang();
  }
});

// ─── regression: Mio, Jysk, Piranha, 2026-09-29–10-04 ───────────────────────
//
// Alla tre Marketplace-annonser servern publicerade låg ute, men hamnade i "kontrollera för hand":
// korten i "Dina inlägg" bär ingen länk, och adressen syns först när kortet öppnas.
test("skarpt läge: adressen hittas genom att öppna det nyaste Marketplace-kortet med vår rubrik", async () => {
  const attrapp = await startaFbAttrapp({ marketplaceCardsOnly: true });
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  process.env.FACEBOOK_DRY_RUN = "false";
  const job = skrivJobb(JOBS, { id: "eeeeeeee-2222-4333-8444-555555555555" });
  const loopaId = loopaIdFor(job.id);
  await butik.ensureRecord(loopaId, job.id, "loopa", new Date().toISOString());
  await butik.publish(loopaId, { kind: "admin", userId: "a" });
  await store.enqueueMarketplace(loopaId, job.id, false);
  try {
    const r = await processQueue({ max: 5 });
    assert.equal(r.stoppedBy, null, r.stoppedBy ?? "");
    const mp = await store.getMarketplace(loopaId);
    assert.equal(mp?.status, "PUBLISHED", JSON.stringify(mp?.steps.slice(-6)));
    assert.equal(mp?.phase, "verified");
    assert.match(mp?.facebookUrl ?? "", /\/marketplace\/item\/4242\/$/, "Marketplace-kortet, inte gruppkortet (9999) eller den äldre annonsen (1111)");
    assert.equal(mp?.facebookListingId, "4242");
    assert.equal(attrapp.lage.marketplace.length, 1);
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
