// ─── Samarbetslänken loopa.nu/k/massproduction ───────────────────────────────
//
// En partner delar den här länken i sina egna kanaler. Den ska fungera i varje form folk kan tänkas
// skriva den, alltid finnas, aldrig gå att ta bort, och varje besök ska hamna under Samarbeten →
// massproduction i Varifrån och på länkens rad under Kampanjlänkar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const kampanjer = await import("../server/src/data/kampanjer.js");
const besok = await import("../server/src/data/besok.js");
const { helaResan } = await import("../server/src/data/kundresa.js");

async function nyKatalog(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "loopa-kampanjlank-"));
  process.env.DATA_FLODE_DIR = dir;
  kampanjer.nollstall();
  besok.nollstall();
  return dir;
}

test("länken finns utan att någon skapat den, och står först i panelens lista", async () => {
  await nyKatalog();
  const alla = await kampanjer.allaKampanjer();
  assert.equal(alla[0].kod, "massproduction");
  assert.equal(alla[0].plats, "massproduction");
  assert.equal(alla[0].mal, "/");
  assert.equal(alla[0].fast, true);
  assert.ok(!("aliaser" in alla[0]), "aliasen är serverns, inte panelens");
});

test("den exakta adressen ger appskalet, med koden", async () => {
  await nyKatalog();
  assert.deepEqual(await kampanjer.kampanjSvar("/k/massproduction", ""), { typ: "appen", kod: "massproduction" });
});

test("varje annan stavning omdirigeras till den exakta adressen, med queryn kvar", async () => {
  await nyKatalog();
  const fall: Array<[string, string, string]> = [
    ["/k/massproduction/", "", "/k/massproduction"],
    ["/k/MassProduction", "", "/k/massproduction"],
    ["/k/MASSPRODUCTION", "", "/k/massproduction"],
    ["/K/massproduction", "", "/k/massproduction"],
    ["/k/mass-production", "", "/k/massproduction"],
    ["/k/Mass_Production", "", "/k/massproduction"],
    ["/k/Mass%20Production", "", "/k/massproduction"],
    ["/k/massproductionab", "", "/k/massproduction"],
    ["/k/massprod", "", "/k/massproduction"],
    ["/k/MassProduction", "?fbclid=abc123", "/k/massproduction?fbclid=abc123"],
  ];
  for (const [vag, query, dit] of fall) {
    assert.deepEqual(await kampanjer.kampanjSvar(vag, query), { typ: "omdirigera", location: dit }, vag);
  }
});

test("en trasig eller okänd länk leder till säljsidan — aldrig ett fel", async () => {
  await nyKatalog();
  for (const vag of ["/k/finnsinte", "/k/", "/k/a/b", "/k/%E0%A4%A", "/k/" + "x".repeat(200)]) {
    assert.deepEqual(await kampanjer.kampanjSvar(vag, ""), { typ: "omdirigera", location: "/" }, vag);
  }
  assert.equal(await kampanjer.kampanjSvar("/butik", ""), null, "andra sidor rörs inte");
});

test("panelens slumpade länkar fungerar som förut", async () => {
  await nyKatalog();
  const k = await kampanjer.skapaKampanj({ namn: "Affisch", plats: "affisch", mal: "/" }, null);
  assert.match(k.kod, /^[a-hjkmnp-z2-9]{5}$/);
  assert.deepEqual(await kampanjer.kampanjSvar(`/k/${k.kod}`, ""), { typ: "appen", kod: k.kod });
  const b = await kampanjer.skapaKampanj({ namn: "Butik", plats: "affisch", mal: "/butik" }, null);
  assert.deepEqual(await kampanjer.kampanjSvar(`/k/${b.kod}`, ""), { typ: "omdirigera", location: `/butik?k=${b.kod}` });
  assert.deepEqual((await kampanjer.allaKampanjer()).map((x) => x.kod), ["massproduction", b.kod, k.kod]);
});

test("den går inte att ta bort, och en datafil kan inte skugga den", async () => {
  const dir = await nyKatalog();
  assert.equal(await kampanjer.taBortKampanj("massproduction"), false);
  assert.ok(await kampanjer.kampanjFor("massproduction"));

  // En gammal eller handredigerad datafil med samma kod ska inte ge två rader eller byta mål.
  await writeFile(
    path.join(dir, "kampanjer.json"),
    JSON.stringify([{ kod: "massproduction", namn: "Fel", plats: "affisch", mal: "/butik", skapad: "2026-01-01", av: null }]),
  );
  kampanjer.nollstall();
  const alla = await kampanjer.allaKampanjer();
  assert.equal(alla.filter((k) => k.kod === "massproduction").length, 1);
  assert.equal((await kampanjer.kampanjFor("massproduction"))!.mal, "/");
});

