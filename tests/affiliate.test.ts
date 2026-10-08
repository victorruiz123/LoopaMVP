// ─── Affiliate: länken, anspråket, provisionen och den manuella utbetalningen ─────────────────
//
// Regeln: den som värvar en ny användare via sin affiliate-länk får 5 % av försäljningspriset på varje
// annons den användaren säljer, när affären är slutförd (säljarens pengar utbetalda). Testerna låser
// fast att anspråket bara fäster på nya konton och bara en gång, att provisionen kommer då och bara
// då — en per annons, i öre — och att en retur tar bort en provision som inte betalats ut.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Egna datamappar, satta INNAN modulerna läses in.
const rot = mkdtempSync(path.join(tmpdir(), "loopa-affiliate-test-"));
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.REFERRAL_DATA_DIR = path.join(rot, "referral");
process.env.AFFILIATE_DATA_DIR = path.join(rot, "affiliate");
process.env.EMAIL_PROVIDER = "none";
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.REFERRAL_LINK_BASE;
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const regler = await import("../server/src/affiliate/regler.js");
const { affiliateStore } = await import("../server/src/affiliate/store.js");
const { markeraUtbetald } = await import("../server/src/butik/utbetalning.js");
const butik = await import("../server/src/butik/store.js");
const { createJob } = await import("../server/src/jobStore.js");

const { gorAnsprak, profilFor, oversikt, adminOversikt, markeraUtbetalda, provisionOre, affiliateLank, harAnnonser } = regler;

const NU = new Date("2026-10-08T10:00:00Z");
const DAG = 24 * 60 * 60 * 1000;
let n = 0;

function konto(skapadDagarSedan = 0) {
  return { id: randomUUID(), email: `person${n++}@exempel.se`, createdAt: new Date(NU.getTime() - skapadDagarSedan * DAG).toISOString() };
}

/** Affiliate A och en nyregistrerad B som kom via A:s länk. */
async function paret() {
  const a = konto(200);
  const pa = await profilFor(a.id, a.email, NU);
  const b = konto(0);
  assert.equal(await gorAnsprak(b, pa.kod, false, NU), "ok");
  return { a, b, pa };
}

/** En annons i butiken, såld. Utbetalningen görs av testet. */
async function saldMobel(agare: string) {
  const job = await createJob(null, null, agare, null);
  const id = `LP-AFF-${randomUUID().slice(0, 8)}`;
  await butik.ensureRecord(id, job.id, "loopa", NU.toISOString());
  await butik.publish(id, { kind: "seller", userId: agare });
  assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }));
  return id;
}

// ─── länken ──────────────────────────────────────────────────────────────────

