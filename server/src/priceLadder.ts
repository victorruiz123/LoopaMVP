/**
 * Prisstegen — säljarens spann, och vandringen ner genom det.
 *
 * Prismotorn svarar med tre tal: säljs snabbt, förslag, säljs långsamt. Vilket av dem som är rätt
 * beror på något motorn omöjligt kan veta — hur bråttom säljaren har. Stegen låter dem svara på det
 * själva: ett startpris, ett golv, och en sänkning på 15 % i veckan däremellan. Annonsen börjar där
 * säljaren hoppas, och letar sig ner mot det de accepterar utan att de behöver röra den.
 *
 * TVÅ HALVOR, MEDVETET ÅTSKILDA:
 *
 *   1. BESLUTET — vad möbeln kostar den här veckan. Rena funktioner (`nextRung`, `plannedDrop`),
 *      testade i tests/priceLadder.test.ts. Verkställs mot `currentPrice`, som är MÖBELNS pris:
 *      butiken läser det direkt (butik/normalize.ts `priceOf`), och det flyttas varje vecka oavsett
 *      vad marknadsplatserna svarar.
 *
 *   2. SYNKEN — att varje marknadsplats annonsen ligger på visar samma tal. Tradera genom API:t,
 *      Blocket genom prisroboten (integrations/blocket/pris.ts) eller en människa som ändrar för hand
 *      och markerar det i panelen. Kvittot per kanal bor på publiceringen (`KanalPris` i types.ts).
 *
 * FÖRE 2026-10-02 var halvorna hopvävda, och det gav tre tysta fel: priset sänktes bara om Tradera
 * tog emot sänkningen, schemaläggaren startade bara om Tradera var konfigurerat, och hela stegen
 * stod stilla så länge Blocket-annonsen låg uppe (`ladderFrozenByBlocket`) — för Blocket gick inte
 * att redigera. Möbler som låg på Blocket, eller bara i butiken, sjönk alltså aldrig. Nu sjunker
 * möbeln. En kanal som inte hänger med är ett fel PÅ KANALEN: det syns i panelen, försöks igen, och
 * larmas när en människa behövs. Det är inte ett skäl att låta priset stå.
 */

import { getJob, listJobs, persist } from "./jobStore.js";
import { getTraderaLage, traderaConfigured, updateTraderaPrice, type TraderaLage } from "./integrations/tradera/tradera.js";
import { annonsensFrakt, prisMedHemleverans } from "./hemleverans.js";
import { kategoriMedRattelse } from "./butik/overrides.js";
import { store } from "./butik/store.js";
import { loopaIdFor } from "./loopaId.js";
import type { BlocketPublication, ConditionJob, KanalPris, PriceLadder, TraderaPublication } from "./types.js";

/** 15 % i veckan. Kan sättas per annons, men det här är förvalet hela funktionen är byggd kring. */
export const DEFAULT_WEEKLY_DROP = 0.15;
/** Vad en säljare får välja, som andel per vecka. Speglas i web/src/lib/priceLadder.ts. */
export const MIN_WEEKLY_DROP = 0.01;
export const MAX_WEEKLY_DROP = 0.5;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hur långt det är mellan två sänkningar. En vecka i drift; miljövariabeln finns för att kunna se
 * hela stegen löpa på några minuter i en demo utan att vänta en månad på fjärde steget.
 */
export function dropIntervalMs(): number {
  const ms = Number(process.env.PRICE_LADDER_INTERVAL_MS ?? WEEK_MS);
  return Number.isFinite(ms) && ms >= 1000 ? ms : WEEK_MS;
}

/** Hur ofta vi tittar efter förfallna sänkningar och kanaler ur fas. Inte samma sak som hur ofta de sker. */
function tickMs(): number {
  const ms = Number(process.env.PRICE_LADDER_TICK_MS ?? 15 * 60 * 1000);
  return Number.isFinite(ms) && ms >= 1000 ? ms : 15 * 60 * 1000;
}

/**
 * Ett avvisat prisbyte får inte tystna till nästa vecka — men det får inte heller mala. Sex timmar
 * ger ett par nya försök inom veckan och slutar sedan av sig självt när golvet ändå nås.
 */
export const RETRY_MS = 6 * 60 * 60 * 1000;

