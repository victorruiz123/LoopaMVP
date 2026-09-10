// Röstrundans rena logik (web/src/__dev/voice-tour-logic.ts): regexar och matchning som driver
// närbildsuttag, märkesdetektering och talat-mot-funnet-avstämningen. Ingen DOM, inga API-anrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  damageMoments,
  detectBrand,
  spokenDamageChecklist,
  DAMAGE_WORDS,
  NEXT_PIECE_COMMAND,
} from "../web/src/__dev/voice-tour-logic.ts";

test("damageMoments: hittar skadeord och tar segmentets mitt", () => {
  const m = damageMoments(
    [
      { start: 0, end: 4, text: "Ett soffbord i ek från IKEA" },
      { start: 10, end: 14, text: "Här är en repa på kanten" },
    ],
    2,
  );
  assert.equal(m.length, 1);
  assert.equal(m[0].tS, 12);
  assert.match(m[0].said, /repa/);
});

test("damageMoments: närliggande träffar slås ihop till ETT ögonblick", () => {
  const m = damageMoments(
    [
      { start: 10, end: 12, text: "en repa här" },
      { start: 13, end: 15, text: "och en fläck precis bredvid" },
      { start: 40, end: 42, text: "baksidan har en spricka" },
    ],
    5,
  );
  assert.equal(m.length, 2);
  assert.match(m[0].said, /repa.*fläck/);
  assert.equal(m[1].tS, 41);
});

test("damageMoments: respekterar maxantalet", () => {
  const segs = [
    { start: 0, end: 2, text: "repa ett" },
    { start: 20, end: 22, text: "fläck två" },
    { start: 40, end: 42, text: "spricka tre" },
  ];
  assert.equal(damageMoments(segs, 2).length, 2);
});

test("damageMoments: böjningar täcks av stammarna", () => {
  for (const text of ["den är repig", "flera repor", "lite sliten", "fanérsläpp i hörnet", "skruven saknas"]) {
    assert.ok(DAMAGE_WORDS.test(text), `"${text}" borde träffa`);
  }
  assert.ok(!DAMAGE_WORDS.test("ett fint bord i massiv ek"), "oskadat tal ska inte träffa");
});

test("detectBrand: hittar märket skiftlägesokänsligt och returnerar registrets stavning", () => {
  const brands = ["IKEA", "Mio", "Bruno Mathsson"];
  assert.equal(detectBrand("ett soffbord från ikea i björk", brands), "IKEA");
  assert.equal(detectBrand("en fåtölj av bruno mathsson", brands), "Bruno Mathsson");
});

test("detectBrand: kräver hela ord — inga träffar inuti andra ord", () => {
  assert.equal(detectBrand("vi lastade kamION med möbler", ["Mio"]), null);
  assert.equal(detectBrand("en miojournal", ["Mio"]), null);
});

test("detectBrand: tomt tal eller okänt märke ger null", () => {
  assert.equal(detectBrand("", ["IKEA"]), null);
  assert.equal(detectBrand("ett bord från Snickers Möbler", ["IKEA", "Mio"]), null);
});

test("spokenDamageChecklist: repa räknas som hittad när modellen rapporterade scratch", () => {
  const checks = spokenDamageChecklist([{ tS: 5, said: "en repa på kanten" }], ["scratch"]);
  assert.equal(checks[0].found, true);
});

test("spokenDamageChecklist: nämnd repa utan replikt fynd flaggas som ej hittad", () => {
  const checks = spokenDamageChecklist([{ tS: 5, said: "en repa på kanten" }], ["stain"]);
  assert.equal(checks[0].found, false);
});

test("spokenDamageChecklist: skadeord utan typmappning nöjer sig med att NÅGOT rapporterades", () => {
  const checks = spokenDamageChecklist([{ tS: 5, said: "en defekt här" }], ["stain"]);
  assert.equal(checks[0].found, true);
  const none = spokenDamageChecklist([{ tS: 5, said: "en defekt här" }], []);
  assert.equal(none[0].found, false);
});

test("röstkommandot 'nästa möbel' träffar i löpande tal", () => {
  assert.ok(NEXT_PIECE_COMMAND.test("okej nästa möbel tack"));
  assert.ok(NEXT_PIECE_COMMAND.test("Nästa  möbel"));
  assert.ok(!NEXT_PIECE_COMMAND.test("nästa vecka möblerar vi om"));
});
