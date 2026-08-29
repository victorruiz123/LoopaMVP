// ─── 3D-modellens mått: vad stand-in:en får tro om möbeln ────────────────────
//
// Modellen ritar det den får. Ett enda överskrivet mått syns direkt som en möbel med fel proportioner
// — och det är säljarens egen möbel figuren ska föreställa. Testerna nedan låser fast vilka attribut
// som ÄR ett mått på möbeln och vilka som bara ser ut som ett.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDimensions } from "../web/src/lib/furnitureModel.js";
import type { ListingAttribute } from "../web/src/types.js";

const attrs = (...pairs: [string, string][]): ListingAttribute[] =>
  pairs.map(([label, value]) => ({ key: label.toLowerCase(), label, value, sourceUrl: null }));

test("sittdjup är inte djup och längd är inte bredd", () => {
  // NORDVIKEN barstol, exakt de attribut annonsen fick: bredden och djupet stod i listan, men efter
  // dem kom sittdjupet och förpackningens längd. Läses de som möbelns mått blir 40 × 45 × 88 till
  // 90 × 34 × 88 — och stolen ritas ut dubbelt så bred som den är.
  const dims = parseDimensions(
    attrs(
      ["Bredd", "40 cm"],
      ["Djup", "45 cm"],
      ["Höjd", "88 cm"],
      ["Sitthöjd", "62 cm"],
      ["Sittdjup", "34 cm"],
      ["Längd", "90 cm"],
    ),
    "chair",
  );
  assert.deepEqual(dims, { width: 40, depth: 45, height: 88, assumed: [] });
});

test("längden är bredden när ingen bredd står", () => {
  // En soffa mäts på längden. Saknas bredden är längden det bästa vi har — den ersätter den bara aldrig.
  const dims = parseDimensions(attrs(["Längd", "198 cm"], ["Djup", "99 cm"]), "sofa");
  assert.equal(dims?.width, 198);
  assert.deepEqual(dims?.assumed, ["height"], "höjden är antagen, bredden är läst");
});

test("det samlade måttfältet läses i ordningen bredd × djup × höjd", () => {
  const dims = parseDimensions(attrs(["Mått", "198 x 99 x 83 cm"]), "sofa");
  assert.deepEqual(dims, { width: 198, depth: 99, height: 83, assumed: [] });
});

test("en egen etikett vinner över det samlade fältet", () => {
  const dims = parseDimensions(attrs(["Bredd", "200 cm"], ["Mått", "198 x 99 x 83 cm"]), "sofa");
  assert.equal(dims?.width, 200);
  assert.equal(dims?.depth, 99, "resten fylls från måttfältet");
});

test("ett bord mäts längd × bredd — bredden är djupet", () => {
  // NORDVIKEN utdragbart bord, exakt vad harvestSpecs läser ur ikea.se: längd, bredd, höjd och
  // inget djup. Läses etiketterna rakt av blir bordet 105 cm brett och 60 cm djupt — 60 hämtat ur
  // TYPICAL, alltså påhittat — medan de 210 som faktiskt stod i underlaget kastas.
  const dims = parseDimensions(attrs(["Bredd", "105 cm"], ["Höjd", "75 cm"], ["Längd", "210 cm"]), "table");
  assert.deepEqual(dims, { width: 210, depth: 105, height: 75, assumed: [] });
});

test("ett utskrivet djup vinner över bredd-som-djup", () => {
  const dims = parseDimensions(
    attrs(["Bredd", "105 cm"], ["Djup", "90 cm"], ["Höjd", "75 cm"], ["Längd", "210 cm"]),
    "table",
  );
  assert.deepEqual(dims, { width: 105, depth: 90, height: 75, assumed: [] }, "står Djup är frågan besvarad");
});

test("en längd kortare än bredden är inte bordets längd", () => {
  // Då är etiketterna inte de vi tror — en kartong, ett bordsben, en skiva. Hellre orört.
  const dims = parseDimensions(attrs(["Bredd", "105 cm"], ["Höjd", "75 cm"], ["Längd", "40 cm"]), "table");
  assert.equal(dims?.width, 105);
  assert.deepEqual(dims?.assumed, ["depth"]);
});

test("en säng mäts också längd × bredd", () => {
  const dims = parseDimensions(attrs(["Bredd", "160 cm"], ["Längd", "200 cm"], ["Höjd", "60 cm"]), "bed");
  assert.deepEqual(dims, { width: 200, depth: 160, height: 60, assumed: [] });
});

test("en stol rörs inte — längden där är kartongen", () => {
  const dims = parseDimensions(attrs(["Bredd", "44 cm"], ["Höjd", "97 cm"], ["Längd", "90 cm"]), "chair");
  assert.equal(dims?.width, 44, "bredden är stolens egen");
  assert.deepEqual(dims?.assumed, ["depth"]);
});

test("utan ett enda belagt mått ritas ingen modell", () => {
  assert.equal(parseDimensions(attrs(["Material", "Massiv furu"]), "chair"), null);
});
