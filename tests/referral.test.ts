// ─── Inbjudningarna: koden, triggern, skydden och provisionen i utbetalningen ─────────────────
//
// Regeln: den som bjuder in någon får EN försäljning utan Loopas provision, när den inbjudna lägger upp
// sin första annons. Befintliga konton kan bjudas in så länge de aldrig sålt något. Testerna låser fast
// att krediten kommer då och bara då, att skydden håller, och att en möbel med andelen 0 betalas ut i
// sin helhet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Egna datamappar, satta INNAN modulerna läses in — butikens och jobbens sökvägar läses vid import.
const rot = mkdtempSync(path.join(tmpdir(), "loopa-referral-test-"));
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.REFERRAL_DATA_DIR = path.join(rot, "referral");
process.env.EMAIL_PROVIDER = "none";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { nyKod, normaliseraKod, inbjudningslank, KOD_ALFABET } = await import("../server/src/referral/kod.js");
const { emailNyckel, adressNyckel, telefonNyckel } = await import("../server/src/referral/avtryck.js");
const regler = await import("../server/src/referral/regler.js");
const { referralStore } = await import("../server/src/referral/store.js");
const { uppdelning, STANDARD_ANDEL, TAK_SEK, GRATIS_ANDEL } = await import("../server/src/provision.js");
const { markeraUtbetald, UtbetalningFel, listaUtbetalningar } = await import("../server/src/butik/utbetalning.js");
const butik = await import("../server/src/butik/store.js");
const { createJob, persist } = await import("../server/src/jobStore.js");
const webbFees = await import("../web/src/lib/fees.js");

const { gorAnsprak, profilFor, efterForstaAnnons, anvandKredit, krediterFor, tillgangliga, MAX_TILLGANGLIGA } = regler;

// ─── hjälpare ───────────────────────────────────────────────────────────────

const NU = new Date("2026-09-18T10:00:00Z");
let n = 0;

function konto(over: Partial<import("../server/src/referral/regler.js").Konto> = {}) {
  const id = randomUUID();
  return {
    id,
    email: `person${n++}@exempel.se`,
    createdAt: NU.toISOString(),
    adress: { gatuadress: `Gatan ${n}`, postnummer: "11122" },
    telefon: null,
    ...over,
  };
}

/** Inbjudare A och en nyregistrerad B som kom via A:s länk. */
async function paret(overB: Parameters<typeof konto>[0] = {}, overA: Parameters<typeof konto>[0] = {}) {
  const a = konto(overA);
  const pa = await profilFor(a, NU);
  const b = konto(overB);
  assert.equal(await gorAnsprak(b, pa.kod, false, NU), "ok");
  return { a, b, pa };
}

/** En såld möbel som ägs av `agare`, med valfria villkor. Returnerar produkt-id:t. */
async function saldMobel(agare: string, saleTerms?: { commissionRate: number; referralCreditId: string | null }) {
  const job = await createJob(null, null, agare, null);
  if (saleTerms) job.saleTerms = { ...saleTerms, decidedAt: NU.toISOString() };
  await persist(job);
  const id = `LP-TEST-${randomUUID().slice(0, 8)}`;
  await butik.ensureRecord(id, job.id, "loopa", NU.toISOString());
  await butik.publish(id, { kind: "seller", userId: agare });
  assert.ok(await butik.claimForSale(id, "butik", { kind: "buyer", userId: "kopare" }));
  return id;
}

// ─── koden ─────────────────────────────────────────────────────────────────

