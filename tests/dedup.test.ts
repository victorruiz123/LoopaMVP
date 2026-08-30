// ─── dedup.ts: the local safety net after the main inspection call ───────────
//
// Pass 1 merges same-image findings in one damage family whose boxes overlap (IoU).
// Pass 2 merges findings across images when family, part and location point at the
// same place — luddigt, för modellen skriver sällan samma del likadant två gånger.
//
// The pass-2 tests are the discriminating pair for fix 2b: identical
// semanticLocation MUST keep merging, different semanticLocation must NOT.
// Today only the first holds; the second is gated on APPLIED_FIXES.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeDamages } from "../server/src/pipeline/dedup.js";
import type { Damage, DamageEvidence } from "../server/src/types.js";
import { APPLIED_FIXES } from "./fixes.js";

let seq = 0;

function box(imageId: string, x: number, y: number, w = 0.2, h = 0.2): DamageEvidence {
  return { imageId, mark: { kind: "box", x, y, w, h } };
}

function dmg(p: Partial<Damage> = {}): Damage {
  seq += 1;
  return {
    id: `d_${seq}`,
    type: p.type ?? "scratch",
    part: p.part ?? "sitsens ovansida",
    semanticLocation: p.semanticLocation ?? "främre kanten",
    severity: p.severity ?? "S1",
    impact: p.impact ?? "cosmetic",
    description: p.description ?? "",
    confidence: p.confidence ?? 80,
    verification: p.verification ?? "CONFIRMED",
    verificationReason: "",
    evidence: p.evidence ?? [box("img_0", 0.1, 0.1)],
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
  };
}

// ── pass 1: IoU inom samma bild ─────────────────────────────────────────────

test("pass 1: överlappande boxar, samma bild och typ, slås ihop", () => {
  // Olika part gör att pass 2 inte kan ta åt sig äran.
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.15, 0.15)] }),
  ]);
  assert.equal(out.length, 1);
});

