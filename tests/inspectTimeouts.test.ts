// ─── Tidsgränserna för inspektionsanropet skalar med antalet bilder ───
//
// Ett varv gav sex bilder; fotoguiden ger upp till tio. Mätt: 4 bilder 21 s, 8 bilder 37 s — ≈4 s per bild.
// En fast gräns på 60 s hade klippt av ett friskt anrop med tio bilder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectTimeouts } from "../server/src/pipeline/inspect.js";
import { JOB_DEADLINE_MS, MAX_IMAGES_PER_JOB, MIN_PHOTOS_FOR_GRADING } from "../server/src/config.js";

test("upp till fyra bilder rörs gränserna inte: golvet är de gamla 60 s och 30 s", () => {
  for (const n of [1, 2, 3, 4]) {
    assert.deepEqual(inspectTimeouts(n), { primaryMs: 60_000, fallbackMs: 30_000 }, `${n} bilder`);
  }
});

test("gränserna växer med antalet bilder", () => {
  assert.deepEqual(inspectTimeouts(6), { primaryMs: 68_000, fallbackMs: 34_000 });
  assert.deepEqual(inspectTimeouts(10), { primaryMs: 100_000, fallbackMs: 50_000 });
  for (let n = 1; n < MAX_IMAGES_PER_JOB; n++) {
    assert.ok(inspectTimeouts(n + 1).primaryMs >= inspectTimeouts(n).primaryMs);
  }
});

test("värsta fallet — primär OCH reserv — ryms i jobbets deadline vid taket", () => {
  const { primaryMs, fallbackMs } = inspectTimeouts(MAX_IMAGES_PER_JOB);
  // Granskning, pris och annons kommer efter, så inspektionen får inte äta hela klockan.
  assert.ok(primaryMs + fallbackMs < JOB_DEADLINE_MS * 0.75, `${primaryMs + fallbackMs} ms av ${JOB_DEADLINE_MS} ms`);
});

test("orimliga värden ger ändå en användbar gräns", () => {
  assert.deepEqual(inspectTimeouts(0), inspectTimeouts(1));
  assert.deepEqual(inspectTimeouts(-5), inspectTimeouts(1));
  assert.deepEqual(inspectTimeouts(2.9), inspectTimeouts(2));
});

test("minimikravet för skickbedömning ligger inom ramarna", () => {
  assert.ok(MIN_PHOTOS_FOR_GRADING >= 1 && MIN_PHOTOS_FOR_GRADING <= MAX_IMAGES_PER_JOB);
});

test("taket är tio: fotoguidens sju steg plus tre extra", () => {
  assert.equal(MAX_IMAGES_PER_JOB, 10);
});