/** Kort omtag när Blocket-roboten var upptagen med en publicering: det är en kö, inte ett avslag. */
export const SENARE_MS = 20 * 60 * 1000;

/** Priser sätts i jämna tior. Ett steg som landar på 2 037 kr läser som en bugg, inte som en rabatt. */
const ROUNDING = 10;

/** Lägsta pris Tradera tar emot. Golvet får inte ställas under det. */
const MIN_PRICE = 1;

const iso = (ms: number) => new Date(ms).toISOString();

// ---------- Räkningen ----------

/**
 * Nästa steg ner: `pct` av priset bort, avrundat till jämna tior, aldrig under golvet.
 *
 * Garanterar att priset FALLER. Utan den sista kontrollen fastnar små belopp: 20 kr minus 15 % är
 * 17, som avrundat till tior blir 20 igen, och stegen hade stått och trampat på samma tal i evighet.
 */
export function nextRung(current: number, floor: number, pct: number): number {
  if (current <= floor) return floor;
  let next = Math.round((current * (1 - pct)) / ROUNDING) * ROUNDING;
  if (next >= current) next = current - ROUNDING;
  return Math.max(floor, next);
}

/**
 * Hela stegen, startpriset först och golvet sist. Det säljaren ser en förhandsvisning av innan de
 * väljer, och det som avgör hur många veckor spannet räcker.
 */
export function ladderRungs(start: number, floor: number, pct: number, maxWeeks = 104): number[] {
  const rungs = [Math.round(start)];
  let price = rungs[0];
  while (price > floor && rungs.length <= maxWeeks) {
    price = nextRung(price, floor, pct);
    rungs.push(price);
  }
  return rungs;
}

export interface LadderInput {
  startPrice: number;
  floorPrice: number;
  weeklyDropPct?: number;
}

/**
 * Bygger en steg ur säljarens val, eller säger vad som är fel med det.
 *
 * Valideras här och inte i vägen: samma regler gäller den som sätter spannet via API:t som den som
 * drar i reglaget, och ett golv över startpriset är inte ett gränssnittsfel utan ett omöjligt spann.
 */
export function makePriceLadder(input: LadderInput): PriceLadder | { error: string } {
  const startPrice = Math.round(Number(input.startPrice));
  const floorPrice = Math.round(Number(input.floorPrice));
  if (!Number.isFinite(startPrice) || startPrice < MIN_PRICE) {
    return { error: "Startpriset måste vara ett pris i kronor." };
  }
  if (!Number.isFinite(floorPrice) || floorPrice < MIN_PRICE) {
    return { error: "Lägsta priset måste vara ett pris i kronor." };
  }
  if (floorPrice > startPrice) {
    return { error: "Lägsta priset kan inte vara högre än startpriset." };
  }

  /**
   * Takten säljaren valt, eller förvalet. 1–50 % i veckan: under 1 % står priset i praktiken stilla
   * och "sänks varje vecka" blir en osanning, över 50 % är ett ras ingen menar — och samma gränser
   * ritas i prisvyn (web/src/lib/priceLadder.ts), så att servern aldrig avvisar något reglaget tillät.
   */
  const rawPct = input.weeklyDropPct === undefined ? DEFAULT_WEEKLY_DROP : Number(input.weeklyDropPct);
  if (!Number.isFinite(rawPct) || rawPct < MIN_WEEKLY_DROP || rawPct > MAX_WEEKLY_DROP) {
    return { error: `Sänkningen måste vara mellan ${Math.round(MIN_WEEKLY_DROP * 100)} och ${Math.round(MAX_WEEKLY_DROP * 100)} % i veckan.` };
  }

  return {
    startPrice,
    floorPrice,
    weeklyDropPct: rawPct,
    currentPrice: startPrice,
    // Klockan startar först vid publiceringen. En steg som räknar veckor på ett utkast hade sänkt
    // priset på en annons som aldrig legat uppe.
    nextDropAt: null,
    drops: [],
    floorReachedAt: null,
    lastError: null,
    chosenAt: new Date().toISOString(),
    listingMode: null,
  };
}

