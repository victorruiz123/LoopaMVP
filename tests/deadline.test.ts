// ─── Identifieringens hårda tidsgräns ─────────────────────────────────────────────────────────────
//
// En klocka för hela identifieringen: tid kvar räknas för allt, signalen avbryts när tiden är slut, och arbete som inte hinner bli klart
// startas inte. Här prövas klockan själv (med en falsk tid där det går); att identifieringen faktiskt håller den prövas i
// tests/identify-deadline.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Deadline, DeadlineExceeded, isDeadlineExceeded } from "../server/src/research/deadline.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

test("tid kvar, förfluten tid och budget räknas från starten — och går aldrig under noll", () => {
  const c = fakeClock();
  const d = new Deadline(56_000, { now: c.now });
  assert.equal(d.remaining(), 56_000);
  assert.equal(d.elapsed(), 0);
  c.advance(20_000);
  assert.equal(d.remaining(), 36_000);
  assert.equal(d.elapsed(), 20_000);
  assert.equal(d.budget(1_500), 34_500, "det ett anrop får när 1,5 s måste finnas kvar efter det");
  c.advance(100_000);
  assert.equal(d.remaining(), 0);
  assert.equal(d.budget(1_500), 0, "aldrig negativt");
  assert.equal(d.expired(), true);
  d.dispose();
});

test("arbete som inte hinner bli klart startas inte: canStart svarar på tiden som finns kvar", () => {
  const c = fakeClock();
  const d = new Deadline(56_000, { now: c.now });
  assert.equal(d.canStart(40_000), true);
  c.advance(30_000);
  assert.equal(d.canStart(40_000), false, "26 s kvar räcker inte till ett anrop på 40 s");
  assert.equal(d.canStart(20_000), true);
  d.dispose();
});

test("startar klockan efter att tiden gått (t.ex. bildförberedelsen räknades redan) räknas från den tidigare starten", () => {
  const c = fakeClock();
  const d = new Deadline(56_000, { now: c.now, startedAt: c.now() - 6_000 });
  assert.equal(d.remaining(), 50_000);
  d.dispose();
});

test("signalen avbryts när tiden är slut, med en orsak som går att känna igen", async () => {
  const d = new Deadline(60);
  assert.equal(d.signal.aborted, false);
  await sleep(110);
  assert.equal(d.signal.aborted, true);
  assert.ok(d.signal.reason instanceof DeadlineExceeded);
  assert.equal(isDeadlineExceeded(d.signal.reason), true);
  assert.equal(isDeadlineExceeded(new Error("annat")), false);
  d.dispose();
});

test("en tidsgräns som redan gått ut är avbruten från början", () => {
  const d = new Deadline(10, { startedAt: Date.now() - 1_000 });
  assert.equal(d.signal.aborted, true);
  assert.equal(d.canStart(1), false);
});

test("dispose stoppar klockan: ett färdigt resultat avbryts inte i efterhand", async () => {
  const d = new Deadline(40);
  d.dispose();
  await sleep(90);
  assert.equal(d.signal.aborted, false);
});

test("within: avbryts av tidsgränsen ELLER av anroparens egen signal", async () => {
  const d = new Deadline(5_000);
  const caller = new AbortController();
  const combined = d.within(caller.signal, undefined);
  assert.equal(combined.aborted, false);
  caller.abort();
  assert.equal(combined.aborted, true, "anroparen avbröt");

  const d2 = new Deadline(40);
  const other = new AbortController();
  const c2 = d2.within(other.signal);
  await sleep(90);
  assert.equal(c2.aborted, true, "tidsgränsen gick ut");
  assert.ok(isDeadlineExceeded(c2.reason));
  d.dispose();
  d2.dispose();
});
