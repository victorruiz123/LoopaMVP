// ─── Massproductions: pengar eller credits ──────────────────────────────────
//
// Erbjudandet gäller BARA märket Massproductions. Exemplet som definierar det: en möbel för 5 000 kr
// ger antingen 4 000 kr (80 %) eller 5 500 credits (10 % över). Credits sparas per användare, en
// post per möbel, och syns i profilen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = await mkdtemp(path.join(tmpdir(), "loopa-mp-"));
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.AFFILIATE_DATA_DIR = path.join(rot, "affiliate");
process.env.EMAIL_PROVIDER = "none";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const mp = await import("../server/src/massproductions.js");
const butik = await import("../server/src/butik/store.js");
const { createJob } = await import("../server/src/jobStore.js");
const { uppdelning } = await import("../server/src/provision.js");

async function nyKatalog(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "loopa-credits-"));
  process.env.CREDITS_DIR = dir;
  mp.nollstall();
  return dir;
}

test("exemplet: 5 000 kr ger 4 000 kr i pengar eller 5 500 credits", () => {
  assert.equal(uppdelning(5000).saljarenSek, 4000);
  assert.equal(mp.creditsFor(5000), 5500);
});

test("credits är alltid 10 % över möbelpriset, i hela credits", () => {
  for (const [pris, credits] of [[0, 0], [100, 110], [1234, 1357], [2999, 3299], [12000, 13200], [4999.6, 5500]] as const) {
    assert.equal(mp.creditsFor(pris), credits, String(pris));
  }
  assert.throws(() => mp.creditsFor(-1));
  assert.throws(() => mp.creditsFor(Number.NaN));
});

test("bara märket Massproductions — i de stavningar folk skriver", () => {
  for (const m of ["Massproductions", "massproductions", "MASSPRODUCTIONS", "Mass Productions", "Massproduction", "Massproductions AB", " massproductions "]) {
    assert.equal(mp.arMassproductions(m), true, m);
  }
  for (const m of ["IKEA", "String", "HAY", "Mass", "Massproductionsx", "Productions", "", null, undefined]) {
    assert.equal(mp.arMassproductions(m as string | null), false, String(m));
  }
});

test("valet: bara pengar eller credits", () => {
  assert.equal(mp.arErsattningsTyp("pengar"), true);
  assert.equal(mp.arErsattningsTyp("credits"), true);
  for (const v of ["kontant", "", null, undefined, 1, "CREDITS"]) assert.equal(mp.arErsattningsTyp(v), false, String(v));
});

test("credits sparas per användare — men räknas INTE i saldot förrän möbeln är såld", async () => {
  const dir = await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Taburett Hockey", mobelprisSek: 5000 });
  await mp.reserveraCredits({ userId: "anna", jobId: "job-2", titel: "Stol Glyph", mobelprisSek: 2000 });
  await mp.reserveraCredits({ userId: "bo", jobId: "job-3", titel: "Bord Tableau", mobelprisSek: 10000 });

  const anna = await mp.minaCredits("anna");
  assert.equal(anna.saldo, 0, "inget är sålt — inget på kontot");
  assert.equal(anna.vantar, 5500 + 2200);
  assert.deepEqual(anna.poster.map((p) => p.status), ["vantar", "vantar"]);
  assert.deepEqual(await mp.minaCredits("ingen"), { saldo: 0, vantar: 0, poster: [] });

  // Den ena säljs: bara den blir tillgodo.
  const sald = await mp.tillgodoVidForsaljning("job-1");
  assert.equal(sald?.status, "tillgodo");
  assert.ok(sald?.saldAt);
  const efter = await mp.minaCredits("anna");
  assert.equal(efter.saldo, 5500);
  assert.equal(efter.vantar, 2200);
  assert.equal((await mp.minaCredits("bo")).saldo, 0, "en annan användares möbel påverkas inte");

  // På disk, och läses tillbaka efter en omstart.
  const fil = JSON.parse(await readFile(path.join(dir, "credits.json"), "utf-8"));
  assert.equal(fil.length, 3);
  mp.nollstall();
  assert.equal((await mp.minaCredits("anna")).saldo, 5500);
});

test("försäljningen är idempotent, och en möbel utan credits påverkas inte", async () => {
  await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Hockey", mobelprisSek: 5000 });
  await mp.tillgodoVidForsaljning("job-1");
  assert.equal(await mp.tillgodoVidForsaljning("job-1"), null, "redan tillgodo — ingenting händer");
  assert.equal((await mp.minaCredits("anna")).saldo, 5500, "aldrig dubbelt");
  assert.equal(await mp.tillgodoVidForsaljning("job-pengar"), null, "valde pengar eller annat märke: ingen post");
});

