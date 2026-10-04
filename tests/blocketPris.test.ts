// ─── Blockets prisändring, körd mot attrappen ────────────────────────────────
//
// Prisstegen sänker möbeln varje vecka; Blocket har inget API, så roboten öppnar Blockets eget
// redigeringsformulär (/recommerce/create/<annons-id>, uppmätt 2026-10-02), byter priset och
// sparar. Fem saker måste hålla, och de är valda för att de går sönder tyst:
//
// DIREKTADRESSEN FÖRST. Länken "Ändra annonsen" på Mina annonser ligger i en dold meny; den som
// letar efter en synlig länk hittar ingenting. Adressen är deterministisk, så roboten går dit direkt
// — och tar menyvägen bara när direktadressen inte ger ett formulär.
//
// RUBRIKVAKTEN. Samma adress med ett okänt id ger det TOMMA skapandeformuläret. Ett Spara där hade
// skapat en ny annons. Priset fylls i först när rubriken i formuläret är vår.
//
// RÄTT FÄLT. "Lägsta pris" ligger före "Pris". En luddig etikettsökning skriver det nya priset i fel
// fält, och annonsen står kvar på det gamla.
//
// TORRKÖRNINGEN SPARAR INTE. Provskriptet ska kunna visa hela vägen fram till Spara utan att röra
// annonsen.
//
// SPÄRREN GÄLLER UTAN WEBBLÄSARE. Utan brytaren svarar `flyttaBlocketPris` "manuell" innan Chromium
// ens startas — stegen fortsätter, panelen säger till.
//
// VAD TESTERNA INTE BEVISAR: att sparandet går igenom hos Blocket (var sidan landar, BankID,
// granskning). Det kan bara en skarp körning svara på (npm run blocket:pris -- <jobId> --skarpt).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna datamappar, satta INNAN modulerna läses in.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-blocketpris-jobs-"));
process.env.BLOCKET_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-blocketpris-data-"));
const SESSIONSFIL = path.join(process.env.LOOPA_JOBS_DIR, "blocket-session.json");
writeFileSync(SESSIONSFIL, JSON.stringify({ cookies: [], origins: [] }));
process.env.BLOCKET_SESSION = SESSIONSFIL;
delete process.env.BLOCKET_PUBLICERA;
delete process.env.BLOCKET_PRIS_ROBOT;
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BLOCKET_DATA_DIR!, { recursive: true, force: true });
});

const { startaAttrapp } = await import("./blocketAttrapp.js");
const { startBrowser } = await import("../server/src/integrations/blocket/browser.js");
const { adIdFromUrl, blocketPrisRobotPa, driveBlocketPriceChange, flyttaBlocketPris, prisMonster, rubrikStammer } = await import(
  "../server/src/integrations/blocket/pris.js"
);
import type { Attrapp, AttrappOptions } from "./blocketAttrapp.js";
import type { BlocketStep, ConditionJob } from "../server/src/types.js";

const ANNONS = { id: "24720589", rubrik: "IKEA Strandmon fåtölj i grått", pris: 1800 };
const NYTT_PRIS = 1530;

interface Korning {
  attrapp: Attrapp;
  steg: BlocketStep[];
  resultat: Awaited<ReturnType<typeof driveBlocketPriceChange>> | null;
  fel: Error | null;
}

