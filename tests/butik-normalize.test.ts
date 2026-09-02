// ─── Från fritext till filterbar vara ───────────────────────────────────────
//
// Attributen är skrivna av en språkmodell och stavas därefter: i de 109 skarpa annonserna heter samma
// mått `width`, `bredd` och `dimensions`, färgen `color` och `farg`, sitthöjden fyra saker. Testerna
// nedan är tagna ur den korpusen, inte uppfunna — varje rad är en stavning som faktiskt förekommer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDimensionsMm, normalizeColor, normalizeMaterial, titleOf } from "../server/src/butik/normalize.js";
import { resolveCategorySlug, fold, brandSlug } from "../server/src/butik/catalog.js";
import type { ListingAttribute } from "../server/src/types.js";

const attrs = (...pairs: ([string, string] | [string, string, boolean])[]): ListingAttribute[] =>
  pairs.map(([label, value, estimated]) => ({
    key: String(label).toLowerCase(), label: String(label), value: String(value), sourceUrl: null,
    ...(estimated ? { estimated: true } : {}),
  }));

test("måtten läses ur engelska nycklar och blir millimeter", () => {
  const d = parseDimensionsMm(attrs(["width", "81 cm"], ["depth", "92 cm"], ["height", "80 cm"]), "soffor-fatoljer");
  assert.deepEqual(d, { widthMm: 810, depthMm: 920, heightMm: 800, seatHeightMm: null, estimated: false });
});

test("måtten läses lika bra ur svenska nycklar", () => {
  const d = parseDimensionsMm(attrs(["bredd", "42 cm"], ["djup", "54 cm"], ["hojd", "90 cm"]), "stolar");
  assert.deepEqual(d, { widthMm: 420, depthMm: 540, heightMm: 900, seatHeightMm: null, estimated: false });
});

test("sitthöjd är inte höjd och sittdjup är inte djup", () => {
  // NORDVIKEN barstol: 40 × 45 × 88 med sitthöjd 62 och sittdjup 34. Läses delarna som möbelns mått
  // blir stolen 34 djup och 62 hög — och det är inte den stolen någon köper.
  const d = parseDimensionsMm(
    attrs(["Bredd", "40 cm"], ["Djup", "45 cm"], ["Höjd", "88 cm"], ["Sitthöjd", "62 cm"], ["Sittdjup", "34 cm"]),
    "stolar",
  );
  assert.equal(d.widthMm, 400);
  assert.equal(d.depthMm, 450);
  assert.equal(d.heightMm, 880);
  assert.equal(d.seatHeightMm, 620, "sitthöjden ska läsas — bara inte som höjd");
});

test("bord mäts längd × bredd: bredden ÄR djupet", () => {
  // IKEA skriver ett matbord som "Längd 210 | Bredd 105 | Höjd 75". Rakt av blir det ett 105 cm brett
  // bord med okänt djup. Samma regel som web/src/lib/furnitureModel.ts:164.
  const d = parseDimensionsMm(attrs(["Längd", "210 cm"], ["Bredd", "105 cm"], ["Höjd", "75 cm"]), "bord");
  assert.equal(d.widthMm, 2100);
  assert.equal(d.depthMm, 1050);
});

test("men bara när djupet saknas — står Djup utskrivet är frågan besvarad", () => {
  const d = parseDimensionsMm(attrs(["Längd", "210 cm"], ["Bredd", "105 cm"], ["Djup", "90 cm"]), "bord");
  assert.equal(d.widthMm, 1050, "bredden står kvar som bredd när djupet redan är känt");
  assert.equal(d.depthMm, 900);
});

test("stolar rörs inte av längdregeln — de 90 cm är kartongen", () => {
  const d = parseDimensionsMm(attrs(["Bredd", "40 cm"], ["Längd", "90 cm"], ["Höjd", "88 cm"]), "stolar");
  assert.equal(d.widthMm, 400);
});

test("det sammansatta måttfältet läses när de enskilda saknas", () => {
  const d = parseDimensionsMm(
    attrs(["dimensions", "Bredd 52 cm, djup 50 cm, höjd 80 cm, sitthöjd 47 cm"]),
    "stolar",
  );
  assert.deepEqual(d, { widthMm: 520, depthMm: 500, heightMm: 800, seatHeightMm: 470, estimated: false });
});

test("ett uppskattat mått används men flaggas", () => {
  const d = parseDimensionsMm(attrs(["Bredd", "ca 80 cm", true], ["Höjd", "80 cm"]), "ovrigt");
  assert.equal(d.widthMm, 800, "hedgen 'ca' hindrar inte läsningen");
  assert.equal(d.estimated, true, "men kortet måste kunna säga att måttet är typiskt, inte uppmätt");
});

test("tal som inte kan vara möbelmått kastas", () => {
  // Artikelnummer och årtal står i samma lista som måtten.
  assert.equal(parseDimensionsMm(attrs(["Bredd", "2019"]), "bord").widthMm, null);
  assert.equal(parseDimensionsMm(attrs(["Bredd", "2 cm"]), "bord").widthMm, null);
});