test("retur: credits annulleras, även om de redan var tillgodo", async () => {
  await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Hockey", mobelprisSek: 5000 });
  await mp.tillgodoVidForsaljning("job-1");
  const ret = await mp.annulleraVidRetur("job-1");
  assert.equal(ret?.status, "annullerad");
  const anna = await mp.minaCredits("anna");
  assert.equal(anna.saldo, 0);
  assert.equal(anna.vantar, 0);
  assert.equal(await mp.tillgodoVidForsaljning("job-1"), null, "en annullerad post blir aldrig tillgodo igen");
});

test("en okänd status i filen räknas som väntande — aldrig som tillgodo", async () => {
  const dir = await nyKatalog();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(dir, "credits.json"),
    JSON.stringify([{ id: "x", userId: "anna", jobId: "job-x", titel: "Gammal", mobelprisSek: 1000, credits: 1100, status: "reserverad", skapad: "2026-11-01T00:00:00Z" }]),
  );
  mp.nollstall();
  const anna = await mp.minaCredits("anna");
  assert.equal(anna.saldo, 0);
  assert.equal(anna.vantar, 1100);
});

// ─── genom butikens riktiga övergångar ──────────────────────────────────────

async function mobelIButiken(agare: string) {
  const job = await createJob(null, null, agare, null);
  const id = `LP-MP-${Math.random().toString(36).slice(2, 10)}`;
  await butik.ensureRecord(id, job.id, "loopa", new Date().toISOString());
  await butik.publish(id, { kind: "seller", userId: agare });
  return { id, jobId: job.id };
}

test("hela vägen: överlämnad → väntar, såld i butiken → tillgodo, returnerad → annullerad", async () => {
  await nyKatalog();
  const { id, jobId } = await mobelIButiken("anna");
  await mp.reserveraCredits({ userId: "anna", jobId, titel: "Tableau", mobelprisSek: 5000 });
  assert.equal((await mp.minaCredits("anna")).saldo, 0, "ute till salu: inget på kontot");

  assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }));
  assert.equal((await mp.minaCredits("anna")).saldo, 5500, "såld: på kontot");

  assert.ok(await butik.markDelivered(id, { kind: "admin", userId: "admin" }));
  assert.ok(await butik.markReturned(id, { kind: "admin", userId: "admin" }));
  const efter = await mp.minaCredits("anna");
  assert.equal(efter.saldo, 0, "returnerad: borta");
  assert.equal(efter.poster[0].status, "annullerad");
});

test("såld på Tradera och via panelen går samma väg", async () => {
  await nyKatalog();
  const t = await mobelIButiken("anna");
  const p = await mobelIButiken("anna");
  await mp.reserveraCredits({ userId: "anna", jobId: t.jobId, titel: "A", mobelprisSek: 1000 });
  await mp.reserveraCredits({ userId: "anna", jobId: p.jobId, titel: "B", mobelprisSek: 2000 });
  assert.ok(await butik.claimForSale(t.id, "tradera", { kind: "tradera", itemId: 1 }, { traderaItemId: 1 }));
  assert.ok(await butik.claimForSale(p.id, "butik", { kind: "admin", userId: "admin" }));
  assert.equal((await mp.minaCredits("anna")).saldo, 1100 + 2200);
});

test("en möbel som inte säljs ger aldrig credits — inte ens när den tas ner", async () => {
  await nyKatalog();
  const { id, jobId } = await mobelIButiken("anna");
  await mp.reserveraCredits({ userId: "anna", jobId, titel: "Ligger kvar", mobelprisSek: 3000 });
  assert.ok(await butik.unpublish(id, { kind: "admin", userId: "admin" }));
  const anna = await mp.minaCredits("anna");
  assert.equal(anna.saldo, 0);
  assert.equal(anna.vantar, 3300);
});

test("samma möbel ger aldrig credits två gånger — inte ens samtidigt", async () => {
  await nyKatalog();
  const forsta = await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Hockey", mobelprisSek: 5000 });
  const igen = await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Hockey", mobelprisSek: 9000 });
  assert.equal(igen.id, forsta.id);
  assert.equal(igen.credits, 5500, "den första posten står kvar som den var");

  await Promise.all(Array.from({ length: 10 }, () => mp.reserveraCredits({ userId: "bo", jobId: "job-9", titel: "x", mobelprisSek: 1000 })));
  assert.equal((await mp.minaCredits("bo")).poster.length, 1);
  await Promise.all(Array.from({ length: 10 }, () => mp.tillgodoVidForsaljning("job-9")));
  assert.equal((await mp.minaCredits("bo")).saldo, 1100, "tio samtidiga försäljningar — en gång");
});

