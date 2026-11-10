// ─── Produktforskningen: en adress är inte ett belägg ────────────────────────────────────────────
//
// Modellen får skriva vilken adress som helst i sourceUrl. Verifieringen avgör i kod vad som får
// kallas bekräftat: sidan hämtad av oss, modellnamnet på sidan, värdet på sidan. Testerna nedan
// håller tre löften — en okänd adress sållas bort, en bekräftad sida ger "page_confirmed", och en
// sida som inte gick att läsa lämnar påståendet som citerat men aldrig som bekräftat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dimensionNeedles, foldText, materialNeedles, verifyClaims } from "../server/src/research/verify.js";
import { normalizeDimension, normalizeMaterial } from "../server/src/research/normalize.js";

const IKEA = "https://www.ikea.com/se/sv/p/norrnas-stol-bjork-isunda-gra-s49984122/";
const OTHER = "https://www.example-shop.se/norrnas";
const FAKE = "https://www.ikea.com/se/sv/p/norrnas-invented-12345/";

const dim = (type: string, value: number, sourceUrl: string, unit = "cm", quote: string | null = null) =>
  normalizeDimension({ type, label: type, value, valueMax: null, unit, appliesTo: null, sourceUrl, quote })!;
const mat = (component: string, material: string, sourceUrl: string) =>
  normalizeMaterial({ component, material, detail: null, appliesTo: null, sourceUrl, quote: null })!;

const PAGE = `NORRNÄS Stol, björk/Isunda grå. Mått Bredd: 42 cm Djup: 54 cm Höjd: 89 cm Sitthöjd: 46 cm
Material Stomme: Massiv björk, Klarlack Sits: Polyuretanskum 35 kg/m3`;

test("bekräftat mot sidan: modellnamnet och värdet står där", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    dimensions: [dim("overall_width", 42, IKEA), dim("seat_height", 46, IKEA), dim("overall_depth", 540, IKEA, "mm")],
    materials: [mat("Stomme", "Massiv björk", IKEA), mat("Sits", "Polyuretanskum", IKEA)],
    facts: [],
    fetchPage: async (url) => (url === IKEA ? PAGE : null),
  });
  assert.equal(out.dimensions.length, 3);
  assert.ok(out.dimensions.every((d) => d.verification === "page_confirmed" && d.verified));
  assert.ok(out.materials.every((m) => m.verification === "page_confirmed"));
  assert.equal(out.rejected.length, 0);
  assert.equal(out.pagesRead, 1);
});

test("en adress som ingen känner och som inte går att läsa behålls — men som osäker, och utan länk", async () => {
  // Den första versionen sållade bort den. Mätt på NORRNÄS: 9 av 12 uppgifter, för att adresserna
  // idag svarar 404. Att kasta dem är att kasta de uppgifter säljaren behöver kontrollera.
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    dimensions: [dim("overall_width", 42, FAKE), dim("overall_height", 89, IKEA)],
    materials: [],
    facts: [],
    fetchPage: async (url) => (url === FAKE ? "gone" : PAGE),
  });
  assert.equal(out.dimensions.length, 2);
  const fake = out.dimensions.find((d) => d.type === "overall_width")!;
  assert.equal(fake.verification, "unverified");
  assert.equal(fake.verified, false);
  assert.equal(fake.sourceUrl, null, "en död adress visas aldrig som länk");
  assert.deepEqual(out.unlinkable, [FAKE]);
  assert.equal(out.dimensions.find((d) => d.type === "overall_height")!.verification, "page_confirmed");
  assert.equal(out.rejected.length, 0);
});

test("ett mått utan både källa och citat avvisas — det är den enda kategorin ingen kan kontrollera", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    dimensions: [normalizeDimension({ type: "overall_width", label: "Bredd", value: 42, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: null, quote: null })!],
    materials: [],
    facts: [],
    fetchPage: async () => PAGE,
  });
  assert.equal(out.dimensions.length, 0);
  assert.equal(out.rejected[0].why, "varken källa eller citat");
});

test("ett mått utan adress men med citat behålls som osäkert", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set(),
    dimensions: [normalizeDimension({ type: "overall_width", label: "Bredd", value: 42, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: null, quote: "Bredd: 42 cm" })!],
    materials: [],
    facts: [],
    fetchPage: async () => PAGE,
  });
  assert.equal(out.dimensions.length, 1);
  assert.equal(out.dimensions[0].verification, "unverified");
});

