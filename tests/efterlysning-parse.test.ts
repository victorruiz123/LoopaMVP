// ─── Skyddsnätet och följdfrågorna ──────────────────────────────────────────
//
// Tolkningen är en modell och varierar. Mätt skarpt tappade den pris, bredd, färg och material ur
// "grön sammetssoffa, 3-sits, max 6000 kr och högst 220 cm bred" — en mening där den fick kategorin
// rätt. Skyddsnätet fyller de HÅRDA fälten när det händer, och bara dem: de är de gränser som aldrig
// får brytas, och att tappa dem ger möbler köparen inte har råd med eller inte får in genom dörren.
//
// Mönstren måste vara snäva. "3-sits" är inte ett pris, "60-tal" är inte en bredd, och ett generöst
// mönster hade hittat båda.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fillHardFields, readMaxHeight, readMaxPrice, readMaxWidth } from "../server/src/efterlysning/backstop.js";
import { followUps, summarize, type ParsedSpec } from "../server/src/efterlysning/parse.js";

const spec = (over: Partial<ParsedSpec> = {}): ParsedSpec => ({
  filter: {}, styleTags: [], deadline: null, urgency: "none", note: null, summary: "", aiUsed: true, ...over,
});

// ─── priset ─────────────────────────────────────────────────────────────────

test("pris läses med gränsord eller valuta", () => {
  assert.equal(readMaxPrice("max 6000 kr"), 6000);
  assert.equal(readMaxPrice("upp till 4 000"), 4000);
  assert.equal(readMaxPrice("budget 3000"), 3000);
  assert.equal(readMaxPrice("under 1500 kronor"), 1500);
  assert.equal(readMaxPrice("kostar 2 500 kr"), 2500);
});

test("ett tal utan stöd är inget pris", () => {
  // Annars blir varje sitsantal ett pristak.
  assert.equal(readMaxPrice("en 3-sits soffa"), null);
  assert.equal(readMaxPrice("gärna 60-tal"), null);
});

test("orimliga belopp avvisas hellre än gissas", () => {
  assert.equal(readMaxPrice("max 50 kr"), null, "för lågt för en möbel");
  assert.equal(readMaxPrice("max 2000000 kr"), null, "sannolikt ett skrivfel");
});

// ─── måtten ─────────────────────────────────────────────────────────────────

test("bredd läses åt båda hållen och i meter", () => {
  assert.equal(readMaxWidth("högst 220 cm bred"), 2200);
  assert.equal(readMaxWidth("bredd max 160 cm"), 1600);
  assert.equal(readMaxWidth("max 2 meter bred"), 2000);
  assert.equal(readMaxWidth("1,8 m bred"), 1800);
});

test("höjd och bredd blandas inte ihop", () => {
  assert.equal(readMaxWidth("max 90 cm hög"), null);
  assert.equal(readMaxHeight("max 90 cm hög"), 900);
});

test("'högst' är ingen höjd — ordgränsen fångar det", () => {
  // Mätt skarpt: utan ordgräns matchade "hög" inuti "högst", och meningen "max 6000 kr och högst
  // 220 cm bred" gav både bredd OCH höjd 220 cm — ur ett ord som betyder "som mest".
  const t = "grön sammetssoffa, max 6000 kr och högst 220 cm bred";
  assert.equal(readMaxWidth(t), 2200);
  assert.equal(readMaxHeight(t), null);
});

test("men riktiga höjdord fångas fortfarande", () => {
  assert.equal(readMaxHeight("bokhylla max 180 cm hög"), 1800);
  assert.equal(readMaxHeight("höjden får vara max 200 cm"), 2000);
});

test("ett tal utan riktningsord är inget mått", () => {
  assert.equal(readMaxWidth("3-sits, 60-tal"), null);
  assert.equal(readMaxWidth("max 6000 kr"), null);
});

// ─── nätet fyller bara luckor ───────────────────────────────────────────────

test("nätet lägger till det tolkningen tappade", () => {
  const f = fillHardFields({ categorySlug: "soffor-fatoljer" }, "grön sammetssoffa, 3-sits, max 6000 kr och högst 220 cm bred");
  assert.equal(f.maxPriceSek, 6000);
  assert.equal(f.maxWidthMm, 2200);
  assert.equal(f.categorySlug, "soffor-fatoljer", "rör inte det som redan fanns");
});

test("men överprövar aldrig ett fält modellen satt", () => {
  // Modellen ser sammanhang ett mönster aldrig kommer åt. Vinner regexen byts ett bra svar mot ett grovt.
  const f = fillHardFields({ maxPriceSek: 4000 }, "max 6000 kr");
  assert.equal(f.maxPriceSek, 4000);
});

