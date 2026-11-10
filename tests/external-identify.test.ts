// ─── Svar från Googles AI-läge (appprototypen) ───────────────────────────────────────────────────────────────────────────────────────
//
// 2026-10-27: i prototypens körning 8 avvisade specsökningens verifiering alla nio mått ("varken källa eller citat"), eftersom AI-lägets svar bara har en källista i botten
// och inga länkar per mått, och länkarna som lästes ur löptext slutade på kommatecken. Här prövas de rena delarna som rättar det.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeSources, cleanExternalLinks, cleanModelName, clipReason, inferProductType, parseAlternatives, pickCategory, pickModelPage } from "../server/src/externalIdentify.js";

// Länkarna så som de kom ur Googles sida i körning 8.
const LINKS = [
  "https://sits.eu/collection/brandon/,",
  "https://www.snug-interiors.co.uk/products/sits-brandon-armchair).",
  "https://www.innex.cz/files/BRANDON.pdf",
  "https://www.google.com/search?q=sits+brandon",
  "https://encrypted-tbn0.gstatic.com/images?q=x",
];

test("cleanExternalLinks tar bort skiljetecken i slutet, Googles egna adresser och dubbletter", () => {
  const clean = cleanExternalLinks([...LINKS, "https://sits.eu/collection/brandon/"]);
  assert.deepEqual(clean, [
    "https://sits.eu/collection/brandon/",
    "https://www.snug-interiors.co.uk/products/sits-brandon-armchair",
    "https://www.innex.cz/files/BRANDON.pdf",
  ]);
});

test("pickModelPage väljer märkets egen sida för modellen, inte en katalog-PDF", () => {
  const clean = cleanExternalLinks(LINKS);
  assert.equal(pickModelPage(clean, "Brandon", "Sits"), "https://sits.eu/collection/brandon/");
  assert.equal(pickModelPage(clean.slice().reverse(), "Brandon", "Sits"), "https://sits.eu/collection/brandon/");
});

test("pickModelPage hittar på ingen sida när ingen länk handlar om märket eller modellen", () => {
  assert.equal(pickModelPage(["https://example.com/blog/soffor-2024", "https://foo.se/"], "Brandon", "Sits"), null);
  assert.equal(pickModelPage([], "Brandon", "Sits"), null);
});

test("attributeSources ger uppgifter utan egen länk modellens sida (så att vår sidhämtning kan pröva dem), tar bort AI-lägets ord som 'citat' och lägger sidan bland uppgivna källor", () => {
  const spec = {
    dimensions: [
      { type: "overall_width", value: 84, sourceUrl: null, quote: null },
      { type: "seat_height", value: 45, sourceUrl: "https://annan.se/stol", quote: "Sitthöjd 45 cm" },
      { type: "arm_height", value: 62, sourceUrl: null, quote: "armstödshöjd: 62" },
    ],
    materials: [{ component: "stomme", material: "björk", sourceUrl: null, quote: "stomme: björk" }],
    sourcesUsed: [],
  };
  const out = attributeSources(spec, "Brandon", "Sits", cleanExternalLinks(LINKS)) as typeof spec;
  assert.equal(out.dimensions[0].sourceUrl, "https://sits.eu/collection/brandon/");
  assert.equal(out.dimensions[1].sourceUrl, "https://annan.se/stol", "egen länk rörs inte");
  assert.equal(out.dimensions[1].quote, "Sitthöjd 45 cm", "citatet vid en egen länk rörs inte");
  assert.equal(out.dimensions[2].sourceUrl, "https://sits.eu/collection/brandon/");
  assert.equal(out.dimensions[2].quote, null, "AI-lägets ord är inget sidcitat");
  assert.equal(out.materials[0].sourceUrl, "https://sits.eu/collection/brandon/");
  assert.equal(out.materials[0].quote, null);
  assert.deepEqual(out.sourcesUsed, [{ url: "https://sits.eu/collection/brandon/", title: null, kind: "other" }]);
});

test("attributeSources lämnar svaret orört när ingen sida kan pekas ut", () => {
  const spec = { dimensions: [{ type: "overall_width", value: 84, sourceUrl: null, quote: "bredd: 84" }], materials: [], sourcesUsed: [] };
  assert.deepEqual(attributeSources(spec, "Brandon", "Sits", ["https://example.com/x"]), spec);
});

