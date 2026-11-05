// ─── data/kundresa: hela resan, från besöket till utbetalningen ──────────────
//
// TRATTEN FÅR ALDRIG VÄXA NEDÅT. Fler sålda än godkända, eller fler färdiga än påbörjade, ser ut som
// ett rimligt tal i panelen och är ett fel — därför prövas bakifrånregeln uttryckligen.
//
// DE NYA BESÖKSRADERNA är en öppen väg in, precis som de gamla: namnen prövas mot sina listor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const besok = await import("../server/src/data/besok.js");
const flode = await import("../server/src/data/flode.js");
const { helaResan, tidslinje } = await import("../server/src/data/kundresa.js");

let dir = "";
async function nyKatalog(): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), "loopa-kundresa-"));
  process.env.DATA_FLODE_DIR = dir;
  besok.nollstall();
  flode.nollstall();
}

const SESS_A = "aaaaaaaa11111111";
const SESS_B = "bbbbbbbb22222222";
const SESS_C = "cccccccc33333333";

test("besöket: sektioner, klick, scroll och butikshändelser — bara namn ur listorna", async () => {
  await nyKatalog();
  await besok.spara(SESS_A, "landning", { sida: "/butik" });
  await besok.spara(SESS_A, "sida", { sida: "/butik" });
  await besok.spara(SESS_A, "sektion", { sida: "/butik", namn: "butik_marken" });
  await besok.spara(SESS_A, "sektion", { sida: "/butik", namn: "<script>" });
  await besok.spara(SESS_A, "klick", { sida: "/butik", namn: "butik_marken" });
  await besok.spara(SESS_A, "handling", { sida: "/butik", namn: "begin_checkout", objekt: "lp-ab12-cd34" });
  await besok.spara(SESS_A, "handling", { sida: "/butik", namn: "hittepa" });
  await besok.spara(SESS_A, "scroll", { sida: "/butik", djup: 75 });
  await besok.spara(SESS_A, "scroll", { sida: "/butik", djup: 33 });

  const fil = await readFile(path.join(dir, "besok.jsonl"), "utf-8");
  assert.ok(!fil.includes("<script>"));
  assert.ok(!fil.includes("hittepa"));
  assert.ok(!fil.includes('"djup":33'), "bara fjärdedelar är scrolldjup");

  const [b] = await besok.allaBesok();
  assert.deepEqual(b.sektioner.map((s) => s.namn), ["butik_marken"]);
  assert.deepEqual(b.klick.map((k) => k.namn), ["butik_marken"]);
  assert.deepEqual(b.handlingar.map((h) => [h.namn, h.objekt]), [["begin_checkout", "LP-AB12-CD34"]]);
  assert.equal(b.sidor[0].djup, 75, "scrollen hör till visningen av samma sida");
});

