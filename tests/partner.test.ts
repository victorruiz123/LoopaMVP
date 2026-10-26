// ─── Partnerna: länken, märkningen och 0 % provision ─────────────────────────────────────────
//
// Regeln: en annons som läggs upp via en partners länk (loopa.nu/p/<slug>) bär partnerns namn och
// säljs utan Loopas provision. Testerna låser fast att slugen slås upp på servern, att klientens lista
// är densamma, att besöken räknas, att utbetalningen ger säljaren hela priset, och att panelen ser
// annonsen som partnerns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Egna datamappar, satta INNAN modulerna läses in — butikens och jobbens sökvägar läses vid import.
const rot = mkdtempSync(path.join(tmpdir(), "loopa-partner-test-"));
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.REFERRAL_DATA_DIR = path.join(rot, "referral");
process.env.ANALYS_DATA_DIR = path.join(rot, "analys");
process.env.EMAIL_PROVIDER = "none";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { partnerFor, PARTNERS, besoksHandelse } = await import("../server/src/partner/partners.js");
const { KLIENTHANDELSER } = await import("../server/src/analys/store.js");
const { GRATIS_ANDEL } = await import("../server/src/provision.js");
const { markeraUtbetald } = await import("../server/src/butik/utbetalning.js");
const butik = await import("../server/src/butik/store.js");
const { createJob, persist } = await import("../server/src/jobStore.js");

const NU = new Date("2026-10-26T10:00:00Z");

/** En såld möbel med villkoren "Sälj med Loopa" skriver för en partner. */
async function saldPartnerMobel(agare: string, partner: string) {
  const job = await createJob(null, null, agare, null);
  job.saleTerms = { commissionRate: GRATIS_ANDEL, referralCreditId: null, partner, decidedAt: NU.toISOString() };
  await persist(job);
  const id = `LP-TEST-${randomUUID().slice(0, 8)}`;
  await butik.ensureRecord(id, job.id, "loopa", NU.toISOString());
  await butik.publish(id, { kind: "seller", userId: agare });
  assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }));
  return { id, job };
}

test("Global Flytt är en partner, och slugen slås upp förlåtande men aldrig gissningsvis", () => {
  assert.equal(partnerFor("globalflytt")?.namn, "Global Flytt");
  assert.equal(partnerFor(" GlobalFlytt ")?.slug, "globalflytt");
  assert.equal(partnerFor("global-flytt"), null);
  assert.equal(partnerFor("K7QM-2XRP"), null, "en affiliate-kod är ingen partner");
  assert.equal(partnerFor(null), null);
  assert.equal(partnerFor(42), null);
});

test("klientens partnerlista är densamma som serverns", () => {
  const klient = readFileSync(path.join(import.meta.dirname, "..", "web", "src", "lib", "partner.ts"), "utf8");
  for (const p of Object.values(PARTNERS)) {
    assert.match(klient, new RegExp(`${p.slug}: \\{ slug: "${p.slug}", namn: "${p.namn}"`), `${p.slug} saknas i web/src/lib/partner.ts`);
  }
});

test("besöken via länken får skrivas till mätningen", () => {
  for (const slug of Object.keys(PARTNERS)) assert.ok(KLIENTHANDELSER.has(besoksHandelse(slug)));
  assert.equal(besoksHandelse("globalflytt"), "partner_besok_globalflytt");
});

test("en partnerannons betalas ut i sin helhet — Loopa tar 0 kr", async () => {
  const { id } = await saldPartnerMobel(randomUUID(), "globalflytt");
  const r = await markeraUtbetald(id, { mobelprisSek: 4500 }, "admin");
  assert.equal(r.utbetalning?.andel, 0);
  assert.equal(r.utbetalning?.loopaSek, 0);
  assert.equal(r.utbetalning?.saljarenSek, 4500);
});

test("panelen märker partnerns annonser och räknar dem", async () => {
  const { job } = await saldPartnerMobel(randomUUID(), "globalflytt");
  const { listaAnnonser } = await import("../server/src/adminAnnonser.js");
  const lista = await listaAnnonser();
  const rad = lista.rader.find((r) => r.jobId === job.id);
  assert.equal(rad?.partner, "globalflytt");
  const gf = lista.partners.find((p) => p.slug === "globalflytt");
  assert.ok(gf);
  // Två partnermöbler i det här testets lager: den här och den från testet ovan.
  assert.equal(gf.annonser, lista.rader.filter((r) => r.partner === "globalflytt").length);
  assert.ok(gf.annonser >= 1);
});
