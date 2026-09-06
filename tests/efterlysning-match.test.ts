// ─── Matchningen: vad som får brytas och vad som aldrig får det ──────────────
//
// Hela produktlöftet sitter i skillnaden mellan en hård gräns och en mjuk önskan. En soffa 30 cm
// för bred kommer inte in genom dörren hur välformulerad kompromissen än är; en blå soffa i stället
// för en grön är ett förslag köparen själv får ta ställning till.
//
// Testerna nedan låser den skillnaden, och de låser den åt BÅDA hållen: generositeten får inte
// smyga in ett brott mot en hård gräns, och strängheten får inte kasta bort en kandidat som bara
// har fel färg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, evaluateAll, violatesHard } from "../server/src/efterlysning/match.js";
import type { Efterlysning } from "../server/src/efterlysning/types.js";
import type { Product } from "../server/src/butik/types.js";

function want(over: Partial<Efterlysning> = {}): Efterlysning {
  return {
    id: "e1", userId: "u1", email: null, state: "active",
    filter: { categorySlug: "soffor", maxPriceSek: 5000, maxWidthMm: 2100 },
    styleTags: [], deadline: null, urgency: "none", note: null,
    summary: "", parseMethod: "form",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z", area: null,
    notifiedProductIds: [], scannedCount: 0, scannedClearances: 0, lastSweptAt: null,
    ...over,
  };
}

function sofa(over: Partial<Product> = {}): Product {
  return {
    id: "p1", source: "loopa", title: "3-sits soffa", brand: "Mio", model: "Madison",
    categorySlug: "soffor", color: "grön", material: "sammet",
    dimensions: { widthMm: 2000, depthMm: 900, heightMm: 850, seatHeightMm: null },
    priceSek: 4000, retailPriceSek: null, imageUrl: null, condition: null,
    state: "live", listedAt: "2026-09-01T00:00:00Z", listedAtKnown: true,
    externalUrl: null, auction: null, region: "Stockholm", homeDeliveryAvailable: true,
    returnsAccepted: true, jobId: null, identity: null,
    ...over,
  } as Product;
}

// ─── hårda gränser ──────────────────────────────────────────────────────────

test("fel kategori är aldrig en träff, hur generöst vi än letar", () => {
  const p = sofa({ categorySlug: "bord" });
  assert.equal(violatesHard(want(), p), "fel kategori");
  assert.equal(evaluate(want(), p, "tradera", true), null, "inte ens generöst");
});

test("över maxpris är ett annat objekt, inte en kompromiss", () => {
  assert.equal(evaluate(want(), sofa({ priceSek: 5001 }), "tradera", true), null);
  assert.ok(evaluate(want(), sofa({ priceSek: 5000 }), "tradera", true), "precis på gränsen får vara med");
});

test("för bred fälls även om allt annat stämmer perfekt", () => {
  const p = sofa({ dimensions: { widthMm: 2101, depthMm: 900, heightMm: 850, seatHeightMm: null } });
  assert.equal(evaluate(want(), p, "loopa_live", true), null);
});

test("ETT SAKNAT MÅTT fäller möbeln i strikt läge — notiser gissar aldrig", () => {
  // Vi väcker aldrig någon för en möbel vi inte vet får plats.
  const p = sofa({ dimensions: { widthMm: null, depthMm: 900, heightMm: 850, seatHeightMm: null } });
  assert.equal(evaluate(want(), p, "tradera", false), null);
});

test("men i direktsvepet blir det en ärlig nära-träff, inte en tom skärm", () => {
  // Mätt skarpt: "matbord, max 160 cm" gav NOLL kandidater, eftersom nästan ingen Tradera-annons
  // anger bredd. Se DECISIONS.md #1 — okänt är varken inom eller över.
  const p = sofa({ dimensions: { widthMm: null, depthMm: 900, heightMm: 850, seatHeightMm: null } });
  const c = evaluate(want(), p, "tradera", true);
  assert.equal(c?.kind, "near");
  assert.match(c!.fitNote, /bredden framgår inte av annonsen/);
});

test("ett saknat mått är inte ett BROTT — bara okänt", () => {
  const p = sofa({ dimensions: { widthMm: null, depthMm: 900, heightMm: 850, seatHeightMm: null } });
  assert.equal(violatesHard(want(), p), null, "inget bevisat brott");
});

test("ett för STORT mått är fortfarande ett brott, i båda lägena", () => {
  const p = sofa({ dimensions: { widthMm: 2101, depthMm: 900, heightMm: 850, seatHeightMm: null } });
  assert.equal(violatesHard(want(), p), "för bred");
  assert.equal(evaluate(want(), p, "tradera", true), null);
});

test("utan gräns spelar ett saknat mått ingen roll", () => {
  const e = want({ filter: { categorySlug: "soffor", maxPriceSek: 5000 } });
  const p = sofa({ dimensions: { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null } });
  assert.ok(evaluate(e, p, "loopa_live", false));
});

