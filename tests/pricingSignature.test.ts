// Låser den jämförelse som avgör om ett spekulativt pris får behållas.
//
// Spekulationen startar prismotorn på den PRELIMINÄRA skadelistan, parallellt med granskningen. Blir
// listan densamma efter granskningen är svaret giltigt; blir den inte det ska det kastas. Hela den
// beslutspunkten vilar på pricingSignature, så den testas för sig.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pricingSignature } from "../server/src/pricing.js";
import { loadFixtures } from "./snapshot.js";
import type { Damage } from "../server/src/types.js";

function damage(over: Partial<Damage> = {}): Damage {
  return {
    id: "d1",
    type: "scratch",
    part: "sits",
    semanticLocation: "framkant",
    severity: "S2",
    impact: "cosmetic",
    description: "Repa på sitsens framkant",
    confidence: 90,
    verification: "CONFIRMED",
    verificationReason: "",
    evidence: [],
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
    ...over,
  };
}

test("oförändrad lista ger samma signatur — spekulationen får behållas", () => {
  const list = [damage({ id: "a" }), damage({ id: "b", type: "stain", part: "rygg" })];
  assert.equal(pricingSignature(list, "Bra skick"), pricingSignature([...list], "Bra skick"));
});

test("ordningen spelar ingen roll — granskningen kan flytta om ett fynd utan att ändra priset", () => {
  const a = damage({ id: "a" });
  const b = damage({ id: "b", type: "stain", part: "rygg" });
  assert.equal(pricingSignature([a, b], "Bra skick"), pricingSignature([b, a], "Bra skick"));
});

test("ett avslaget fynd ändrar signaturen — spekulationen ska missa", () => {
  const kept = damage({ id: "a" });
  const rejected = damage({ id: "b", type: "stain", part: "rygg" });
  const before = pricingSignature([kept, rejected], "Bra skick");
  const after = pricingSignature([kept, { ...rejected, verification: "REJECTED" }], "Bra skick");
  assert.notEqual(before, after);
});

test("annat skick ändrar signaturen även när skadelistan står stilla", () => {
  const list = [damage()];
  assert.notEqual(pricingSignature(list, "Bra skick"), pricingSignature(list, "Okej skick"));
});

test("skillnader som INTE når prismotorn räknas inte som skillnad", () => {
  // S3 och S4 mappar båda till grad 2, och confidence skickas aldrig med. Två listor som ger
  // prismotorn identisk indata ska ge identisk signatur — annars kastas ett giltigt svar i onödan.
  const s3 = damage({ severity: "S3", confidence: 70 });
  const s4 = damage({ severity: "S4", confidence: 99 });
  assert.equal(pricingSignature([s3], "Bra skick"), pricingSignature([s4], "Bra skick"));
});

// ---- B.6: det verkliga fallet ur fixturerna --------------------------------
// video-1-run3 är den enda inspelade körningen där granskningen avslog ett fynd. Där MÅSTE
// spekulationen missa, annars prissätts möbeln på en skada besiktningen tog tillbaka.
test("video-1-run3: granskningens avslag får spekulationen att missa", () => {
  const fixture = loadFixtures().find((f) => f.id === "video-1-run3");
  assert.ok(fixture, "fixturen video-1-run3 saknas");
  const rejected = fixture.input.damages.filter((d) => d.verification === "REJECTED");
  assert.equal(rejected.length, 1, "fixturen ska ha exakt ett avslaget fynd");

  const afterVerify = pricingSignature(fixture.input.damages, "Mycket bra skick");
  // Före granskningen stod alla fynd — det är listan spekulationen startar på.
  const beforeVerify = pricingSignature(
    fixture.input.damages.map((d): Damage => ({ ...d, verification: "CONFIRMED" })),
    "Mycket bra skick",
  );
  assert.notEqual(beforeVerify, afterVerify, "avslaget måste synas i signaturen");
});

test("de övriga inspelade körningarna träffar — spekulationen lönar sig", () => {
  const recorded = loadFixtures().filter((f) => f.source === "recorded" && f.id !== "video-1-run3");
  let hits = 0;
  for (const f of recorded) {
    const before = pricingSignature(
      f.input.damages.map((d): Damage => ({ ...d, verification: "CONFIRMED" })),
      "Bra skick",
    );
    if (before === pricingSignature(f.input.damages, "Bra skick")) hits++;
  }
  assert.equal(hits, recorded.length, `${recorded.length - hits} av ${recorded.length} skulle ha missat`);
});
