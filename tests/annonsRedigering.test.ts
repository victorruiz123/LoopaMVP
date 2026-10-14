// ─── Redigeringsrobotarna mot attrapperna ────────────────────────────────────
//
// En annons som ligger ute ändras — rubrik, text, mått, pris — och robotarna ska föra ut ändringen.
// Körs mot attrapperna (tests/blocketAttrapp.ts, tests/facebookAttrapp.ts) med Spara PÅ: det enda
// sättet att se att rätt sak skickas. Det som låses fast:
//
// RÄTT SAK I RÄTT FÄLT. Blocket får rubrik, beskrivning och mått; Facebook rubrik, pris och text.
// RUBRIKVAKTEN. En annan annons i formuläret rörs inte.
// BARA DET SOM ÄNDRATS. Står det redan så öppnas ingen webbläsare och ingenting sparas.
// SÄLJINLÄGG ÄR MARKETPLACE-ANNONSER. Delar ett gruppinlägg id med Marketplace ändras annonsen en gång.
// RÄTT KANALER. Ett nytt pris går bara till Facebook; Tradera läggs inte om när texten där är densamma.
// FEL FÖRSÖKS IGEN — en bit. Sedan står felet kvar för admin.
//
// VAD TESTERNA INTE BEVISAR: att Facebooks redigeringssida och inläggsmeny ser ut som attrappen. Det
// avgör en torrkörning på servern (npm run annons:visa).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-redigering-"));
const JOBS = path.join(rot, "jobs");
process.env.LOOPA_JOBS_DIR = JOBS;
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.BLOCKET_DATA_DIR = path.join(rot, "blocket");
process.env.FACEBOOK_DATA_DIR = path.join(rot, "facebook");
process.env.FACEBOOK_PROFILE_DIR = path.join(rot, "facebook", "profile");
process.env.FACEBOOK_MODE = "mock";
process.env.FACEBOOK_ENABLED = "1";
process.env.FACEBOOK_MIN_SECONDS_BETWEEN_WRITES = "0";
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
process.env.ANNONS_UPPDATERING = "1";
process.env.ANNONS_UPPDATERING_OMFORSOK_MS = String(24 * 3600_000); // omförsöken körs för hand nedan
const SESSION = path.join(rot, "blocket-session.json");
writeFileSync(SESSION, JSON.stringify({ cookies: [], origins: [] }));
process.env.BLOCKET_SESSION = SESSION;
for (const k of ["TRADERA_APP_ID", "TRADERA_APP_KEY", "TRADERA_USER_ID", "TRADERA_USER_TOKEN", "BLOCKET_STORAGE_STATE_GZIP", "BLOCKET_STORAGE_STATE"]) delete process.env[k];
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { startaAttrapp } = await import("./blocketAttrapp.js");
const { startaFbAttrapp } = await import("./facebookAttrapp.js");
const { skrivJobb } = await import("./facebookFixtur.js");
const { getJob, persist } = await import("../server/src/jobStore.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const overrides = await import("../server/src/butik/overrides.js");
const { blocketInnehall, buildBlocketDescription, planBlocketPublish } = await import("../server/src/integrations/blocket/publish.js");
const { redigeraBlocketAnnons } = await import("../server/src/integrations/blocket/redigera.js");
const { annonsIdUrAdress, redigeraFacebook, rubrikenArVar } = await import("../server/src/integrations/facebook/redigera.js");
const { facebookListingFor, groupListingSnapshot, groupSnapshot, marketplaceSnapshot } = await import("../server/src/integrations/facebook/mapping.js");
const store = await import("../server/src/integrations/facebook/store.js");
const { korAnnonsUppdatering, schemalaggAnnonsUppdatering, MAX_FORSOK } = await import("../server/src/integrations/annonsUppdatering.js");
const { planTraderaPublish, traderaAdBlocks } = await import("../server/src/integrations/tradera/publish.js");
import type { ConditionJob } from "../server/src/types.js";

const NY_MENING = "Liten repa på ena armstödet, syns på bild 2.";
let lopnr = 0;

/** Ett nytt, färdigt jobb med eget id. Lagret cachar jobb, så varje test får sitt. */
async function nyttJobb(): Promise<ConditionJob> {
  lopnr += 1;
  const id = `11111111-2222-4333-8444-${String(lopnr).padStart(12, "0")}`;
  skrivJobb(JOBS, { id });
  const job = (await getJob(id))!;
  job.sellerPostalCode = "11122";
  await persist(job);
  return job;
}

/** Säljarens rättelse: en mening till i beskrivningen, som den riktiga vägen (rättelselagret). */
async function rattaBeskrivningen(job: ConditionJob): Promise<void> {
  const text = job.result!.listing!.result!.listing.description;
  await overrides.satt(loopaIdFor(job.id), { description: `${text} ${NY_MENING}` }, "test");
}

// ── Blocket ──────────────────────────────────────────────────────────────────

async function blocketUppe(job: ConditionJob, rubrikPaBlocket?: string) {
  const plan = await planBlocketPublish(job);
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  const fore = blocketInnehall(plan.plan, buildBlocketDescription(await overrides.medRattelser(job), plan.plan.shippingSek));
  const attrapp = await startaAttrapp({
    annonser: [{ id: "24720589", rubrik: rubrikPaBlocket ?? fore.rubrik, pris: 6500, beskrivning: fore.beskrivning, matt: { hojd: 82, bredd: 230, djup: 98 } }],
  });
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  job.blocket = {
    status: "published",
    url: `${attrapp.bas}/24720589`,
    receiptUrl: null,
    dryRun: false,
    error: null,
    startedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    steps: [],
    shippingSek: plan.plan.shippingSek,
    innehall: fore,
  };
  await persist(job);
  return attrapp;
}

test("Blocket: rättad beskrivning och rubrik sparas i rätt fält, och ögonblicksbilden följer med", async () => {
  const job = await nyttJobb();
  const attrapp = await blocketUppe(job);
  await rattaBeskrivningen(job);
  await overrides.satt(loopaIdFor(job.id), { title: "Sweef Cloud soffa, grå sammet" }, "test");
  process.env.BLOCKET_REDIGERA = "1";
  try {
    const utfall = await redigeraBlocketAnnons(job);
    assert.equal(utfall.status, "klar", utfall.detalj);
    assert.equal(attrapp.lage.redigeringar.length, 1);
    const sparat = attrapp.lage.redigeringar[0];
    assert.ok(sparat.beskrivning?.includes(NY_MENING), "den nya meningen står i beskrivningen");
    assert.equal(sparat.rubrik, "Sweef Cloud soffa, grå sammet");
    assert.equal(sparat.hojd, "82");
    assert.equal(sparat.bredd, "230");
    assert.equal(sparat.djup, "98");
    assert.equal(sparat.pris, "6500", "priset rörs inte — det är prisrobotens");
    assert.ok(job.blocket?.innehall?.beskrivning.includes(NY_MENING));

    // En andra gång: ingenting har ändrats sedan, så ingen webbläsare och inget sparat.
    const igen = await redigeraBlocketAnnons(job);
    assert.equal(igen.status, "oforandrad");
    assert.equal(attrapp.lage.redigeringar.length, 1);
  } finally {
    delete process.env.BLOCKET_REDIGERA;
    await attrapp.stang();
  }
});

test("Blocket: rubrikvakten stoppar en annan annons i formuläret — ingenting sparas", async () => {
  const job = await nyttJobb();
  const attrapp = await blocketUppe(job, "IKEA Ektorp tresits i beige");
  await rattaBeskrivningen(job);
  process.env.BLOCKET_REDIGERA = "1";
  try {
    const utfall = await redigeraBlocketAnnons(job);
    assert.equal(utfall.status, "fel");
    assert.match(utfall.detalj, /annan annons/);
    assert.deepEqual(attrapp.lage.redigeringar, []);
  } finally {
    delete process.env.BLOCKET_REDIGERA;
    await attrapp.stang();
  }
});

test("Blocket utan Spara-brytaren: allt ifyllt, ingenting sparat", async () => {
  const job = await nyttJobb();
  const attrapp = await blocketUppe(job);
  await rattaBeskrivningen(job);
  try {
    const utfall = await redigeraBlocketAnnons(job);
    assert.equal(utfall.status, "torrkord", utfall.detalj);
    assert.deepEqual(attrapp.lage.redigeringar, []);
  } finally {
    await attrapp.stang();
  }
});

// ── Facebook ─────────────────────────────────────────────────────────────────

const INLAGG = "/groups/444/posts/9001/";

/** Marketplace-annons 111, ett säljinlägg i grupp 555 som ÄR samma annons, och ett textinlägg i 444. */
async function facebookUppe(job: ConditionJob) {
  const redo = await facebookListingFor(job);
  assert.ok(redo.ok, redo.ok ? "" : redo.reason);
  const l = redo.listing;
  const mpFore = marketplaceSnapshot(l, "Möbler");
  const textFore = groupSnapshot(l);
  const attrapp = await startaFbAttrapp({
    redigerbart: { marketplace: { "111": { title: mpFore.title, description: mpFore.description, price: mpFore.price } }, inlagg: { [INLAGG]: textFore.text } },
  });
  process.env.FACEBOOK_BASE_URL = attrapp.bas;
  const id = l.loopaId;
  await store.enqueueMarketplace(id, job.id, false);
  await store.updateMarketplace(id, (p) => ({ ...p, status: "PUBLISHED", facebookListingId: "111", facebookUrl: `${attrapp.bas}/marketplace/item/111/`, contentSnapshot: mpFore }));
  await store.enqueueGroupPublication(id, "555", job.id, false);
  await store.updateGroupPublication(id, "555", (p) => ({ ...p, status: "PUBLISHED", composer: "listing", facebookPostUrl: `${attrapp.bas}/commerce/listing/111/`, contentSnapshot: groupListingSnapshot(l) }));
  await store.enqueueGroupPublication(id, "444", job.id, false);
  await store.updateGroupPublication(id, "444", (p) => ({ ...p, status: "PUBLISHED", composer: "post", facebookPostUrl: `${attrapp.bas}${INLAGG}`, contentSnapshot: textFore }));
  return attrapp;
}

test("Facebook: ny text till Marketplace och textinlägget; säljinlägget är samma annons och ändras en gång", async () => {
  const job = await nyttJobb();
  const attrapp = await facebookUppe(job);
  await rattaBeskrivningen(job);
  process.env.FACEBOOK_REDIGERA = "1";
  try {
    const utfall = await redigeraFacebook(job);
    assert.equal(utfall.status, "klar", utfall.detalj);
    const annons = attrapp.lage.redigeringar.filter((r) => r.var === "annons 111");
    const text = attrapp.lage.redigeringar.filter((r) => r.var === INLAGG);
    assert.equal(annons.length, 1, "Marketplace-annonsen och säljinlägget är samma annons");
    assert.ok(annons[0].text.includes(NY_MENING));
    assert.equal(annons[0].pris, "6500");
    assert.equal(text.length, 1);
    assert.ok(text[0].text.includes(NY_MENING));
    assert.ok(text[0].text.includes("loopa.nu"), "Loopa-länken står kvar i inlägget");

    const id = loopaIdFor(job.id);
    assert.ok((await store.getMarketplace(id))?.contentSnapshot?.description.includes(NY_MENING));
    assert.ok((await store.getGroupPublication(id, "555"))?.contentSnapshot?.text.includes(NY_MENING));
    assert.ok((await store.getGroupPublication(id, "444"))?.contentSnapshot?.text.includes(NY_MENING));

    const igen = await redigeraFacebook(job);
    assert.equal(igen.status, "oforandrad", igen.detalj);
    assert.equal(attrapp.lage.redigeringar.length, 2);
  } finally {
    delete process.env.FACEBOOK_REDIGERA;
    await attrapp.stang();
  }
});

test("Facebook: en prissänkning når Marketplace-priset och textinläggets första rad", async () => {
  const job = await nyttJobb();
  const attrapp = await facebookUppe(job);
  job.priceLadder = { startPrice: 6500, floorPrice: 4000, weeklyDropPct: 0.1, currentPrice: 5850, nextDropAt: null, drops: [] } as never;
  await persist(job);
  process.env.FACEBOOK_REDIGERA = "1";
  try {
    const utfall = await redigeraFacebook(job);
    assert.equal(utfall.status, "klar", utfall.detalj);
    assert.equal(attrapp.lage.redigeringar.find((r) => r.var === "annons 111")?.pris, "5850");
    assert.match(attrapp.lage.redigeringar.find((r) => r.var === INLAGG)?.text ?? "", /5\s?850/);
  } finally {
    delete process.env.FACEBOOK_REDIGERA;
    await attrapp.stang();
  }
});

test("Facebook: rubrikvakten och id ur adressen", () => {
  assert.equal(rubrikenArVar("Sweef Cloud 3-sits soffa i grå sammet", ["Sweef Cloud 3-sits soffa i grå sammet"]), true);
  assert.equal(rubrikenArVar("Sweef Cloud 3-sits soffa i grå", [null, "Sweef Cloud 3-sits soffa i grå sammet"]), true, "kapad rubrik");
  assert.equal(rubrikenArVar("IKEA Ektorp tresits", ["Sweef Cloud 3-sits soffa"]), false);
  assert.equal(rubrikenArVar("", ["Sweef"]), false);
  assert.equal(annonsIdUrAdress("https://www.facebook.com/commerce/listing/123456/?ref=x"), "123456");
  assert.equal(annonsIdUrAdress("https://www.facebook.com/marketplace/item/987/"), "987");
  assert.equal(annonsIdUrAdress("https://www.facebook.com/groups/1/posts/2/"), null);
});

// ── Styrningen ───────────────────────────────────────────────────────────────

test("ett nytt pris går bara till Facebook; en textändring i samma omgång lägger till de andra", async () => {
  const job = await nyttJobb();
  job.tradera = { ...job.tradera!, status: "published", itemId: 42, url: null };
  await persist(job);
  await schemalaggAnnonsUppdatering(job, 60_000, "pris");
  assert.deepEqual((await getJob(job.id))?.annonsUppdatering?.vantande, ["facebook"]);
  await schemalaggAnnonsUppdatering(job, 60_000, "text");
  assert.deepEqual((await getJob(job.id))?.annonsUppdatering?.vantande, ["tradera", "blocket", "facebook"]);
});

test("Tradera läggs inte om när texten där är densamma", async () => {
  const job = await nyttJobb();
  const plan = await planTraderaPublish(job);
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  const block = traderaAdBlocks(await overrides.medRattelser(job), plan.plan.shippingSek);
  job.tradera = { ...job.tradera!, status: "published", itemId: 42, url: null, adBlocks: block, rubrik: plan.plan.title, shippingSek: plan.plan.shippingSek };
  job.annonsUppdatering = { begard: new Date().toISOString(), status: "vantar", klar: null, kanaler: {}, vantande: ["tradera"] };
  await persist(job);
  await korAnnonsUppdatering(job.id);
  const u = (await getJob(job.id))?.annonsUppdatering;
  assert.equal(u?.kanaler.tradera?.status, "oforandrad", u?.kanaler.tradera?.detalj);
  assert.equal(u?.status, "klar");
});

test(`ett fel försöks igen, högst ${MAX_FORSOK} gånger, och står sedan kvar`, async () => {
  const job = await nyttJobb();
  const attrapp = await blocketUppe(job);
  await attrapp.stang(); // Blocket "ligger nere": varje försök faller
  await rattaBeskrivningen(job);
  job.annonsUppdatering = { begard: new Date().toISOString(), status: "vantar", klar: null, kanaler: {}, vantande: ["blocket"] };
  await persist(job);
  for (let i = 1; i <= MAX_FORSOK; i++) {
    await korAnnonsUppdatering(job.id);
    const u = (await getJob(job.id))!.annonsUppdatering!;
    assert.equal(u.kanaler.blocket?.status, "fel");
    assert.equal(u.forsok?.blocket, i);
    if (i < MAX_FORSOK) assert.deepEqual(u.vantande, ["blocket"], `försök ${i} väntar på ett till`);
    else {
      assert.deepEqual(u.vantande, []);
      assert.equal(u.status, "klar");
      assert.match(u.kanaler.blocket!.detalj, /gav upp/);
    }
  }
});

// ── Adminens provkörning ─────────────────────────────────────────────────────

const { synonymByte, startaProv } = await import("../server/src/integrations/provRedigering.js");

test("synonymbytet: första ordet med en synonym, hela ord, versalen bevarad", () => {
  assert.equal(synonymByte("Rymlig och stabil soffa.")?.text, "Stor och stabil soffa.");
  assert.equal(synonymByte("En fin stol.")?.text, "En snygg stol.");
  assert.equal(synonymByte("Finsk design, fint skick.")?.text, "Finsk design, snyggt skick.", "inte inuti ett annat ord");
  assert.equal(synonymByte("Säljes billigt."), null);
});

test("provet: ett ord byts på Blocket och Facebook, Tradera rörs inte, och ångra lägger tillbaka det", async () => {
  const job = await nyttJobb();
  const blocket = await blocketUppe(job);
  const face = await facebookUppe(job);
  job.tradera = { ...job.tradera!, status: "published", itemId: 42, url: null };
  await persist(job);
  const vanta = async () => {
    for (let i = 0; i < 240 && (await getJob(job.id))?.provRedigering?.status === "pagar"; i++) await new Promise((r) => setTimeout(r, 250));
  };
  try {
    const prov = await startaProv(job, "andra", "admin-1");
    assert.equal(prov.fran, "Rymlig");
    assert.equal(prov.till, "Stor");
    await vanta();
    const efter = (await getJob(job.id))!.provRedigering!;
    assert.equal(efter.kanaler.blocket?.status, "klar", efter.kanaler.blocket?.detalj);
    assert.equal(efter.kanaler.facebook?.status, "klar", efter.kanaler.facebook?.detalj);
    assert.match(blocket.lage.redigeringar.at(-1)?.beskrivning ?? "", /Stor tresitssoffa/);
    assert.match(face.lage.redigeringar.find((r) => r.var === "annons 111")?.text ?? "", /Stor tresitssoffa/);
    assert.equal(job.tradera?.itemId, 42, "Tradera ligger kvar orörd");
    assert.match((await overrides.hamta(loopaIdFor(job.id)))?.description ?? "", /^Stor tresitssoffa/, "ändringen gäller hos Loopa också");

    await startaProv(job, "angra", "admin-1");
    await vanta();
    const angrat = (await getJob(job.id))!.provRedigering!;
    assert.equal(angrat.riktning, "angra");
    assert.equal(angrat.kanaler.blocket?.status, "klar", angrat.kanaler.blocket?.detalj);
    assert.match(blocket.lage.redigeringar.at(-1)?.beskrivning ?? "", /Rymlig tresitssoffa/);
    assert.match(face.lage.redigeringar.filter((r) => r.var === "annons 111").at(-1)?.text ?? "", /Rymlig tresitssoffa/);
    assert.equal((await overrides.hamta(loopaIdFor(job.id)))?.description ?? null, null, "rättelsen är borta igen");
  } finally {
    await blocket.stang();
    await face.stang();
  }
});
