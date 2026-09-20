// ─── Måttminnet: säljarens tumstock bärs vidare till nästa möbel av samma modell ─────────────────
//
// Rättelsen i måttsteget gällde tidigare bara den annons den gjordes på. Nästa säljare med samma
// modell fick samma felaktiga mått att rätta en gång till. Testerna här håller tre löften: att bara
// mätningar lagras, att en enstaka felskrivning inte kan flytta måttet för alla, och att minnet
// aldrig tar platsen från en källa.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { glomMattminnet, mattminnetsRader, modellNyckel, noteraMatt, talUr } from "../server/src/mattminne.js";
import { mergeSpecs } from "../server/src/specHarvest.js";
import type { ListingAttribute } from "../server/src/types.js";

beforeEach(() => {
  process.env.LOOPA_MATTMINNE_DIR = mkdtempSync(path.join(tmpdir(), "mattminne-"));
  glomMattminnet();
});

const matt = (label: string, value: string, model = "NORDVIKEN") =>
  noteraMatt({ jobId: "j", brand: "IKEA", model, attr: { key: label.toLowerCase(), label, value } });

const rad = (label: string, value: string, extra: Partial<ListingAttribute> = {}): ListingAttribute => ({
  key: label.toLowerCase(),
  label,
  value,
  sourceUrl: null,
  estimated: false,
  ...extra,
});

test("ett mått en säljare skrivit in kommer tillbaka på nästa möbel av samma modell", async () => {
  await matt("Bredd", "92 cm");
  const ut = await mattminnetsRader("IKEA", "NORDVIKEN");
  assert.deepEqual(
    ut.map((a) => [a.label, a.value, a.fromSellers]),
    [["Bredd", "92 cm", true]],
  );
});

test("en annan modell får ingenting", async () => {
  await matt("Bredd", "92 cm");
  assert.deepEqual(await mattminnetsRader("IKEA", "EKTORP"), []);
  assert.deepEqual(await mattminnetsRader(null, "NORDVIKEN"), []);
});

test("märket räknas bara en gång när modellnamnet redan bär det", () => {
  assert.equal(modellNyckel("IKEA", "IKEA Nordviken"), "ikea nordviken");
  assert.equal(modellNyckel("ikea", "NORDVIKEN"), "ikea nordviken");
  assert.equal(modellNyckel("IKEA", "N"), null, "en enda bokstav är inte en modell");
});

test("en felskrivning kan inte flytta måttet för alla", async () => {
  await matt("Bredd", "92 cm");
  await matt("Bredd", "91 cm");
  await matt("Bredd", "920 cm"); // utanför rimliga mått: lagras aldrig
  await matt("Bredd", "192"); // rimligt tal, men en etta för mycket — medianen håller emot
  const [bredd] = await mattminnetsRader("IKEA", "NORDVIKEN");
  assert.equal(bredd.value, "92 cm");
});

test("medianen är alltid ett tal någon faktiskt mätt", async () => {
  await matt("Höjd", "100 cm");
  await matt("Höjd", "104 cm");
  const [hojd] = await mattminnetsRader("IKEA", "NORDVIKEN");
  assert.equal(hojd.value, "100 cm", "nedre mitten, inte ett medelvärde ingen mätt");
});

test("säljarens skrivsätt spelar ingen roll, men ett intervall är ingen mätning", () => {
  assert.equal(talUr("92", "cm"), 92);
  assert.equal(talUr("92,5 cm", "cm"), 92.5);
  assert.equal(talUr("920 mm", "cm"), 92);
  assert.equal(talUr("ca 0,9 m", "cm"), 90);
  assert.equal(talUr("80–82 cm", "cm"), null);
  assert.equal(talUr("massiv ek", "cm"), null);
  assert.equal(talUr("8,4 kg", "kg"), 8.4);
});

test("bara mätningar lagras — material och sammanslagna mått lämnas åt annonsen", async () => {
  await noteraMatt({ jobId: "j", brand: "IKEA", model: "NORDVIKEN", attr: { key: "material", label: "Material", value: "Massiv ek" } });
  await noteraMatt({ jobId: "j", brand: "IKEA", model: "NORDVIKEN", attr: { key: "matt", label: "Mått", value: "81 x 92 x 82 cm" } });
  assert.deepEqual(await mattminnetsRader("IKEA", "NORDVIKEN"), []);
});

test("minnet ersätter en uppskattning men aldrig en källa", async () => {
  await matt("Bredd", "92 cm");
  await matt("Höjd", "100 cm");
  const minnet = await mattminnetsRader("IKEA", "NORDVIKEN");
  const ut = mergeSpecs(
    [rad("Bredd", "80 cm", { sourceUrl: "https://ikea.com" }), rad("Höjd", "ca 105 cm", { estimated: true })],
    minnet,
  );
  assert.deepEqual(
    ut.map((a) => [a.label, a.value]),
    [
      ["Bredd", "80 cm"],
      ["Höjd", "100 cm"],
    ],
  );
});

test("en sidskörd som landar efter minnet skriver in det belagda måttet", async () => {
  await matt("Bredd", "92 cm");
  const minnet = await mattminnetsRader("IKEA", "NORDVIKEN");
  const medMinne = mergeSpecs([rad("Material", "Massiv ek")], minnet);
  const ut = mergeSpecs(medMinne, [rad("Bredd", "81 cm", { sourceUrl: "https://ikea.com" })]);
  const bredd = ut.filter((a) => a.label === "Bredd");
  assert.equal(bredd.length, 1, "måttet står en gång, inte två");
  assert.equal(bredd[0].value, "81 cm");
  assert.equal(bredd[0].sourceUrl, "https://ikea.com");
});

test("säljarens egen rättelse på DEN här möbeln går före minnet", async () => {
  await matt("Bredd", "92 cm");
  const minnet = await mattminnetsRader("IKEA", "NORDVIKEN");
  const ut = mergeSpecs([rad("Bredd", "88 cm", { sellerEdited: true })], minnet);
  assert.deepEqual(
    ut.map((a) => [a.value, !!a.sellerEdited]),
    [["88 cm", true]],
  );
});