test("erbjudandet visas bara för Massproductions, med serverns belopp", () => {
  const pengar = uppdelning(5000);
  assert.deepEqual(mp.erbjudandeFor({ identity: { brand: "Massproductions" } }, pengar), { pengar, credits: 5500, paslag: 0.1, valt: null });
  assert.equal(mp.erbjudandeFor({ identity: { brand: "IKEA" } }, pengar), null, "andra märken: inget val");
  assert.equal(mp.erbjudandeFor({ identity: null }, pengar), null, "inget märke valt: inget val");
  assert.equal(mp.erbjudandeFor({ identity: { brand: "Massproductions" } }, null), null, "priset okänt: inget val än");
});

test("ett gjort val står kvar — med det låsta beloppet, även om priset ändrats", () => {
  const job = { identity: { brand: "Massproductions" }, saleTerms: { ersattning: { typ: "credits" as const, credits: 5500, mobelprisSek: 5000 } } };
  const e = mp.erbjudandeFor(job, uppdelning(4000))!;
  assert.equal(e.valt, "credits");
  assert.equal(e.credits, 5500);
});

test("trycket: Massproductions kräver ett val, andra märken påverkas inte", () => {
  const mpJob = { identity: { brand: "Massproductions" } };
  assert.equal(mp.ersattningVidTryck(mpJob, undefined, 5000), "saknas");
  assert.equal(mp.ersattningVidTryck(mpJob, "kontant", 5000), "saknas");
  assert.equal(mp.ersattningVidTryck(mpJob, "credits", 5000), "saknar-namn", "credits kräver ett namn");
  assert.equal(mp.ersattningVidTryck(mpJob, "credits", 5000, "  A "), "saknar-namn", "ett tecken är inget namn");
  assert.deepEqual(mp.ersattningVidTryck(mpJob, "credits", 5000, "  Anna   Svensson "), { typ: "credits", credits: 5500, mobelprisSek: 5000, namn: "Anna Svensson" });
  assert.deepEqual(mp.ersattningVidTryck(mpJob, "pengar", 5000), { typ: "pengar", credits: null, mobelprisSek: 5000, namn: null }, "pengar kräver inget namn");
  // Ett annat märke: inget krav, och ett val som ändå skickas (en manipulerad klient) ignoreras.
  assert.equal(mp.ersattningVidTryck({ identity: { brand: "String" } }, undefined, 5000), null);
  assert.equal(mp.ersattningVidTryck({ identity: { brand: "String" } }, "credits", 5000), null);
});

test("en borttagen annons tar sina väntande credits med sig — i profilen och på disk", async () => {
  await nyKatalog();
  const { markJobRemoved } = await import("../server/src/jobStore.js");
  const a = await createJob(null, null, "anna", null);
  const b = await createJob(null, null, "anna", null);
  await mp.reserveraCredits({ userId: "anna", jobId: a.id, titel: "2-sits", mobelprisSek: 5000 });
  await mp.reserveraCredits({ userId: "anna", jobId: b.id, titel: "3-sits", mobelprisSek: 5000 });
  assert.equal((await mp.minaCredits("anna")).vantar, 11000);

  await markJobRemoved(a.id, "seller");
  const efter = await mp.minaCredits("anna");
  assert.equal(efter.vantar, 5500);
  assert.deepEqual(efter.poster.map((p) => p.jobId), [b.id]);
  mp.nollstall();
  assert.equal((await mp.minaCredits("anna")).poster.length, 1, "borta på disk, inte bara dold");
});

test("en annons som togs bort innan rensningen fanns döljs ändå", async () => {
  await nyKatalog();
  const { markJobRemoved } = await import("../server/src/jobStore.js");
  const a = await createJob(null, null, "anna", null);
  await markJobRemoved(a.id, "seller");
  // Posten skrivs efteråt — som en gammal post för en redan borttagen annons.
  await mp.reserveraCredits({ userId: "anna", jobId: a.id, titel: "Gammal", mobelprisSek: 5000 });
  const anna = await mp.minaCredits("anna");
  assert.equal(anna.vantar, 0);
  assert.equal(anna.poster.length, 0);
});

test("credits som redan är tillgodo står kvar om annonsen tas bort — men går med när kontot raderas", async () => {
  await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-sald", titel: "Såld", mobelprisSek: 2000 });
  await mp.tillgodoVidForsaljning("job-sald");
  assert.equal(await mp.taBortVidBorttagenAnnons("job-sald"), false);
  assert.equal((await mp.minaCredits("anna")).saldo, 2200);
  assert.equal(await mp.taBortVidBorttagenAnnons("job-sald", { ocksaTillgodo: true }), true);
  assert.equal((await mp.minaCredits("anna")).saldo, 0);
});

// ─── Brevet till Massproductions går vid FÖRSÄLJNINGEN ───────────────────────

