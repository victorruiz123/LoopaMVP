// ─── data/besok: besöksmätningen ─────────────────────────────────────────────
//
// KANALEN är regeln panelen läser allt annat genom. Sorterar den fel är felet TYST — en inbjudan som
// räknas som Facebook ser ut som ett rimligt tal. Ordningen prövas därför uttryckligen.
//
// NORMALISERINGEN är säkerheten: vägen in är öppen, och en kod eller ett token i en sökväg får aldrig
// hamna i en sidlista någon annan läser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const besok = await import("../server/src/data/besok.js");
const flode = await import("../server/src/data/flode.js");

// En katalog per test: loggfilen är sanningen och `nollstall` läser om den, så ett test som delade
// fil med ett annat hade räknat det andras besök.
let dir = "";
async function nyKatalog(): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), "loopa-besok-"));
  process.env.DATA_FLODE_DIR = dir;
  besok.nollstall();
  flode.nollstall();
}


const SESS_A = "aaaaaaaa11111111";
const SESS_B = "bbbbbbbb22222222";
const SESS_C = "cccccccc33333333";

test("kanalen: inbjudan före UTM före värdnamn, och tomt är Direkt", () => {
  assert.equal(besok.kanalFor({ inbjudan: true, utm_source: "facebook", host: "google.com" }).kanal, "Inbjudan");
  assert.equal(besok.kanalFor({ affiliate: true, host: "google.com" }).kanal, "Affiliate");
  assert.equal(besok.kanalFor({ utm_source: "instagram", host: "google.com" }).kanal, "Sociala medier");
  assert.equal(besok.kanalFor({ utm_source: "nyhetsbrev", utm_medium: "email" }).kanal, "E-post");
  assert.equal(besok.kanalFor({ utm_source: "affisch" }).kanal, "Kampanj");
  assert.equal(besok.kanalFor({ host: "www.google.se" }).kanal, "Sök");
  assert.equal(besok.kanalFor({ host: "l.facebook.com" }).kanal, "Sociala medier");
  assert.equal(besok.kanalFor({ host: "l.facebook.com" }).kalla, "facebook.com");
  assert.equal(besok.kanalFor({ host: "www.blocket.se" }).kanal, "Marknadsplatser");
  assert.equal(besok.kanalFor({ host: "loopa.nu" }).kanal, "Marknadssajten");
  assert.equal(besok.kanalFor({ host: "app.loopa.nu" }).kanal, "Direkt");
  assert.equal(besok.kanalFor({}).kanal, "Direkt");
  assert.equal(besok.kanalFor({ host: "exempel.se" }).kanal, "Övrigt");
});

test("sidan: id:n och koder slipas bort, slugs står kvar", () => {
  assert.equal(besok.normaliseraSida("/c/LP-AB12-CD34"), "/c/:id");
  assert.equal(besok.normaliseraSida("/i/ABCD-EF23"), "/i/:kod");
  assert.equal(besok.normaliseraSida("/a/hemligt-token-123"), "/a/:kod");
  assert.equal(besok.normaliseraSida("/butik/mobel/matbord?q=ek"), "/butik/mobel/matbord");
  assert.equal(besok.normaliseraSida("/butik/annons/3f2a9c1e-1111-2222-3333-444455556666"), "/butik/annons/:id");
  assert.equal(besok.normaliseraSida("/", "capture"), "/ · capture");
  assert.equal(besok.normaliseraSida("/", "home"), "/");
  assert.equal(besok.normaliseraSida("/", "<script>"), "/");
  assert.equal(besok.normaliseraSida("https://ond.se/x"), null);
});

