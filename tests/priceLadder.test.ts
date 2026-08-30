// ─── priceLadder.ts: prisspannet och vandringen ner genom det ────────────────
//
// Stegen sänker priset på riktiga, publika annonser, veckor efter att någon tittat på skärmen. Det
// gör räkningen till den enda platsen felet kan upptäckas i tid: en steg som trampar på samma tal
// sänker aldrig, och en som räknar fel ikapp sänker för mycket.
//
// Verkställandet — anropet mot Tradera — testas inte här. Det är ett nätverksanrop; beslutet OM det,
// och till vilket pris, är det som är vårt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WEEKLY_DROP,
  ladderRungs,
  makePriceLadder,
  nextRung,
  plannedDrop,
} from "../server/src/priceLadder.js";
import type { PriceLadder } from "../server/src/types.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

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
