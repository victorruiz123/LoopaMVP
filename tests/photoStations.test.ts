// ─── fotoguidens vinklar: vad guiden faktiskt lovar ──────────────────────────
//
// Fotoguiden är alternativet till att filma ett varv, och skillnaden mot filmen är att här VET vi vad
// varje bild visar: säljaren blev ombedd att ställa sig på ett bestämt ställe. Etiketten följer med
// hela vägen in i besiktningsprompten, så en station vars etikett inte stämmer med var telefonen
// ritas är inte ett skönhetsfel — det är ett påstående om möbeln som ingen kontrollerat.
//
// Det här låser fast tre saker: att guiden inte ber om fler bilder än som ryms, att varvet går åt det
// håll etiketterna säger, och att telefonen hamnar bakom möbeln på precis de vinklar den ska.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PHOTO_STATIONS } from "../web/src/lib/photoStations.js";
import { buildScene, placeMarker } from "../web/src/lib/guideScene.js";
import { MAX_IMAGES_PER_JOB } from "../server/src/config.js";

test("guiden ber aldrig om fler bilder än servern bedömer", () => {
  // Fler stationer än taket hade betytt att säljaren fotograferar vinklar som tyst kastas i
  // createConditionJob — samma tysta kap som en gång gav tio bilder in och sex bedömda.
  assert.ok(
    PHOTO_STATIONS.length <= MAX_IMAGES_PER_JOB,
    `${PHOTO_STATIONS.length} stationer mot taket ${MAX_IMAGES_PER_JOB}`,
  );
});

test("varje station har en egen etikett", () => {
  // Etiketten är det besiktningen läser. Två stationer med samma etikett gör "Bild 2 (Höger sida)"
  // omöjlig att skilja från "Bild 4 (Höger sida)", och id:t är dessutom nyckeln en omtagning ersätter på.
  const labels = PHOTO_STATIONS.map((s) => s.label);
  const ids = PHOTO_STATIONS.map((s) => s.id);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of PHOTO_STATIONS) assert.ok(s.label.length > 0 && s.instruction.length > 0);
});

test("framifrån kommer först", () => {
  // Bilderna skickas i stationsordning, och bild noll är det omslagsvalet faller tillbaka på när
  // modellen inte pekar ut någon (pickCoverImageId). Framifrån ska vara den bilden.
  assert.equal(PHOTO_STATIONS[0].id, "front");
  assert.equal(PHOTO_STATIONS[0].at.t, 0);
});

test("de obligatoriska vinklarna ÄR varvet: ett kvarts varv i taget, åt ett håll", () => {
  // Ordningen ÄR promenaden: t växer medsols sett uppifrån, precis som pilarna i filmguiden. Backar
  // en station blir guiden en uppräkning av väderstreck i stället för en väg att gå. Och står en av de
  // fyra någon annanstans än på banan stämmer inte längre etiketten med var telefonen ritas.
  const lap = PHOTO_STATIONS.filter((s) => s.required);
  assert.deepEqual(lap.map((s) => s.label), ["Framifrån", "Vänster sida", "Bakifrån", "Höger sida"]);
  for (const s of lap) assert.equal(s.at.r, undefined, `${s.label} står inte på banan`);
  for (let i = 1; i < lap.length; i++) {
    assert.ok(
      Math.abs(lap[i].at.t - lap[i - 1].at.t - Math.PI / 2) < 1e-9,
      `${lap[i - 1].label} → ${lap[i].label} är inte ett kvarts varv framåt`,
    );
  }
});

test("extravinklarna står utanför banan", () => {
  // Ovanifrån och närbilden är inte platser på promenaden utan avsteg från den, och det är radien och
  // höjden som säger det. Utan egen radie hade de ritats som ännu en av de fyra sidorna.
  const extras = PHOTO_STATIONS.filter((s) => !s.required);
  assert.deepEqual(extras.map((s) => s.id), ["top", "closeup"]);
  for (const s of extras) assert.ok(s.at.r !== undefined, `${s.label} saknar egen radie`);
});

test("telefonen ritas bakom möbeln på de vinklar som ligger bakom den", () => {
  // Att markören försvinner BAKOM soffan halva varvet är hela instruktionen: en markör som glider
  // ovanpå möbeln hade lika gärna kunnat betyda "svep förbi". Vänder lagringen är guiden fel om
  // vilken sida säljaren står på, medan etiketten fortsätter påstå den gamla.
  const scene = buildScene();
  const behind = Object.fromEntries(
    PHOTO_STATIONS.map((s) => [s.id, placeMarker(scene, s.at).behind]),
  );
  assert.equal(behind.front, false);
  assert.equal(behind.left, true);
  assert.equal(behind.back, true);
  assert.equal(behind.right, false);
});

test("varje vinkel ryms i bilden guiden ritas i", () => {
  // Scenen skalas efter banan och möbeln, inte efter markören. Närbilden och vyn ovanifrån ligger
  // utanför banan — en höjd eller radie som skjuter markören ur viewBoxen syns som en telefon som
  // klipps av vid kanten, och då pekar guiden på ingenting.
  const scene = buildScene();
  for (const s of PHOTO_STATIONS) {
    const { phone, scale } = placeMarker(scene, s.at);
    const r = 14 * scale; // markörens radie, se Marker i GuideScene
    assert.ok(phone[0] - r > 0 && phone[0] + r < 300, `${s.id} hamnar utanför i sidled`);
    assert.ok(phone[1] - r > 0 && phone[1] + r < 208, `${s.id} hamnar utanför i höjdled`);
  }
});