test("pass 1: boxar utan överlapp slås inte ihop", () => {
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.0, 0.0, 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.8, 0.8, 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

test("pass 1: boxar jämförs aldrig över bildgränser", () => {
  // Identiska koordinater men olika bilder — inget gemensamt koordinatsystem.
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

// ── pass 2: typ + del ───────────────────────────────────────────────────────

test("pass 2: samma typ, del OCH plats i tre olika bilder slås ihop till en", () => {
  // Modellen missade att konsolidera samma fysiska repa sedd från tre håll.
  const out = dedupeDamages([
    dmg({ evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ evidence: [box("img_1", 0.4, 0.2)] }),
    dmg({ evidence: [box("img_2", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 3, "alla tre bevisen ska följa med");
});

test("pass 2: olika typ på samma del slås aldrig ihop", () => {
  const out = dedupeDamages([
    dmg({ type: "scratch", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ type: "stain", evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

test("pass 2 [BUGG 2b]: samma del men olika semanticLocation", () => {
  // Systemprompten säger uttryckligen att två skador på samma del men olika
  // ställen är SKILDA defekter. Nyckeln är type+part och ignorerar platsen,
  // så idag slås de ihop ändå.
  const out = dedupeDamages([
    dmg({ semanticLocation: "främre vänstra kanten", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ semanticLocation: "bakre högra hörnet", evidence: [box("img_1", 0.7, 0.7)] }),
    dmg({ semanticLocation: "mitten", evidence: [box("img_2", 0.4, 0.4)] }),
  ]);
  const expected = APPLIED_FIXES.has("2b") ? 3 : 1;
  assert.equal(out.length, expected);
});

// ── mergeGroup ──────────────────────────────────────────────────────────────

test("merge: den allvarligaste skadan blir primär", () => {
  const out = dedupeDamages([
    dmg({ severity: "S1", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ severity: "S3", evidence: [box("img_1", 0.1, 0.1)] }),
    dmg({ severity: "S2", evidence: [box("img_2", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "S3");
});

test("merge: confidence blir gruppens medelvärde", () => {
  const out = dedupeDamages([
    dmg({ confidence: 80, evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ confidence: 60, evidence: [box("img_1", 0.1, 0.1)] }),
  ]);
  assert.equal(out[0].confidence, 70);
});

test("merge: identiska bevis i samma bild dubbleras inte", () => {
  const out = dedupeDamages([
    dmg({ part: "sitsen", evidence: [box("img_0", 0.1, 0.1)] }),
    dmg({ part: "ryggstödet", evidence: [box("img_0", 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 1);
});

test("dedup lämnar en ensam skada orörd", () => {
  const one = dmg();
  const out = dedupeDamages([one]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, one.id);
});

test("dedup klarar tom input", () => {
  assert.deepEqual(dedupeDamages([]), []);
});

// ── pass 2: luddig matchning över bildrutor ─────────────────────────────────
//
// Varför luddig: modellen döper samma del olika i två bildrutor ("sitsens ram",
// "sitsens sarg") och väljer olika typ för samma märke ("scuff", "worn_material").
// Exakt strängmatchning gjorde då två skador av en — kortet räknade upp samma
// repa två gånger, och tröskeln på >=3 skador flyttade betyget i onödan.
//
// Spärren mot att gå för långt är LÄGESORDEN. De testas var för sig nedan.

test("samma del, olika ordval, slås ihop över bildrutor", () => {
  const out = dedupeDamages([
    dmg({ type: "chip", part: "sitsens ram", semanticLocation: "främre högra hörnet", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "chip", part: "sitsens sarg", semanticLocation: "främre högra hörnet", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2, "skadan ska kunna märkas ut i båda bildrutorna");
});

test("samma märke under två namn i samma familj slås ihop", () => {
  const out = dedupeDamages([
    dmg({ type: "worn_material", part: "ryggstöd", semanticLocation: "övre kanten", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scuff", part: "ryggstöd", semanticLocation: "översta kanten", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 1);
});

test("sammansättningar räknas som samma del: 'vänster framben' och 'främre vänstra benet'", () => {
  const out = dedupeDamages([
    dmg({ type: "scuff", part: "vänster framben", semanticLocation: "nedre delen nära golvet", evidence: [box("img_0", 0.2, 0.8)] }),
    dmg({ type: "worn_material", part: "främre vänstra benet", semanticLocation: "nederkanten vid foten", evidence: [box("img_1", 0.7, 0.8)] }),
  ]);
  assert.equal(out.length, 1);
});

test("en konkret typ vinner över general_wear när gruppen slås ihop", () => {
  // Kortet ska säga "skrapmärke", inte "allmänt slitage": säljaren ska kunna gå
  // fram till möbeln och se efter vad anmärkningen gäller.
  const out = dedupeDamages([
    dmg({ type: "general_wear", part: "höger armstöd", semanticLocation: "ovansidan", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scuff", part: "höger armstöd", semanticLocation: "ovansidan framtill", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "scuff");
});

test("olika familj slås aldrig ihop, hur lika läget än är", () => {
  const out = dedupeDamages([
    dmg({ type: "stain", part: "sitsen", semanticLocation: "mitten", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scratch", part: "sitsen", semanticLocation: "mitten", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 2);
});

// ── lägesorden: spärren som gör den luddiga matchningen ofarlig ─────────────

const KONFLIKTER: Array<[string, string, string]> = [
  ["vänster mot höger", "vänster framben", "höger framben"],
  ["fram mot bak", "främre vänstra benet", "bakre vänstra benet"],
  ["över mot under", "sitsens ovansida", "sitsens undersida"],
];

for (const [namn, partA, partB] of KONFLIKTER) {
  test(`lägesord i konflikt (${namn}) hindrar sammanslagning`, () => {
    const out = dedupeDamages([
      dmg({ type: "scuff", part: partA, semanticLocation: "kanten", evidence: [box("img_0", 0.2, 0.2)] }),
      dmg({ type: "scuff", part: partB, semanticLocation: "kanten", evidence: [box("img_1", 0.6, 0.3)] }),
    ]);
    assert.equal(out.length, 2);
  });
}

test("övre och nedre kanten på samma del är två ställen", () => {
  const out = dedupeDamages([
    dmg({ type: "scuff", part: "ryggstöd", semanticLocation: "övre kanten", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scuff", part: "ryggstöd", semanticLocation: "nedre kanten", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 2);
});

test("mitten av en yta är inte dess kant", () => {
  const out = dedupeDamages([
    dmg({ type: "scratch", part: "sits", semanticLocation: "mitten av sitsen", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scratch", part: "sits", semanticLocation: "främre högra hörnet", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 2);
});

test("ett läge som bara pekar åt olika håll slås inte ihop på ordlikhet", () => {
  // "sitsens ovansida" och "främre högra hörnet" motsäger inte varandra, men de
  // pekar inte heller åt samma håll — en repa på sitsytan och ett skav i hörnet.
  const out = dedupeDamages([
    dmg({ type: "scratch", part: "sits", semanticLocation: "ovansida", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scuff", part: "sits", semanticLocation: "främre högra hörnet", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 2);
});

test("olika delar slås inte ihop bara för att läget heter samma sak", () => {
  const out = dedupeDamages([
    dmg({ type: "scuff", part: "ryggstöd", semanticLocation: "kanten", evidence: [box("img_0", 0.2, 0.2)] }),
    dmg({ type: "scuff", part: "vänster armstöd", semanticLocation: "kanten", evidence: [box("img_1", 0.6, 0.3)] }),
  ]);
  assert.equal(out.length, 2);
});

// ── pass 1: familjen gäller även inom en bildruta ───────────────────────────

test("pass 1: samma märke rapporterat som två typer i samma bild slås ihop", () => {
  const out = dedupeDamages([
    dmg({ type: "scratch", part: "sitsen", semanticLocation: "mitten", evidence: [box("img_0", 0.30, 0.30, 0.2, 0.2)] }),
    dmg({ type: "abrasion", part: "annan del", semanticLocation: "annat ställe", evidence: [box("img_0", 0.32, 0.32, 0.2, 0.2)] }),
  ]);
  assert.equal(out.length, 1);
});

test("pass 1: två typer i samma bild med svagt överlapp hålls isär", () => {
  // Kravet på överlapp är hårdare när typerna skiljer sig: en repa och en nötning
  // som knappt tangerar varandra är två fynd, inte ett dubbelrapporterat.
  const out = dedupeDamages([
    dmg({ type: "scratch", part: "sitsen", semanticLocation: "mitten", evidence: [box("img_0", 0.30, 0.30, 0.2, 0.2)] }),
    dmg({ type: "abrasion", part: "annan del", semanticLocation: "annat ställe", evidence: [box("img_0", 0.42, 0.42, 0.2, 0.2)] }),
  ]);
  assert.equal(out.length, 2);
});

// ── pass 2 rör aldrig två fynd ur samma bildruta ────────────────────────────

test("två märken i SAMMA bildruta, samma ord, hålls isär", () => {
  // Två skav på samma ben, en bit ifrån varandra, rapporterade ur samma bildruta:
  // modellen ger dem samma del och samma läge, så pass 2:s ordmatchning såg en enda
  // skada. Rutorna säger något annat, och det är pass 1 som får jämföra dem.
  const out = dedupeDamages([
    dmg({ type: "scuff", part: "vänster framben", semanticLocation: "nedre delen", evidence: [box("img_0", 0.10, 0.10, 0.1, 0.1)] }),
    dmg({ type: "scuff", part: "vänster framben", semanticLocation: "nedre delen", evidence: [box("img_0", 0.60, 0.60, 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 2);
});

test("samma skada ur två bildrutor slås fortfarande ihop", () => {
  // Spärren ovan får inte träffa det den inte gäller: olika bildrutor, samma märke.
  const out = dedupeDamages([
    dmg({ type: "scuff", part: "vänster framben", semanticLocation: "nedre delen", evidence: [box("img_0", 0.10, 0.10, 0.1, 0.1)] }),
    dmg({ type: "scuff", part: "vänster framben", semanticLocation: "nedre delen", evidence: [box("img_1", 0.60, 0.60, 0.1, 0.1)] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2);
});
