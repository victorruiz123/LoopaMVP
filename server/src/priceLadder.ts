/**
 * Prisstegen — säljarens spann, och vandringen ner genom det.
 *
 * Prismotorn svarar med tre tal: säljs snabbt, förslag, säljs långsamt. Vilket av dem som är rätt
 * beror på något motorn omöjligt kan veta — hur bråttom säljaren har. Stegen låter dem svara på det
 * själva: ett startpris, ett golv, och en sänkning på 15 % i veckan däremellan. Annonsen börjar där
 * säljaren hoppas, och letar sig ner mot det de accepterar utan att de behöver röra den.
 *
 * Modulen gör två saker, medvetet åtskilda: räkna ut nästa steg (rena funktioner, testade i
 * tests/priceLadder.test.ts) och verkställa det mot Tradera (schemaläggaren längst ner).
 */

import { getJob, listJobs, persist } from "./jobStore.js";
import { traderaConfigured, updateTraderaPrice } from "./integrations/tradera/tradera.js";
import { traderaPriceWithShipping } from "./integrations/tradera/shipping.js";
import type { ConditionJob, PriceLadder } from "./types.js";

/** 15 % i veckan. Kan sättas per annons, men det här är förvalet hela funktionen är byggd kring. */
export const DEFAULT_WEEKLY_DROP = 0.15;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hur långt det är mellan två sänkningar. En vecka i drift; miljövariabeln finns för att kunna se
 * hela stegen löpa på några minuter i en demo utan att vänta en månad på fjärde steget.
 */
export function dropIntervalMs(): number {
  const ms = Number(process.env.PRICE_LADDER_INTERVAL_MS ?? WEEK_MS);
  return Number.isFinite(ms) && ms >= 1000 ? ms : WEEK_MS;
}

/** Hur ofta vi tittar efter förfallna sänkningar. Inte samma sak som hur ofta de sker. */
function tickMs(): number {
  const ms = Number(process.env.PRICE_LADDER_TICK_MS ?? 15 * 60 * 1000);
  return Number.isFinite(ms) && ms >= 1000 ? ms : 15 * 60 * 1000;
}

/**
 * Ett avvisat prisbyte får inte tystna till nästa vecka — men det får inte heller mala. Sex timmar
 * ger ett par nya försök inom veckan och slutar sedan av sig självt när golvet ändå nås.
 */
const RETRY_MS = 6 * 60 * 60 * 1000;

/** Priser sätts i jämna tior. Ett steg som landar på 2 037 kr läser som en bugg, inte som en rabatt. */
const ROUNDING = 10;

