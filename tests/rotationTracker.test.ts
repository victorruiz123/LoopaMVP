// ─── rotationTracker: vinkelmatematiken bakom autostoppet ────────────────────
//
// alpha är 0-360 och wrappar. Ett varv som passerar noll ser ut som ett hopp på
// -359 grader om man subtraherar rått, och då nollställs varvräkningen mitt i.
// Det är hela poängen med signedDelta, och det som är värt att låsa fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signedDelta } from "../web/src/lib/rotationTracker.js";

test("vanlig rörelse framåt", () => {
  assert.equal(signedDelta(10, 15), 5);
});

test("vanlig rörelse bakåt", () => {
  assert.equal(signedDelta(15, 10), -5);
});

test("wrap 359 -> 1 är +2, inte -358", () => {
  assert.equal(signedDelta(359, 1), 2);
});

test("wrap 1 -> 359 är -2, inte +358", () => {
  assert.equal(signedDelta(1, 359), -2);
});

test("wrap 350 -> 10 är +20", () => {
  assert.equal(signedDelta(350, 10), 20);
});

test("exakt 180 viks inte om till -180", () => {
  assert.equal(signedDelta(0, 180), 180);
});

test("ett helt varv i 36 steg summerar till 360", () => {
  let prev = 0;
  let total = 0;
  for (let i = 1; i <= 36; i++) {
    const a = (i * 10) % 360;
    total += Math.abs(signedDelta(prev, a));
    prev = a;
  }
  assert.equal(Math.round(total), 360);
});

test("ett varv som PASSERAR noll summerar också till 360", () => {
  let prev = 350;
  let total = 0;
  for (let i = 1; i <= 36; i++) {
    const a = (350 + i * 10) % 360;
    total += Math.abs(signedDelta(prev, a));
    prev = a;
  }
  assert.equal(Math.round(total), 360);
});

test("ett halvt varv fram och tillbaka summerar till ett helt — riktningen spelar ingen roll", () => {
  // Säljaren som backar tillbaka ska inte få sin framgång uppäten, men ska heller inte
  // kunna vifta sig till ett varv: varje steg räknas som absolutbelopp.
  let prev = 0;
  let total = 0;
  for (const a of [90, 180, 90, 0]) {
    total += Math.abs(signedDelta(prev, a));
    prev = a;
  }
  assert.equal(total, 360);
});