test("koden är fyra plus fyra tecken ur ett alfabet utan förväxlingsbara tecken", () => {
  for (const c of "0O1IL") assert.ok(!KOD_ALFABET.includes(c), `${c} ska inte finnas i alfabetet`);
  for (let i = 0; i < 200; i++) assert.match(nyKod(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
});

test("koden normaliseras förlåtande men rättas aldrig till en annan", () => {
  assert.equal(normaliseraKod("k7qm 2xrp"), "K7QM-2XRP");
  assert.equal(normaliseraKod("K7QM2XRP"), "K7QM-2XRP");
  assert.equal(normaliseraKod("K7QM-2XR0"), null, "0 finns inte i alfabetet");
  assert.equal(normaliseraKod("K7QM-2XR"), null);
  assert.equal(normaliseraKod(42), null);
});

// ─── registreringen ─────────────────────────────────────────────────────────

/**
 * Länken är en SÖKVÄG, och det är inte kosmetik.
 *
 * `/?ref=KOD` ledde i drift till marknadssajtens företagssida: loopa.nu ägs av Cloudflare Pages, och
 * Workern som håller säljflödet är bunden till rutter som matchar hela URL:en. `loopa.nu/` matchar
 * roten utan query — läggs något efter `?` matchar ingen rutt alls, och Pages svarar 302 → /company.
 * Rutten `loopa.nu/?*` går inte att lägga till: Cloudflare avvisar query i ruttmönster (fel 10022).
 *
 * Testet låser fast formen så att ingen råkar skriva tillbaka frågetecknet. Går det här testet sönder
 * är inbjudningslänken trasig i drift, medan allt ser rätt ut lokalt — där ingen Worker står emellan.
 */
test("inbjudningslänken är en sökväg och aldrig en query-sträng", () => {
  process.env.REFERRAL_LINK_BASE = "https://loopa.nu";
  const lank = inbjudningslank("ABCD-EFGH");
  delete process.env.REFERRAL_LINK_BASE;

  assert.equal(lank, "https://loopa.nu/i/ABCD-EFGH");
  assert.ok(!lank.includes("?"), "en query-sträng når aldrig appen på loopa.nu — se wrangler.toml");
  assert.ok(new URL(lank).pathname.startsWith("/i/"), "sökvägen måste ligga under Workerns rutt /i/*");
});

test("anspråket skriver referred_by en gång och aldrig igen", async () => {
  const { b, pa } = await paret();
  const annan = await profilFor(konto(), NU);
  assert.equal(await gorAnsprak(b, annan.kod, false, NU), "redan_inbjuden");
  assert.equal((await referralStore().profil(b.id))!.referredBy, pa.userId, "första inbjudaren står kvar");
});

test("ett befintligt konto kan bjudas in — så länge det aldrig sålt något", async () => {
  const a = konto();
  const pa = await profilFor(a, NU);
  const gammal = konto({ createdAt: "2025-01-01T00:00:00Z" });
  assert.equal(await gorAnsprak(gammal, pa.kod, false, NU), "ok", "gammalt konto utan försäljningar");
  const saljare = konto({ createdAt: "2025-01-01T00:00:00Z" });
  assert.equal(await gorAnsprak(saljare, pa.kod, true, NU), "har_salt");
  assert.equal((await referralStore().profil(saljare.id))?.referredBy ?? null, null);
});

test("anspråket nekas för egna koder och koder som inte finns", async () => {
  const a = konto();
  const pa = await profilFor(a, NU);
  assert.equal(await gorAnsprak(a, pa.kod, false, NU), "egen_kod");
  assert.equal(await gorAnsprak(konto(), "AAAA-BBBB", false, NU), "ogiltig_kod");
  assert.equal(await gorAnsprak(konto(), "trasig", false, NU), "ogiltig_kod");
});

test("anspråket i sig ger ingen kredit — först vännens annons gör det", async () => {
  const { a } = await paret();
  assert.equal((await krediterFor(a.id, NU)).length, 0);
});

// ─── triggern ──────────────────────────────────────────────────────────────

test("den inbjudnas första annons ger inbjudaren en kredit som gäller i 12 månader", async () => {
  const { a, b } = await paret();
  const r = await efterForstaAnnons({ saljarId: b.id, saleId: "LP-1", nu: NU });
  assert.equal(r.utfall, "kredit");
  const k = (await krediterFor(a.id, NU))[0];
  assert.equal(k.status, "available");
  assert.equal(k.referredUserId, b.id);
  assert.equal(k.expiresAt, "2027-09-18T10:00:00.000Z");
  assert.ok((await referralStore().profil(b.id))!.forstaAnnonsAt, "inbjudarens lista visar 'har lagt upp en annons'");
});

test("en inbjuden ger högst en kredit, hur många annonser de än lägger upp", async () => {
  const { a, b } = await paret();
  assert.equal((await efterForstaAnnons({ saljarId: b.id, saleId: "LP-3", nu: NU })).utfall, "kredit");
  assert.equal((await efterForstaAnnons({ saljarId: b.id, saleId: "LP-4", nu: NU })).utfall, "redan_kredit");
  assert.equal((await krediterFor(a.id, NU)).length, 1);
});

test("en säljare utan inbjudare utlöser ingenting", async () => {
  const c = konto();
  await profilFor(c, NU);
  assert.equal((await efterForstaAnnons({ saljarId: c.id, saleId: "LP-5", nu: NU })).utfall, "ingen_inbjudare");
});

test("ingen kredit när inbjudare och inbjuden delar e-post, adress eller telefon", async () => {
  // Samma Gmail-adress med punkter och +tillägg — så gör man ett andra konto.
  const e = await paret({ email: "a.nna+2@gmail.com" }, { email: "anna@gmail.com" });
  assert.equal((await efterForstaAnnons({ saljarId: e.b.id, saleId: "LP-6", nu: NU })).utfall, "delar_identitet");

  const adress = { gatuadress: "Storgatan 1 A", postnummer: "112 23" };
  const ad = await paret({ adress: { gatuadress: "storgatan 1a", postnummer: "11223" } }, { adress });
  assert.equal((await efterForstaAnnons({ saljarId: ad.b.id, saleId: "LP-7", nu: NU })).utfall, "delar_identitet");

  const tel = await paret({ telefon: "+46 70-123 45 67" }, { telefon: "070 123 45 67" });
  assert.equal((await efterForstaAnnons({ saljarId: tel.b.id, saleId: "LP-8", nu: NU })).utfall, "delar_identitet");

  const nekade = (await referralStore().handelser()).filter((h) => h.event === "referral_credit_denied");
  assert.ok(nekade.some((h) => h.props.orsak === "samma_epost"));
  assert.ok(nekade.some((h) => h.props.orsak === "samma_adress"));
  assert.ok(nekade.some((h) => h.props.orsak === "samma_telefon"));
});

test("grannar med samma postnummer men olika gata får sin kredit", async () => {
  const g = await paret({ adress: { gatuadress: "Storgatan 3", postnummer: "11223" } }, { adress: { gatuadress: "Storgatan 1", postnummer: "11223" } });
  assert.equal((await efterForstaAnnons({ saljarId: g.b.id, saleId: "LP-9", nu: NU })).utfall, "kredit");
});

test("den som redan har tio oanvända krediter får ingen elfte", async () => {
  const a = konto();
  const pa = await profilFor(a, NU);
  for (let i = 0; i < MAX_TILLGANGLIGA; i++) {
    const b = konto();
    assert.equal(await gorAnsprak(b, pa.kod, false, NU), "ok");
    assert.equal((await efterForstaAnnons({ saljarId: b.id, saleId: `LP-M${i}`, nu: NU })).utfall, "kredit");
  }
  const elfte = konto();
  await gorAnsprak(elfte, pa.kod, false, NU);
  assert.equal((await efterForstaAnnons({ saljarId: elfte.id, saleId: "LP-M11", nu: NU })).utfall, "tak");
  assert.equal(tillgangliga(await krediterFor(a.id, NU), NU).length, MAX_TILLGANGLIGA);
});

// ─── användningen ───────────────────────────────────────────────────────────

test("en kredit används en gång, och en utgången går inte att använda", async () => {
  const { a, b } = await paret();
  await efterForstaAnnons({ saljarId: b.id, saleId: "LP-10", nu: NU });
  const k = await anvandKredit(a.id, "LP-NY", NU);
  assert.equal(k?.status, "used");
  assert.equal(k?.usedOnSaleId, "LP-NY");
  assert.equal(await anvandKredit(a.id, "LP-NY2", NU), null, "samma kredit kan inte användas två gånger");

  const x = await paret();
  await efterForstaAnnons({ saljarId: x.b.id, saleId: "LP-11", nu: NU });
  const omEttAr = new Date("2027-09-19T00:00:00Z");
  assert.equal(await anvandKredit(x.a.id, "LP-SEN", omEttAr), null);
  assert.equal((await krediterFor(x.a.id, omEttAr))[0].status, "expired");
});

// ─── provisionen ────────────────────────────────────────────────────────────

test("provisionen: 20 % med tak, 0 med gratisförsäljning, och delarna summerar alltid till priset", () => {
  assert.deepEqual(uppdelning(3000), { mobelprisSek: 3000, andel: 0.2, loopaSek: 600, saljarenSek: 2400, tak: false });
  assert.equal(uppdelning(8000).loopaSek, TAK_SEK);
  assert.equal(uppdelning(8000).tak, true);
  assert.deepEqual(uppdelning(8000, GRATIS_ANDEL), { mobelprisSek: 8000, andel: 0, loopaSek: 0, saljarenSek: 8000, tak: false });
  for (const p of [0, 1, 3, 999, 1234, 5001, 12345]) {
    const d = uppdelning(p);
    assert.equal(d.loopaSek + d.saljarenSek, d.mobelprisSek);
  }
  assert.throws(() => uppdelning(-1));
  assert.throws(() => uppdelning(100, 1.5));
});

test("webbens avgiftstal är samma som serverns — de två får inte glida isär", () => {
  assert.equal(webbFees.LOOPA_FEE_PCT, STANDARD_ANDEL);
  assert.equal(webbFees.LOOPA_FEE_CAP_SEK, TAK_SEK);
});

test("ingen annan serverfil räknar provision", () => {
  // provision.ts är den enda platsen. Ett nytt `* 0.2` eller en ny avgiftsuträkning ska läsa därifrån.
  const filer = ["server/src/butik/utbetalning.ts", "server/src/butik/checkout.ts", "server/src/server.ts"];
  for (const f of filer) {
    const src = readFileSync(path.join(import.meta.dirname, "..", f), "utf-8");
    assert.doesNotMatch(src, /\*\s*0\.2\b|0\.20\b|LOOPA_FEE_PCT/, `${f} räknar provision själv`);
  }
});

// ─── utbetalningen, hela vägen ──────────────────────────────────────────────

test("utbetalningen med commission_rate 0 ger säljaren hela priset och Loopa 0 kr", async () => {
  const { a, b } = await paret();

  // B lägger upp sin första annons: A får krediten. Utbetalningen har ingen del i det längre.
  assert.equal((await efterForstaAnnons({ saljarId: b.id, saleId: "LP-B" })).utfall, "kredit");

  // B:s möbel säljs och betalas ut på vanliga villkor.
  const forsta = await saldMobel(b.id);
  const r1 = await markeraUtbetald(forsta, { mobelprisSek: 3000 }, "admin");
  assert.equal(r1.utbetalning?.andel, STANDARD_ANDEL);
  assert.equal(r1.utbetalning?.loopaSek, 600);
  assert.equal(r1.utbetalning?.saljarenSek, 2400);

  const [kredit] = tillgangliga(await krediterFor(a.id));
  assert.ok(kredit, "B:s annons ska ha gett A en kredit");

  // A publicerar en möbel med krediten. Villkoren sätts som i "Sälj med Loopa".
  const anvand = await anvandKredit(a.id, "LP-A");
  assert.equal(anvand?.id, kredit.id);
  const gratis = await saldMobel(a.id, { commissionRate: GRATIS_ANDEL, referralCreditId: anvand!.id });
  const r2 = await markeraUtbetald(gratis, { mobelprisSek: 8000 }, "admin");
  assert.equal(r2.utbetalning?.andel, 0);
  assert.equal(r2.utbetalning?.loopaSek, 0, "Loopa tar ingenting");
  assert.equal(r2.utbetalning?.saljarenSek, 8000, "säljaren får hela möbelpriset");
  assert.equal(r2.utbetalning?.referralCreditId, kredit.id);
  assert.equal(r2.gratis, true);

  // Utbetalningar ger ingen kredit i sig — A har fortfarande bara den ena.
  const andra = await saldMobel(b.id);
  await markeraUtbetald(andra, { mobelprisSek: 1000 }, "admin");
  assert.equal((await krediterFor(a.id)).length, 1);
});

test("en möbel betalas aldrig ut två gånger, och en osåld inte alls", async () => {
  const c = konto();
  const id = await saldMobel(c.id);
  await markeraUtbetald(id, { mobelprisSek: 500 }, "admin");
  await assert.rejects(markeraUtbetald(id, { mobelprisSek: 500 }, "admin"), UtbetalningFel);

  const job = await createJob(null, null, c.id, null);
  const osald = `LP-TEST-${randomUUID().slice(0, 8)}`;
  await butik.ensureRecord(osald, job.id, "loopa", NU.toISOString());
  await assert.rejects(markeraUtbetald(osald, { mobelprisSek: 500 }, "admin"), UtbetalningFel);
});

test("möbler utan villkor (från före inbjudningarna) betalas ut på förvalet", async () => {
  const id = await saldMobel(konto().id);
  const rad = (await listaUtbetalningar()).find((r) => r.productId === id)!;
  assert.equal(rad.gratis, false);
  const ut = await markeraUtbetald(id, { mobelprisSek: 2000 }, "admin");
  assert.equal(ut.utbetalning?.loopaSek, 400);
});

test("avtrycken normaliseras så att alias och skrivsätt inte räcker för att smita förbi", () => {
  assert.equal(emailNyckel("A.Nna+loopa@GoogleMail.com"), "anna@gmail.com");
  assert.equal(emailNyckel("anna.b+x@exempel.se"), "anna.b@exempel.se", "punkter räknas bara bort hos Gmail");
  assert.equal(adressNyckel({ gatuadress: "Storgatan 1 A", postnummer: "112 23" }), "storgatan1a|11223");
  assert.equal(adressNyckel({ gatuadress: "", postnummer: "11223" }), null, "postnummer ensamt är inget avtryck");
  assert.equal(telefonNyckel("070-123 45 67"), telefonNyckel("+46701234567"));
});

// ─── landningssidan och popupen ─────────────────────────────────────────────

test("landningssidan får inbjudarens förnamn och ingenting annat", async () => {
  const { fornamn } = await import("../server/src/referral/avtryck.js");
  assert.equal(fornamn("victor ruiz", "x@y.se"), "Victor", "bara förnamnet");
  assert.equal(fornamn(null, "victor.ruiz@ruiz.se"), "Victor", "e-postens första del när namn saknas");
  assert.equal(fornamn(null, "vr1987@gmail.com"), null, "ingen hälsning på något som inte ser ut som ett namn");

  const { inbjudareFor } = await import("../server/src/referral/routes.js");
  const a = konto({ email: "victor@ruiz.se" });
  const pa = await profilFor(a, NU);
  assert.deepEqual(await inbjudareFor(pa.kod), { namn: "Victor" });
  assert.deepEqual(await inbjudareFor(pa.kod.toLowerCase().replace("-", "")), { namn: "Victor" });
  assert.equal(await inbjudareFor("AAAA-BBBB"), null);
});

test("popupen om en ny gratisförsäljning visas en gång, och bara för mottagaren", async () => {
  const { a, b } = await paret();
  await efterForstaAnnons({ saljarId: b.id, saleId: "LP-POP", nu: NU });
  const [k] = await krediterFor(a.id, NU);
  assert.equal(k.visadAt ?? null, null, "ny kredit är inte visad");

  await referralStore().markeraVisad(k.id, b.id, NU.toISOString());
  assert.equal((await krediterFor(a.id, NU))[0].visadAt ?? null, null, "någon annan kan inte kvittera");

  await referralStore().markeraVisad(k.id, a.id, NU.toISOString());
  assert.equal((await krediterFor(a.id, NU))[0].visadAt, NU.toISOString());
});