test("skrivningen: vitlistan håller, och bara första landningen räknas", async () => {
  await nyKatalog();
  await besok.spara(SESS_A, "landning", { sida: "/", host: "www.google.se", epost: "a@b.se" });
  await besok.spara(SESS_A, "landning", { sida: "/" }); // omladdning — utan referrer
  await besok.spara(SESS_A, "hittepa", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/" }); // dubblett
  await besok.spara(SESS_A, "sida", { sida: "/butik/mobel/soffa", fran: "/" });

  const fil = await readFile(path.join(dir, "besok.jsonl"), "utf-8");
  assert.ok(!fil.includes("a@b.se"), "en egenskap utanför vitlistan får aldrig nå disken");
  assert.ok(!fil.includes("hittepa"));

  const [b] = await besok.allaBesok();
  assert.equal(b.kanal, "Sök", "omladdningen utan referrer får inte göra besöket till Direkt");
  assert.deepEqual(b.sidor.map((s) => s.sida), ["/", "/butik/mobel/soffa"]);
});

test("trafiken: kanaler, nya konton med källa, konvertering via flödet, adminer räknas inte", async () => {
  await nyKatalog();
  // A: från Instagram (UTM), registrerar sig och når ett intygat kort.
  await besok.spara(SESS_A, "landning", { sida: "/", utm_source: "instagram", utm_campaign: "Host" });
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await besok.spara(SESS_A, "sida", { sida: "/", vy: "capture" });
  await besok.spara(SESS_A, "konto", {}, "user-aaaaaaaa");
  await flode.spara(SESS_A, null, "steg", { steg: "capture", ms: 1000 });
  await flode.spara(SESS_A, "job-1", "intygat", { steg: "listing" }, "user-aaaaaaaa");
  // B: från Google, studsar.
  await besok.spara(SESS_B, "landning", { sida: "/kop", host: "google.se" });
  await besok.spara(SESS_B, "sida", { sida: "/kop" });
  // C: en admin som klickar runt.
  await besok.spara(SESS_C, "landning", { sida: "/butik" });
  await besok.spara(SESS_C, "sida", { sida: "/butik" }, "admin-aaaaaaaa");

  const nu = new Date();
  const konton = [
    { id: "user-aaaaaaaa", name: "Anna", email: null, signedUpAt: nu.toISOString(), signupApproximate: false, isAdmin: false },
    { id: "user-bbbbbbbb", name: "Bo", email: null, signedUpAt: nu.toISOString(), signupApproximate: false, isAdmin: false },
    { id: "admin-aaaaaaaa", name: "Admin", email: null, signedUpAt: null, signupApproximate: false, isAdmin: true },
  ];
  const svar = besok.trafik(await besok.allaBesok(), await flode.allaSessioner(), konton, 30, new Date(nu.getTime() + 1000));

  assert.equal(svar.summering.besok, 2, "adminens besök ska inte räknas");
  assert.equal(svar.summering.nyaKonton, 2);
  assert.equal(svar.summering.nyaKontonUtanKalla, 1);
  assert.equal(svar.summering.intygade, 1);

  const social = svar.kanaler.find((k) => k.kanal === "Sociala medier");
  assert.ok(social);
  assert.equal(social.nyaKonton, 1);
  assert.equal(social.paborjade, 1);
  assert.equal(social.intygade, 1);
  const sok = svar.kanaler.find((k) => k.kanal === "Sök");
  assert.equal(sok?.studs, 1);

  const anna = svar.nyaKonton.find((k) => k.id === "user-aaaaaaaa");
  assert.equal(anna?.kanal, "Sociala medier");
  assert.equal(anna?.kampanj, "host");
  assert.deepEqual(anna?.vag, ["/", "/ · capture"]);
  assert.equal(anna?.intygat, true);

  assert.deepEqual(svar.kampanjer.map((k) => k.kampanj), ["host"]);
  assert.ok(svar.overgangar.some((o) => o.fran === "/" && o.till === "/ · capture"));
  assert.equal(svar.sidor.find((s) => s.sida === "/kop")?.utgang, 1);
});

test("raderingen: kontots besök stryks, andras lämnas", async () => {
  await nyKatalog();
  await besok.spara(SESS_A, "sida", { sida: "/" });
  await besok.spara(SESS_A, "konto", {}, "user-aaaaaaaa");
  await besok.spara(SESS_B, "sida", { sida: "/kop" });
  assert.equal(await besok.glomKonto("user-aaaaaaaa"), 1);
  const kvar = await besok.allaBesok();
  assert.ok(kvar.every((b) => b.sess !== SESS_A));
  assert.ok(kvar.some((b) => b.sess === SESS_B));
});