/** Startar attrappen med annonsen uppe, kör prisändringen mot den och städar efter sig. */
async function kor(opts: { dryRun: boolean; title?: string; attrapp?: AttrappOptions }): Promise<Korning> {
  const attrapp = await startaAttrapp({ annonser: [ANNONS], ...(opts.attrapp ?? {}) });
  process.env.BLOCKET_BAS_URL = attrapp.bas;

  const steg: BlocketStep[] = [];
  const session = await startBrowser();
  let resultat: Korning["resultat"] = null;
  let fel: Error | null = null;
  try {
    resultat = await driveBlocketPriceChange(
      session.page,
      session.context,
      { adUrl: `${attrapp.bas}/${ANNONS.id}`, title: opts.title ?? ANNONS.rubrik, price: NYTT_PRIS, dryRun: opts.dryRun },
      (name, status, details) => steg.push({ name, status, at: new Date().toISOString(), ...(details ? { details } : {}) }),
    );
  } catch (err) {
    fel = err instanceof Error ? err : new Error(String(err));
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
  return { attrapp, steg, resultat, fel };
}

test("annons-id:t läses ur de adresser Blocket faktiskt ger oss", () => {
  assert.equal(adIdFromUrl("https://www.blocket.se/26725957"), "26725957");
  assert.equal(adIdFromUrl("https://www.blocket.se/annons/stockholm/fatolj/26725957/"), "26725957");
  assert.equal(adIdFromUrl("https://www.blocket.se/order-and-payment/ad-receipt?adId=26725957&orderId=1"), "26725957");
  assert.equal(adIdFromUrl("https://www.blocket.se/mina-annonser"), null);
  assert.equal(adIdFromUrl(null), null);
});

test("prismönstret känner igen priset som Blocket skriver det — på annonsen och på ägarsidan", () => {
  const m = prisMonster(2040);
  assert.match("Pris: 2 040 kr", m);
  assert.match("2040 kr", m);
  assert.match("2 040 kr", m, "hårt mellanslag");
  assert.match("Torget säljes 2 040,−", m, "ägarsidan skriver med ,− och utan kr");
  assert.match("Torget säljes 2040,-", m);
  assert.doesNotMatch("12 040 kr", m, "ett annat pris som slutar likadant");
  assert.doesNotMatch("2 040 st", m);
  assert.doesNotMatch("2 040,50 kr", m, "ören är inte ett tankstreck");
  assert.match("Nu 1 530 kr", prisMonster(1530));
});

test("rubrikvakten: tålig mot kapning och putsning, men aldrig tom", () => {
  assert.equal(rubrikStammer("IKEA Strandmon fåtölj i grått", "IKEA Strandmon fåtölj i grått"), true);
  assert.equal(rubrikStammer("ikea  strandmon fåtölj i grått ", "IKEA Strandmon fåtölj i grått"), true, "skiftläge och mellanslag");
  assert.equal(rubrikStammer("IKEA Strandmon fåtölj i grått, nytvättad", "IKEA Strandmon fåtölj i grått"), true, "en admin har putsat slutet");
  assert.equal(rubrikStammer("Svart IKEA NORDVIKEN barstol (62 cm)", "IKEA Strandmon fåtölj i grått"), false, "en annan annons");
  assert.equal(rubrikStammer("", "IKEA Strandmon fåtölj i grått"), false, "det tomma skapandeformuläret");
  assert.equal(rubrikStammer(null, "IKEA Strandmon fåtölj i grått"), false);
});

test("brytaren: egen 1 slår på, egen 0 slår av, osatt följer publiceringen", () => {
  delete process.env.BLOCKET_PUBLICERA;
  delete process.env.BLOCKET_PRIS_ROBOT;
  assert.equal(blocketPrisRobotPa(), false);
  process.env.BLOCKET_PRIS_ROBOT = "1";
  assert.equal(blocketPrisRobotPa(), true, "prisroboten kan vara på innan publiceringsroboten är det");
  process.env.BLOCKET_PRIS_ROBOT = "0";
  process.env.BLOCKET_PUBLICERA = "1";
  assert.equal(blocketPrisRobotPa(), false, "0 stänger av ensam");
  delete process.env.BLOCKET_PRIS_ROBOT;
  assert.equal(blocketPrisRobotPa(), true, "osatt följer skarpt läge");
  delete process.env.BLOCKET_PUBLICERA;
});

test("torrkörningen går direkt till redigeringsformuläret, vaktar rubriken och fyller i priset — men sparar inte", async () => {
  const { attrapp, steg, resultat, fel } = await kor({ dryRun: true });
  assert.equal(fel, null, fel?.message);
  assert.equal(resultat?.status, "torrkorning");

  const lage = attrapp.lage;
  assert.ok(lage.besokta.includes(`/recommerce/create/${ANNONS.id}`), "redigeringen öppnades på direktadressen");
  assert.ok(!lage.besokta.includes("/mina-annonser"), "Mina annonser behövdes inte");
  assert.deepEqual(lage.redigeringar, [], "torrkörningen får aldrig spara");

  const oppnade = steg.find((s) => s.name.startsWith("Öppnade redigeringen"));
  assert.ok(oppnade, "steget som öppnar redigeringen saknas");
  assert.match(oppnade!.name, /direkt adress/);
  assert.equal(oppnade!.details?.rubrik, ANNONS.rubrik, "rubriken lästes ur formuläret");
  assert.ok(steg.some((s) => s.name === `Pris: ${NYTT_PRIS} kr`), "priset fylldes inte i via etiketten");
});

test("skarp körning sparar det nya priset i RÄTT fält, lämnar leveranssidan ifred och läser kvittot på ägarsidan", async () => {
  const { attrapp, steg, resultat, fel } = await kor({ dryRun: false });
  assert.equal(fel, null, fel?.message);
  assert.equal(resultat?.status, "andrad");
  assert.equal(resultat?.verifierad, true, "ägarsidan ska visa det nya priset");
  assert.equal(resultat?.lage, "Aktiv", "en sänkning lämnar annonsen aktiv");

  // "Lägsta pris" ligger före "Pris" på sidan: bara exakt etikettmatchning träffar rätt.
  assert.deepEqual(attrapp.lage.redigeringar, [{ id: ANNONS.id, pris: String(NYTT_PRIS), lagsta: "" }]);
  assert.equal(attrapp.lage.prisNu[ANNONS.id], String(NYTT_PRIS));

  // Spara leder till leveranssidan i redigeringsläge. Den ska besökas (det är dit Blocket går) men
  // ALDRIG sparas: leveransvalet är säljarens.
  assert.ok(attrapp.lage.besokta.includes(`/recommerce/delivery/${ANNONS.id}`), "Spara ska ha lett till leveranssidan");
  assert.deepEqual(attrapp.lage.leveransSparad, [], "leveransvalet rördes");
  assert.ok(attrapp.lage.besokta.includes(`/my-items/details/${ANNONS.id}`), "kvittot läses på ägarsidan");

  const sparade = steg.find((s) => s.name.startsWith("Sparade"));
  assert.ok(sparade, "spara-steget saknas");
  assert.match(sparade!.name, /w-button/, "Spara är en w-button — button:has-text() ska inte kunna matcha den");
  assert.match(String(sparade!.details?.url), /\/recommerce\/delivery\//);
});

test("en HÖJNING sparas också, men annonsen hamnar i granskning och den publika sidan svarar 404 — kvittot läses ändå", async () => {
  // Attrappen härmar det uppmätta: höjt pris = Granskas = publika sidan borta. Verifieringen får inte
  // hänga på den publika sidan, för då ser varje höjning (och varje granskad sänkning) ut som ett fel.
  const attrapp = await startaAttrapp({ annonser: [{ ...ANNONS, pris: 1200 }] });
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const session = await startBrowser();
  try {
    const r = await driveBlocketPriceChange(
      session.page,
      session.context,
      { adUrl: `${attrapp.bas}/${ANNONS.id}`, title: ANNONS.rubrik, price: 1500, dryRun: false },
      () => {},
    );
    assert.equal(r.status, "andrad");
    assert.equal(r.verifierad, true);
    assert.equal(r.lage, "Granskas");
    assert.equal(attrapp.lage.prisNu[ANNONS.id], "1500");
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
});

test("reservvägen: när direktadressen inte ger ett formulär öppnas kortets meny på Mina annonser", async () => {
  const { attrapp, steg, resultat, fel } = await kor({ dryRun: true, attrapp: { redigeringKraverMeny: true } });
  assert.equal(fel, null, fel?.message);
  assert.equal(resultat?.status, "torrkorning");
  assert.ok(attrapp.lage.besokta.includes("/mina-annonser"));
  const oppnade = steg.find((s) => s.name.startsWith("Öppnade redigeringen"));
  assert.match(oppnade!.name, /Mina annonser → menyn/);
});

test("rubrikvakten stoppar: annonsen står som aktiv men redigeringsadressen ger ett tomt skapandeformulär — där sparas ingenting", async () => {
  // Försvar på djupet bakom aktivkontrollen: skulle Blocket någon gång svara med ett tomt formulär
  // för en aktiv annons får det inte bli en ny annons av det.
  const { attrapp, fel } = await kor({ dryRun: false, attrapp: { redigeringTom: true } });
  assert.match(fel?.message ?? "", /ingen rubrik|annan annons/, fel?.message);
  assert.deepEqual(attrapp.lage.redigeringar, [], "ingen annan annons får ha rörts");
  assert.equal(attrapp.lage.publicerad, false, "och framför allt skapas ingen ny annons");
});

test("rubrikvakten stoppar: rätt id men formuläret visar en annan rubrik än vår", async () => {
  const { attrapp, fel } = await kor({ dryRun: false, title: "Svart IKEA NORDVIKEN barstol (62 cm)" });
  assert.match(fel?.message ?? "", /annan annons/);
  assert.deepEqual(attrapp.lage.redigeringar, []);
});

test("en annons som inte längre är aktiv rörs inte — fast redigeringsadressen fortfarande öppnar formuläret", async () => {
  // Uppmätt fara: /recommerce/create/<id> öppnar formuläret även för en utgången annons, och ett Spara
  // där hade publicerat om den. Roboten ska sänka priser, inte lägga ut annonser.
  const { attrapp, fel } = await kor({ dryRun: false, attrapp: { annonser: [{ ...ANNONS, aktiv: false }] } });
  assert.match(fel?.message ?? "", /inte bland de aktiva/);
  assert.ok(!attrapp.lage.besokta.includes(`/recommerce/create/${ANNONS.id}`), "formuläret får inte ens öppnas");
  assert.deepEqual(attrapp.lage.redigeringar, []);
});

test("genom hela jobbvägen blir en inaktiv annons 'för hand', inte ett fel som försöks igen", async () => {
  const attrapp = await startaAttrapp({ annonser: [{ ...ANNONS, aktiv: false }] });
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  process.env.BLOCKET_PUBLICERA = "1";
  const job = {
    id: "pris-inaktiv",
    createdAt: new Date().toISOString(),
    error: null,
    progress: { stage: "done", message: "Klar" },
    result: { listing: { status: "ok", result: { listing: { title: ANNONS.rubrik, description: "", conditionText: "" }, identity: { brand: "IKEA", exactProduct: "Strandmon" }, attributes: [] } } },
    blocket: {
      status: "published",
      url: `${attrapp.bas}/${ANNONS.id}`,
      receiptUrl: null,
      dryRun: false,
      error: null,
      startedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      steps: [],
    },
  } as unknown as ConditionJob;
  try {
    const utfall = await flyttaBlocketPris(job, NYTT_PRIS);
    assert.equal(utfall.status, "manuell");
    assert.match((utfall as { skal: string }).skal, /inte bland de aktiva/);
    assert.deepEqual(attrapp.lage.redigeringar, []);
    assert.ok((job.blocket!.prisSteg ?? []).some((s) => s.name.startsWith("Annonsen är inte aktiv")), "steget ska finnas på jobbet");
  } finally {
    delete process.env.BLOCKET_PUBLICERA;
    await attrapp.stang();
  }
});

test("en utloggad session stoppar innan något rörs", async () => {
  const { attrapp, fel, resultat } = await kor({ dryRun: false, attrapp: { inloggad: false } });
  assert.equal(resultat, null);
  assert.match(fel?.message ?? "", /gått ut/);
  assert.deepEqual(attrapp.lage.redigeringar, []);
});

test("utan brytaren svarar synken 'manuell' — och startar aldrig någon webbläsare", async () => {
  const job = {
    id: "pris-sparr",
    createdAt: new Date().toISOString(),
    error: null,
    result: null,
    progress: { stage: "done", message: "Klar" },
    blocket: {
      status: "published",
      url: "https://www.blocket.se/26725957",
      receiptUrl: null,
      dryRun: false,
      error: null,
      startedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      steps: [],
    },
  } as unknown as ConditionJob;

  delete process.env.BLOCKET_PUBLICERA;
  delete process.env.BLOCKET_PRIS_ROBOT;
  const utfall = await flyttaBlocketPris(job, 2640);
  assert.equal(utfall.status, "manuell");
  assert.match((utfall as { skal: string }).skal, /BLOCKET_PRIS_ROBOT=1/);

  // Avstängd prisrobot i skarpt läge: publiceringen får köra, prisändringen inte.
  process.env.BLOCKET_PUBLICERA = "1";
  process.env.BLOCKET_PRIS_ROBOT = "0";
  try {
    const av = await flyttaBlocketPris(job, 2640);
    assert.equal(av.status, "manuell");
  } finally {
    delete process.env.BLOCKET_PUBLICERA;
    delete process.env.BLOCKET_PRIS_ROBOT;
  }

  // Utan adress finns inget att leta efter.
  const utanUrl = { ...job, blocket: { ...job.blocket!, url: null } } as ConditionJob;
  assert.match(((await flyttaBlocketPris(utanUrl, 2640)) as { skal: string }).skal, /adress saknas/);
});