test("ett saknat PRIS fälls när ett tak är satt", () => {
  assert.equal(violatesHard(want(), sofa({ priceSek: null })), "över priset");
});

// ─── mjuka önskemål ─────────────────────────────────────────────────────────

test("fel färg är en nära-träff, inte ett nej", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const c = evaluate(e, sofa({ color: "blå" }), "tradera", true);
  assert.equal(c?.kind, "near");
  assert.match(c!.fitNote, /blå, inte grön/);
});

test("OKÄND färg påstås inte vara fel färg", () => {
  // "inte grön" om en annons utan färguppgift är ett påstående om möbeln på en grund vi inte har.
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const c = evaluate(e, sofa({ color: null }), "tradera", true);
  assert.match(c!.fitNote, /färg framgår inte av annonsen/);
  assert.doesNotMatch(c!.fitNote, /inte grön/);
});

test("märket läses ur rubriken när fältet är tomt", () => {
  // Mätt skarpt: "STRING vägghylla" fick etiketten "inte String". Se DECISIONS.md #2.
  const e = want({ filter: { categorySlug: "soffor", brands: ["String"] } });
  const c = evaluate(e, sofa({ brand: null, title: "STRING vägghylla i metall" }), "tradera", true);
  assert.doesNotMatch(c!.fitNote, /inte String/);
});

test("ett känt fel rankas före en lucka", () => {
  // Den som skrivit "grön" ska få en soffa vars färg inte står FÖRE en som bevisligen är blå.
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const wrong = evaluate(e, sofa({ id: "a", color: "blå" }), "tradera", true)!;
  const unknown = evaluate(e, sofa({ id: "b", color: null }), "tradera", true)!;
  assert.ok(unknown.rank < wrong.rank);
});

test("men bara när vi letar generöst — notiser släpper aldrig igenom en nära-träff", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  assert.equal(evaluate(e, sofa({ color: "blå" }), "tradera", false), null);
});

test("rätt färg gör den exakt, och meningen säger det", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const c = evaluate(e, sofa({ color: "grön" }), "loopa_live", false);
  assert.equal(c?.kind, "exact");
  assert.equal(c!.fitNote, "Uppfyller allt du bad om.");
});

test("färg matchas som delsträng åt båda hållen", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  assert.equal(evaluate(e, sofa({ color: "mörkgrön" }), "loopa_live", false)?.kind, "exact");
});

test("en Tradera-vara utan betyg räknas inte som fel skick", () => {
  // Vi har inte granskat den. Att kalla frånvaron av vårt betyg för ett avsteg hade gjort varje
  // extern möbel till en nära-träff på en grund vi inte kan belägga.
  const e = want({ filter: { ...want().filter, grades: ["A", "B"] } });
  const c = evaluate(e, sofa({ source: "tradera", condition: null }), "tradera", false);
  assert.equal(c?.kind, "exact");
});

test("men ett betyg vi HAR satt och som inte duger gör den nära", () => {
  const e = want({ filter: { ...want().filter, grades: ["A"] } });
  const p = sofa({ condition: { grade: "C" } as Product["condition"] });
  assert.equal(evaluate(e, p, "loopa_live", true)?.kind, "near");
});

test("flera missar räknas upp i samma mening", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"], brands: ["Swedese"] } });
  const c = evaluate(e, sofa({ color: "blå", brand: "Mio" }), "tradera", true);
  assert.match(c!.fitNote, /Mio, inte Swedese/);
  assert.match(c!.fitNote, /blå, inte grön/);
});

// ─── rangordning ────────────────────────────────────────────────────────────

test("källan väger tyngre än hur väl den sitter", () => {
  // En exakt Tradera-träff är fortfarande någon annans annons; en nära Loopa-vara är granskad,
  // prissatt och köpbar i dag. Ordningen speglar vad köparen faktiskt får.
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const nearLoopa = evaluate(e, sofa({ id: "a", color: "blå" }), "loopa_live", true)!;
  const exactTradera = evaluate(e, sofa({ id: "b", color: "grön" }), "tradera", true)!;
  assert.ok(nearLoopa.rank < exactTradera.rank);
});

test("inom samma källa går exakt före nära", () => {
  const e = want({ filter: { ...want().filter, colors: ["grön"] } });
  const list = evaluateAll(e, [sofa({ id: "a", color: "blå" }), sofa({ id: "b", color: "grön" })], "tradera", true);
  assert.deepEqual(list.map((c) => c.product.id), ["b", "a"]);
});

test("stiltaggar kan bara ranka, aldrig fälla", () => {
  const e = want({ styleTags: ["60-tal"] });
  const c = evaluate(e, sofa(), "tradera", true);
  assert.equal(c?.kind, "near", "stilen syns inte i texten -> nära");
  assert.ok(c, "men den fälls inte");
  // Och den påstås inte vara fel stil: stil står aldrig i ett fält, så frånvaro är inte bevis.
  assert.match(c!.fitNote, /framgår inte/);
});