// 2026-10-28: AI-läget ska inte välja en modell utan rangordna fyra förslag; säljaren ser dem alla. Förslag 2–4 behåller sin egen säkerhet, motivering och sida.
test("parseAlternatives behåller svarets ordning, tar bort förslag 1 och dubbletter, och kapar vid tre", () => {
  const clean = cleanExternalLinks(LINKS);
  const raw = [
    { model: "BRANDON", why: "samma som förslag 1", confidence: "high", sourceUrl: null },
    { model: "Quattro", why: " armstöd lika höga ", confidence: "medium", sourceUrl: "https://www.snug-interiors.co.uk/products/sits-brandon-armchair)." },
    { model: "quattro", why: "dubblett", confidence: "low", sourceUrl: null },
    { model: "Palma", why: "", confidence: "mycket", sourceUrl: "https://hittepa.se/palma" },
    { model: "Impulse", why: null, confidence: "low", sourceUrl: null },
    { model: "Fjärde", why: "kommer över kapet", confidence: "low", sourceUrl: null },
  ];
  const out = parseAlternatives(raw, "Brandon", clean);
  assert.deepEqual(out.map((a) => a.model), ["Quattro", "Palma", "Impulse"]);
  assert.equal(out[0].why, "armstöd lika höga");
  assert.equal(out[0].confidence, "medium");
  assert.equal(out[0].sourceUrl, "https://www.snug-interiors.co.uk/products/sits-brandon-armchair", "skiljetecknet i slutet av en länk ur löptext tas bort");
  assert.equal(out[1].confidence, "low", "okänd säkerhet blir låg, aldrig högre");
  assert.equal(out[1].sourceUrl, null, "en adress som inte står bland sidans länkar behålls aldrig");
  assert.equal(out[1].why, null);
});

// 2026-10-28: "Stella Armchair" hittade ingen sida — Sits egen sida heter "Stella furniture collection" — så tre av fyra förslag stod utan bild. Namnet ska vara märkets.
test("cleanModelName tar bort märket först och produkttypen sist, men aldrig hela namnet", () => {
  assert.equal(cleanModelName("Sits Brandon Armchair", "Sits"), "Brandon");
  assert.equal(cleanModelName("Stella Armchair", "Sits"), "Stella");
  assert.equal(cleanModelName("Colorado (Armchair)", "Sits"), "Colorado");
  assert.equal(cleanModelName("Impulse fåtölj", "Sits"), "Impulse");
  assert.equal(cleanModelName("Ektorp 3-sits soffa", "IKEA"), "Ektorp 3-sits");
  assert.equal(cleanModelName("Brandon", "Sits"), "Brandon");
  assert.equal(cleanModelName("Fåtölj", "Sits"), "Fåtölj", "ett namn som bara är en produkttyp lämnas orört");
});

test("inferProductType läser typen ur svarets egna ord och gissar aldrig när den saknas", () => {
  assert.equal(inferProductType("Brandon Armchair", "Fåtölj (Armchair), standardbredd"), "fåtölj");
  assert.equal(inferProductType("Brandon 3-seater sofa"), "soffa");
  assert.equal(inferProductType("Norrnäs matstol"), "stol");
  assert.equal(inferProductType("Impulse", null, undefined), null);
});

test("pickModelPage föredrar märkets egen sida när modellnamnet är rensat", () => {
  const clean = cleanExternalLinks(["https://www.taskers.com/sits-brandon-armchair-tsk116023", "https://sits.eu/collection/brandon/"]);
  assert.equal(pickModelPage(clean, cleanModelName("Brandon Armchair", "Sits"), "Sits"), "https://sits.eu/collection/brandon/");
});

test("parseAlternatives räknar 'Brandon Armchair' som samma modell som förslag 1 'Brandon'", () => {
  const out = parseAlternatives([{ model: "Brandon Armchair", why: "x", confidence: "high", sourceUrl: null }, { model: "Stella Armchair", why: "y", confidence: "low", sourceUrl: null }], "Brandon", [], "Sits");
  assert.deepEqual(out.map((a) => a.model), ["Stella"]);
});

// 2026-11-02: AI-läget listade "NORDVIKEN barstol" och sedan "NORDVIKEN matstol" (samma modell) som förslag 1 och 4, och uppföljningen gav ett femte, SKOGSTA. Strukturerarens lista fick bara
// innehålla förslag 2–4, så SKOGSTA föll bort och säljaren fick tre kort i stället för fyra. Listan släpper nu in fler, och dubbletten tas bort här.
test("parseAlternatives hoppar över en modell som redan är förslag 1 (annan höjd) och tar nästa, så att tre återstår", () => {
  const raw = [
    { model: "INGEMAR", why: "utgången", confidence: "medium", sourceUrl: null },
    { model: "ROSENTORP", why: "utgången", confidence: "low", sourceUrl: null },
    { model: "NORDVIKEN", why: "matstolen i samma serie", confidence: "low", sourceUrl: null },
    { model: "SKOGSTA", why: "ur uppföljningen", confidence: "low", sourceUrl: null },
  ];
  assert.deepEqual(parseAlternatives(raw, "NORDVIKEN", [], "IKEA").map((a) => a.model), ["INGEMAR", "ROSENTORP", "SKOGSTA"]);
});

