// ─── Adminpanelens annonsvy: rättelserna, mätningen och tillståndsbytena ─────
//
// Tre saker måste hålla, och de är valda för att de går sönder tyst:
//
// RÄTTELSEN ÖVERLEVER EN OMRÄKNING. Hela poängen med överstyrningslagret är att en människas ord
// står kvar när besiktningen räknas om. Skrivs rättelsen in i jobbet i stället försvinner den vid
// nästa `syncFromJobs` — och den som rättade tror att det är gjort.
//
// TOMT ÄR ETT BESLUT. `null` betyder "den här möbeln har ingen känd färg", osatt betyder "använd det
// maskinen kom fram till". Plattas de till varandra går det inte längre att tömma ett fält.
//
// MÄTNINGEN RÄKNAR RÄTT HINK. Visningar, exponeringar och klick svarar på olika frågor, och en
// hopblandning ger en klickfrekvens som ser bra ut för att nämnaren är fel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna datamappar, satta INNAN modulerna läses in: sökvägarna läses vid import, och utan det här
// skriver testerna bland de skarpa varorna och den skarpa mätloggen.
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-annons-test-"));
process.env.ANALYS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-analys-test-"));
process.on("exit", () => {
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.ANALYS_DATA_DIR!, { recursive: true, force: true });
});