test("sidan gick inte att läsa: citerad om källan är känd, osäker om den bara hittats på — men aldrig kastad", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    claimedUrls: new Set([OTHER]),
    dimensions: [dim("overall_width", 42, IKEA), dim("overall_depth", 54, OTHER)],
    materials: [],
    facts: [],
    fetchPage: async () => null,
  });
  assert.equal(out.dimensions.length, 2);
  assert.equal(out.dimensions.find((d) => d.type === "overall_width")!.verification, "cited", "verktyget besökte den");
  assert.equal(out.dimensions.find((d) => d.type === "overall_depth")!.verification, "unverified", "en nätverksfel är ingen bekräftelse");
  assert.equal(out.rejected.length, 0);
});

test("blockerad sida, PDF och JS-skal är ingen invändning: källan står kvar som citerad, med länk", async () => {
  const BLOCKED = "https://www.retailer.se/norrnas";
  const PDF = "https://www.ikea.com/manual/norrnas.pdf";
  const SHELL = "https://www.scribd.com/document/57860287/IKEA-Catalogue-2011";
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set(),
    claimedUrls: new Set([BLOCKED, PDF, SHELL]),
    dimensions: [dim("overall_width", 42, BLOCKED), dim("overall_depth", 54, PDF), dim("overall_height", 94, SHELL)],
    materials: [],
    facts: [],
    fetchPage: async (url) => (url === BLOCKED ? "blocked" : url === PDF ? "unsupported" : "Scribd - Läs och dela dokument."),
  });
  assert.deepEqual(out.dimensions.map((d) => d.verification), ["cited", "cited", "cited"]);
  assert.ok(out.dimensions.every((d) => d.sourceUrl), "länkarna lever, så de visas");
  assert.deepEqual(out.unlinkable, []);
});

test("en bildfil är ingen källa: påståendet står kvar, länken visas inte och sidan hämtas inte", async () => {
  const IMG = "https://imgv2-1-f.scribdassets.com/img/document/125213024/298x396/f9cbcbce7a/1411473862?v=1";
  const asked: string[] = [];
  const out = await verifyClaims({
    brand: "IKEA",
    model: "INGEMAR",
    knownUrls: new Set(),
    claimedUrls: new Set([IMG]),
    dimensions: [dim("overall_width", 42, IMG)],
    materials: [],
    facts: [],
    fetchPage: async (url) => (asked.push(url), PAGE),
  });
  assert.deepEqual(asked, []);
  assert.equal(out.dimensions[0].verification, "unverified");
  assert.equal(out.dimensions[0].sourceUrl, null);
});

test("en lång sida som inte nämner modellen är en annan sida: osäkert och olänkat, om inte verktyget besökte den", async () => {
  const LONG = `STEFAN stol, svart. ${"Bredd: 42 cm Djup: 49 cm Höjd: 90 cm. ".repeat(200)}`;
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    claimedUrls: new Set([OTHER]),
    dimensions: [dim("overall_width", 42, OTHER), dim("overall_depth", 49, IKEA)],
    materials: [],
    facts: [],
    fetchPage: async () => LONG,
  });
  const other = out.dimensions.find((d) => d.type === "overall_width")!;
  assert.equal(other.verification, "unverified");
  assert.equal(other.sourceUrl, null);
  assert.equal(out.dimensions.find((d) => d.type === "overall_depth")!.verification, "cited");
});

test("sidan nämner modellen men inte värdet: citerad, inte bekräftad", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    dimensions: [dim("overall_width", 99, IKEA)],
    materials: [mat("Stomme", "Massiv ek", IKEA)],
    facts: [],
    fetchPage: async () => PAGE,
  });
  assert.equal(out.dimensions[0].verification, "cited");
  assert.equal(out.materials[0].verification, "cited");
});

test("en adress ur modellens egen källista duger när sidan handlar om modellen och värdet finns", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set(),
    claimedUrls: new Set([OTHER]),
    dimensions: [dim("overall_width", 42, OTHER)],
    materials: [],
    facts: [],
    fetchPage: async () => PAGE,
  });
  assert.equal(out.dimensions[0].verification, "page_confirmed");
});

