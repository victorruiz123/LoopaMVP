// ─── AI-sökningen: modellen föreslår, servern bestämmer ─────────────────────
//
// `validate` är gränsen mellan en språkmodells svar och butikens rutnät. Testerna nedan är skrivna
// mot det modellen FAKTISKT gjorde under utveckling, inte mot vad den borde göra.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, toQuery, rateLimited } from "../server/src/butik/aiSearch.js";

const BRANDS = ["IKEA", "Sits", "Swedese", "Mio"];

test("en fullständig tolkning blir ett fullständigt filter", () => {
  const r = validate(
    { kategori: "soffor-fatoljer", marken: ["IKEA"], maxpris: 5000, maxbredd_cm: 200, farger: ["svart"], material: ["tyg"], skick: ["A"] },
    BRANDS,
  );
  assert.equal(r.filter.categorySlug, "soffor-fatoljer");
  assert.deepEqual(r.filter.brands, ["IKEA"]);
  assert.equal(r.filter.maxPriceSek, 5000);
  assert.equal(r.filter.maxWidthMm, 2000, "centimeter in, millimeter i filtret");
  assert.deepEqual(r.filter.grades, ["A"]);
});

test("en påhittad kategori kastas — resten står kvar", () => {
  // Modellen får bara välja bland katalogens slugs. Gör den inte det ska sökningen ändå fungera.
  const r = validate({ kategori: "trädgårdsmöbler", maxpris: 1000 }, BRANDS);
  assert.equal(r.filter.categorySlug, undefined);
  assert.equal(r.filter.maxPriceSek, 1000, "ett fel fält får inte fälla hela tolkningen");
});

test("ett märke vi inte har i lager kastas", () => {
  // Ett märke utan varor är en garanterat tom sida.
  const r = validate({ marken: ["HAY", "IKEA"] }, BRANDS);
  assert.deepEqual(r.filter.brands, ["IKEA"]);
});

test("märket matchas oavsett stavning men lagras som lagret stavar det", () => {
  assert.deepEqual(validate({ marken: ["ikea"] }, BRANDS).filter.brands, ["IKEA"]);
});

test("modellens resonemang i sokord kastas", () => {
  // Ordagrant vad gemini-3.6-flash svarade en gång. `q` matchas mot varje titel, så en mening där
  // ger noll träffar på en fråga som hade gott om svar.
  const r = validate({ kategori: "stolar", sokord: "barstol Cristofaro? No, just barstol. Wait, let's keep it simple." }, BRANDS);
  assert.equal(r.filter.q, undefined, "en mening är inget sökord");
  assert.equal(r.filter.categorySlug, "stolar", "kategorin står kvar");
});

test("ett riktigt modellnamn släpps igenom", () => {
  assert.equal(validate({ sokord: "Ektorp" }, BRANDS).filter.q, "Ektorp");
  assert.equal(validate({ sokord: "3-sits soffa" }, BRANDS).filter.q, "3-sits soffa", "några ord är ok");
});

test("orimliga tal kastas", () => {
  assert.equal(validate({ maxpris: -50 }, BRANDS).filter.maxPriceSek, undefined);
  assert.equal(validate({ maxbredd_cm: 9000 }, BRANDS).filter.maxWidthMm, undefined, "en 90-metersmöbel finns inte");
  assert.equal(validate({ maxpris: 0 }, BRANDS).filter.maxPriceSek, undefined);
});

test("ett påhittat betyg kastas", () => {
  assert.equal(validate({ skick: ["utmärkt"] }, BRANDS).filter.grades, undefined);
  assert.deepEqual(validate({ skick: ["b"] }, BRANDS).filter.grades, ["B"], "gemener är samma betyg");
});

test("en tom tolkning ger hela lagret, inte noll träffar", () => {
  const r = validate({}, BRANDS);
  assert.deepEqual(r.filter, {});
  assert.equal(r.summary, "Hela lagret");
});

test("sammanfattningen faller tillbaka på fälten när modellen inte skrev någon", () => {
  const r = validate({ kategori: "bord", maxpris: 2000 }, BRANDS);
  assert.match(r.summary, /Bord/);
  // Tusenavskiljaren är ett HÅRT mellanslag (U+00A0) ur toLocaleString("sv-SE"), inte ett vanligt.
  assert.match(r.summary, /2\s?000 kr/);
});

test("toQuery talar rutnätets dialekt: centimeter och svenska namn", () => {
  // Servern räknar i millimeter, adressen i centimeter. Översättningen bor på ett ställe.
  const q = toQuery({ categorySlug: "bord", maxWidthMm: 2100, brands: ["IKEA"], maxPriceSek: 3000 });
  assert.deepEqual(q, { kategori: "bord", maxBredd: 210, marke: ["IKEA"], maxPris: 3000 });
});

test("taket per avsändare släpper igenom en människa men inte ett skript", () => {
  const who = `test-${Math.random()}`;
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (!rateLimited(who)) allowed += 1;
  assert.ok(allowed >= 10 && allowed <= 12, `släppte igenom ${allowed}, förväntade ~12`);
  // En annan avsändare påverkas inte av grannens sökande.
  assert.equal(rateLimited(`annan-${Math.random()}`), false);
});

test("ett sökord som bara upprepar kategorin kastas", () => {
  // "svart barstol i trä" gav kategori=stolar OCH sokord="barstol". Sökordet matchas mot titeln, och
  // våra titlar heter "IKEA NORDVIKEN" — aldrig "barstol". Tillsammans gav de noll träffar på en
  // fråga med 48 svar.
  const r = validate({ kategori: "stolar", sokord: "barstol", farger: ["svart"] }, BRANDS);
  assert.equal(r.filter.q, undefined);
  assert.equal(r.filter.categorySlug, "stolar");
  assert.deepEqual(r.filter.colors, ["svart"]);
});

test("men ett modellnamn kastas inte, även med en kategori satt", () => {
  const r = validate({ kategori: "soffor-fatoljer", sokord: "Ektorp" }, BRANDS);
  assert.equal(r.filter.q, "Ektorp");
});
