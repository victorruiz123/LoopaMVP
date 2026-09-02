// ─── Väggen och panelen: ingen köpare får gå att peka ut ────────────────────
//
// Efterlysningsväggen är publik och riktad till säljare. Den är också det enda stället där data om
// köpare lämnar systemet, och testerna nedan är gränsen. Tre regler:
//
//   1. Aldrig identitet — inget namn, ingen e-post, inget id som går att slå upp.
//   2. Aldrig anteckningen — "måste gå in genom en smal dörr i Vasastan" beskriver en lägenhet.
//   3. Grovt område — och bara när gruppen är enig, annars "Stockholm".
//
// Säljarkroken prövas mot samma gräns: den svarar med ETT ANTAL. En säljare som ser "någon i
// Vasastan söker en grön sammetssoffa max 6 000" vet både var köparen bor och vad de har råd med.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-vagg-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const { wall, demandDashboard, demandCountFor, toCsv } = await import("../server/src/efterlysning/wall.js");

const spec = (over = {}) => ({
  userId: "u1", email: "hemlig@example.com",
  filter: { categorySlug: "forvaring", brands: ["String"], materials: ["valnöt"], maxPriceSek: 4000 },
  styleTags: [], deadline: null, urgency: "none" as const,
  note: "Måste gå in genom en smal dörr i Vasastan",
  summary: "Förvaring · String · valnöt · max 4 000 kr", parseMethod: "chat" as const, area: "Södermalm",
  ...over,
});

test("väggen bär inget som pekar ut en köpare", async () => {
  await store.create(spec());
  const [post] = await wall();
  const text = JSON.stringify(post);
  assert.doesNotMatch(text, /hemlig@example\.com/, "ingen e-post");
  assert.doesNotMatch(text, /u1/, "inget användar-id");
  assert.doesNotMatch(text, /smal dörr/, "ingen anteckning — den beskriver en lägenhet");
  assert.doesNotMatch(text, /-[0-9a-f]{4}-/, "inget efterlysnings-id att slå upp");
});

test("rubriken är den en säljare läser", async () => {
  const [post] = await wall();
  assert.match(post.title, /^Sökes: String förvaring i valnöt, upp till 4\s000 kr$/);
});

test("priset visas som ett BAND, inte som någons budget", async () => {
  await store.create(spec({ userId: "u2", filter: { categorySlug: "bord", maxPriceSek: 2750 } }));
  const post = (await wall("bord"))[0];
  assert.match(post.title, /upp till 2\s500 kr/, "2 750 kr avrundas nedåt till ett spann");
  assert.doesNotMatch(post.title, /2\s750/);
});

test("bandet ÖVERDRIVER ALDRIG köparens budget", async () => {
  // Den första versionen la 4 000 kr i bandet "upp till 6 000" — en förhandlingsposition given bort
  // gratis till varje säljare som läser väggen. Hellre snålare än de är.
  await store.create(spec({ userId: "u9", filter: { categorySlug: "stolar", maxPriceSek: 4900 } }));
  const post = (await wall("stolar"))[0];
  assert.match(post.title, /upp till 4\s000 kr/);
});

test("flera som söker samma sak blir EN rad", async () => {
  // Skyddar dem, och är ett starkare säljargument än två rader.
  await store.create(spec({ userId: "u3" }));
  const rader = await wall("forvaring");
  assert.equal(rader.length, 1);
  assert.equal(rader[0].count, 2);
});

test("oense områden blir 'Stockholm', inte en lista", async () => {
  // Två stadsdelar på en rad pekar ut vilken av två personer som bor var.
  await store.create(spec({ userId: "u4", area: "Vasastan" }));
  assert.equal((await wall("forvaring"))[0].area, "Stockholm");
});

test("väntetiden är dagar, inte ett datum", async () => {
  const post = (await wall("forvaring"))[0];
  assert.equal(typeof post.waitingDays, "number");
  assert.doesNotMatch(JSON.stringify(post), /20\d\d-\d\d-\d\d/);
});

test("en pausad efterlysning står inte på väggen", async () => {
  const e = await store.create(spec({ userId: "pausad", filter: { categorySlug: "sangar", maxPriceSek: 2000 } }));
  await store.update(e.id, { state: "paused" });
  assert.equal((await wall("sangar")).length, 0);
});

test("en osparad efterlysning (utan konto) står inte heller där", async () => {
  await store.create(spec({ userId: null, filter: { categorySlug: "belysning", maxPriceSek: 500 } }));
  assert.equal((await wall("belysning")).length, 0);
});

// ─── panelen ────────────────────────────────────────────────────────────────

test("panelen rankar på OMÄTTAD efterfrågan", async () => {
  // Den listan säger vad vi ska be folk filma.
  const rader = await demandDashboard();
  assert.ok(rader.length > 0);
  assert.ok(rader[0].unmet >= (rader[rader.length - 1]?.unmet ?? 0));
  assert.equal(typeof rader[0].medianWaitDays, "number");
});

test("CSV:n bär ingen köparidentitet heller", async () => {
  const csv = toCsv(await demandDashboard());
  assert.doesNotMatch(csv, /hemlig@example\.com/);
  assert.doesNotMatch(csv, /smal dörr/);
  assert.match(csv.split("\n")[0], /^kategori;marke;prisband/);
});

// ─── säljarkroken ───────────────────────────────────────────────────────────

test("säljarkroken svarar med ett antal och inget annat", async () => {
  const n = await demandCountFor({ categorySlug: "forvaring", brand: "String", priceSek: 3000 });
  assert.equal(typeof n, "number");
  assert.ok(n >= 1);
});

test("en möbel över köparens tak räknas inte", async () => {
  assert.equal(await demandCountFor({ categorySlug: "forvaring", brand: "String", priceSek: 9000 }), 0);
});

test("fel märke räknas inte", async () => {
  assert.equal(await demandCountFor({ categorySlug: "forvaring", brand: "IKEA", priceSek: 1000 }), 0);
});

test("en möbel utan pris kan inte falla på ett pristak", async () => {
  assert.ok(await demandCountFor({ categorySlug: "forvaring", brand: "String", priceSek: null }) >= 1);
});

test("samma sak i olika prisklass blir EN rad, med det lägsta taket", async () => {
  // Med bandet i grupperingsnyckeln hamnade två köpare av samma gröna soffa på skilda rader — den
  // ena med 5 500 kr och den andra med 6 000 — och två rader med var sin stadsdel pekar ut mer än
  // en rad med två.
  await store.create(spec({ userId: "g1", area: "Vasastan", filter: { categorySlug: "belysning", colors: ["grön"], maxPriceSek: 6000 } }));
  await store.create(spec({ userId: "g2", area: "Kungsholmen", filter: { categorySlug: "belysning", colors: ["grön"], maxPriceSek: 5500 } }));
  const rader = await wall("belysning");
  assert.equal(rader.length, 1, "en rad, inte två");
  assert.equal(rader[0].count, 2);
  assert.match(rader[0].title, /upp till 5\s000 kr/, "det lägsta taket, aldrig det högsta");
  assert.equal(rader[0].area, "Stockholm", "oense områden slås ihop");
});
