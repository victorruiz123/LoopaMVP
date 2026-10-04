// ─── priceLadder.ts: prisspannet, vandringen ner genom det, och kanalerna som ska följa med ────
//
// Stegen sänker priset på riktiga, publika annonser, veckor efter att någon tittat på skärmen. Det
// gör räkningen till den enda platsen felet kan upptäckas i tid: en steg som trampar på samma tal
// sänker aldrig, och en som räknar fel ikapp sänker för mycket.
//
// Sedan 2026-10-02 är stegen två halvor: BESLUTET (möbelns pris den här veckan) och SYNKEN (att
// Tradera och Blocket visar det). Fyra saker måste hålla, och alla fyra gick sönder tyst förut:
//
// MÖBELN SJUNKER ÄVEN NÄR EN KANAL SÄGER NEJ. Butiken läser priset direkt; ett Tradera-avslag får
// inte hålla kvar möbeln på det gamla priset överallt.
//
// ARVET SKER FÖRE SÄNKNINGEN. En annons från före kvittot räknas ligga på stegens pris — men bara
// om det skrivs innan stegen flyttar priset. Annars ser den ut att vara i fas och flyttas aldrig.
//
// EN KANAL SOM INTE GÅR ATT NÅ ÄR ETT FEL PÅ KANALEN. Den bokförs, larmas en gång, och försöks
// igen. Den stoppar inte de andra.
//
// KLOCKAN STARTAR EN GÅNG. En andra publicering flyttar inte nästa sänkning.
//
// Nätverket och Chromium är injicerade: det är besluten och bokföringen som prövas.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna datamappar, satta INNAN modulerna läses in — sökvägarna läses vid import.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-steg-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-steg-butik-"));
delete process.env.TRADERA_APP_ID;
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
});

