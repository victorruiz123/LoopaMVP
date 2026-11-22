// ─── Bildguidens regler (web/src/lib/photoGuide.ts) ──────────────────────────
//
// Guidens skärm är det som ritas; reglerna är det som avgör om en säljare får skicka, vad som räknas som en
// bild, och i vilken ordning modellen ser dem. Ett fel här syns inte som ett krasch utan som en besiktning
// på fel underlag — så reglerna prövas utan skärm.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRA_STEP,
  GUIDE_STEPS,
  MAX_PHOTOS,
  MIN_PHOTOS,
  canPlace,
  canSubmit,
  distinctShots,
  firstMissingCore,
  isLastStep,
  makeShot,
  missingCore,
  nextOpenStep,
  orderForUpload,
  photoCount,
  placeShot,
  remainingToMin,
  removeShot,
  shotFor,
  takenByStep,
  toPayload,
  type GuideShot,
} from "../web/src/lib/photoGuide.js";
import { MAX_IMAGES_PER_JOB } from "../server/src/config.js";
import { GUIDE_MIN_PHOTOS } from "../server/src/config.js";

const step = (id: string) => GUIDE_STEPS.find((s) => s.id === id)!;
let n = 0;
/** En bild med unikt innehåll — olika data-URL:er, som olika tagningar. */
const bild = (stepId: string | null): GuideShot => makeShot(`data:image/jpeg;base64,${++n}`, stepId ? step(stepId) : null, "camera");

/** Alla fem kärnstegen tagna. */
function karna(): GuideShot[] {
  return ["cover", "front", "left", "back", "right"].reduce<GuideShot[]>((s, id) => placeShot(s, bild(id)), []);
}

// ─── stegen ───

test("sju steg: omslaget först, sedan varvet, sedan de två valfria", () => {
  assert.deepEqual(GUIDE_STEPS.map((s) => s.id), ["cover", "front", "left", "back", "right", "top", "closeup"]);
});

test("kärnan är exakt fem — det är minimikravet", () => {
  assert.equal(GUIDE_STEPS.filter((s) => s.core).length, MIN_PHOTOS);
  assert.deepEqual(GUIDE_STEPS.filter((s) => !s.core).map((s) => s.id), ["top", "closeup"]);
});

test("klientens och serverns siffror är lika", () => {
  assert.equal(MIN_PHOTOS, GUIDE_MIN_PHOTOS);
  assert.equal(MAX_PHOTOS, MAX_IMAGES_PER_JOB);
  // Guiden får aldrig be om fler bilder än servern behåller.
  assert.ok(GUIDE_STEPS.length <= MAX_IMAGES_PER_JOB);
});

test("varje steg har en unik etikett, en rubrik och en instruktion", () => {
  const labels = new Set(GUIDE_STEPS.map((s) => s.label));
  assert.equal(labels.size, GUIDE_STEPS.length);
  for (const s of [...GUIDE_STEPS, EXTRA_STEP]) {
    assert.ok(s.title.trim() && s.instruction.trim(), `${s.id} saknar text`);
  }
});

test("etiketterna är de servern känner igen: omslag, vyer, närbild och extra", () => {
  assert.deepEqual(
    [...GUIDE_STEPS, EXTRA_STEP].map((s) => s.label),
    ["Omslagsbild", "Framifrån", "Vänster sida", "Bakifrån", "Höger sida", "Ovanifrån", "Närbild", "Extra bild"],
  );
});

test("kortnamnen är unika och ryms i stegraden: högst åtta tecken", () => {
  // Sju steg delar en telefonbredd, ≈47 px var. "Omslagsbild" och "Ovanifrån" bröts mitt i ordet i det kortet.
  const shorts = [...GUIDE_STEPS, EXTRA_STEP].map((s) => s.short);
  assert.equal(new Set(shorts).size, shorts.length);
  for (const s of shorts) assert.ok(s.length > 0 && s.length <= 8, `"${s}" är ${s.length} tecken`);
});

test("instruktionerna nämner inte armstöd eller dynor — de ska passa en stol och ett bord också", () => {
  for (const s of GUIDE_STEPS.filter((x) => x.id !== "cover")) {
    assert.ok(!/armstöd|dyn/i.test(s.instruction), `${s.id}: ${s.instruction}`);
  }
});