/**
 * Vad som ska hända med en steg just nu, eller null om den inte är förfallen.
 *
 * Tar igen missade veckor. En server som legat nere över en månad ska inte sänka ett (1) steg och
 * sedan ligga en månad efter för alltid — den ska landa på det pris annonsen skulle ha haft. Alla
 * inhämtade veckor blir ETT prisbyte per kanal, vilket också är vad en köpare ser: ett pris.
 */
export function plannedDrop(
  ladder: PriceLadder,
  now: number,
  intervalMs: number,
): { to: number; nextDropAt: string | null; weeks: number } | null {
  if (!ladder.nextDropAt || ladder.floorReachedAt) return null;
  const due = Date.parse(ladder.nextDropAt);
  if (!Number.isFinite(due) || due > now) return null;

  const weeks = Math.floor((now - due) / intervalMs) + 1;
  let price = ladder.currentPrice;
  for (let i = 0; i < weeks && price > ladder.floorPrice; i++) {
    price = nextRung(price, ladder.floorPrice, ladder.weeklyDropPct);
  }
  return {
    to: price,
    nextDropAt: price <= ladder.floorPrice ? null : new Date(due + weeks * intervalMs).toISOString(),
    weeks,
  };
}

// ---------- Klockan ----------

/**
 * Sätter klockan efter var priset står: en vecka framåt, eller färdig om priset redan är på golvet.
 * Rör inte priset. Används när klockan ska börja gå (publicering, godkännande) och när ett adminpris
 * lyfter annonsen från golvet igen.
 */
export function startaKlockan(ladder: PriceLadder, now = Date.now()): void {
  if (ladder.currentPrice <= ladder.floorPrice) {
    ladder.floorReachedAt = iso(now);
    ladder.nextDropAt = null;
  } else {
    ladder.floorReachedAt = null;
    ladder.nextDropAt = iso(now + dropIntervalMs());
  }
}

/** Går klockan, eller har den gått klart? Falskt bara för en steg som aldrig startats. */
export function klockanStartad(ladder: PriceLadder): boolean {
  return !!ladder.nextDropAt || !!ladder.floorReachedAt;
}

/**
 * Startar klockan när annonsen faktiskt ligger uppe — EN gång.
 *
 * Anropas från varje väg ut: godkännandet (butiken), Tradera-publiceringen och Blocket-publiceringen.
 * Den första sätter igång veckorna; de senare rör inte klockan. Utan den regeln hade en Blocket-
 * publicering som lyckades en vecka efter Tradera flyttat nästa sänkning en vecka framåt, och ett
 * omförsök efter ett fel hade nollställt det priset redan sjunkit till.
 *
 * `publishedPrice` och inte `startPrice`: föll prisstegen bort och annonsen gick upp på ett annat
 * pris är DET priset sänkningen ska utgå från, inte ett tal från en steg som aldrig användes.
 * `mode` är Traderas annonstyp och sätts bara av Tradera-vägen.
 */
export async function armPriceLadder(
  jobId: string,
  publishedPrice: number,
  mode?: "auction" | "fixed",
): Promise<void> {
  const job = await getJob(jobId);
  const ladder = job?.priceLadder;
  if (!job || !ladder) return;

  if (mode) ladder.listingMode = mode;
  if (!klockanStartad(ladder)) {
    ladder.currentPrice = Math.round(publishedPrice);
    ladder.lastError = null;
    startaKlockan(ladder);
  }
  await persist(job);
}

// ---------- Kanalernas kvitto ----------

export type PrisKanal = "tradera" | "blocket";

const KANALER: readonly PrisKanal[] = ["tradera", "blocket"];
const KANALNAMN: Record<PrisKanal, string> = { tradera: "Tradera", blocket: "Blocket" };

/** Ett nytt kvitto: kanalen ligger på `bekraftat`, allt annat nollat. */
export function nyttKanalPris(bekraftat: number, via: KanalPris["via"], now = Date.now()): KanalPris {
  return {
    bekraftat: Math.round(bekraftat),
    bekraftatAt: iso(now),
    via,
    fel: null,
    felAt: null,
    forsok: 0,
    nastaForsokAt: null,
    kraverManuell: false,
    larmatAt: null,
  };
}

/** Ligger annonsen uppe på kanalen, så att det finns ett pris att hålla i fas? */
export function kanalPublicerad(job: ConditionJob, kanal: PrisKanal): boolean {
  if (kanal === "tradera") return job.tradera?.status === "published" && typeof job.tradera.itemId === "number";
  return job.blocket?.status === "published";
}