test("resan: två delar, bakifrånregeln, kanalen följer annonsen, adminer räknas inte", async () => {
  await nyKatalog();
  // A: Instagram, filmar, laddar upp och får en färdig annons (job-1), som säljs och betalas ut.
  await besok.spara(SESS_A, "landning", { sida: "/", utm_source: "instagram", enhet: "mobil" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/", vy: "capture" });
  await flode.spara(SESS_A, null, "mikro", { steg: "capture", namn: "kamera_oppnad" });
  await flode.spara(SESS_A, "job-1", "mikro", { steg: "starting", namn: "uppladdat" }, "user-aaaaaaaa");
  await flode.spara(SESS_A, "job-1", "intygat", { steg: "listing" }, "user-aaaaaaaa");
  // B: Google, börjar filma och ger upp.
  await besok.spara(SESS_B, "landning", { sida: "/", host: "google.se", enhet: "dator" });
  await besok.spara(SESS_B, "sida", { sida: "/" });
  await flode.spara(SESS_B, null, "mikro", { steg: "capture", namn: "kamera_oppnad" });
  // C: en admin.
  await besok.spara(SESS_C, "landning", { sida: "/" });
  await besok.spara(SESS_C, "sida", { sida: "/" }, "admin-aaaaaaaa");

  const nu = new Date(Date.now() + 1000);
  const igar = new Date(nu.getTime() - 24 * 3600 * 1000).toISOString();
  const svar = helaResan({
    besok: await besok.allaBesok(),
    floden: await flode.allaSessioner(),
    admins: new Set(["admin-aaaaaaaa"]),
    dagar: 30,
    kanal: null,
    kampanjkoder: [],
    enhet: null,
    nu,
    annonser: [
      // Såld, men utan godkännandets tidsstämpel: den räknas ändå som godkänd.
      { jobId: "job-1", ownerId: "user-aaaaaaaa", skapad: igar, fardig: true, overlamnad: igar, godkand: null, sald: igar },
      // Lämnad till Loopa och väntar i kön.
      { jobId: "job-2", ownerId: "user-bbbbbbbb", skapad: igar, fardig: true, overlamnad: igar, godkand: null, sald: null },
      // Inte färdig: räknas inte alls.
      { jobId: "job-3", ownerId: "user-bbbbbbbb", skapad: igar, fardig: false, overlamnad: null, godkand: null, sald: null },
      // Adminens: räknas inte.
      { jobId: "job-4", ownerId: "admin-aaaaaaaa", skapad: igar, fardig: true, overlamnad: igar, godkand: null, sald: null },
    ],
  });

  assert.deepEqual(svar.besoksdel.map((s) => s.antal), [2, 2, 1, 1]);
  assert.deepEqual(svar.annonsdel.map((s) => s.antal), [2, 2, 1, 1], "såld betyder godkänd, även utan tidsstämpel");
  assert.equal(svar.ko.vantar, 1);

  const instagram = svar.perKanal.find((k) => k.kanal === "Sociala medier");
  assert.equal(instagram?.annonser, 1, "annonsen bär kanalen från besöket där den filmades");
  assert.equal(instagram?.salda, 1);
  assert.equal(svar.perKanal.at(-1)?.kanal, "Okänd", "Okänd står sist");

  const bara = helaResan({
    besok: await besok.allaBesok(),
    floden: await flode.allaSessioner(),
    admins: new Set(["admin-aaaaaaaa"]),
    dagar: 30,
    kanal: null,
    kampanjkoder: [],
    enhet: "dator",
    nu,
    annonser: [],
  });
  assert.equal(bara.besoksdel[0].antal, 1, "enhetsfiltret håller");

  assert.deepEqual(instagram?.kallor.map((k) => [k.kalla, k.besok, k.annonser]), [["instagram", 1, 1]], "källan inom kanalen");
  assert.equal(instagram?.forraBesok, null, "ingen förra period när besöken inte mättes då");
  // Ingångarna: varje besök räknas en gång, efter hur långt det kom.
  assert.deepEqual(svar.beteende.alla.utfall, { lamnade: 0, tittade: 0, mobler: 0, salja: 1, annons: 1 });
  assert.equal(svar.matning.utanKalla, 0);
  assert.equal(svar.beteende.sessioner.length, 2);
});

test("tidslinjen: landningen först, sidorna och flödet i ordning", async () => {
  await nyKatalog();
  await besok.spara(SESS_A, "landning", { sida: "/", host: "google.se" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await flode.spara(SESS_A, null, "mikro", { steg: "capture", namn: "kamera_oppnad" });
  const [b] = await besok.allaBesok();
  const [f] = await flode.allaSessioner();
  const linje = tidslinje(b, f);
  assert.equal(linje.punkter[0].typ, "landning");
  assert.deepEqual(linje.punkter.map((p) => p.typ), ["landning", "sida", "flode"]);
});

test("kampanjlänken: koden slås upp på servern och ger kanal, källa och resultat", async () => {
  await nyKatalog();
  const kampanjer = await import("../server/src/data/kampanjer.js");
  kampanjer.nollstall();
  const k = await kampanjer.skapaKampanj({ namn: "Affisch Söder", plats: "affisch", mal: "/" }, null);
  assert.ok(kampanjer.arKod(k.kod));
  await assert.rejects(kampanjer.skapaKampanj({ namn: "", plats: "affisch" }, null));
  await assert.rejects(kampanjer.skapaKampanj({ namn: "x", plats: "hittepa" }, null));

  await besok.spara(SESS_A, "landning", { sida: "/", kampanjkod: k.kod, utm_source: "falsk" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await besok.spara(SESS_B, "landning", { sida: "/", kampanjkod: "zzzzz" });
  await besok.spara(SESS_B, "sida", { sida: "/" });
  const alla = await besok.allaBesok();
  const a = alla.find((b) => b.sess === SESS_A)!;
  assert.equal(a.kanal, "Offline", "källan är serverns, inte länkens");
  assert.equal(a.kalla, "affisch");
  assert.equal(a.kampanjkod, k.kod);
  const b = alla.find((x) => x.sess === SESS_B)!;
  assert.equal(b.kampanjkod, null, "en okänd kod räknas inte");
  assert.equal(b.kanal, "Direkt");

  const svar = helaResan({ besok: alla, floden: [], admins: new Set(), dagar: 30, kanal: null, kampanjkoder: [k.kod], enhet: null, nu: new Date(Date.now() + 1000), annonser: [] });
  assert.deepEqual(svar.perKampanj.map((r) => [r.kod, r.besok]), [[k.kod, 1]]);
  assert.deepEqual([svar.matning.besok, svar.matning.viaLank, svar.matning.utanKalla], [2, 1, 1]);
});

test("säljflödet: ordningen är appens i dag — inget konto mitt i, och målet är att lämna till Loopa", async () => {
  await nyKatalog();
  const { SALJSTEG } = await import("../server/src/data/kundresa.js");
  assert.ok(!SALJSTEG.includes("signup" as never), "kontot frågas först i Sälj med Loopa");
  assert.deepEqual(SALJSTEG.slice(-3), ["listing", "salj", "lamnad"]);

  // A: filmar, får ett kort, trycker Sälj med Loopa och möter kontot — och stannar där.
  await besok.spara(SESS_A, "landning", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await flode.spara(SESS_A, null, "mikro", { steg: "home", namn: "startsida" });
  await flode.spara(SESS_A, "job-a", "mikro", { steg: "capture", namn: "kamera_oppnad" });
  await flode.spara(SESS_A, "job-a", "intygat", { steg: "listing" });
  await flode.spara(SESS_A, "job-a", "klick", { steg: "listing", namn: "publicera" });
  await flode.spara(SESS_A, "job-a", "mikro", { steg: "listing", namn: "konto" });
  // B: samma väg, och annonsen kom fram — det står i jobbet, inte i flödet.
  await besok.spara(SESS_B, "landning", { sida: "/" });
  await besok.spara(SESS_B, "sida", { sida: "/" });
  await flode.spara(SESS_B, "job-b", "mikro", { steg: "capture", namn: "kamera_oppnad" });
  await flode.spara(SESS_B, "job-b", "intygat", { steg: "listing" });
  // C: öppnar sin annons igen från profilen — inget nytt försök, räknas inte.
  await besok.spara(SESS_C, "landning", { sida: "/" });
  await besok.spara(SESS_C, "sida", { sida: "/" });
  await flode.spara(SESS_C, "job-b", "steg", { steg: "listing", ms: 1000 });

  const igar = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const svar = helaResan({
    besok: await besok.allaBesok(),
    floden: await flode.allaSessioner(),
    admins: new Set(),
    dagar: 30,
    kanal: null,
    kampanjkoder: [],
    enhet: null,
    nu: new Date(Date.now() + 1000),
    annonser: [{ jobId: "job-b", ownerId: null, skapad: igar, fardig: true, overlamnad: igar, godkand: null, sald: null }],
  });
  const steg = new Map(svar.beteende.saljflode.map((s) => [s.steg, s]));
  assert.equal(steg.get("capture")?.nadde, 2, "profilbesöket räknas inte som ett nytt försök");
  assert.equal(steg.get("salj")?.nadde, 2, "att lämna till Loopa betyder att de tryckte");
  assert.equal(steg.get("lamnad")?.nadde, 1);
  assert.deepEqual(steg.get("salj")?.fel, [{ namn: "konto_vid_publicering", antal: 1 }]);
});

test("ingångarna: köparnas sidor står inte med, och räknas inte in i snittet", async () => {
  await nyKatalog();
  await besok.spara(SESS_A, "landning", { sida: "/butik" });
  await besok.spara(SESS_A, "sida", { sida: "/butik" });
  await besok.spara(SESS_B, "landning", { sida: "/" });
  await besok.spara(SESS_B, "sida", { sida: "/" });
  const svar = helaResan({
    besok: await besok.allaBesok(),
    floden: await flode.allaSessioner(),
    admins: new Set(),
    dagar: 30,
    kanal: null,
    kampanjkoder: [],
    enhet: null,
    nu: new Date(Date.now() + 1000),
    annonser: [],
  });
  assert.equal(svar.beteende.alla.besok, 1, "bara besöket som landade på säljsidan");
});

test("just nu: bara besök de senaste fem minuterna, och skärmen säljaren står på", async () => {
  await nyKatalog();
  const { justNu } = await import("../server/src/data/kundresa.js");
  await besok.spara(SESS_A, "landning", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await flode.spara(SESS_A, null, "mikro", { steg: "capture", namn: "kamera_oppnad" });
  await besok.spara(SESS_B, "landning", { sida: "/butik" });
  await besok.spara(SESS_B, "sida", { sida: "/butik" });
  const alla = await besok.allaBesok();
  const floden = await flode.allaSessioner();

  const nu = justNu(alla, floden, new Set(), new Date(Date.now() + 1000));
  assert.equal(nu.besokare, 2);
  assert.equal(nu.iSaljflodet, 1);
  assert.ok(nu.perPlats.some((p) => p.plats === "/ · capture"), "säljaren står i filmningen");

  const senare = justNu(alla, floden, new Set(), new Date(Date.now() + 10 * 60_000));
  assert.equal(senare.besokare, 0, "efter fem minuter utan något nytt är besöket inte pågående");
});