test("ett besök genom länken: Samarbeten → massproduction, och räknas på länkens rad", async () => {
  await nyKatalog();
  // Klienten skickar koden; källan skrivs av servern, så en förfalskad utm_source räknas inte.
  await besok.spara("mpsess0000000001", "landning", { sida: "/", kampanjkod: "massproduction", utm_source: "falsk", enhet: "mobil" });
  await besok.spara("mpsess0000000001", "sida", { sida: "/" });
  // Även en kod som kommer fram med versaler räknas på samma rad.
  await besok.spara("mpsess0000000002", "landning", { sida: "/", kampanjkod: "MassProduction" });
  await besok.spara("mpsess0000000002", "sida", { sida: "/" });

  const alla = await besok.allaBesok();
  for (const b of alla) {
    assert.equal(b.kanal, "Samarbeten");
    assert.equal(b.kalla, "massproduction");
    assert.equal(b.kampanjkod, "massproduction");
  }
  const kods = (await kampanjer.allaKampanjer()).map((k) => k.kod);
  const svar = helaResan({ besok: alla, floden: [], admins: new Set(), dagar: 30, kanal: null, kampanjkoder: kods, enhet: null, nu: new Date(Date.now() + 1000), annonser: [] });
  assert.equal(svar.perKampanj.find((r) => r.kod === "massproduction")!.besok, 2);
  const kanal = svar.perKanal.find((k) => k.kanal === "Samarbeten")!;
  assert.equal(kanal.besok, 2);
  assert.deepEqual(kanal.kallor.map((k) => k.kalla), ["massproduction"]);
  assert.equal(svar.matning.viaLank, 2);
});

test("/salj/massproduction: samma länk under rutten som redan ligger ute", async () => {
  await nyKatalog();
  assert.deepEqual(await kampanjer.saljKampanjSvar("/salj/massproduction", ""), { typ: "appen", kod: "massproduction" });
  for (const vag of ["/salj/massproduction/", "/salj/MassProduction", "/SALJ/mass-production"]) {
    assert.deepEqual(await kampanjer.saljKampanjSvar(vag, "?fbclid=1"), { typ: "omdirigera", location: "/salj/massproduction?fbclid=1" }, vag);
  }
  // Allt annat under /salj/ ska få den gamla 301:an till roten — anroparen gör den på null.
  for (const vag of ["/salj", "/salj/", "/salj/steg-2", "/salj/a/b", "/salj/finnsinte"]) {
    assert.equal(await kampanjer.saljKampanjSvar(vag, ""), null, vag);
  }
});

test("Massproductions-valet räknas på länkens rad: annonser och säljare som valde credits", async () => {
  await nyKatalog();
  // Tre säljare via länken. A lämnar två möbler (credits och pengar), B väljer pengar, C credits.
  // D kom via länken men har en möbel av ett annat märke — inget val, och räknas inte.
  for (const [s, uid] of [["mpsessA000000001", "user-aaaaaaaa"], ["mpsessB000000001", "user-bbbbbbbb"], ["mpsessC000000001", "user-cccccccc"], ["mpsessD000000001", "user-dddddddd"]]) {
    await besok.spara(s, "landning", { sida: "/", kampanjkod: "massproduction" }, uid);
  }
  const alla = await besok.allaBesok();
  const nu = new Date(Date.now() + 1000);
  const igar = new Date(Date.now() - 1000).toISOString();
  // Annonserna hittar länken genom säljarens första besök, så inga flöden behövs.
  const annons = (jobId: string, ownerId: string, ersattning: "pengar" | "credits" | null) => ({
    jobId, ownerId, skapad: igar, fardig: true, overlamnad: ersattning ? igar : null, godkand: null, sald: null, ersattning,
  });
  const svar = helaResan({
    besok: alla,
    floden: [],
    admins: new Set(),
    dagar: 30,
    kanal: null,
    kampanjkoder: ["massproduction"],
    enhet: null,
    nu,
    annonser: [annons("jA1", "user-aaaaaaaa", "credits"), annons("jA2", "user-aaaaaaaa", "pengar"), annons("jB", "user-bbbbbbbb", "pengar"), annons("jC", "user-cccccccc", "credits"), annons("jD", "user-dddddddd", null)],
  });
  const rad = svar.perKampanj.find((r) => r.kod === "massproduction")!;
  assert.equal(rad.annonser, 5);
  assert.deepEqual(rad.ersattning, { credits: 2, pengar: 2, saljare: 3, saljareCredits: 2 });
});
