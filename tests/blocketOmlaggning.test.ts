// ─── Veckans omläggning på Blocket, hela vägen, mot attrappen ────────────────
//
// Frågan: när veckans sänkning kommer, tas Blocket-annonsen NER och läggs den upp IGEN med det SÄNKTA
// priset — och kan något som stoppar uppläggningen göra att möbeln blir liggande nere?
//
// ALLT ÄR DEN RIKTIGA KODEN, inget injicerat utom breven: veckovarvet (priceLadder.ts), omläggningen
// (omlaggning.ts), förberedelsen och sista knappen (blocket/publish.ts), borttagningen
// (blocket/borttagning.ts) och planen ur jobbet (planBlocketPublish: priset ur stegen, frakten,
// postnumret, bilderna på disk).
//
// ORDNINGEN SOM PRÖVAS, och varför: skarpt 2026-10-20 togs barstolen ner och den nya annonsen fastnade
// sedan på BankID, och en bild tappades tyst. Nu förbereds den nya annonsen hela vägen till sista
// knappen FÖRST; bara om det gick tas den gamla ner, och sist trycks knappen.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// En tappad bild väntas in i 15 s i drift; här räcker det med en kort stund.
process.env.BLOCKET_BILD_VANTA_MS = "2500";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-omlagg-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-omlagg-butik-"));
process.env.BLOCKET_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-omlagg-data-"));
const SESSIONSFIL = path.join(process.env.BLOCKET_DATA_DIR, "blocket-session.json");
writeFileSync(SESSIONSFIL, JSON.stringify({ cookies: [], origins: [] }));
process.env.BLOCKET_SESSION = SESSIONSFIL;
process.env.BLOCKET_TA_BORT_ROBOT = "1";
process.env.BLOCKET_PUBLICERA = "1";
delete process.env.BLOCKET_SYNLIG;
delete process.env.TRADERA_APP_ID;
delete process.env.PRIS_OMLAGGNING;
process.on("exit", () => {
  for (const d of [process.env.LOOPA_JOBS_DIR!, process.env.BUTIK_DATA_DIR!, process.env.BLOCKET_DATA_DIR!]) rmSync(d, { recursive: true, force: true });
});

const { startaAttrapp } = await import("./blocketAttrapp.js");
const { skrivJobb } = await import("./facebookFixtur.js");
const { nyttKanalPris, tickPriceLadders } = await import("../server/src/priceLadder.js");
const { getJob, persist } = await import("../server/src/jobStore.js");
import type { Attrapp, AttrappOptions } from "./blocketAttrapp.js";
import type { ConditionJob } from "../server/src/types.js";
import type { KanalPrisLage } from "../server/src/priceLadder.js";

const RUBRIK = "Sweef Cloud 3-sits soffa i grå sammet";
const GAMMALT_ID = "21946768";
const FRAKT = 600;
const WEEK = 7 * 24 * 60 * 60 * 1000;
let lopnummer = 0;

const skapade: ConditionJob[] = [];
let attrapp: Attrapp | null = null;
afterEach(async () => {
  for (const j of skapade) {
    j.removedAt = new Date().toISOString();
    await persist(j);
  }
  skapade.length = 0;
  await attrapp?.stang();
  attrapp = null;
});

/** Ett besiktigat jobb vars Blocket-annons ligger uppe på 2 400 kr + frakt, med en sänkning som förfallit. */
async function upplagt(attrappOpts: AttrappOptions = {}): Promise<{ job: ConditionJob; attrapp: Attrapp }> {
  attrapp = await startaAttrapp({ annonser: [{ id: GAMMALT_ID, rubrik: RUBRIK, pris: 2400 + FRAKT }], ...attrappOpts });
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const nu = Date.now();
  lopnummer += 1;
  const id = `0000000${lopnummer}-2222-4333-8444-555555555555`;
  skrivJobb(process.env.LOOPA_JOBS_DIR!, { id, title: RUBRIK });
  const job = (await getJob(id))!;
  Object.assign(job, {
    sellerPostalCode: "11234",
    priceLadder: {
      startPrice: 2400,
      floorPrice: 1500,
      weeklyDropPct: 0.15,
      currentPrice: 2400,
      nextDropAt: new Date(nu - 60_000).toISOString(),
      drops: [],
      floorReachedAt: null,
      lastError: null,
      chosenAt: new Date(nu - 2 * WEEK).toISOString(),
      listingMode: "fixed",
    },
    blocket: {
      status: "published",
      url: `${attrapp.bas}/${GAMMALT_ID}`,
      receiptUrl: null,
      dryRun: false,
      error: null,
      startedAt: new Date(nu - WEEK).toISOString(),
      publishedAt: new Date(nu - WEEK).toISOString(),
      steps: [],
      shippingSek: FRAKT,
      pris: nyttKanalPris(2400, "publicering", nu - WEEK),
    },
  });
  await persist(job);
  skapade.push(job);
  return { job, attrapp };
}