function publikation(job: ConditionJob, kanal: PrisKanal): TraderaPublication | BlocketPublication | null | undefined {
  return kanal === "tradera" ? job.tradera : job.blocket;
}

/**
 * Ger annonser från före kvittot ett: de räknas ligga på stegens pris.
 *
 * MÅSTE KÖRAS FÖRE VECKANS SÄNKNING. Antagandet "kanalen ligger på `currentPrice`" är sant precis
 * fram till att stegen flyttar `currentPrice`; görs arvet efteråt ser den gamla annonsen ut att
 * redan vara i fas med det nya priset, och den flyttas aldrig. Returnerar sant när något skrevs.
 */
export function arvKanalPris(job: ConditionJob, now = Date.now()): boolean {
  const ladder = job.priceLadder;
  if (!ladder) return false;
  let skrev = false;
  for (const kanal of KANALER) {
    const pub = publikation(job, kanal);
    if (!pub || !kanalPublicerad(job, kanal) || pub.pris) continue;
    pub.pris = nyttKanalPris(ladder.currentPrice, "antaget", now);
    skrev = true;
  }
  return skrev;
}

/** Var en kanal står mot stegen — det panelen ritar. */
export interface KanalPrisLage {
  kanal: PrisKanal;
  namn: string;
  /** Möbelpriset kanalen ligger på enligt kvittot. */
  bekraftat: number;
  /** Möbelpriset den ska ligga på: stegens. */
  borVara: number;
  iFas: boolean;
  via: KanalPris["via"];
  fel: string | null;
  nastaForsokAt: string | null;
  kraverManuell: boolean;
  /** Länken till annonsen, för den som ska ändra för hand. */
  url: string | null;
  /** Hemleveransen annonsen bär. Annonspriset = möbelpriset + den här. */
  frakt: number;
}

/** Var varje publicerad kanal står mot stegen. Tom lista = inget ligger uppe, eller ingen steg. */
export function kanalPrisLagen(job: ConditionJob): KanalPrisLage[] {
  const ladder = job.priceLadder;
  if (!ladder) return [];
  const borVara = Math.round(ladder.currentPrice);
  const lagen: KanalPrisLage[] = [];
  for (const kanal of KANALER) {
    if (!kanalPublicerad(job, kanal)) continue;
    const pub = publikation(job, kanal)!;
    // Inget kvitto än = antas i fas, utan att skriva. Arvet skrivs av varvet (arvKanalPris).
    const kp = pub.pris ?? nyttKanalPris(borVara, "antaget");
    lagen.push({
      kanal,
      namn: KANALNAMN[kanal],
      bekraftat: kp.bekraftat,
      borVara,
      iFas: kp.bekraftat === borVara,
      via: kp.via,
      fel: kp.fel,
      nastaForsokAt: kp.nastaForsokAt,
      kraverManuell: kp.kraverManuell,
      url: pub.url ?? null,
      // Synkront med flit: kanalen ÄR publicerad, så beloppet står på publiceringen (eller är
      // grundbeloppet för äldre annonser) och kategorin behöver aldrig slås upp.
      frakt: annonsensFrakt(job, null),
    });
  }
  return lagen;
}

/** Visar någon kanal ett annat pris än stegens? */
export function prisUrFas(job: ConditionJob): boolean {
  return kanalPrisLagen(job).some((l) => !l.iFas);
}

/**
 * En människa har ändrat kanalen för hand till stegens pris, och säger det i panelen.
 *
 * Skriver kvittot som "manuellt" och rensar larmet — nästa gång kanalen hamnar ur fas är det en ny
 * händelse som ska larmas på nytt. Returnerar null när det inte finns något att bekräfta.
 */
export function bekraftaKanalPris(job: ConditionJob, kanal: PrisKanal, now = Date.now()): KanalPris | null {
  const ladder = job.priceLadder;
  const pub = publikation(job, kanal);
  if (!ladder || !pub || !kanalPublicerad(job, kanal)) return null;
  pub.pris = nyttKanalPris(ladder.currentPrice, "manuellt", now);
  ladder.lastError = null;
  return pub.pris;
}

// ---------- Synken ----------