test("clipReason kapar vid en hel mening, annars vid ett ord, och lämnar korta texter orörda", () => {
  assert.equal(clipReason("Kort och gott."), "Kort och gott.");
  assert.equal(clipReason(null), null);
  assert.equal(clipReason("   "), null);
  const long = "Armstöden är breda och helt rektangulära och ryggdynan vilar mot en fast stomme. De smala benen sitter indragna under hörnen, vilket stämmer med märkets bilder för tygklädseln. Den skiljer sig från Stella genom utställda armstöd.";
  const sentence = clipReason(long, 200) as string;
  assert.ok(sentence.length <= 200 && sentence.endsWith("."), sentence);
  assert.equal(clipReason("ord ".repeat(100), 50)?.endsWith("…"), true);
});

test("parseAlternatives tål ett svar utan alternativ", () => {
  assert.deepEqual(parseAlternatives(undefined, "Brandon", []), []);
  assert.deepEqual(parseAlternatives([{ model: "  ", why: "x", confidence: "high", sourceUrl: null }, null], "Brandon", []), []);
});

// 2026-10-29: AI-läget svarar nu i fri text (ingen MÖBELTYP-rad), så typen måste kunna läsas ur svarets egna ord — annars hämtar bildjakten soffbilder till fåtöljer.
test("pickCategory: strukturerarens typ först, sedan namnets och variantens ord, sist svarets inledning — aldrig källistan längre ner", () => {
  assert.equal(pickCategory(" fåtölj ", "Impulse", null, ""), "fåtölj");
  assert.equal(pickCategory("", "Brandon Armchair", null, "Sofa …"), "fåtölj");
  assert.equal(pickCategory(null, "Impulse", "Fåtölj (Armchair)", ""), "fåtölj");
  assert.equal(pickCategory("", "Impulse", null, "Fåtöljen på bilderna är en Sits Impulse."), "fåtölj");
  const langtSvar = "Modellen på bilderna är en Sits Impulse. " + "x".repeat(600) + " ÄPPLARYD sofa with chaise, Lejde light gray - IKEA";
  assert.equal(pickCategory("", "Impulse", null, langtSvar), null, "en källa 600 tecken längre ner får inte avgöra typen");
});

// 2026-10-29: i en körning nämnde AI-lägets svar typen först i källistorna ("Impulse Fåtölj | Folkhemmet"), så kandidaterna fick ingen typ och varken sidtypsregeln eller bildkontrollen gjorde något.
test("rostaTyp: typen de flesta orden pekar på, och ingen typ utan minst två träffar och ett tydligt övertag", async () => {
  const { rostaTyp } = await import("../server/src/candidateType.js");
  assert.equal(rostaTyp("Baserat på bilderna har möbeln raka armstöd. Impulse Fåtölj | Folkhemmet. Impulse Fåtölj | Vision of Home. Sits armchairs. Quattro Sofas"), "fåtölj");
  assert.equal(rostaTyp("Brandon 3-seater sofa. Corner sofa. Soffa i tyg. Fåtölj"), "soffa");
  assert.equal(rostaTyp("Sits Impulse och Brandon. Sofa"), null, "en träff räcker inte");
  assert.equal(rostaTyp("fåtölj fåtölj soffa soffa"), null, "inget tydligt övertag");
  assert.equal(pickCategory("", "Impulse", null, "Tittar. Baserat på bilderna " + "x".repeat(700) + " Impulse Fåtölj | A. Impulse Fåtölj | B. Armchairs", ["https://snug.test/sits-impulse-armchair/p1"]), "fåtölj");
});

test("cleanModelName tar bort parenteser: 'Impulse (med breda armstöd)' är Impulse, och bildsökningen frågar efter det", () => {
  assert.equal(cleanModelName("Impulse (med breda armstöd)", "Sits"), "Impulse");
  assert.equal(cleanModelName("Sits Brandon (Fåtölj / Fåtölj XL)", "Sits"), "Brandon");
  assert.equal(cleanModelName("Stella (Standard / Wide) Armchair", "Sits"), "Stella");
  assert.equal(cleanModelName("(Armchair)", "Sits"), "(Armchair)", "bara en parentes: det ursprungliga behålls");
});