test("sidorna förklarar att vänster och höger är sedda framifrån", () => {
  assert.match(step("left").instruction, /Sett framifrån/);
  assert.match(step("right").instruction, /Sett framifrån/);
});

// ─── bilder och minimum ───

test("en tom guide kan inte skickas, och saknar fem bilder", () => {
  assert.equal(canSubmit([]), false);
  assert.equal(remainingToMin([]), 5);
});

test("fyra bilder räcker inte; den femte öppnar", () => {
  const s = karna();
  assert.equal(canSubmit(s.slice(0, 4)), false);
  assert.equal(remainingToMin(s.slice(0, 4)), 1);
  assert.equal(canSubmit(s), true);
  assert.equal(remainingToMin(s), 0);
});

test("omslaget räknas mot minimum", () => {
  // Omslag + framifrån + vänster + baksida + höger = 5. Utan omslaget behövs en femte bild från någon annanstans.
  assert.equal(canSubmit(karna().filter((s) => s.stepId !== "cover")), false);
});

test("vilka fem bilder som helst räcker — kravet är antal, inte vilka steg", () => {
  const s = ["top", "closeup", "front", "left", "back"].reduce<GuideShot[]>((acc, id) => placeShot(acc, bild(id)), []);
  assert.equal(canSubmit(s), true, "ett hoppat omslag blockerar inte; det är en rådgivning, inte ett krav");
});

test("samma bild fem gånger är en bild", () => {
  const dup = makeShot("data:image/jpeg;base64,SAMMA", step("front"), "upload");
  const s = ["cover", "front", "left", "back", "right"].map((id) => ({ ...dup, id: `d-${id}`, stepId: id }));
  assert.equal(photoCount(s), 1);
  assert.equal(canSubmit(s), false);
  assert.equal(distinctShots(s).length, 1);
});

// ─── placera, ersätta, ta bort ───

test("ett omtag ersätter bilden i steget och räknas inte som en till", () => {
  const forst = bild("front");
  const andra = bild("front");
  const s = placeShot(placeShot([], forst), andra);
  assert.equal(s.length, 1);
  assert.equal(shotFor(s, "front")?.id, andra.id);
});

test("ett omtag ändrar inte ordningen på de andra bilderna", () => {
  const s = karna();
  const nytt = placeShot(s, bild("left"));
  assert.deepEqual(nytt.map((x) => x.stepId), s.map((x) => x.stepId));
  assert.notEqual(shotFor(nytt, "left")?.id, shotFor(s, "left")?.id);
});

test("taket: en elfte bild ryms inte, men ett omtag gör det", () => {
  let s = karna();
  s = placeShot(s, bild("top"));
  s = placeShot(s, bild("closeup"));
  for (let i = 0; s.length < MAX_PHOTOS; i++) s = placeShot(s, bild(null));
  assert.equal(s.length, MAX_PHOTOS);

  assert.equal(canPlace(s, null), false, "ingen extra bild ryms");
  assert.equal(placeShot(s, bild(null)), s, "listan ska vara oförändrad");
  assert.equal(canPlace(s, "front"), true, "men ett omtag på ett steg ryms");
  assert.equal(placeShot(s, bild("front")).length, MAX_PHOTOS);
});

test("extra bilder får ingen stegplats och staplas", () => {
  let s = karna();
  s = placeShot(s, bild(null));
  s = placeShot(s, bild(null));
  assert.equal(s.filter((x) => x.stepId === null).length, 2);
  assert.equal(s[s.length - 1].viewLabel, "Extra bild");
});

test("att ta bort en bild öppnar steget igen", () => {
  const s = karna();
  const efter = removeShot(s, shotFor(s, "back")!.id);
  assert.equal(shotFor(efter, "back"), undefined);
  assert.deepEqual(missingCore(efter).map((x) => x.id), ["back"]);
  assert.equal(canSubmit(efter), false);
});

// ─── vad som saknas, och vart man går härnäst ───

test("alla kärnsteg tagna: inget saknas", () => {
  assert.deepEqual(missingCore(karna()), []);
  assert.equal(firstMissingCore(karna()), null);
});