test("nätet hittar inget att fylla i när meningen inte säger något", () => {
  assert.deepEqual(fillHardFields({}, "en snygg fåtölj"), {});
});

// ─── färg och material ──────────────────────────────────────────────────────
//
// Kom till efter pris och mått, av ett annat skäl: sammanfattningen förblev ärlig när "grön" föll
// bort, men köparen som skrev "grön" och fick sex soffor utan färgkrav hade ändå inte blivit hörd.

test("färg och material fylls i när tolkningen tappar dem", () => {
  const f = fillHardFields({}, "grön sammetssoffa max 6000 kr");
  assert.deepEqual(f.colors, ["grön"]);
  assert.deepEqual(f.materials, ["sammet"]);
  assert.equal(f.maxPriceSek, 6000);
});

test("färger böjs — 'mörkblått' är blå", () => {
  assert.deepEqual(fillHardFields({}, "en soffa i mörkblått tyg").colors, ["blå"]);
  assert.deepEqual(fillHardFields({}, "gult skinn").colors, ["gul"]);
  assert.deepEqual(fillHardFields({}, "ljusblå matta").colors, ["blå"]);
});

test("men en färg sitter inte i vilken sammansättning som helst", () => {
  // "vitrinskåp" är inte vitt. Färgord tar böjningsändelser, inte fogar.
  assert.equal(fillHardFields({}, "ett vitrinskåp i ek").colors, undefined);
});

test("ett kort träslag måste stå som eget ord eller före en möbeldel", () => {
  assert.deepEqual(fillHardFields({}, "ekbord max 160 cm").materials, ["ek"]);
  assert.equal(fillHardFields({}, "ekonomiskt matbord").materials, undefined);
});

test("'bok' och 'al' är inte med i listan alls", () => {
  // Båda är riktiga träslag och båda är för dyra att ha med: "bokhylla" är inte gjord av bok och
  // "alltid" är inte gjort av al.
  assert.deepEqual(fillHardFields({}, "vit bokhylla i björk").materials, ["björk"]);
  assert.equal(fillHardFields({}, "alltid trevligt med en soffa").materials, undefined);
});

test("ett mått är inget pris, ens med ett gränsord framför", () => {
  // "ekbord max 160 cm" läste bordets bredd som dess pristak innan spärren fanns.
  assert.equal(fillHardFields({}, "ekbord max 160 cm").maxPriceSek, undefined);
  assert.equal(fillHardFields({}, "ekbord för 4000 kr").maxPriceSek, 4000);
});

// ─── följdfrågorna ──────────────────────────────────────────────────────────

test("bara fält som ändrar matchningen frågas om", () => {
  const q = followUps(spec({ filter: { categorySlug: "soffor-fatoljer", maxPriceSek: 5000, maxWidthMm: 2100 } }));
  assert.deepEqual(q, [], "allt hårt är satt — ingen fråga kvar");
});

test("saknad kategori frågas alltid, den avgör vilka källor vi frågar", () => {
  assert.equal(followUps(spec())[0].field, "kategori");
});

test("mått frågas bara om skrymmande möbler", () => {
  const lampa = followUps(spec({ filter: { categorySlug: "belysning", maxPriceSek: 500 } }));
  assert.deepEqual(lampa, [], "en lampa passar överallt");
  const soffa = followUps(spec({ filter: { categorySlug: "soffor-fatoljer", maxPriceSek: 5000 } }));
  assert.deepEqual(soffa.map((q) => q.field), ["matt"]);
});

test("aldrig fler än tre frågor", () => {
  assert.ok(followUps(spec()).length <= 3);
});

test("färg och stil frågas aldrig om — de gör en träff bättre, inte möjlig", () => {
  const q = followUps(spec({ filter: { categorySlug: "belysning", maxPriceSek: 500 } }));
  assert.equal(q.length, 0);
});

// ─── sammanfattningen ───────────────────────────────────────────────────────

test("sammanfattningen beskriver bara det vi faktiskt filtrerar på", () => {
  const s = summarize(spec({
    filter: { categorySlug: "soffor-fatoljer", maxPriceSek: 6000, maxWidthMm: 2200, colors: ["grön"] },
    styleTags: ["60-tal"],
  }));
  assert.match(s, /Soffor/);
  assert.match(s, /60-tal/);
  assert.match(s, /grön/);
  // \s och inte ett blanksteg: toLocaleString("sv-SE") skiljer tusental med U+00A0.
  assert.match(s, /max 6\s000 kr/);
  assert.match(s, /max b 220 cm/);
});
