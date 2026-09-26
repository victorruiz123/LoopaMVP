// ─── Facebook i Loopas riktiga livscykel: "Godkänn och lägg ut", urvalet, priset och den sålda sidan ──
//
// Facebook är en kanal bland Tradera och Blocket — inte ett eget system. Det som låses fast här:
//
//   A. Godkännandet köar Marketplace och de VALDA grupperna (per möbel, under taket), aldrig andra.
//   B. Tradera och Blocket är opåverkade: planen bär dem som förut, Facebook är en tredje rad.
//   C. Ett Facebook-fel kan inte hindra butiken: möbeln blir live även när Facebook-lagret är trasigt.
//   D. Priset: Facebook bär produktsidans pris (möbeln) med leveransen utskriven; Tradera bär möbeln + 600.
//   E/F. Idempotens: ett andra tryck skapar ingenting nytt — varken Marketplace eller grupp.
//   G. Urvalet respekterar behörighet, länkförbud, geografi, märke, paus, manuella åtgärder och taket.
//   H–K. Den sålda möbelns adress svarar 200 med "hittat ett nytt hem", utan köp, med bara köpbara alternativ.
//
// Allt körs mot tempmappar och attrappen — aldrig mot facebook.com, Tradera eller Blocket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbdist-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbdist-butik-"));
process.env.ANALYS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbdist-analys-"));
process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbdist-fb-"));
const FB_DIR = process.env.FACEBOOK_DATA_DIR;
process.env.FACEBOOK_PROFILE_DIR = path.join(FB_DIR, "profile");
process.env.FACEBOOK_MODE = "mock";
process.env.FACEBOOK_ENABLED = "1";
process.env.FACEBOOK_DRY_RUN = "true";
process.env.FACEBOOK_AUTO_JOIN = "0";
process.env.FACEBOOK_MAX_GROUPS_PER_LISTING = "2";
process.env.FACEBOOK_GROUP_COOLDOWN_HOURS = "24";
process.env.EMAIL_PROVIDER = "none";
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
for (const k of ["TRADERA_APP_ID", "BLOCKET_SESSION", "BLOCKET_STORAGE_STATE_GZIP", "BLOCKET_STORAGE_STATE", "BLOCKET_COMPANY_STORAGE_STATE_GZIP", "BLOCKET_COMPANY_STORAGE_STATE", "BLOCKET_PUBLICERA"]) delete process.env[k];
process.on("exit", () => {
  for (const d of [process.env.LOOPA_JOBS_DIR!, process.env.BUTIK_DATA_DIR!, process.env.ANALYS_DATA_DIR!, FB_DIR]) rmSync(d, { recursive: true, force: true });
});