/** Lägsta pris Tradera tar emot. Golvet får inte ställas under det. */
const MIN_PRICE = 1;

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

  const rawPct = input.weeklyDropPct === undefined ? DEFAULT_WEEKLY_DROP : Number(input.weeklyDropPct);
  if (!Number.isFinite(rawPct) || rawPct <= 0 || rawPct >= 1) {
    return { error: "Sänkningen måste vara mellan 0 och 100 % i veckan." };
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
 * inhämtade veckor blir ETT prisbyte hos Tradera, vilket också är vad en köpare ser: ett pris.
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

// ---------- Verkställandet ----------

/**
 * Startar klockan när annonsen faktiskt ligger uppe.
 *
 * `publishedPrice` och inte `startPrice`: föll prisstegen bort och annonsen gick upp på
 * annonsgeneratorns förslag är DET priset sänkningen ska utgå från, inte ett tal från en steg som
 * aldrig användes.
 */
export async function armPriceLadder(
  jobId: string,
  publishedPrice: number,
  mode: "auction" | "fixed",
): Promise<void> {
  const job = await getJob(jobId);
  const ladder = job?.priceLadder;
  if (!job || !ladder) return;

  ladder.currentPrice = Math.round(publishedPrice);
  ladder.listingMode = mode;
  ladder.lastError = null;
  if (ladder.currentPrice <= ladder.floorPrice) {
    ladder.floorReachedAt = new Date().toISOString();
    ladder.nextDropAt = null;
  } else {
    ladder.floorReachedAt = null;
    ladder.nextDropAt = new Date(Date.now() + dropIntervalMs()).toISOString();
  }
  await persist(job);
}

/** Har jobbet en steg som ligger och väntar på nästa sänkning? */
export function ladderIsRunning(job: ConditionJob): boolean {
  const ladder = job.priceLadder;
  if (!ladder || !ladder.nextDropAt || ladder.floorReachedAt) return false;
  return job.tradera?.status === "published" && typeof job.tradera.itemId === "number";
}

async function applyDrop(job: ConditionJob, now: number): Promise<boolean> {
  const ladder = job.priceLadder!;
  const itemId = job.tradera!.itemId!;
  const planned = plannedDrop(ladder, now, dropIntervalMs());
  if (!planned) return false;

  const from = ladder.currentPrice;
  if (planned.to >= from) {
    // Redan i botten — stegen är färdig även om ingen hann markera den som det.
    ladder.floorReachedAt = new Date(now).toISOString();
    ladder.nextDropAt = null;
    await persist(job);
    return false;
  }

  try {
    // Fastpris byter Köp Nu-priset, auktion byter utropspriset. Det senare avvisar Tradera så fort
    // annonsen fått ett bud — och det är rätt: ett utropspris under ett lagt bud är inte en sänkning,
    // det är ett annat kontrakt. Avslaget hamnar i `lastError` och syns för säljaren.
    //
    // Frakten läggs på HÄR och räknas aldrig in i stegen: talen i `ladder` är möbelkronor, priset i
    // annonsen är möbeln plus hemleveransen. Sänkningen ska äta av möbeln, inte av leveransen.
    await updateTraderaPrice(itemId, traderaPriceWithShipping(planned.to), ladder.listingMode ?? "fixed");
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    ladder.lastError = message;
    // Skjut fram, inte bort: en avvisad sänkning ska försöka igen inom veckan, inte tiga till nästa.
    ladder.nextDropAt = new Date(now + RETRY_MS).toISOString();
    await persist(job);
    console.warn(`[pris-steg] ${job.id.slice(0, 8)} kunde inte sänkas till ${planned.to} kr — ${message}`);
    return false;
  }

  ladder.currentPrice = planned.to;
  ladder.drops.push({ at: new Date(now).toISOString(), from, to: planned.to });
  ladder.lastError = null;
  ladder.nextDropAt = planned.nextDropAt;
  if (planned.to <= ladder.floorPrice) ladder.floorReachedAt = new Date(now).toISOString();
  await persist(job);

  const missed = planned.weeks > 1 ? ` (${planned.weeks} veckor ikapp)` : "";
  const done = ladder.floorReachedAt ? " — golvet nått, priset ligger kvar" : "";
  console.info(
    `[pris-steg] ${job.id.slice(0, 8)} ${from} → ${planned.to} kr` +
      ` (annonspris ${traderaPriceWithShipping(planned.to)} kr med frakt)${missed}${done}`,
  );
  return true;
}

/** Ett varv: sänker priset på varje publicerad annons vars vecka gått ut. Returnerar antalet. */
export async function tickPriceLadders(now = Date.now()): Promise<number> {
  if (!traderaConfigured()) return 0;
  let dropped = 0;
  for (const job of await listJobs()) {
    if (!ladderIsRunning(job)) continue;
    try {
      if (await applyDrop(job, now)) dropped++;
    } catch (err) {
      // Ett jobb som faller får inte ta resten av kön med sig.
      console.warn(`[pris-steg] ${job.id.slice(0, 8)} kraschade i sänkningen — ${err}`);
    }
  }
  return dropped;
}

/**
 * Kör stegen så länge servern lever.
 *
 * Ett varv direkt vid uppstart med flit: sänkningen är veckovis och servern startas om betydligt
 * oftare än så, men den kan också ha legat nere just den dagen ett steg förföll.
 */
export function startPriceLadderScheduler(): () => void {
  if (!traderaConfigured()) return () => {};
  const timer = setInterval(() => {
    void tickPriceLadders().catch((err) => console.warn(`[pris-steg] varvet misslyckades — ${err}`));
  }, tickMs());
  void tickPriceLadders().catch((err) => console.warn(`[pris-steg] första varvet misslyckades — ${err}`));
  console.info(`[pris-steg] schemaläggaren igång, ett varv var ${Math.round(tickMs() / 60000)} min`);
  return () => clearInterval(timer);
}