function brevlada() {
  const manuella: Array<{ lage: KanalPrisLage; annonspris: number }> = [];
  const nere: string[] = [];
  return {
    manuella,
    nere,
    beroenden: {
      larma: async (_j: ConditionJob, lage: KanalPrisLage, annonspris: number) => {
        manuella.push({ lage, annonspris });
      },
      larmaNere: async (_j: ConditionJob, _k: string, fel: string) => {
        nere.push(fel);
      },
    },
  };
}

test("veckans sänkning: Blocket-annonsen tas ner och läggs upp igen med det SÄNKTA priset", async () => {
  const { job, attrapp } = await upplagt();
  const post = brevlada();
  await tickPriceLadders(Date.now(), post.beroenden);

  assert.equal(job.priceLadder!.currentPrice, 2040, "veckans sänkning: 2 400 → 2 040 kr");
  assert.deepEqual(attrapp.lage.borttagna, [{ id: GAMMALT_ID, skal: null }], "den gamla annonsen togs ner");
  assert.deepEqual(attrapp.lage.markeradeSalda, []);
  assert.deepEqual(attrapp.lage.redigeringar, [], "priset ändrades INTE på den gamla annonsen");
  assert.equal(attrapp.lage.formular?.pris, String(2040 + FRAKT), "den nya annonsen bär det SÄNKTA priset (möbel + frakt)");
  assert.equal(attrapp.lage.bilder.length, 2, "alla bilder");
  assert.equal(attrapp.lage.paket?.includes("Bas"), true, "gratispaketet");
  assert.equal(attrapp.lage.publicerad, true);
  assert.equal(job.blocket!.status, "published");
  assert.notEqual(job.blocket!.url, `${attrapp.bas}/${GAMMALT_ID}`, "en ny annons, inte den gamla");
  assert.equal(job.blocket!.shippingSek, FRAKT, "frakten följer med");
  assert.equal(job.blocket!.pris!.bekraftat, 2040);
  assert.equal(job.blocket!.pris!.via, "omlaggning");
  assert.equal(Object.keys(job.priceLadder!.omlaggning ?? {}).length, 0);
  assert.equal(job.priceLadder!.omlaggningar!.length, 1);
  assert.equal(job.priceLadder!.lastError, null);
  assert.deepEqual(post.nere, []);

  // ORDNINGEN: den nya fylldes i (formuläret skickat) innan den gamla togs bort.
  const besokta = attrapp.lage.besokta;
  assert.ok(besokta.indexOf("/skicka-formular") < besokta.indexOf("/ta-bort-annons"), "förbered först, ta ner sedan");
  assert.ok(besokta.lastIndexOf("/valj-paket") > besokta.indexOf("/ta-bort-annons"), "sista knappen trycks efter borttagningen");
});

test("kräver Blocket BankID tas INGENTING ner: den gamla annonsen ligger kvar, admin får ett brev", async () => {
  const { job, attrapp } = await upplagt({ kraverBankID: true });
  const post = brevlada();
  await tickPriceLadders(Date.now(), post.beroenden);

  assert.equal(job.priceLadder!.currentPrice, 2040, "möbeln sjunker ändå — butiken visar rätt pris");
  assert.deepEqual(attrapp.lage.borttagna, [], "den gamla annonsen rördes inte");
  assert.equal(attrapp.lage.publicerad, false);
  assert.equal(job.blocket!.status, "published", "kanalen står kvar som uppe");
  assert.equal(job.blocket!.url, `${attrapp.bas}/${GAMMALT_ID}`);
  assert.equal(Object.keys(job.priceLadder!.omlaggning ?? {}).length, 0, "ingenting är nere");
  const kp = job.blocket!.pris!;
  assert.equal(kp.bekraftat, 2400);
  assert.equal(kp.kraverManuell, true);
  assert.match(kp.fel!, /BankID/);
  assert.equal(post.manuella.length, 1, "ett brev till admin");
  assert.deepEqual(post.nere, [], "inget 'nere'-brev — annonsen är uppe");
});

test("en bild som aldrig kommer upp stoppar förberedelsen — den gamla annonsen ligger kvar", async () => {
  const { job, attrapp } = await upplagt({ tappaUppladdning: [2], tappaAlltid: true });
  const post = brevlada();
  await tickPriceLadders(Date.now(), post.beroenden);

  assert.deepEqual(attrapp.lage.borttagna, []);
  assert.equal(attrapp.lage.publicerad, false);
  assert.equal(job.blocket!.status, "published");
  assert.match(job.blocket!.pris!.fel!, /gick inte att förbereda.*Bara 1 av 2 bilder/);
  assert.equal(Object.keys(job.priceLadder!.omlaggning ?? {}).length, 0);
});