test("länken är en sökväg, /p/KOD — inte ?ref=, som Cloudflare skickar till marknadssajten", async () => {
  const a = konto(10);
  const p = await profilFor(a.id, a.email, NU);
  assert.match(p.kod, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(affiliateLank(p.kod), `https://loopa.nu/p/${p.kod}`);
  // Samma konto, samma kod — varje gång.
  assert.equal((await profilFor(a.id, a.email, NU)).kod, p.kod);
});

// ─── anspråket ───────────────────────────────────────────────────────────────

test("ett nytt konto som kom via länken kopplas till affiliate", async () => {
  const { a, b } = await paret();
  const pb = await affiliateStore().profil(b.id);
  assert.equal(pb?.referredBy, a.id);
});

test("första koden gäller och kan inte bytas", async () => {
  const { a, b } = await paret();
  const c = konto(100);
  const pc = await profilFor(c.id, c.email, NU);
  assert.equal(await gorAnsprak(b, pc.kod, false, NU), "redan_varvad");
  assert.equal((await affiliateStore().profil(b.id))?.referredBy, a.id);
});

test("egen kod, okänd kod och gamla konton fäster inte", async () => {
  const a = konto(50);
  const pa = await profilFor(a.id, a.email, NU);
  assert.equal(await gorAnsprak(a, pa.kod, false, NU), "egen_kod");
  assert.equal(await gorAnsprak(konto(0), "AAAA-AAAA", false, NU), "ogiltig_kod");
  assert.equal(await gorAnsprak(konto(0), "trams", false, NU), "ogiltig_kod");
  // Ett befintligt konto som klickat på en väns länk ska inte ge vännen 5 % av allt det säljer.
  assert.equal(await gorAnsprak(konto(31), pa.kod, false, NU), "inte_nytt_konto");
  assert.equal(await gorAnsprak({ ...konto(0), createdAt: null }, pa.kod, false, NU), "inte_nytt_konto");
  assert.equal(await gorAnsprak(konto(0), pa.kod, true, NU), "har_annonser");
});

test("ett konto med annonser räknas inte som nytt", async () => {
  const c = konto(0);
  assert.equal(await harAnnonser(c.id), false);
  await saldMobel(c.id);
  assert.equal(await harAnnonser(c.id), true);
});

// ─── provisionen ─────────────────────────────────────────────────────────────

test("5 % i öre: 1 234 kr ger 61,70 kr", () => {
  assert.deepEqual(provisionOre(1234), { salePriceOre: 123400, amountOre: 6170 });
  assert.deepEqual(provisionOre(0), { salePriceOre: 0, amountOre: 0 });
});

test("provisionen skapas när säljarens pengar betalas ut — inte när möbeln säljs", async () => {
  const { a, b } = await paret();
  const id = await saldMobel(b.id);
  assert.equal(await affiliateStore().provisionForProdukt(id), null, "såld men inte utbetald ger ingenting");

  await markeraUtbetald(id, { mobelprisSek: 2000 }, "admin");
  const p = await affiliateStore().provisionForProdukt(id);
  assert.ok(p);
  assert.equal(p.affiliateUserId, a.id);
  assert.equal(p.sellerUserId, b.id);
  assert.equal(p.salePriceOre, 200000);
  assert.equal(p.amountOre, 10000);
  assert.equal(p.status, "pending");
});

test("max en provision per såld annons", async () => {
  const { b } = await paret();
  const id = await saldMobel(b.id);
  assert.equal(await regler.provisionVidUtbetalning({ productId: id, sellerUserId: b.id, mobelprisSek: 1000 }, NU), "provision");
  assert.equal(await regler.provisionVidUtbetalning({ productId: id, sellerUserId: b.id, mobelprisSek: 1000 }, NU), "redan_provision");
  assert.equal((await affiliateStore().provisioner()).filter((p) => p.productId === id).length, 1);
});

test("ingen provision för en säljare som inte är värvad", async () => {
  const c = konto(0);
  const id = await saldMobel(c.id);
  await markeraUtbetald(id, { mobelprisSek: 1500 }, "admin");
  assert.equal(await affiliateStore().provisionForProdukt(id), null);
});

test("en retur annullerar en provision som inte betalats ut", async () => {
  const { b } = await paret();
  const id = await saldMobel(b.id);
  await markeraUtbetald(id, { mobelprisSek: 800 }, "admin");
  assert.ok(await butik.markDelivered(id, { kind: "admin", userId: "admin" }));
  assert.ok(await butik.markReturned(id, { kind: "admin", userId: "admin" }));
  const p = await affiliateStore().provisionForProdukt(id);
  assert.equal(p?.status, "cancelled");
  assert.equal(p?.cancelReason, "returnerad");
});

test("en redan utbetald provision rörs inte av en retur", async () => {
  const { b } = await paret();
  const id = await saldMobel(b.id);
  await markeraUtbetald(id, { mobelprisSek: 800 }, "admin");
  const p = (await affiliateStore().provisionForProdukt(id))!;
  assert.equal(await markeraUtbetalda([p.id], "admin", NU), 1);
  await butik.markDelivered(id, { kind: "admin", userId: "admin" });
  await butik.markReturned(id, { kind: "admin", userId: "admin" });
  assert.equal((await affiliateStore().provisionForProdukt(id))?.status, "paid");
});

// ─── översikterna och utbetalningen ──────────────────────────────────────────

test("affiliate ser registreringar, annonser, sålda och väntande/utbetalt", async () => {
  const { a, b } = await paret();
  const pa = await profilFor(a.id, a.email, NU);
  const c = konto(0);
  assert.equal(await gorAnsprak(c, pa.kod, false, NU), "ok");

  const s1 = await saldMobel(b.id);
  const s2 = await saldMobel(c.id);
  // En annons som inte sålts.
  const job = await createJob(null, null, b.id, null);
  await butik.ensureRecord(`LP-AFF-OSALD-${n}`, job.id, "loopa", NU.toISOString());

  await markeraUtbetald(s1, { mobelprisSek: 1000 }, "admin");
  await markeraUtbetald(s2, { mobelprisSek: 3000 }, "admin");
  const forsta = (await affiliateStore().provisionForProdukt(s1))!;
  await markeraUtbetalda([forsta.id], "admin", NU);

  const o = await oversikt(a.id, a.email, NU);
  assert.equal(o.registreringar, 2);
  assert.equal(o.annonser, 3);
  assert.equal(o.salda, 2);
  assert.equal(o.utbetaltOre, 5000);
  assert.equal(o.vantandeOre, 15000);
  assert.equal(o.lank, `https://loopa.nu/p/${pa.kod}`);
});

test("den manuella utbetalningen byter bara väntande provisioner, en gång", async () => {
  const { a, b } = await paret();
  const id = await saldMobel(b.id);
  await markeraUtbetald(id, { mobelprisSek: 600 }, "admin");
  const p = (await affiliateStore().provisionForProdukt(id))!;
  assert.equal(await markeraUtbetalda([p.id, p.id], "admin-1", NU), 1);
  assert.equal(await markeraUtbetalda([p.id], "admin-2", NU), 0, "redan utbetald");
  const efter = (await affiliateStore().provisionForProdukt(id))!;
  assert.equal(efter.paidBy, "admin-1");

  const rad = (await adminOversikt()).find((r) => r.userId === a.id);
  assert.equal(rad?.email, a.email, "admin ser vart pengarna ska");
  assert.equal(rad?.utbetaltOre, 3000);
});

test("ett raderat konto tappar sin e-post, men provisionerna står kvar", async () => {
  const { a, b } = await paret();
  const id = await saldMobel(b.id);
  await markeraUtbetald(id, { mobelprisSek: 500 }, "admin");
  await affiliateStore().rensaEmail(a.id);
  assert.equal((await affiliateStore().profil(a.id))?.email, null);
  assert.equal((await affiliateStore().provisionForProdukt(id))?.status, "pending");
});