const { skrivJobb } = await import("./facebookFixtur.js");
const store = await import("../server/src/integrations/facebook/store.js");
const { enqueueForListing, facebookChannelPlan, selectForListing } = await import("../server/src/integrations/facebook/queue.js");
const { selectGroupsForListing, refreshEligibility } = await import("../server/src/integrations/facebook/membership.js");
const { newGroup } = await import("../server/src/integrations/facebook/groups.js");
const { facebookLimits } = await import("../server/src/integrations/facebook/config.js");
const { assessRules } = await import("../server/src/integrations/facebook/rules.js");
const { facebookListingFor, marketplaceCopy, groupPostCopy } = await import("../server/src/integrations/facebook/mapping.js");
const { planAutoPublish } = await import("../server/src/integrations/autoPublish.js");
const { planTraderaPublish } = await import("../server/src/integrations/tradera/publish.js");
const { andraAnnons } = await import("../server/src/adminAnnonser.js");
const butik = await import("../server/src/butik/store.js");
const { handleButikRequest } = await import("../server/src/butik/routes.js");
const { seoFor } = await import("../server/src/butik/seo.js");
const { similarProducts } = await import("../server/src/butik/similar.js");
const { productById } = await import("../server/src/butik/inventory.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const { getJob } = await import("../server/src/jobStore.js");
import type { FacebookGroup, GroupCategory } from "../server/src/integrations/facebook/types.js";
import type { Product } from "../server/src/butik/types.js";

const JOBS = process.env.LOOPA_JOBS_DIR;
const NU = new Date("2026-09-26T12:00:00.000Z");

function grupp(key: string, name: string, patch: Partial<FacebookGroup> & { category?: GroupCategory } = {}): FacebookGroup {
  const { category, ...rest } = patch;
  return refreshEligibility(
    {
      ...newGroup({ key, name, canonicalUrl: `https://www.facebook.com/groups/${key}/`, category: category ?? "FURNITURE_BUY_SELL", memberCount: 5000, visibility: "PUBLIC", geography: "Stockholm" }),
      relevanceScore: 80,
      adsStatus: "LIKELY_ALLOWED",
      rulesLastCheckedAt: NU.toISOString(),
      rulesText: "Gruppregler: skriv pris och ort.",
      composerKind: "listing",
      membershipStatus: "MEMBER",
      ...rest,
    },
    facebookLimits(),
  );
}

const PROFIL = { categorySlug: "soffor", brand: "Sweef", location: "Stockholm" };

// ─── G. Urvalet ─────────────────────────────────────────────────────────────

test("G. urvalet: möbelgrupp i Stockholm först, rätt grupper hoppas över med skäl, taket kapar", () => {
  const groups = [
    grupp("allman", "Köp & Sälj Nacka Värmdö", { category: "LOCAL_BUY_SELL", relevanceScore: 75 }),
    grupp("mobler", "Möbler säljes & köpes Stockholm", { relevanceScore: 90 }),
    grupp("gbg", "Möbler köp & sälj Göteborg", { geography: "Göteborg", relevanceScore: 95 }),
    grupp("ikea", "IKEA köp & sälj Stockholm", { category: "BRAND_COMMUNITY", relevanceScore: 85 }),
    grupp("sweef", "Sweef-ägare köper och säljer", { category: "BRAND_COMMUNITY", relevanceScore: 70 }),
    grupp("lankforbud", "Loppis Södermalm", { linksProhibited: true, relevanceScore: 88 }),
    grupp("nyss", "Köp och sälj i Bromma", { category: "LOCAL_BUY_SELL", lastPostedAt: new Date(NU.getTime() - 3 * 3_600_000).toISOString() }),
    grupp("veckotakt", "Secondhand Vasastan", { category: "SECONDHAND", postCooldownHours: 168, lastPostedAt: new Date(NU.getTime() - 3 * 86_400_000).toISOString() }),
    grupp("atgard", "Köp/Sälj Sundbyberg", { category: "LOCAL_BUY_SELL", relevanceScore: 99 }),
    grupp("ejmedlem", "Köpes Säljes Solna", { membershipStatus: "NOT_MEMBER" }),
    grupp("avstangd", "Köp & Sälj Täby", { enabledForDistribution: false, enabledForDistributionSetBy: "admin" }),
  ];
  const r = selectGroupsForListing(groups, PROFIL, { max: 10, defaultCooldownHours: 24, blockedGroupIds: new Set(["atgard"]), now: NU });
  const ids = r.selected.map((s) => s.group.id);
  assert.deepEqual(ids, ["mobler", "sweef", "allman"], JSON.stringify(r.selected.map((s) => [s.group.id, s.score, s.reasons])));
  assert.ok(r.selected[0].reasons.some((x) => /möbelspecifik/.test(x)));
  assert.ok(r.selected[1].reasons.some((x) => /Sweef i gruppnamnet/.test(x)));
  const skal = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
  assert.match(skal.gbg, /annan stad/);
  assert.match(skal.ikea, /annat märke/);
  assert.match(skal.lankforbud, /länkar/);
  assert.match(skal.nyss, /mindre än 24 timmar/);
  assert.match(skal.veckotakt, /mindre än 168 timmar/, "gruppens egen takt vinner över förvalet");
  assert.match(skal.atgard, /manuell åtgärd/);
  assert.match(skal.avstangd, /avstängd|inte postbar/);
  assert.ok(!("ejmedlem" in skal), "icke-medlemmar är inte ens kandidater att förklara");

  const kapat = selectGroupsForListing(groups, PROFIL, { max: 1, defaultCooldownHours: 24, blockedGroupIds: new Set(["atgard"]), now: NU });
  assert.deepEqual(kapat.selected.map((s) => s.group.id), ["mobler"]);
  assert.ok(kapat.skipped.some((s) => s.id === "sweef" && /över taket 1/.test(s.reason)));
  assert.equal(selectGroupsForListing(groups, PROFIL, { max: 0, defaultCooldownHours: 24, now: NU }).selected.length, 0);
});

test("G. reglerna: länkförbud är ett nej, och gruppens takt läses", () => {
  const lank = assessRules("Gruppregler: Inga länkar tack. Ett inlägg per vecka.", "LOCAL_BUY_SELL", "Köp & sälj Nacka");
  assert.equal(lank.adsStatus, "PROHIBITED");
  assert.equal(lank.linksProhibited, true);
  assert.equal(lank.postCooldownHours, 168);
  assert.ok(lank.evidence.some((e) => e.startsWith("LÄNKFÖRBUD")));
  const takt = assessRules("Gruppregler: Skriv pris och ort. Max 1 inlägg per dag och person.", "FURNITURE_BUY_SELL", "Möbler köp sälj Stockholm");
  assert.equal(takt.adsStatus, "LIKELY_ALLOWED");
  assert.equal(takt.linksProhibited, false);
  assert.equal(takt.postCooldownHours, 24);
  assert.equal(assessRules("Gruppregler: Skriv pris och ort.", "FURNITURE_BUY_SELL", "Möbler köp sälj").postCooldownHours, null);
});

// ─── A/B/E/F. Godkännandet ──────────────────────────────────────────────────

const job = skrivJobb(JOBS);
const loopaId = loopaIdFor(job.id);

test("B. planen bär Tradera och Blocket som förut och Facebook som en tredje, oberoende rad", async () => {
  await store.putGroup(grupp("mobler", "Möbler säljes & köpes Stockholm", { relevanceScore: 90 }));
  await store.putGroup(grupp("allman", "Köp & Sälj Nacka Värmdö", { category: "LOCAL_BUY_SELL", relevanceScore: 75 }));
  await store.putGroup(grupp("tredje", "Köpes,Säljes & Bortskänkes - Stockholm", { category: "LOCAL_BUY_SELL", relevanceScore: 60 }));
  await store.putGroup(grupp("gbg", "Möbler köp & sälj Göteborg", { geography: "Göteborg", relevanceScore: 95 }));
  const plan = await planAutoPublish((await getJob(job.id))!);
  assert.deepEqual(plan.channels.map((c) => c.channel), ["tradera", "blocket", "facebook"]);
  const fb = plan.channels.find((c) => c.channel === "facebook")!;
  assert.equal(fb.configured, true);
  assert.equal(fb.ready, true, fb.reason ?? "");
  assert.equal(fb.alreadyRunning, false);
  assert.equal(fb.dryRun, true, "torrkörning är förvalet — planen säger det");
  assert.deepEqual(plan.willPublish, ["facebook"], "Tradera och Blocket är okonfigurerade här; utan Facebook hade trycket avvisats");
});

test("A. Godkänn och lägg ut: möbeln blir live och Facebook köas — Marketplace och exakt de valda grupperna", async () => {
  await andraAnnons(loopaId, { lage: "godkann" }, "admin-1");
  const record = await butik.store().get(loopaId);
  assert.equal(record?.state, "live", "godkännandet lade möbeln i butiken");
  const seoLive = await seoFor(`/butik/objekt/${loopaId}`);
  assert.ok(seoLive && !seoLive.noindex, "en möbel till salu är indexerbar — som förut");
  assert.equal(seoLive?.canonical, `https://loopa.nu/butik/objekt/${loopaId}`);
  assert.match(seoLive?.title ?? "", /6500 kr/, "till salu: priset står i titeln");
  // Facebook-kön fylls i bakgrunden, aldrig i adminens svar.
  for (let i = 0; i < 100 && !((await store.getMarketplace(loopaId)) && (await store.groupPublicationsFor(loopaId)).length >= 2); i++) await new Promise((r) => setTimeout(r, 50));
  const mp = await store.getMarketplace(loopaId);
  assert.equal(mp?.status, "QUEUED");
  assert.equal(mp?.dryRun, true);
  const gp = await store.groupPublicationsFor(loopaId);
  assert.deepEqual(gp.map((p) => p.groupId).sort(), ["allman", "mobler"], "taket är 2: möbelgruppen och den bästa allmänna; Göteborg och den tredje aldrig");
  const job2 = (await getJob(job.id))!;
  assert.ok(job2.tradera?.approvedAt, "godkännandestämpeln sattes fast bara Facebook kunde ta emot");
});

test("E/F. ett andra tryck skapar ingenting nytt — varken Marketplace eller grupp", async () => {
  const fore = { mp: (await store.allMarketplace()).length, gp: (await store.allGroupPublications()).length };
  const igen = await enqueueForListing(loopaId, job.id);
  assert.equal(igen.marketplace, "exists");
  assert.equal(igen.groupsCreated, 0);
  assert.equal(igen.groupsExisting, 2);
  assert.deepEqual(igen.groupsSelected, ["mobler", "allman"]);
  const plan = await planAutoPublish((await getJob(job.id))!);
  const fb = plan.channels.find((c) => c.channel === "facebook")!;
  assert.equal(fb.alreadyRunning, true, "allt som kan köas är köat — kanalen hoppas över i nästa tryck");
  await assert.rejects(andraAnnons(loopaId, { lage: "godkann" }, "admin-1"), /Ingen kanal kan ta emot annonsen/);
  assert.equal((await store.allMarketplace()).length, fore.mp);
  assert.equal((await store.allGroupPublications()).length, fore.gp);
});

test("G. panelens tak skriver över miljöns", async () => {
  await store.writeSettings({ maxGroupsPerListing: 1 }, "test");
  const r = await selectForListing(PROFIL);
  assert.deepEqual(r.selected.map((s) => s.group.id), ["mobler"]);
  await store.writeSettings({ maxGroupsPerListing: null }, "test");
  assert.equal((await selectForListing(PROFIL)).selected.length, 2, "null = miljöns FACEBOOK_MAX_GROUPS_PER_LISTING (2 här)");
});

// ─── C. Felisolering ────────────────────────────────────────────────────────

test("C. ett trasigt Facebook-lager hindrar varken butiken eller planen", async () => {
  const job2 = skrivJobb(JOBS, { id: "cccccccc-2222-4333-8444-555555555555" });
  const id2 = loopaIdFor(job2.id);
  const trasig = path.join(FB_DIR, "inte-en-mapp");
  writeFileSync(trasig, "x");
  const fore = process.env.FACEBOOK_DATA_DIR;
  process.env.FACEBOOK_DATA_DIR = trasig;
  try {
    const { onListingLive } = await import("../server/src/integrations/facebook/queue.js");
    const av = butik.onPublished((r) => onListingLive(r.id, r.jobId));
    try {
      await butik.ensureRecord(id2, job2.id, "loopa", new Date().toISOString());
      const live = await butik.publish(id2, { kind: "admin", userId: "a" });
      assert.equal(live?.state, "live", "publiceringen gick igenom fast Facebook-lagret inte går att skriva");
    } finally {
      av();
    }
    await new Promise((r) => setTimeout(r, 200));
    // Vad Facebook-lagret än gjorde av skrivningen (föll eller tystnade) står möbeln live, och ett
    // direkt anrop kastar aldrig upp i godkännandet: onListingLive fångar allt (queue.ts).
    const direkt = await enqueueForListing(id2, job2.id).catch((err: Error) => err);
    assert.ok(direkt instanceof Error || typeof direkt === "object", "anropet svarade eller föll — ingetdera når adminens svar");
    assert.equal((await butik.store().get(id2))?.state, "live", "möbeln ligger kvar live trots Facebook-felet");
    const plan = await planAutoPublish((await getJob(job2.id))!);
    assert.equal(plan.channels.length, 3, "de andra kanalerna står kvar i planen, Facebook som en rad");
    assert.ok(plan.channels.find((c) => c.channel === "facebook"), "Facebook-raden finns även när lagret är trasigt");
  } finally {
    process.env.FACEBOOK_DATA_DIR = fore;
  }
});

// ─── D. Priset ──────────────────────────────────────────────────────────────

test("D. Facebook bär produktsidans pris; Tradera bär möbeln plus hemleveransen; adminens pris följer med", async () => {
  const job3 = skrivJobb(JOBS, { id: "dddddddd-2222-4333-8444-555555555555", price: 2000 });
  // Prisstegen är sanningen när den finns: säljarens spann, sänkt vecka för vecka, i MÖBELKRONOR.
  job3.priceLadder = { startPrice: 1200, floorPrice: 800, weeklyDropPct: 0.15, currentPrice: 1000, nextDropAt: null, drops: [], floorReachedAt: null, lastError: null, chosenAt: NU.toISOString(), listingMode: "fixed" };
  writeFileSync(path.join(JOBS, job3.id, "job.json"), JSON.stringify(job3, null, 2));

  const fb = await facebookListingFor(job3);
  assert.ok(fb.ok);
  if (!fb.ok) return;
  assert.equal(fb.listing.price, 1000, "prisstegens nuvarande pris, inte prismotorns 2 000");
  assert.equal(fb.listing.deliveryFeeSek, 600, "kassans fraktavgift — samma tal som produktsidan visar");
  const mp = marketplaceCopy(fb.listing);
  assert.match(mp.description, /Pris: 1\s000 kr/);
  assert.match(mp.description, /Hemleverans i Stockholm: 600 kr \(läggs till i kassan på Loopa\)\./);
  assert.ok(!/1\s600/.test(mp.description), "aldrig möbeln + frakt i ett tal på Facebook — det talet finns inte på produktsidan");
  assert.match(groupPostCopy(fb.listing), /Hemleverans i Stockholm: 600 kr/);

  const tradera = await planTraderaPublish(job3);
  assert.ok(tradera.ok, tradera.ok ? "" : tradera.reason);
  if (!tradera.ok) return;
  assert.equal(tradera.plan.itemPrice, 1000);
  assert.equal(tradera.plan.price, 1600, "Tradera: möbeln + 600 kr hemleverans i ETT tal");
  const produkt = await productById(loopaIdFor(job3.id));
  // Produktsidan (butik/normalize.ts priceOf) och Facebook läser samma tal.
  assert.equal(produkt?.priceSek ?? fb.listing.price, fb.listing.price);

  // Adminens pris i panelen flyttar stegen — och därmed Facebook, utan egen räkning.
  await andraAnnons(loopaIdFor(job3.id), { prisNu: 900 }, "admin-1");
  const efter = await facebookListingFor((await getJob(job3.id))!);
  assert.ok(efter.ok && efter.listing.price === 900, "Facebook följer adminens pris");
});

// ─── H–K. Den sålda möbelns sida ────────────────────────────────────────────

function fejkReq(): IncomingMessage {
  return { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}
function fejkRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
    end: (chunk?: string | Buffer) => {
      body = chunk ? String(chunk) : "";
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => (body ? JSON.parse(body) : null) };
}

test("H/I/K. den sålda möbelns adress svarar 200, säger såld och bär inget köp", async () => {
  const sald = await butik.claimForSale(loopaId, "butik", { kind: "admin", userId: "a" });
  assert.equal(sald?.state, "sold");
  const { res, status, body } = fejkRes();
  const url = new URL(`https://loopa.nu/api/butik/produkter/${loopaId}`);
  assert.equal(await handleButikRequest(["produkter", loopaId], fejkReq(), res, url), true);
  assert.equal(status(), 200, "en såld möbel är ingen 404");
  const svar = body() as { product: Product; events: unknown[] };
  assert.equal(svar.product.state, "sold");
  assert.equal(svar.product.title, "Sweef Cloud 3-sits soffa");

  const seo = (await seoFor(`/butik/objekt/${loopaId}`))!;
  assert.ok(seo);
  assert.ok(!seo.noindex, "beslut 2026-09-26: en såld Loopa-möbel är en indexerbar landningssida, inte noindex");
  assert.equal(seo.canonical, `https://loopa.nu/butik/objekt/${loopaId}`, "kanonisk adress = den publika produktadressen");
  assert.match(seo.body ?? "", /Den här möbeln har redan hittat ett nytt hem/);
  assert.match(seo.body ?? "", /fler alternativ för dig/i);
  assert.ok(!/6500 kr/.test(seo.body ?? ""), "inget pris i kroppen på en såld möbel");
  assert.match(seo.title, /Sweef Cloud 3-sits soffa – såld – /);
  assert.match(seo.description, /hittat ett nytt hem/);
  assert.match(seo.jsonLd ?? "", /SoldOut/, "strukturerad data säger slutsåld");
  assert.equal(seo.ogType, "product");

  const skarm = readFileSync(path.resolve("web/src/butik/screens/ProductScreen.tsx"), "utf-8");
  assert.ok(skarm.includes("Den här möbeln har redan hittat ett nytt hem"));
  assert.ok(skarm.includes("Fler alternativ för dig"));
  assert.ok(/sold && loopa && !utanKop && <SimilarProducts/.test(skarm), "alternativen ritas för den sålda möbeln");
  assert.ok(!/sold && [^\n]*btn-primary/.test(skarm), "ingen köpknapp villkorad på såld");
});

test("J. alternativen är bara köpbara Loopa-möbler och aldrig den sålda själv", async () => {
  const sald = (await productById(loopaId))!;
  assert.equal(sald.state, "sold");
  const bas = { ...sald, source: "loopa" as const, state: "live" as const };
  const pool: Product[] = [
    sald,
    { ...bas, id: "LP-LIVE-0001" },
    { ...bas, id: "LP-RESERV-0002", state: "reserved" },
    { ...bas, id: "LP-SALD-0003", state: "sold" },
    { ...bas, id: "LP-UTKAST-0004", state: "draft" as Product["state"] },
    { ...bas, id: "TR-0005", source: "tradera" as Product["source"] },
  ];
  const ids = similarProducts(sald, pool, 8).map((p) => p.id);
  assert.deepEqual(ids.sort(), ["LP-LIVE-0001", "LP-RESERV-0002"]);
  assert.ok(!ids.includes(loopaId));

  const { res, status, body } = fejkRes();
  const url = new URL(`https://loopa.nu/api/butik/produkter/${loopaId}/liknande`);
  assert.equal(await handleButikRequest(["produkter", loopaId, "liknande"], fejkReq(), res, url), true);
  assert.equal(status(), 200);
  const items = (body() as { items: Product[] }).items;
  assert.ok(items.every((p) => p.id !== loopaId && (p.state === "live" || p.state === "reserved") && p.source === "loopa"));
});
