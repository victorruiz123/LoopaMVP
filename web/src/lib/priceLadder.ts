import type { PriceEstimate } from "../types";

/**
 * Prisstegens räkning, klientsidan.
 *
 * Spegel av server/src/priceLadder.ts, med samma motivering som types.ts och labels.ts bär: motorn är
 * fristående och webbklienten importerar inte ur den. Skillnaden är att här RÄKNAS stegen om medan
 * säljaren drar i reglaget — förhandsvisningen måste följa fingret, och ett serveranrop per pixel är
 * inte ett alternativ. Servern räknar ändå om sitt eget svar; det här talet är en visning, inte ett
 * beslut.
 */

/** 15 % i veckan — förvalet hela funktionen är byggd kring. */
export const WEEKLY_DROP = 0.15;

const ROUNDING = 10;

/** Nästa steg ner. Faller alltid, stannar på golvet. */
export function nextRung(current: number, floor: number, pct: number = WEEKLY_DROP): number {
  if (current <= floor) return floor;
  let next = Math.round((current * (1 - pct)) / ROUNDING) * ROUNDING;
  if (next >= current) next = current - ROUNDING;
  return Math.max(floor, next);
}

/** Hela stegen: startpriset först, golvet sist. */
export function ladderRungs(
  start: number,
  floor: number,
  pct: number = WEEKLY_DROP,
  maxWeeks = 104,
): number[] {
  const rungs = [Math.round(start)];
  let price = rungs[0];
  while (price > floor && rungs.length <= maxWeeks) {
    price = nextRung(price, floor, pct);
    rungs.push(price);
  }
  return rungs;
}

/** Antal veckor tills golvet nås. 0 när startpriset redan ÄR golvet. */
export function weeksToFloor(start: number, floor: number, pct: number = WEEKLY_DROP): number {
  return ladderRungs(start, floor, pct).length - 1;
}

/** Avrundning till jämna tior — samma som stegen använder, så reglagen inte ger tal stegen aldrig kan nå. */
export function roundToRung(value: number): number {
  return Math.max(ROUNDING, Math.round(value / ROUNDING) * ROUNDING);
}

/**
 * Reglagens ytterlägen.
 *
 * Prismotorns spann är utgångspunkten men inte en gräns: en säljare som vet något om just sin möbel —
 * en ovanlig färg, ett nyligen omklätt tyg — ska kunna begära mer än "säljs långsamt", och den som
 * bara vill bli av med den ska kunna gå under "säljs snabbt". Marginalerna åt båda hållen finns för
 * att reglaget inte ska ta emot där motorn slutar.
 */
export function ladderBounds(price: PriceEstimate): { min: number; max: number; step: number } {
  const mid = price.default ?? 1000;
  const low = price.low ?? Math.round(mid * 0.7);
  const high = price.high ?? Math.round(mid * 1.3);
  const min = Math.max(ROUNDING, roundToRung(low * 0.5));
  const max = Math.max(min + ROUNDING * 10, roundToRung(high * 1.3));
  return { min, max, step: max > 6000 ? 50 : ROUNDING };
}

const DAY = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" });

/** "12 sep". Kort form — datumet står bredvid ett pris och ska inte konkurrera med det. */
export function formatDropDate(iso: string | null): string {
  if (!iso) return "–";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "–" : DAY.format(date);
}