const {
  DEFAULT_WEEKLY_DROP,
  RETRY_MS,
  SENARE_MS,
  annonsenLever,
  armPriceLadder,
  arvKanalPris,
  bekraftaKanalPris,
  kanalPrisLagen,
  ladderRungs,
  makePriceLadder,
  nextRung,
  nyttKanalPris,
  plannedDrop,
  prisUrFas,
  startaKlockan,
  synkaKanaler,
  tickPriceLadders,
} = await import("../server/src/priceLadder.js");
const { getJob, persist } = await import("../server/src/jobStore.js");
const { ensureRecord, publish } = await import("../server/src/butik/store.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const { SHIPPING_INCLUDED_SEK, prisMedHemleverans } = await import("../server/src/hemleverans.js");
import type { ConditionJob, PriceLadder } from "../server/src/types.js";
import type { KanalPrisLage, SynkBeroenden } from "../server/src/priceLadder.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Räkningen
// ---------------------------------------------------------------------------

test("ett steg är 15 % ner, avrundat till jämna tior", () => {
  assert.equal(nextRung(2400, 1500, DEFAULT_WEEKLY_DROP), 2040);
  assert.equal(nextRung(2040, 1500, DEFAULT_WEEKLY_DROP), 1730);
});

test("stegen stannar på golvet och går aldrig under", () => {
  assert.deepEqual(ladderRungs(2400, 1500, DEFAULT_WEEKLY_DROP), [2400, 2040, 1730, 1500]);
  assert.equal(nextRung(1500, 1500, DEFAULT_WEEKLY_DROP), 1500);
  assert.equal(nextRung(1400, 1500, DEFAULT_WEEKLY_DROP), 1500);
});

test("priset faller även när avrundningen skulle lämna det stilla", () => {
  // 20 kr minus 15 % är 17, som avrundat till tior blir 20 igen. Utan skyddet står stegen still för
  // alltid på små belopp, och "sänks varje vecka" blir en osanning i gränssnittet.
  assert.equal(nextRung(20, 1, DEFAULT_WEEKLY_DROP), 10);
  const rungs = ladderRungs(50, 10, DEFAULT_WEEKLY_DROP);
  for (let i = 1; i < rungs.length; i++) assert.ok(rungs[i] < rungs[i - 1], `steg ${i} föll inte`);
  assert.equal(rungs.at(-1), 10);
});

test("ett spann utan höjd är en enda pinne", () => {
  assert.deepEqual(ladderRungs(1500, 1500, DEFAULT_WEEKLY_DROP), [1500]);
});

test("golvet får inte ligga över startpriset", () => {
  const bad = makePriceLadder({ startPrice: 1000, floorPrice: 2000 });
  assert.ok("error" in bad);
  const pct = makePriceLadder({ startPrice: 1000, floorPrice: 500, weeklyDropPct: 1.5 });
  assert.ok("error" in pct);
});

test("takten är säljarens, inom 1–50 % i veckan — utanför avvisas med gränserna i klartext", () => {
  // Säljaren väljer takten i prisvyn; stegen räknar med just den, inte med förvalet.
  const tio = makePriceLadder({ startPrice: 2000, floorPrice: 1000, weeklyDropPct: 0.1 }) as PriceLadder;
  assert.equal(tio.weeklyDropPct, 0.1);
  assert.deepEqual(ladderRungs(tio.startPrice, tio.floorPrice, tio.weeklyDropPct).slice(0, 3), [2000, 1800, 1620]);
  const halva = makePriceLadder({ startPrice: 2000, floorPrice: 1000, weeklyDropPct: 0.5 }) as PriceLadder;
  assert.equal(halva.weeklyDropPct, 0.5);
  assert.ok(!("error" in makePriceLadder({ startPrice: 2000, floorPrice: 1000, weeklyDropPct: 0.01 })));
  for (const forMycket of [0.51, 0.9, 0.005, 0]) {
    const svar = makePriceLadder({ startPrice: 2000, floorPrice: 1000, weeklyDropPct: forMycket });
    assert.ok("error" in svar, `${forMycket} skulle ha avvisats`);
    assert.match((svar as { error: string }).error, /mellan 1 och 50 %/);
  }
  // Utelämnad takt = förvalet, som förut.
  assert.equal((makePriceLadder({ startPrice: 2000, floorPrice: 1000 }) as PriceLadder).weeklyDropPct, DEFAULT_WEEKLY_DROP);
});

test("en ny steg börjar på startpriset och har klockan avstängd", () => {
  const ladder = makePriceLadder({ startPrice: 2400, floorPrice: 1500 });
  assert.ok(!("error" in ladder));
  const made = ladder as PriceLadder;
  assert.equal(made.currentPrice, 2400);
  assert.equal(made.weeklyDropPct, DEFAULT_WEEKLY_DROP);
  // Veckorna räknas först när annonsen ligger uppe — armPriceLadder sätter nextDropAt.
  assert.equal(made.nextDropAt, null);
  assert.equal(made.floorReachedAt, null);
});

function running(over: Partial<PriceLadder> = {}): PriceLadder {
  return {
    startPrice: 2400,
    floorPrice: 1500,
    weeklyDropPct: DEFAULT_WEEKLY_DROP,
    currentPrice: 2400,
    nextDropAt: null,
    drops: [],
    floorReachedAt: null,
    lastError: null,
    chosenAt: new Date(0).toISOString(),
    listingMode: "fixed",
    ...over,
  };
}

test("inget händer före utsatt tid", () => {
  const now = Date.now();
  const ladder = running({ nextDropAt: new Date(now + WEEK).toISOString() });
  assert.equal(plannedDrop(ladder, now, WEEK), null);
});

test("en förfallen vecka ger ett steg, och nästa datum en vecka senare", () => {
  const due = Date.now();
  const ladder = running({ nextDropAt: new Date(due).toISOString() });
  const drop = plannedDrop(ladder, due + 60_000, WEEK);
  assert.equal(drop?.to, 2040);
  assert.equal(drop?.weeks, 1);
  assert.equal(drop?.nextDropAt, new Date(due + WEEK).toISOString());
});

test("missade veckor tas igen till det pris annonsen borde ha haft", () => {
  // En server som legat nere i tre veckor ska inte sänka ett steg och ligga tre veckor efter för
  // alltid. Nästa datum följer det URSPRUNGLIGA schemat, inte tidpunkten vi råkade vakna på.
  const due = Date.now();
  const ladder = running({ currentPrice: 10000, floorPrice: 1000, nextDropAt: new Date(due).toISOString() });
  const drop = plannedDrop(ladder, due + 2.5 * WEEK, WEEK);
  assert.equal(drop?.weeks, 3);
  assert.equal(drop?.to, 6150); // 10000 -> 8500 -> 7230 -> 6150
  assert.equal(drop?.nextDropAt, new Date(due + 3 * WEEK).toISOString());
});

test("när golvet nås finns ingen nästa sänkning", () => {
  const due = Date.now();
  const ladder = running({ currentPrice: 1730, nextDropAt: new Date(due).toISOString() });
  const drop = plannedDrop(ladder, due, WEEK);
  assert.equal(drop?.to, 1500);
  assert.equal(drop?.nextDropAt, null);
});

test("en färdig steg vaknar inte igen", () => {
  const due = Date.now();
  const done = running({
    currentPrice: 1500,
    nextDropAt: new Date(due).toISOString(),
    floorReachedAt: new Date(due).toISOString(),
  });
  assert.equal(plannedDrop(done, due + WEEK, WEEK), null);
});

test("klockan: på golvet är den färdig, över golvet går den en vecka framåt", () => {
  const nu = Date.parse("2026-10-02T12:00:00.000Z");
  const pa = running({ currentPrice: 1500 });
  startaKlockan(pa, nu);
  assert.equal(pa.nextDropAt, null);
  assert.ok(pa.floorReachedAt);

  const over = running({ currentPrice: 2000, floorReachedAt: new Date(nu).toISOString() });
  startaKlockan(over, nu);
  assert.equal(over.nextDropAt, new Date(nu + WEEK).toISOString());
  assert.equal(over.floorReachedAt, null, "ett pris över golvet är inte färdigt");
});

// ---------------------------------------------------------------------------
// Kanalerna — riggen
// ---------------------------------------------------------------------------

const NU = Date.parse("2026-10-02T09:00:00.000Z");
const FORFALLEN = new Date(NU - 60_000).toISOString();
let lopnummer = 0;

/**
 * Varvet går över ALLA jobb i katalogen, så ett test ska inte lämna sina jobb levande åt nästa:
 * de märks borttagna efteråt, och `annonsenLever` hoppar då över dem.
 */
const skapade: ConditionJob[] = [];
afterEach(async () => {
  for (const j of skapade) {
    j.removedAt = new Date().toISOString();
    await persist(j);
  }
  skapade.length = 0;
});

/** Ett jobb på disk, med steg och de kanaler testet ber om. */
async function jobb(opts: {
  ladder?: Partial<PriceLadder>;
  tradera?: boolean;
  blocket?: boolean;
  utanKvitto?: boolean;
  removedAt?: string;
}): Promise<ConditionJob> {
  lopnummer += 1;
  const ladder = running({ nextDropAt: FORFALLEN, ...opts.ladder });
  const job = {
    id: `steg-${lopnummer}-${NU}`,
    createdAt: new Date(NU - WEEK).toISOString(),
    error: null,
    result: null,
    progress: { stage: "done", message: "Klar" },
    priceLadder: ladder,
    removedAt: opts.removedAt ?? null,
    tradera: opts.tradera
      ? {
          status: "published",
          requestId: 1,
          itemId: 4711,
          url: "https://www.tradera.com/item/4711",
          error: null,
          startedAt: new Date(NU - WEEK).toISOString(),
          publishedAt: new Date(NU - WEEK).toISOString(),
          shippingSek: SHIPPING_INCLUDED_SEK,
          pris: opts.utanKvitto ? undefined : nyttKanalPris(ladder.currentPrice, "publicering", NU - WEEK),
        }
      : null,
    blocket: opts.blocket
      ? {
          status: "published",
          url: "https://www.blocket.se/26725957",
          receiptUrl: null,
          dryRun: false,
          error: null,
          startedAt: new Date(NU - WEEK).toISOString(),
          publishedAt: new Date(NU - WEEK).toISOString(),
          steps: [],
          shippingSek: SHIPPING_INCLUDED_SEK,
          pris: opts.utanKvitto ? undefined : nyttKanalPris(ladder.currentPrice, "publicering", NU - WEEK),
        }
      : null,
  } as unknown as ConditionJob;
  await persist(job);
  // Jobblagret cachar i minnet, och det är DET objektet varvet muterar — `persist` lägger inte in
  // något i cachen. Läs tillbaka, så att testets referens är samma som serverns.
  const cachat = (await getJob(job.id))!;
  skapade.push(cachat);
  return cachat;
}

interface Rigg {
  beroenden: Partial<SynkBeroenden>;
  tradera: Array<{ itemId: number; pris: number; mode: string }>;
  blocket: Array<{ jobId: string; pris: number }>;
  larm: Array<{ jobId: string; lage: KanalPrisLage; annonspris: number }>;
}

/** Injicerade kanaler: Tradera svarar enligt `traderaSvar`, Blocket enligt `blocketSvar`. */
function rigg(
  opts: {
    traderaSvar?: () => Promise<void>;
    /** Vad Tradera säger om annonsen innan vi rör priset. Förval: aktiv, utan bud. */
    traderaLage?: Awaited<ReturnType<SynkBeroenden["traderaLage"]>>;
    blocketSvar?: () => Promise<Awaited<ReturnType<SynkBeroenden["blocket"]>>>;
    nu?: number;
  } = {},
): Rigg {
  const r: Rigg = { tradera: [], blocket: [], larm: [], beroenden: {} };
  r.beroenden = {
    nu: () => opts.nu ?? NU,
    traderaLage: async () =>
      opts.traderaLage === undefined
        ? { totalBids: 0, maxBidSek: null, ended: false, gotBidders: false, gotWinner: false, endDate: null }
        : opts.traderaLage,
    tradera: async (itemId, pris, mode) => {
      r.tradera.push({ itemId, pris, mode });
      if (opts.traderaSvar) await opts.traderaSvar();
    },
    blocket: async (job, pris) => {
      r.blocket.push({ jobId: job.id, pris });
      return opts.blocketSvar ? opts.blocketSvar() : { status: "andrad" };
    },
    larma: async (job, lage, annonspris) => {
      r.larm.push({ jobId: job.id, lage, annonspris });
    },
  };
  return r;
}

const annonspris = (mobel: number) => prisMedHemleverans(mobel, SHIPPING_INCLUDED_SEK);

// ---------------------------------------------------------------------------
// Kanalerna — besluten
// ---------------------------------------------------------------------------

test("veckans sänkning flyttar möbeln och sedan Tradera, i den ordningen", async () => {
  const job = await jobb({ tradera: true });
  const r = rigg();
  // Tradera är inte konfigurerat i testet — den injicerade pushern ska ändå nås. Konfigurationen
  // grindar bara standardberoendet.
  process.env.TRADERA_APP_ID = "x";
  process.env.TRADERA_APP_KEY = "x";
  process.env.TRADERA_USER_ID = "x";
  process.env.TRADERA_USER_TOKEN = "x";
  try {
    const utfall = await tickPriceLadders(NU, r.beroenden);
    assert.equal(utfall.sankta, 1);
    assert.equal(job.priceLadder!.currentPrice, 2040);
    assert.equal(job.priceLadder!.drops.length, 1);
    assert.deepEqual(r.tradera, [{ itemId: 4711, pris: annonspris(2040), mode: "fixed" }], "annonspriset = möbeln + frakten");
    assert.equal(job.tradera!.pris!.bekraftat, 2040);
    assert.equal(job.tradera!.pris!.via, "api");
    assert.equal(job.priceLadder!.lastError, null);
    assert.equal(prisUrFas(job), false);
  } finally {
    delete process.env.TRADERA_APP_ID;
  }
});

test("möbeln sjunker även när Tradera säger nej — felet bokförs på kanalen, med nytt försök om sex timmar", async () => {
  process.env.TRADERA_APP_ID = "x";
  process.env.TRADERA_APP_KEY = "x";
  process.env.TRADERA_USER_ID = "x";
  process.env.TRADERA_USER_TOKEN = "x";
  try {
    const job = await jobb({ tradera: true });
    const r = rigg({
      traderaSvar: async () => {
        throw new Error("Tradera svarade 400: bids exist");
      },
    });
    await tickPriceLadders(NU, r.beroenden);

    assert.equal(job.priceLadder!.currentPrice, 2040, "butikens pris flyttas oavsett vad Tradera svarar");
    const kp = job.tradera!.pris!;
    assert.equal(kp.bekraftat, 2400, "Tradera ligger kvar på det gamla priset enligt kvittot");
    assert.match(kp.fel!, /bids exist/);
    assert.equal(kp.forsok, 1);
    assert.equal(kp.nastaForsokAt, new Date(NU + RETRY_MS).toISOString());
    assert.equal(kp.kraverManuell, false, "ett avslag är inte samma sak som att servern inte kan");
    assert.match(job.priceLadder!.lastError!, new RegExp(`Tradera ligger kvar på ${annonspris(2400)} kr`));
    assert.equal(prisUrFas(job), true);
    assert.equal(r.larm.length, 0, "ett tillfälligt avslag mejlas inte");
  } finally {
    delete process.env.TRADERA_APP_ID;
  }
});

test("arvet sker FÖRE sänkningen: en annons utan kvitto flyttas till det nya priset", async () => {
  process.env.TRADERA_APP_ID = "x";
  process.env.TRADERA_APP_KEY = "x";
  process.env.TRADERA_USER_ID = "x";
  process.env.TRADERA_USER_TOKEN = "x";
  try {
    const job = await jobb({ tradera: true, utanKvitto: true });
    assert.equal(job.tradera!.pris, undefined);
    const r = rigg();
    await tickPriceLadders(NU, r.beroenden);
    // Hade arvet skett efter sänkningen hade kvittot sagt 2040 och Tradera aldrig anropats.
    assert.equal(r.tradera.length, 1, "den gamla annonsen måste flyttas");
    assert.equal(r.tradera[0].pris, annonspris(2040));
    assert.equal(job.tradera!.pris!.bekraftat, 2040);
  } finally {
    delete process.env.TRADERA_APP_ID;
  }
});

test("arvet självt: ett antaget kvitto på stegens pris, bara för publicerade kanaler", async () => {
  const job = await jobb({ tradera: true, blocket: true, utanKvitto: true });
  job.blocket!.status = "error";
  assert.equal(arvKanalPris(job, NU), true);
  assert.equal(job.tradera!.pris!.via, "antaget");
  assert.equal(job.tradera!.pris!.bekraftat, 2400);
  assert.equal(job.blocket!.pris, undefined, "en annons som inte ligger uppe får inget kvitto");
  assert.equal(arvKanalPris(job, NU), false, "andra gången finns inget att ärva");
});

test("Tradera utan nycklar är 'för hand', inte ett tyst stopp — och sänkningen sker ändå", async () => {
  const job = await jobb({ tradera: true });
  const r = rigg();
  await tickPriceLadders(NU, r.beroenden);
  assert.equal(job.priceLadder!.currentPrice, 2040);
  assert.equal(r.tradera.length, 0, "utan nycklar görs inget anrop");
  const kp = job.tradera!.pris!;
  assert.equal(kp.kraverManuell, true);
  assert.match(kp.fel!, /inte konfigurerat/);
  assert.equal(r.larm.length, 1, "en människa måste få veta");
  assert.equal(r.larm[0].lage.kanal, "tradera");
  assert.equal(r.larm[0].annonspris, annonspris(2040));
});

test("Blocket utan robot: möbeln sjunker, kanalen märks 'för hand', brevet går EN gång", async () => {
  const job = await jobb({ blocket: true });
  const r = rigg({ blocketSvar: async () => ({ status: "manuell", skal: "Roboten ändrar inte priser i det här läget." }) });

  await tickPriceLadders(NU, r.beroenden);
  assert.equal(job.priceLadder!.currentPrice, 2040);
  const kp = job.blocket!.pris!;
  assert.equal(kp.bekraftat, 2400);
  assert.equal(kp.kraverManuell, true);
  assert.equal(kp.larmatAt, new Date(NU).toISOString());
  assert.equal(r.larm.length, 1);
  assert.match(job.priceLadder!.lastError!, /Blocket ligger kvar på .* tills annonsen ändrats för hand/);

  // Nästa varv inom omförsökstiden: inget nytt försök, inget nytt brev.
  await synkaKanaler(job, { ...r.beroenden, nu: () => NU + 60 * 60 * 1000 });
  assert.equal(r.blocket.length, 1);
  assert.equal(r.larm.length, 1, "samma behov larmas inte två gånger");

  // Efter omförsökstiden försöks det igen — fortfarande manuellt, fortfarande bara ett brev.
  await synkaKanaler(job, { ...r.beroenden, nu: () => NU + RETRY_MS + 1 });
  assert.equal(r.blocket.length, 2);
  assert.equal(r.larm.length, 1);

  // En människa ändrar på Blocket och säger det i panelen.
  const kvitto = bekraftaKanalPris(job, "blocket", NU + RETRY_MS + 2);
  assert.equal(kvitto?.via, "manuellt");
  assert.equal(kvitto?.bekraftat, 2040);
  assert.equal(prisUrFas(job), false);
  assert.equal(job.priceLadder!.lastError, null);
  const lage = kanalPrisLagen(job).find((l) => l.kanal === "blocket")!;
  assert.equal(lage.iFas, true);
  assert.equal(lage.frakt, SHIPPING_INCLUDED_SEK, "panelen ska kunna skriva annonspriset");
});

test("Blocket-roboten flyttar kanalen, och kvittot säger att det var roboten", async () => {
  const job = await jobb({ blocket: true });
  const r = rigg();
  await tickPriceLadders(NU, r.beroenden);
  assert.deepEqual(r.blocket, [{ jobId: job.id, pris: annonspris(2040) }]);
  assert.equal(job.blocket!.pris!.bekraftat, 2040);
  assert.equal(job.blocket!.pris!.via, "robot");
  assert.equal(r.larm.length, 0);
  assert.equal(job.priceLadder!.lastError, null);
});

test("en upptagen robot är ett kort omtag, inte ett avslag och inte ett larm", async () => {
  const job = await jobb({ blocket: true });
  const r = rigg({ blocketSvar: async () => ({ status: "senare", skal: "En annan Blocket-körning pågår." }) });
  await tickPriceLadders(NU, r.beroenden);
  const kp = job.blocket!.pris!;
  assert.equal(kp.nastaForsokAt, new Date(NU + SENARE_MS).toISOString());
  assert.equal(kp.kraverManuell, false);
  assert.equal(kp.forsok, 0);
  assert.equal(r.larm.length, 0);
});

test("den ena kanalens fel rör inte den andra", async () => {
  const job = await jobb({ tradera: true, blocket: true });
  const r = rigg({ blocketSvar: async () => ({ status: "manuell", skal: "av" }) });
  // Tradera saknar nycklar i testet → "för hand"; Blocket svarar manuellt. Båda bokförs var för sig.
  await tickPriceLadders(NU, r.beroenden);
  assert.equal(job.tradera!.pris!.kraverManuell, true);
  assert.equal(job.blocket!.pris!.kraverManuell, true);
  assert.equal(r.larm.length, 2, "ett brev per kanal");
  assert.deepEqual(
    r.larm.map((l) => l.lage.kanal),
    ["tradera", "blocket"],
  );
});

test("omförsökstiden respekteras — och adminens tryck (tvinga) hoppar över den", async () => {
  const job = await jobb({ blocket: true, ladder: { currentPrice: 2040, nextDropAt: new Date(NU + WEEK).toISOString() } });
  job.blocket!.pris = { ...nyttKanalPris(2400, "publicering", NU - WEEK), nastaForsokAt: new Date(NU + 60_000).toISOString() };
  const r = rigg();
  const vantade = await synkaKanaler(job, r.beroenden);
  assert.deepEqual(vantade.vantar, ["blocket"]);
  assert.equal(r.blocket.length, 0);

  const tvingat = await synkaKanaler(job, r.beroenden, { tvinga: true });
  assert.deepEqual(tvingat.flyttade, ["blocket"]);
  assert.equal(job.blocket!.pris!.bekraftat, 2040);
});

test("en kanal som kommit i fas tappar sitt gamla fel", async () => {
  const job = await jobb({ blocket: true, ladder: { nextDropAt: new Date(NU + WEEK).toISOString() } });
  job.blocket!.pris = { ...nyttKanalPris(2400, "publicering", NU - WEEK), fel: "gammalt", kraverManuell: true, nastaForsokAt: new Date(NU + WEEK).toISOString() };
  const r = rigg();
  await synkaKanaler(job, r.beroenden);
  assert.equal(r.blocket.length, 0, "inget att flytta");
  assert.equal(job.blocket!.pris!.fel, null);
  assert.equal(job.blocket!.pris!.kraverManuell, false);
});

// ---------------------------------------------------------------------------
// Klockan och livet
// ---------------------------------------------------------------------------

test("klockan startar en gång: en andra publicering flyttar varken priset eller nästa sänkning", async () => {
  const job = await jobb({ tradera: true, ladder: { nextDropAt: new Date(NU + 3 * 24 * 3600 * 1000).toISOString() } });
  const fore = job.priceLadder!.nextDropAt;
  await armPriceLadder(job.id, 999, "auction");
  assert.equal(job.priceLadder!.nextDropAt, fore, "klockan rördes");
  assert.equal(job.priceLadder!.currentPrice, 2400, "priset rördes");
  assert.equal(job.priceLadder!.listingMode, "auction", "annonstypen får däremot sättas");
});

test("första armeringen startar klockan från det publicerade priset", async () => {
  const job = await jobb({ ladder: { nextDropAt: null, floorReachedAt: null } });
  await armPriceLadder(job.id, 2200);
  assert.equal(job.priceLadder!.currentPrice, 2200);
  assert.ok(job.priceLadder!.nextDropAt, "klockan går");
});

test("en borttagen annons lever inte; en som bara ligger i butiken gör det", async () => {
  const borttagen = await jobb({ tradera: true, removedAt: new Date(NU).toISOString() });
  assert.equal(await annonsenLever(borttagen), false);

  const ingenstans = await jobb({});
  assert.equal(await annonsenLever(ingenstans), false, "utan kanal och utan butikspost finns inget pris ute");

  const iButiken = await jobb({});
  const id = loopaIdFor(iButiken.id);
  await ensureRecord(id, iButiken.id, "loopa", new Date(NU - WEEK).toISOString());
  await publish(id, { kind: "system", job: "test" });
  assert.equal(await annonsenLever(iButiken), true, "butiken är en kanal den också");

  // Och den sjunker — utan att någon marknadsplats anropas.
  const r = rigg();
  await tickPriceLadders(NU, r.beroenden);
  assert.equal(iButiken.priceLadder!.currentPrice, 2040);
  assert.equal(r.tradera.length + r.blocket.length, 0);
  assert.equal(borttagen.priceLadder!.currentPrice, 2400, "den borttagna rördes inte");
});

// ---------------------------------------------------------------------------
// Övergången från den frusna stegen
// ---------------------------------------------------------------------------

test("en steg som stod frusen av Blocket tar inte igen veckorna — klockan startar om från i dag", async () => {
  // Blocket uppe, inget kvitto (koden har aldrig sett annonsen), klockan tre veckor över tiden.
  const job = await jobb({ blocket: true, utanKvitto: true, ladder: { nextDropAt: new Date(NU - 3 * WEEK).toISOString() } });
  const r = rigg();
  const utfall = await tickPriceLadders(NU, r.beroenden);
  assert.equal(utfall.sankta, 0, "ingen sänkning på en gång");
  assert.equal(job.priceLadder!.currentPrice, 2400);
  assert.equal(job.priceLadder!.nextDropAt, new Date(NU + WEEK).toISOString());
  assert.equal(job.blocket!.pris!.via, "antaget");
  assert.equal(r.blocket.length, 0, "inget att flytta — Blocket ligger på stegens pris");

  // Nästa vecka går det som vanligt.
  await tickPriceLadders(NU + WEEK + 1, r.beroenden);
  assert.equal(job.priceLadder!.currentPrice, 2040);
  assert.deepEqual(r.blocket, [{ jobId: job.id, pris: annonspris(2040) }]);
});

test("en Tradera-annons utan kvitto som bara legat nere tar däremot igen veckorna", async () => {
  process.env.TRADERA_APP_ID = "x";
  process.env.TRADERA_APP_KEY = "x";
  process.env.TRADERA_USER_ID = "x";
  process.env.TRADERA_USER_TOKEN = "x";
  try {
    const job = await jobb({ tradera: true, utanKvitto: true, ladder: { nextDropAt: new Date(NU - WEEK - 1000).toISOString() } });
    const r = rigg();
    await tickPriceLadders(NU, r.beroenden);
    assert.equal(job.priceLadder!.currentPrice, 1730, "två veckor förfallna = två steg (2400 → 2040 → 1730)");
    assert.equal(r.tradera[0]?.pris, annonspris(1730));
  } finally {
    delete process.env.TRADERA_APP_ID;
  }
});

test("en annons som ligger ute med en klocka som aldrig startats får den startad — utan att priset rörs", async () => {
  const job = await jobb({ blocket: true, ladder: { nextDropAt: null, floorReachedAt: null } });
  const r = rigg();
  await tickPriceLadders(NU, r.beroenden);
  assert.equal(job.priceLadder!.currentPrice, 2400);
  assert.equal(job.priceLadder!.nextDropAt, new Date(NU + WEEK).toISOString());
  assert.equal(r.blocket.length, 0);
});

test("en utgången Tradera-annons får inget prisanrop — den bokförs 'för hand' med skälet, och ett brev går", async () => {
  // Två av serverns fem Tradera-annonser hade gått ut (29/9 och 20/9) utan att läggas om. Utan den
  // här regeln hade stegen skickat ett PUT som Tradera avvisar, var sjätte timme, i evighet.
  process.env.TRADERA_APP_ID = "x";
  process.env.TRADERA_APP_KEY = "x";
  process.env.TRADERA_USER_ID = "x";
  process.env.TRADERA_USER_TOKEN = "x";
  try {
    const job = await jobb({ tradera: true });
    const r = rigg({ traderaLage: { totalBids: 0, maxBidSek: null, ended: true, gotBidders: false, gotWinner: false, endDate: "2026-09-29T13:12:08.11" } });
    await tickPriceLadders(NU, r.beroenden);
    assert.equal(job.priceLadder!.currentPrice, 2040, "möbeln sjunker ändå — butiken visar rätt pris");
    assert.equal(r.tradera.length, 0, "inget prisanrop mot en utgången annons");
    const kp = job.tradera!.pris!;
    assert.equal(kp.kraverManuell, true);
    assert.match(kp.fel!, /gått ut på Tradera \(2026-09-29\)/);
    assert.equal(r.larm.length, 1);

    // Går den inte att läsa (null) försöks ändringen som vanligt — ett läsfel är inte en utgången annons.
    const job2 = await jobb({ tradera: true });
    const r2 = rigg({ traderaLage: null });
    await tickPriceLadders(NU, r2.beroenden);
    assert.equal(r2.tradera.length, 1);
    assert.equal(job2.tradera!.pris!.bekraftat, 2040);
  } finally {
    delete process.env.TRADERA_APP_ID;
  }
});