test("en sida om en annan produkt bekräftar ingenting", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([OTHER]),
    dimensions: [dim("overall_width", 42, OTHER)],
    materials: [],
    facts: [],
    fetchPage: async () => "STEFAN stol, svart. Bredd: 42 cm Djup: 49 cm Höjd: 90 cm",
  });
  assert.equal(out.dimensions[0].verification, "cited");
});

test("nålarna täcker cm, mm, meter, tum, decimalkomma och citat", () => {
  const d = dim("overall_width", 42.5, IKEA, "cm", "Bredd: 42,5 cm");
  const needles = dimensionNeedles(d);
  const page = foldText("Bredd: 42,5 cm");
  assert.ok(needles.some((re) => re.test(page)));
  assert.ok(needles.some((re) => re.test(foldText("425 mm"))));
  assert.ok(!needles.some((re) => re.test(foldText("142,5 cm"))));
  const m = mat("Klädsel", "85 % polyester, 15 % bomull", IKEA);
  assert.deepEqual(materialNeedles(m), ["85%", "polyester", "15%", "bomull"]);
});

test("avstängd sidverifiering lämnar allt känt som citerat", async () => {
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    dimensions: [dim("overall_width", 42, IKEA)],
    materials: [],
    facts: [],
    enabled: false,
    fetchPage: async () => {
      throw new Error("ska inte anropas");
    },
  });
  assert.equal(out.dimensions[0].verification, "cited");
  assert.equal(out.pagesTried, 0);
});

// ─── Begagnatsajter hämtas aldrig av vår server ─────────────────────────────────────────────────
//
// Googles sök och URL-verktyg får läsa Blocket, Tradera och Facebook Marketplace — det är deras index
// och deras hämtning, och en annonsrubrik är bra belägg för VILKEN modell det är. Men sajternas villkor
// förbjuder automatiserad hämtning (repots egen .env.example citerar Blocket), så vår server gör det
// aldrig, och ett påstående som pekar dit blir "cited" och aldrig "page_confirmed".

import { fetchPageText } from "../server/src/research/verify.js";

const BLOCKET = "https://www.blocket.se/annons/stockholm/ikea-stolar-123";
const TRADERA = "https://www.tradera.com/item/302538/1/ikea-stolar";
const FACEBOOK = "https://www.facebook.com/marketplace/item/123/";

test("fetchPageText rör aldrig nätet för en begagnatsajt", async () => {
  const realFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = (async () => {
    touched++;
    throw new Error("ska inte anropas");
  }) as unknown as typeof fetch;
  try {
    for (const url of [BLOCKET, TRADERA, FACEBOOK, "https://www.ebay.com/itm/1", "https://www.sellpy.se/item/1"]) {
      assert.equal(await fetchPageText(url), "unsupported", url);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(touched, 0);
});

test("verifyClaims ber aldrig hämtaren om en begagnatannons, och märker påståendet 'cited' — även när sidan skulle ha bekräftat det", async () => {
  const asked: string[] = [];
  const out = await verifyClaims({
    brand: "IKEA",
    model: "NORRNÄS",
    knownUrls: new Set([IKEA]),
    claimedUrls: new Set([BLOCKET, TRADERA]),
    dimensions: [dim("overall_width", 42, IKEA), dim("seat_depth", 44, BLOCKET), dim("seat_height", 46, TRADERA)],
    materials: [mat("Stomme", "Massiv björk", BLOCKET)],
    facts: [],
    fetchPage: async (url) => {
      asked.push(url);
      return `NORRNÄS Bredd: 42 cm Djup: 44 cm Sitthöjd: 46 cm Massiv björk`;
    },
  });
  assert.deepEqual(asked, [IKEA], "bara tillverkarens sida hämtades");
  const by = Object.fromEntries(out.dimensions.map((d) => [d.type, d.verification]));
  assert.equal(by.overall_width, "page_confirmed");
  assert.equal(by.seat_depth, "cited");
  assert.equal(by.seat_height, "cited");
  assert.equal(out.materials[0].verification, "cited");
  assert.equal(out.dimensions.find((d) => d.type === "seat_depth")!.verified, false);
});