/** Vad ett försök att flytta en kanal gav, när det inte var ett fel. */
export type FlyttUtfall =
  | { status: "andrad" }
  /** Servern kan inte göra det själv — en människa måste. `skal` är för panelen. */
  | { status: "manuell"; skal: string }
  /** Inte nu, men snart: roboten var upptagen med något annat. */
  | { status: "senare"; skal: string };

/**
 * Det som faktiskt rör omvärlden, injicerbart för testerna. Beslutet om VAD som ska flyttas och
 * bokföringen av svaret är det som prövas; nätverket och Chromium är det inte.
 */
export interface SynkBeroenden {
  tradera: (itemId: number, annonspris: number, mode: "auction" | "fixed") => Promise<void>;
  /** Hur annonsen går hos Tradera — gått ut, såld? Null = gick inte att läsa; då försöks ändringen ändå. */
  traderaLage: (itemId: number) => Promise<TraderaLage | null>;
  blocket: (job: ConditionJob, annonspris: number) => Promise<FlyttUtfall>;
  larma: (job: ConditionJob, lage: KanalPrisLage, annonspris: number) => Promise<void>;
  nu: () => number;
}

const standardBeroenden: SynkBeroenden = {
  tradera: updateTraderaPrice,
  traderaLage: getTraderaLage,
  // Lat import: roboten drar in Playwright, och den som bara räknar på stegen ska slippa det.
  blocket: async (job, annonspris) => {
    const { flyttaBlocketPris } = await import("./integrations/blocket/pris.js");
    return flyttaBlocketPris(job, annonspris);
  },
  larma: mejlaOmManuellt,
  nu: () => Date.now(),
};

export interface SynkResultat {
  flyttade: PrisKanal[];
  /** Kanaler som väntar på sin omförsökstid, eller på att roboten blir ledig. */
  vantar: PrisKanal[];
  /** Kanaler där försöket föll, eller som kräver en människa. */
  fel: PrisKanal[];
}

/**
 * Flyttar varje publicerad kanal till stegens pris, och bokför hur det gick.
 *
 * EN KANAL I TAGET, OCH DEN ENAS FEL RÖR INTE DEN ANDRA. Tradera svarar på en sekund; Blocket-roboten
 * tar minuter. Att Blocket faller får inte låta Tradera stå kvar på fel pris, och tvärtom.
 *
 * Frakten läggs på HÄR och räknas aldrig in i stegen: talen i `ladder` är möbelkronor, priset i
 * annonsen är möbeln plus hemleveransen. Beloppet annonsen gick ut med (`annonsensFrakt`), inte
 * dagens taxa.
 *
 * `tvinga` hoppar över omförsökstiden — adminens "Sätt priset" ska försöka nu, inte om sex timmar.
 */