test("brevet till Massproductions går när möbeln säljs — inte vid överlämningen, och bara för credits", async () => {
  await nyKatalog();
  const kontakt = await import("../server/src/massproductionsKontakt.js");
  process.env.MP_KONTAKT_DIR = await mkdtemp(path.join(tmpdir(), "loopa-mp-brev-"));
  kontakt.nollstall();
  const skickade: Array<{ to: string; text: string }> = [];
  kontakt.anvandBeroenden({
    hamtaKontakt: async () => ({ namn: "Kontots namn", epost: "anna@exempel.se", telefon: null }),
    skicka: async (b) => {
      skickade.push(b);
      return { messageId: "<x>", accepted: [b.to], rejected: [] };
    },
    larma: async () => undefined,
  });
  try {
    const { getJob, persist } = await import("../server/src/jobStore.js");
    const { id, jobId } = await mobelIButiken("anna");
    const job = (await getJob(jobId))!;
    job.saleTerms = { commissionRate: 0.2, referralCreditId: null, partner: null, ersattning: { typ: "credits", credits: 5500, mobelprisSek: 5000, namn: "Anna Svensson" }, decidedAt: new Date().toISOString() };
    await persist(job);
    // Överlämnad: credits väntar, och INGET brev.
    await mp.reserveraCredits({ userId: "anna", jobId, titel: "Tableau", mobelprisSek: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(skickade.length, 0, "brevet gick redan vid överlämningen");

    // En möbel med PENGAR säljs: inget brev.
    const pengar = await mobelIButiken("bo");
    assert.ok(await butik.claimForSale(pengar.id, "butik", { kind: "buyer", userId: "k" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(skickade.length, 0, "en möbel med pengar gav ett brev");

    // Credits-möbeln säljs: ETT brev till Magnus, med namnet säljaren skrev.
    assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }));
    for (let i = 0; i < 40 && skickade.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(skickade.length, 1);
    assert.equal(skickade[0].to, "magnus.eleback@massproductions.se");
    assert.match(skickade[0].text, /Namn: +Anna Svensson/);
    assert.match(skickade[0].text, /har sålt/);
    assert.match(skickade[0].text, new RegExp(id));
  } finally {
    kontakt.anvandBeroenden(null);
  }
});

// ─── Credits räknas på FÖRSÄLJNINGSPRISET ────────────────────────────────────

test("exemplet: utlagd för 5 000 kr, såld för 4 000 kr → 4 400 credits, inte 5 500", async () => {
  await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Soffa", mobelprisSek: 5000 });
  const sald = await mp.tillgodoVidForsaljning("job-1", 4000);
  assert.equal(sald?.credits, 4400);
  assert.equal(sald?.mobelprisSek, 4000);
  assert.equal(sald?.preliminaraCredits, 5500, "det preliminära beloppet finns kvar för historiken");
  assert.equal((await mp.minaCredits("anna")).saldo, 4400);
});

test("utan känt försäljningspris står det preliminära beloppet kvar", async () => {
  await nyKatalog();
  await mp.reserveraCredits({ userId: "anna", jobId: "job-1", titel: "Soffa", mobelprisSek: 5000 });
  assert.equal((await mp.tillgodoVidForsaljning("job-1", null))?.credits, 5500);
});

test("såld i Loopa Butik: credits på kassans frysta pris", async () => {
  await nyKatalog();
  const { id, jobId } = await mobelIButiken("anna");
  await mp.reserveraCredits({ userId: "anna", jobId, titel: "Soffa", mobelprisSek: 5000 });
  const h = await butik.reserve(id, 4000, { kind: "buyer", userId: "kopare" });
  assert.ok(h);
  assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }, { requireToken: h.token }));
  assert.equal((await mp.minaCredits("anna")).saldo, 4400);
});

test("såld på Tradera efter prissänkningar: credits på annonsens pris vid försäljningen", async () => {
  await nyKatalog();
  const { getJob, persist } = await import("../server/src/jobStore.js");
  const { id, jobId } = await mobelIButiken("anna");
  await mp.reserveraCredits({ userId: "anna", jobId, titel: "Soffa", mobelprisSek: 5000 });
  const job = (await getJob(jobId))!;
  // Prisstegen har sänkt priset två veckor: 5 000 → 4 250 → 3 600.
  job.priceLadder = { currentPrice: 3600 } as never;
  await persist(job);

  // Medan den ligger ute följer profilen dagens pris — utan att posten skrivs om.
  const ute = await mp.minaCredits("anna");
  assert.equal(ute.vantar, 3960);
  assert.equal(ute.saldo, 0);

  assert.ok(await butik.claimForSale(id, "tradera", { kind: "tradera", itemId: 7 }, { traderaItemId: 7 }));
  const efter = await mp.minaCredits("anna");
  assert.equal(efter.saldo, 3960);
  assert.equal(efter.poster[0].mobelprisSek, 3600);
});