test("det första saknade kärnsteget är det som 'Ta …' i granskningen hoppar till", () => {
  const s = ["cover", "left", "right"].reduce<GuideShot[]>((acc, id) => placeShot(acc, bild(id)), []);
  assert.deepEqual(missingCore(s).map((x) => x.id), ["front", "back"]);
  assert.equal(firstMissingCore(s)?.id, "front");
});

test("valfria steg räknas aldrig som saknade", () => {
  assert.ok(!missingCore([]).some((x) => x.id === "top" || x.id === "closeup"));
});

test("nästa öppna steg går bara framåt och hoppar över de som redan är tagna", () => {
  const s = ["cover", "front", "back"].reduce<GuideShot[]>((acc, id) => placeShot(acc, bild(id)), []);
  assert.equal(nextOpenStep(s, "front")?.id, "left", "vänster är hoppad och står på tur");
  assert.equal(nextOpenStep(s, "left")?.id, "right", "baksidan är redan tagen");
  assert.equal(nextOpenStep(s, "right")?.id, "top");
  assert.equal(nextOpenStep(s, "closeup"), null, "efter sista steget är guiden slut");
});

test("ett hoppat steg bakåt tvingas aldrig fram: framåt finns inget kvar → granskning", () => {
  const s = ["cover", "front", "left", "right", "top", "closeup"].reduce<GuideShot[]>((acc, id) => placeShot(acc, bild(id)), []);
  assert.equal(shotFor(s, "back"), undefined);
  assert.equal(nextOpenStep(s, "right"), null, "baksidan ligger bakom; guiden går inte tillbaka av sig själv");
});

test("det sista steget känns igen", () => {
  assert.equal(isLastStep("closeup"), true);
  assert.equal(isLastStep("front"), false);
});

test("stegradens miniatyrer: stegets id → bildens data-URL, utan extra bilder", () => {
  const s = placeShot(karna(), bild(null));
  const taken = takenByStep(s);
  assert.deepEqual(Object.keys(taken).sort(), ["back", "cover", "front", "left", "right"]);
  assert.equal(taken.front, shotFor(s, "front")!.dataUrl);
});

// ─── det som skickas ───

test("uppladdningen: omslaget först, sedan stegen i guidens ordning, sedan extra i tagningsordning", () => {
  // Tagna i fel ordning med flit: omslaget sist, och två extra bilder emellan.
  let s: GuideShot[] = [];
  s = placeShot(s, bild("right"));
  const extra1 = bild(null);
  s = placeShot(s, extra1);
  s = placeShot(s, bild("front"));
  const extra2 = bild(null);
  s = placeShot(s, extra2);
  s = placeShot(s, bild("left"));
  s = placeShot(s, bild("cover"));
  s = placeShot(s, bild("back"));

  const ordning = orderForUpload(s);
  assert.deepEqual(ordning.map((x) => x.stepId), ["cover", "front", "left", "back", "right", null, null]);
  assert.deepEqual(ordning.slice(5).map((x) => x.id), [extra1.id, extra2.id]);
});

test("nyttolasten: bara omslaget bär role, alla är foton, och etiketterna följer med", () => {
  const payload = toPayload(placeShot(karna(), bild(null)));
  assert.equal(payload.length, 6);
  assert.equal(payload[0].role, "cover");
  assert.equal(payload[0].viewLabel, "Omslagsbild");
  assert.equal(payload.filter((p) => p.role).length, 1);
  assert.ok(payload.every((p) => p.source === "manual"));
  assert.deepEqual(payload.map((p) => p.viewLabel), ["Omslagsbild", "Framifrån", "Vänster sida", "Bakifrån", "Höger sida", "Extra bild"]);
});

test("nyttolasten har inga dubbletter, även om en bild laddats upp två gånger", () => {
  const dup = makeShot("data:image/jpeg;base64,SAMMA", step("front"), "upload");
  const s = [...karna(), { ...dup, id: "x", stepId: null, viewLabel: "Extra bild" }, dup].filter(Boolean);
  const urls = toPayload(s as GuideShot[]).map((p) => p.dataUrl);
  assert.equal(new Set(urls).size, urls.length);
});

test("en tom guide ger en tom nyttolast", () => {
  assert.deepEqual(toPayload([]), []);
});