test("inga mått alls ger null rakt igenom — aldrig ett typiskt mått", () => {
  // Skillnaden mot furnitureModel.parseDimensions, som MÅSTE ha tre tal för att kunna rita. Ett gissat
  // djup som jämförs mot köparens dörrmått är ett löfte vi inte kan hålla.
  const d = parseDimensionsMm(attrs(["Material", "Ek"]), "bord");
  assert.deepEqual(d, { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null, estimated: false });
});

test("kategorin väljs på längsta nyckelordet, inte på listordning", () => {
  assert.equal(resolveCategorySlug({ category: "soffbord" }), "bord", "soffbord är ett bord");
  assert.equal(resolveCategorySlug({ category: "Barstol" }), "stolar");
  assert.equal(resolveCategorySlug({ category: "Kontorsstol / Arbetsstol" }), "skrivbord-kontor");
});

test("kategorin läses ur en brödsmula och ur versaler", () => {
  assert.equal(resolveCategorySlug({ category: "Möbler > Soffor & Fåtöljer > Fåtöljer" }), "soffor-fatoljer");
  assert.equal(resolveCategorySlug({ category: "FÅTÖLJ" }), "soffor-fatoljer");
  assert.equal(resolveCategorySlug({ category: "3-sitssoffa" }), "soffor-fatoljer");
});

test("ett modellnamn i kategorifältet faller igenom till nästa signal", () => {
  // "NORDVIKEN" och "Lamino" står som kategori på skarpa jobb. De är modeller, inte kategorier.
  assert.equal(resolveCategorySlug({ category: "NORDVIKEN" }), "ovrigt");
  assert.equal(resolveCategorySlug({ category: "NORDVIKEN", title: "IKEA NORDVIKEN matbord i ek" }), "bord");
});

test("type-attributet väger tyngst — det är generatorns eget svar på frågan", () => {
  assert.equal(resolveCategorySlug({ type: "Fåtölj", category: "Möbler" }), "soffor-fatoljer");
});

test("färg och material kapas till något en filterknapp kan bära", () => {
  assert.equal(normalizeColor("Ljusa/beige ton"), "Ljusa");
  assert.equal(normalizeColor("Mörkgrön"), "Mörkgrön");
  assert.equal(normalizeMaterial("Massivträ med akrylfärg, klädsel i 100% polyester"), "Massivträ");
  assert.equal(normalizeMaterial("Plywood, polyeter, träfiberskiva"), "Plywood");
});

test("titeln är märke + modell + möbelord, utan skickpåstående", () => {
  // Annonsgeneratorns egen titel är "Sits Impulse fåtölj i fint skick" — skrivet för Tradera. I
  // butiken står skicket i sin egen rad med sitt eget betyg.
  assert.equal(titleOf("IKEA", "NORDVIKEN", "Barstol", "x"), "IKEA NORDVIKEN barstol");
  assert.equal(titleOf("Swedese", "Lamino", null, "x"), "Swedese Lamino");
});

test("möbelordet upprepas inte när modellnamnet redan säger det", () => {
  assert.equal(titleOf("IKEA", "NORDVIKEN bord", "bord", "x"), "IKEA NORDVIKEN bord");
});

test("titeln hittar aldrig på ett möbelord ur kategorin", () => {
  // IKEA Jules är en barnskrivbordsstol. Den hamnar riktigt i "Skrivbord & kontor", men slugen som
  // substantiv gör den till "IKEA Jules skrivbord" — fel möbel, i det fält köparen läser först.
  assert.equal(titleOf("IKEA", "Jules", null, "x"), "IKEA Jules");
});

test("ett mått som värdet självt kallar bänkhöjd är inte möbelns höjd", () => {
  // NORDVIKEN barstol kom in som height = "62 cm (bänkhöjd)". Nyckeln säger höjd, värdet säger
  // bänkhöjd. Läses den rakt av blir barstolen 62 cm hög.
  const d = parseDimensionsMm(attrs(["height", "62 cm (bänkhöjd)"]), "stolar");
  assert.equal(d.heightMm, null, "hellre inget mått än ett som är en halv stol fel");
});

test("fold och brandSlug viker bort å ä ö", () => {
  assert.equal(fold("Öronlappsfåtölj"), "oronlappsfatolj");
  assert.equal(brandSlug("String Furniture"), "string-furniture");
});

test("ett mått som räknar upp alternativ är inget mått", () => {
  // NORDVIKEN finns som både matbord och barstol, och generatorn skördade bordets spec till stolens
  // annons. Barstolen låg i rutnätet som 210 × 105 × 75 cm — ett matbords mått.
  const d = parseDimensionsMm(
    attrs(
      ["bredd", "210 cm (eller 152 cm / 74 cm beroende på storlek)"],
      ["djup", "105 cm (eller 95 cm / 74 cm beroende på storlek)"],
      ["hojd", "75 cm"],
    ),
    "stolar",
  );
  assert.equal(d.widthMm, null, "hellre inget mått än ett av tre möjliga");
  assert.equal(d.depthMm, null);
  assert.equal(d.heightMm, 750, "det entydiga måttet står kvar");
});

test("en vanlig hedge är fortfarande ett mått", () => {
  // "ca 80 cm" är EN uppgift med osäkerhet, inte en uppräkning av alternativ.
  assert.equal(parseDimensionsMm(attrs(["Bredd", "ca 80 cm"]), "bord").widthMm, 800);
});