const overrides = await import("../server/src/butik/overrides.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const analys = await import("../server/src/analys/store.js");
import type { Product } from "../server/src/butik/types.js";

/** En härledd vara, som normalize.ts hade lämnat den. */
function vara(patch: Partial<Product> = {}): Product {
  return {
    id: "LP-TEST-0001",
    source: "loopa",
    title: "IKEA Strandmon fåtölj",
    brand: "IKEA",
    model: "Strandmon",
    categorySlug: "soffor",
    color: "Beige",
    material: "Tyg",
    dimensions: { widthMm: 820, depthMm: 960, heightMm: 1010, seatHeightMm: 450, estimated: true },
    priceSek: 1800,
    retailPriceSek: 3495,
    imageUrl: "/api/cards/LP-TEST-0001/cover",
    condition: null,
    state: "draft",
    listedAt: "2026-08-01T10:00:00.000Z",
    listedAtKnown: true,
    externalUrl: null,
    auction: null,
    region: "Stockholm",
    homeDeliveryAvailable: true,
    returnsAccepted: true,
    jobId: "job-1",
    identity: null,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Rättelserna
// ---------------------------------------------------------------------------

test("ett satt fält går före det härledda, och resten står kvar", async () => {
  const o = await overrides.satt("LP-TEST-0001", { title: "Strandmon, nytvättad klädsel", color: "Ljusgrå" }, "admin-1");
  const ut = overrides.tillampaPaProdukt(vara(), o);

  assert.equal(ut.title, "Strandmon, nytvättad klädsel");
  assert.equal(ut.color, "Ljusgrå");
  // Orörda fält får inte påverkas av att grannen rättades.
  assert.equal(ut.material, "Tyg");
  assert.equal(ut.brand, "IKEA");
  assert.equal(ut.dimensions.widthMm, 820);
});

test("null betyder uttryckligen tomt, inte osatt", async () => {
  const o = await overrides.satt("LP-TEST-0002", { color: null }, "admin-1");
  const ut = overrides.tillampaPaProdukt(vara({ id: "LP-TEST-0002" }), o);
  assert.equal(ut.color, null, "en admin som tömmer färgen ska få den tom, inte den härledda tillbaka");
  assert.equal(ut.material, "Tyg", "ett fält ingen rört ska fortfarande komma från besiktningen");
});

test("tom sträng läses som tomt — ett tömt formulärfält är ett beslut", async () => {
  const o = await overrides.satt("LP-TEST-0003", { model: "" }, "admin-1");
  assert.equal(o.model, null);
  assert.equal(overrides.tillampaPaProdukt(vara({ id: "LP-TEST-0003" }), o).model, null);
});

test("ett inskrivet mått är inte längre en uppskattning", async () => {
  const o = await overrides.satt("LP-TEST-0004", { widthMm: 790 }, "admin-1");
  const ut = overrides.tillampaPaProdukt(vara({ id: "LP-TEST-0004" }), o);
  assert.equal(ut.dimensions.widthMm, 790);
  assert.equal(
    ut.dimensions.estimated,
    false,
    'någon har mätt möbeln — kortet ska inte fortsätta skriva "ca" och måttfiltret ska våga lova plats',
  );
});

test("rättelsen ligger utanför jobbet och överlever att varan byggs om", async () => {
  await overrides.satt("LP-TEST-0005", { title: "Rättad rubrik" }, "admin-1");
  // Två skilda projektioner av samma jobb, som två varv i syncFromJobs.
  const forsta = overrides.tillampaPaProdukt(vara({ id: "LP-TEST-0005" }), await overrides.hamta("LP-TEST-0005"));
  const andra = overrides.tillampaPaProdukt(
    vara({ id: "LP-TEST-0005", title: "Ny titel ur en omräkning" }),
    await overrides.hamta("LP-TEST-0005"),
  );
  assert.equal(forsta.title, "Rättad rubrik");
  assert.equal(andra.title, "Rättad rubrik", "omräkningen får inte skriva över det en människa bestämt");
});

test("återställningen tar bort rättelsen helt", async () => {
  await overrides.satt("LP-TEST-0006", { title: "Tillfällig" }, "admin-1");
  assert.equal(await overrides.tabort("LP-TEST-0006"), true);
  assert.equal(await overrides.hamta("LP-TEST-0006"), null);
  assert.equal(overrides.tillampaPaProdukt(vara({ id: "LP-TEST-0006" }), null).title, "IKEA Strandmon fåtölj");
});

test("ett fält i taget går att lämna tillbaka — resten av rättelserna står kvar", async () => {
  const id = "LP-TEST-0007";
  await overrides.satt(id, { title: "Rättad rubrik", color: "Ljusgrå" }, "admin-1");

  const kvar = await overrides.taBortFalt(id, ["color"], "admin-2");
  const ut = overrides.tillampaPaProdukt(vara({ id }), kvar);
  assert.equal(ut.title, "Rättad rubrik", "rubriken skulle stå kvar");
  assert.equal(ut.color, "Beige", "färgen skulle följa besiktningen igen");
  assert.equal(kvar?.updatedBy, "admin-2", "spåret ska peka på den som ändrade sist");
});

test("uttryckligen tomt går att ångra — det är just den vägen som saknades", async () => {
  const id = "LP-TEST-0008";
  await overrides.satt(id, { color: null }, "admin-1");
  assert.equal(overrides.tillampaPaProdukt(vara({ id }), await overrides.hamta(id)).color, null);

  await overrides.taBortFalt(id, ["color"], "admin-1");
  assert.equal(overrides.tillampaPaProdukt(vara({ id }), await overrides.hamta(id)).color, "Beige");
});

test("en rättelse som inte rättar något längre försvinner", async () => {
  // Annars ligger en tom post kvar och märker annonsen "Rättad" i listan, utan att något är rättat.
  const id = "LP-TEST-0009";
  await overrides.satt(id, { model: "Strandmon" }, "admin-1");
  assert.equal(await overrides.taBortFalt(id, ["model"], "admin-1"), null);
  assert.equal(await overrides.hamta(id), null);
});

// ---------------------------------------------------------------------------
// Mätningen
// ---------------------------------------------------------------------------

test("händelserna hamnar i rätt hink", async () => {
  const id = "LP-MATT-0001";
  await analys.spara("annons_visning", id, {}, "avtryck-a");
  await analys.spara("annons_visning", id, {}, "avtryck-b");
  await analys.spara("view_item", id, {});
  await analys.spara("outbound_tradera", id, {});
  await analys.spara("begin_checkout", id, {});

  const s = await analys.statistikFor(id);
  assert.equal(s.visningar, 2);
  assert.equal(s.listvisningar, 1, "en exponering i ett rutnät är inte en sidvisning");
  assert.equal(s.utgaende, 1);
  assert.equal(s.kassor, 1);
  assert.equal(s.klick, 2, "allt som inte är en visning räknas som ett klick i tratten");
});

test("samma besökare inom fönstret räknas som en unik visning", async () => {
  const id = "LP-MATT-0002";
  await analys.spara("annons_visning", id, {}, "samma-avtryck");
  await analys.spara("annons_visning", id, {}, "samma-avtryck");
  await analys.spara("annons_visning", id, {}, "annat-avtryck");

  const s = await analys.statistikFor(id);
  assert.equal(s.visningar, 3, "varje hämtning är en visning");
  assert.equal(s.unikaVisningar, 2, "en omladdning är inte en ny människa");
});

test("egenskaper utanför vitlistan skrivs aldrig", async () => {
  const id = "LP-MATT-0003";
  await analys.spara("view_item", id, { item_id: id, epost: "kund@example.com", plats: "kort" });
  const rader = await analys.handelserFor(id);
  assert.equal(rader.length, 1);
  assert.equal(rader[0].props.plats, "kort");
  assert.equal(rader[0].props.item_id, id);
  assert.equal("epost" in rader[0].props, false, "en öppen mätväg får inte bli ett personregister");
});

test("händelser utan annons räknas för helheten och smetar inte på en möbel", async () => {
  await analys.spara("search", null, { q: "soffa" });
  const globalt = await analys.globalStatistik();
  assert.equal(globalt.search >= 1, true);
  const s = await analys.statistikFor("LP-MATT-0001");
  assert.equal(s.perHandelse.search, undefined);
});

test("vitlistan är den som avgör vad servern tar emot", () => {
  assert.equal(analys.KLIENTHANDELSER.has("view_item"), true);
  assert.equal(analys.KLIENTHANDELSER.has("annons_visning"), false, "en besökare får inte påstå en sidvisning");
  assert.equal(analys.SERVERHANDELSER.has("annons_visning"), true);
});

// ---------------------------------------------------------------------------
// Texten ut i kanalerna
// ---------------------------------------------------------------------------

/** Ett jobb med en färdig annonstext, tunt nog för det `medRattelser` faktiskt läser. */
function jobbMedText(id: string, plats: "result" | "listing" | "pendingListing") {
  const listing = {
    status: "ok",
    unavailableReason: null,
    result: {
      identity: { brand: "IKEA", exactProduct: "Strandmon", variant: null, category: null, confidence: "high", uncertain: false, uncertaintyNote: null },
      attributes: [],
      pricing: { retailPriceSek: null, suggestedPriceSek: null, priceRangeMinSek: null, priceRangeMaxSek: null, rationale: null },
      listing: { title: "Generatorns rubrik", description: "Generatorns text.", conditionText: "Gott skick" },
      sources: [],
    },
  };
  const job: Record<string, unknown> = { id, createdAt: new Date().toISOString(), progress: {}, result: null, error: null, productContext: null, identity: null };
  if (plats === "result") job.result = { createdAt: new Date().toISOString(), images: [], damages: [], listing };
  else job[plats] = listing;
  return job as never;
}

test("en rättad rubrik följer med ut i annonsen, inte bara in i panelen", async () => {
  const jobbId = "jobb-rattelse-1";
  await overrides.satt(loopaIdFor(jobbId), { title: "Strandmon, nytvättad", description: "Ny text." }, "admin-1");

  const ut = await overrides.medRattelser(jobbMedText(jobbId, "result"));
  const text = ut.result?.listing?.result?.listing;
  assert.equal(text?.title, "Strandmon, nytvättad");
  assert.equal(text?.description, "Ny text.");
  assert.equal(text?.conditionText, "Gott skick", "skicktexten är besiktningens och rättas inte här");
});

test("texten hittas även när annonsen ligger på jobbet i stället för i resultatet", async () => {
  const jobbId = "jobb-rattelse-2";
  await overrides.satt(loopaIdFor(jobbId), { title: "Rättad" }, "admin-1");
  const ut = await overrides.medRattelser(jobbMedText(jobbId, "pendingListing"));
  assert.equal(ut.pendingListing?.result?.listing.title, "Rättad");
});

test("kopian rör inte originalet — jobbet på disk ska förbli besiktningens", async () => {
  const jobbId = "jobb-rattelse-3";
  await overrides.satt(loopaIdFor(jobbId), { title: "Rättad" }, "admin-1");
  const original = jobbMedText(jobbId, "result");
  const kopia = await overrides.medRattelser(original);
  assert.notEqual(kopia, original);
  assert.equal(
    original.result?.listing?.result?.listing.title,
    "Generatorns rubrik",
    "en rättelse som muterar jobbet skrivs över vid nästa omräkning — och tystnar då",
  );
});

test("utan rättelse lämnas jobbet ifred, samma objekt tillbaka", async () => {
  const original = jobbMedText("jobb-utan-rattelse", "result");
  assert.equal(await overrides.medRattelser(original), original);
});