export async function synkaKanaler(
  job: ConditionJob,
  beroenden: Partial<SynkBeroenden> = {},
  opts: { tvinga?: boolean } = {},
): Promise<SynkResultat> {
  const d: SynkBeroenden = { ...standardBeroenden, ...beroenden };
  const resultat: SynkResultat = { flyttade: [], vantar: [], fel: [] };
  const ladder = job.priceLadder;
  if (!ladder) return resultat;

  const now = d.nu();
  arvKanalPris(job, now);
  const mal = Math.round(ladder.currentPrice);
  let frakt: number | null = null;
  const kvar: string[] = [];

  for (const kanal of KANALER) {
    if (!kanalPublicerad(job, kanal)) continue;
    const pub = publikation(job, kanal)!;
    const kp = pub.pris!;

    if (kp.bekraftat === mal) {
      // I fas. Ett gammalt fel eller larm gäller inte längre.
      if (kp.fel || kp.kraverManuell || kp.nastaForsokAt) {
        kp.fel = null;
        kp.felAt = null;
        kp.kraverManuell = false;
        kp.nastaForsokAt = null;
      }
      continue;
    }

    frakt ??= annonsensFrakt(job, await kategoriMedRattelse(job));
    const annonspris = prisMedHemleverans(mal, frakt);
    const liggerPa = prisMedHemleverans(kp.bekraftat, frakt);

    if (!opts.tvinga && kp.nastaForsokAt && Date.parse(kp.nastaForsokAt) > now) {
      resultat.vantar.push(kanal);
      kvar.push(`${KANALNAMN[kanal]} ligger kvar på ${liggerPa} kr.`);
      continue;
    }

    try {
      let utfall: FlyttUtfall;
      if (kanal === "tradera") {
        if (!traderaConfigured()) {
          utfall = { status: "manuell", skal: "Tradera är inte konfigurerat på servern, så priset där går inte att ändra härifrån." };
        } else {
          /**
           * En annons som gått ut hos Tradera har inget pris att ändra — anropet avvisas, och hade
           * annars försökts om var sjätte timme i evighet (två av fem annonser på servern stod så
           * 2026-10-03). Det är en människas beslut att lägga om den (restartTraderaItem kostar och
           * startar en ny annonstid), så det bokförs som "för hand" med ett brev, inte som ett fel.
           */
          const lage = await d.traderaLage(job.tradera!.itemId!);
          if (lage?.ended) {
            utfall = {
              status: "manuell",
              skal:
                `Annonsen har gått ut på Tradera${lage.endDate ? ` (${lage.endDate.slice(0, 10)})` : ""}` +
                `${lage.gotWinner ? " och är såld där" : ""} — priset går inte att ändra förrän den lagts om.`,
            };
          } else {
            // Fastpris byter Köp Nu-priset, auktion byter utropspriset. Det senare avvisar Tradera så
            // fort annonsen fått ett bud — och det är rätt: ett utropspris under ett lagt bud är inte en
            // sänkning, det är ett annat kontrakt. Avslaget bokförs på kanalen och syns i panelen.
            await d.tradera(job.tradera!.itemId!, annonspris, ladder.listingMode ?? "fixed");
            utfall = { status: "andrad" };
          }
        }
      } else {
        utfall = await d.blocket(job, annonspris);
      }

      if (utfall.status === "andrad") {
        pub.pris = nyttKanalPris(mal, kanal === "tradera" ? "api" : "robot", now);
        resultat.flyttade.push(kanal);
        console.info(`[pris-steg] ${job.id.slice(0, 8)} ${KANALNAMN[kanal]} ${liggerPa} → ${annonspris} kr (annonspris med frakt)`);
      } else if (utfall.status === "senare") {
        kp.fel = utfall.skal;
        kp.felAt = iso(now);
        kp.nastaForsokAt = iso(now + SENARE_MS);
        resultat.vantar.push(kanal);
        kvar.push(`${KANALNAMN[kanal]} ligger kvar på ${liggerPa} kr.`);
      } else {
        kp.fel = utfall.skal;
        kp.felAt = iso(now);
        kp.kraverManuell = true;
        kp.nastaForsokAt = iso(now + RETRY_MS);
        resultat.fel.push(kanal);
        kvar.push(`${KANALNAMN[kanal]} ligger kvar på ${liggerPa} kr tills annonsen ändrats för hand.`);
        if (!kp.larmatAt) {
          const lage = kanalPrisLagen(job).find((l) => l.kanal === kanal)!;
          await d.larma(job, lage, annonspris).catch((err) =>
            console.warn(`[pris-steg] ${job.id.slice(0, 8)} brevet om ${KANALNAMN[kanal]} gick inte iväg — ${err}`),
          );
          kp.larmatAt = iso(now);
        }
        console.warn(`[pris-steg] ${job.id.slice(0, 8)} ${KANALNAMN[kanal]} måste ändras för hand — ${utfall.skal}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      kp.fel = message;
      kp.felAt = iso(now);
      kp.forsok += 1;
      // Skjut fram, inte bort: en avvisad sänkning ska försöka igen inom veckan, inte tiga till nästa.
      kp.nastaForsokAt = iso(now + RETRY_MS);
      resultat.fel.push(kanal);
      kvar.push(`${KANALNAMN[kanal]} ligger kvar på ${liggerPa} kr.`);
      console.warn(`[pris-steg] ${job.id.slice(0, 8)} ${KANALNAMN[kanal]} kunde inte flyttas till ${annonspris} kr — ${message}`);
    }
  }

  ladder.lastError = kvar.length ? kvar.join(" ") : null;
  await persist(job);
  return resultat;
}

/**
 * Brevet till admin när en kanal måste ändras för hand. Ett per gång kanalen hamnar ur fas.
 *
 * Säger exakt vad som ska göras: vilken annons, vilket pris, var, och att det ska markeras i panelen
 * efteråt — annars försöker stegen igen om sex timmar och brevet kommer tillbaka nästa vecka.
 */
async function mejlaOmManuellt(job: ConditionJob, lage: KanalPrisLage, annonspris: number): Promise<void> {
  const { sendLetter } = await import("./efterlysning/notify.js");
  const { adminEmails } = await import("./admin.js");
  const { adTitle } = await import("./adContent.js");
  const id = loopaIdFor(job.id);
  const titel = adTitle(job) || id;
  const body = [
    `${lage.namn}-annonsen för "${titel}" (${id}) ska ligga på ${annonspris} kr (möbeln ${lage.borVara} kr plus hemleverans),`,
    `men servern kan inte ändra den själv: ${lage.fel ?? "okänt skäl"}`,
    "",
    lage.url ? `Annonsen: ${lage.url}` : `Annonsen har ingen sparad adress — leta upp den på ${lage.namn}.`,
    "",
    "Gör så här:",
    `  1. Ändra priset på ${lage.namn} till ${annonspris} kr.`,
    `  2. Öppna annonsen i adminpanelen och tryck "Ändrat för hand" vid ${lage.namn} under Tid och pris.`,
    "",
    "Butiken och de andra kanalerna visar redan det nya priset. Tills steg 2 är gjort försöker stegen",
    "igen var sjätte timme, och nästa veckas sänkning ger ett nytt brev.",
  ].join("\n");
  for (const to of adminEmails()) {
    await sendLetter({ to, subject: `${lage.namn}: ${titel} ska ner till ${annonspris} kr — ändra för hand`, body, kind: "pris" });
  }
}

// ---------- Verkställandet ----------

/** Butikens slutlägen. En såld möbel har inget pris att sänka och inga kanaler att hålla i fas. */
const SLUTLAGEN = new Set(["sold", "delivered", "returned"]);

/**
 * Ligger möbeln ute någonstans — så att det finns ett pris att röra?
 *
 * Tre källor, i den ordning de är säkrast: säljarens borttagning, butikens huvudbok (en försäljning
 * på Tradera eller i kassan hamnar där, via claimForSale), och kanalernas egna lägen. En annons som
 * bara ligger i butiken räknas: butiken är en kanal den också, och den sjönk aldrig förut.
 */
export async function annonsenLever(job: ConditionJob): Promise<boolean> {
  if (job.removedAt) return false;
  let rec: Awaited<ReturnType<ReturnType<typeof store>["get"]>> = null;
  try {
    rec = await store().get(loopaIdFor(job.id));
  } catch {
    rec = null;
  }
  if (rec && SLUTLAGEN.has(rec.state)) return false;
  if (KANALER.some((k) => kanalPublicerad(job, k))) return true;
  return rec?.state === "live" || rec?.state === "reserved";
}

/**
 * Verkställer veckans sänkning på MÖBELNS pris. Returnerar sant när priset flyttades.
 *
 * Kanalerna rörs inte här — det gör `synkaKanaler` efteråt. Skälet är ordningen: butiken läser
 * `currentPrice` direkt och ska visa det nya priset även om Tradera säger nej och Blocket-roboten är
 * avstängd. Förut var det tvärtom, och en avvisad Tradera-ändring höll kvar möbeln på det gamla
 * priset överallt.
 */
async function sankSteg(job: ConditionJob, now: number): Promise<boolean> {
  const ladder = job.priceLadder!;
  const planned = plannedDrop(ladder, now, dropIntervalMs());
  if (!planned) return false;

  const from = ladder.currentPrice;
  if (planned.to >= from) {
    // Redan i botten — stegen är färdig även om ingen hann markera den som det.
    ladder.floorReachedAt = iso(now);
    ladder.nextDropAt = null;
    await persist(job);
    return false;
  }

  ladder.currentPrice = planned.to;
  ladder.drops.push({ at: iso(now), from, to: planned.to });
  ladder.nextDropAt = planned.nextDropAt;
  if (planned.to <= ladder.floorPrice) ladder.floorReachedAt = iso(now);
  await persist(job);

  const missed = planned.weeks > 1 ? ` (${planned.weeks} veckor ikapp)` : "";
  const done = ladder.floorReachedAt ? " — golvet nått, priset ligger kvar" : "";
  console.info(`[pris-steg] ${job.id.slice(0, 8)} möbeln ${from} → ${planned.to} kr${missed}${done}`);
  return true;
}

/**
 * Ett varv: sänker det som förfallit och flyttar varje kanal som inte visar stegens pris.
 *
 * Kanalerna synkas även när ingen sänkning skedde just nu — en adminändring, ett avslag för sex
 * timmar sedan eller en Blocket-robot som just slogs på är alla skäl att försöka igen.
 */
export async function tickPriceLadders(
  now = Date.now(),
  beroenden: Partial<SynkBeroenden> = {},
): Promise<{ sankta: number; flyttade: number }> {
  let sankta = 0;
  let flyttade = 0;
  for (const job of await listJobs()) {
    if (!job.priceLadder) continue;
    try {
      if (!(await annonsenLever(job))) continue;
      const ladder = job.priceLadder;

      /**
       * Övergången från den frusna stegen, en gång per annons.
       *
       * En annons som låg på Blocket när den här koden kom hade sin klocka stoppad i veckor
       * (`ladderFrozenByBlocket`). Att "ta igen" de veckorna nu vore två–tre sänkningar på en gång,
       * på ett pris säljaren sett stå stilla — frysningen var ett beslut då, inte ett driftstopp.
       * Klockan startar om från i dag i stället. Känns igen på att Blocket är uppe utan kvitto;
       * efter arvet nedan händer det aldrig igen.
       */
      const varFrusen = job.blocket?.status === "published" && !job.blocket.pris;
      // Arvet FÖRE sänkningen — se arvKanalPris.
      if (arvKanalPris(job, now)) {
        if (varFrusen && ladder.nextDropAt && Date.parse(ladder.nextDropAt) <= now) {
          startaKlockan(ladder, now);
          console.info(`[pris-steg] ${job.id.slice(0, 8)} stod frusen av Blocket — klockan startar om från i dag, inga veckor tas igen`);
        }
        await persist(job);
      }

      /**
       * En annons som ligger ute med en steg vars klocka aldrig startats får den startad nu.
       *
       * Klockan startades förut bara av en lyckad Tradera-publicering. Möbler som gick ut i butiken
       * och på Blocket utan Tradera har därför en steg som aldrig gått. Priset rörs inte här — första
       * sänkningen kommer om en vecka, som för en nypublicerad annons.
       */
      if (!klockanStartad(ladder)) {
        startaKlockan(ladder, now);
        await persist(job);
        console.info(`[pris-steg] ${job.id.slice(0, 8)} låg ute utan startad klocka — startar den nu`);
      }

      if (await sankSteg(job, now)) sankta++;
      if (prisUrFas(job)) {
        const r = await synkaKanaler(job, { nu: () => now, ...beroenden });
        flyttade += r.flyttade.length;
      }
    } catch (err) {
      // Ett jobb som faller får inte ta resten av kön med sig.
      console.warn(`[pris-steg] ${job.id.slice(0, 8)} kraschade i varvet — ${err}`);
    }
  }
  return { sankta, flyttade };
}

/**
 * Kör stegen så länge servern lever.
 *
 * ALLTID PÅ. Den var förut avstängd utan Tradera-nycklar, och det var fel: möbeln sjunker i butiken
 * och på Blocket också. En kanal som inte är konfigurerad bokförs som "kräver manuell" på just den
 * kanalen (synkaKanaler) — den stoppar inte varvet.
 *
 * Ett varv direkt vid uppstart med flit: sänkningen är veckovis och servern startas om betydligt
 * oftare än så, men den kan också ha legat nere just den dagen ett steg förföll.
 */
export function startPriceLadderScheduler(): () => void {
  const timer = setInterval(() => {
    void tickPriceLadders().catch((err) => console.warn(`[pris-steg] varvet misslyckades — ${err}`));
  }, tickMs());
  void tickPriceLadders().catch((err) => console.warn(`[pris-steg] första varvet misslyckades — ${err}`));
  console.info(`[pris-steg] schemaläggaren igång, ett varv var ${Math.round(tickMs() / 60000)} min`);
  return () => clearInterval(timer);
}
