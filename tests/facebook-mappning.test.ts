// ─── Loopa-annonsen -> Facebook-texten ──────────────────────────────────────
//
// Det Facebook visar måste vara det produktsidan visar: samma titel, samma pris (möbelns, inte plus
// hemleverans), samma skicketikett, och länken tillbaka. Ingenting hittas på — uppskattade mått
// skrivs inte ut, och beskrivningen är generatorns egen, kapad.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbmap-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbmap-butik-"));
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
});

const { skrivJobb } = await import("./facebookFixtur.js");
const { facebookListingFor, marketplaceCopy, groupPostCopy, shortDescription, capTitle, canonicalListingUrl, marketplaceCategoryCandidates, marketplaceConditionCandidates, MAX_FACEBOOK_IMAGES, formatSek } =
  await import("../server/src/integrations/facebook/mapping.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const { prisMedHemleverans } = await import("../server/src/hemleverans.js");
const overrides = await import("../server/src/butik/overrides.js");

const JOBS = process.env.LOOPA_JOBS_DIR;

test("annonsen byggs ur produktsidans projektion: titel, möbelpris, skick, uppmätta mått, bilder, kanonisk adress", async () => {
  const job = skrivJobb(JOBS);
  const r = await facebookListingFor(job);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const l = r.listing;
  assert.equal(l.loopaId, loopaIdFor(job.id));
  assert.equal(l.price, 6500, "möbelns pris — produktsidans tal");
  assert.notEqual(l.price, prisMedHemleverans(6500, 700), "INTE Tradera/Blockets pris med hemleverans");
  assert.equal(l.conditionLabel, "Mycket gott skick");
  assert.equal(l.grade, "B");
  assert.equal(l.brand, "Sweef");
  assert.equal(l.categorySlug, "soffor");
  assert.deepEqual(l.dimensionsCm, { width: 230, depth: 98, height: 82 });
  assert.equal(l.imagePaths.length, 2);
  assert.ok(l.imagePaths[0].endsWith("img_0.jpg"), "omslaget först");
  assert.equal(l.canonicalUrl, `https://loopa.nu/butik/objekt/${l.loopaId}`);
  assert.equal(l.location, "Stockholm");
  assert.ok(!/Hämtas|Skickas ej/.test(l.description), "leverans- och fraktlöften ur en annan kanal tas bort");
  assert.ok(l.description.startsWith("Rymlig tresitssoffa"));
});

test("Marketplace-texten bär skick, pris, mått, uppmaningen och adressen — rubriken hålls under gränsen", async () => {
  const r = await facebookListingFor(skrivJobb(JOBS));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const copy = marketplaceCopy(r.listing);
  assert.ok(copy.title.length <= 99);
  assert.match(copy.description, /Skick: Mycket gott skick/);
  assert.match(copy.description, /Pris: 6.500 kr/);
  assert.match(copy.description, /Mått: B 230 × D 98 × H 82 cm/);
  assert.match(copy.description, /Köp möbeln och se fullständig information via Loopa:\nhttps:\/\/loopa\.nu\/butik\/objekt\/LP-/);
  assert.ok(!copy.description.includes("Hämtas"));
});

test("grupp-inlägget öppnar med rubrik och pris, och slutar med Loopa-länken", async () => {
  const r = await facebookListingFor(skrivJobb(JOBS));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const text = groupPostCopy(r.listing);
  const rader = text.split("\n");
  // Produktsidans titel (butik/normalize.ts titleOf), inte annonsgeneratorns rubrik: det är den sidan länken leder till.
  assert.match(rader[0], /^Sweef Cloud 3-sits soffa i grå sammet säljes – 6.500 kr$/);
  assert.match(text, /Skick: Mycket gott skick/);
  assert.match(text, /Fler bilder och köp via Loopa:\nhttps:\/\/loopa\.nu\/butik\/objekt\//);
  assert.ok(!/\n{3,}/.test(text), "inga tredubbla radbrytningar");
});

// ─── produktion (2026-09-27): Facebook är distribution ENDAST — köpet sker på Loopa ───────
//
// Tradera och Blocket äger sin egen transaktion och länkar därför till den köpfria infosidan
// (/butik/info/<id>, se adContent.ts). Facebook har ingen kassa alls: annonsen MÅSTE peka på den
// köpbara produktsidan (/butik/objekt/<id>), annars finns ingen väg från Facebook till ett köp.
test("Facebook-beskrivningen pekar på den KÖPBARA produktsidan (objekt/<id>) — Marketplace och grupp-säljinlägget likadant, för samma annons", async () => {
  const job = skrivJobb(JOBS, { id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" });
  const loopaId = loopaIdFor(job.id);
  const r = await facebookListingFor(job);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const kanoniskAdress = `https://loopa.nu/butik/objekt/${loopaId}`;
  assert.equal(r.listing.canonicalUrl, kanoniskAdress);

  const mp = marketplaceCopy(r.listing);
  assert.ok(mp.description.includes(kanoniskAdress), "Marketplace-beskrivningen bär den exakta produktadressen");

  const grupp = groupPostCopy(r.listing);
  assert.ok(grupp.includes(kanoniskAdress), "grupp-textinlägget bär SAMMA adress som Marketplace");

  // "Sälj något" i en grupp återanvänder Marketplace-texten rakt av (mapping.ts, groupListingCopy) —
  // samma skäl som Marketplace: inget textfält, inget köp möjligt utom via länken.
  const { groupListingCopy } = await import("../server/src/integrations/facebook/mapping.js");
  assert.deepEqual(groupListingCopy(r.listing), mp, "säljinlägget i grupper är exakt Marketplace-texten");

  // Aldrig Tradera/Blockets infosida (utan köpruta) — den adressen duger inte här, det finns ingen kassa att skicka köparen till.
  assert.ok(!mp.description.includes("/butik/info/"), "Facebook länkar aldrig till den köpfria infosidan");
  assert.ok(!grupp.includes("/butik/info/"));
});

test("uppskattade mått skrivs inte ut, saknat skick skrivs inte ut", async () => {
  const r1 = await facebookListingFor(skrivJobb(JOBS, { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", estimatedDimensions: true }));
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.listing.dimensionsCm, null);
    assert.ok(!marketplaceCopy(r1.listing).description.includes("Mått:"));
  }
  // Ett jobb utan betyg är ingen butiksvara alls (butik/normalize.ts conditionOf) — det kan inte ligga live,
  // och därför inte heller distribueras. Samma grind som rutnätet.
  const r2 = await facebookListingFor(skrivJobb(JOBS, { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee0", grade: null }));
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.reason, /inte en butiksvara/);
});

test("utan pris eller utan bilder finns ingen annons att lägga ut — med samma ord som de andra kanalerna", async () => {
  const utanPris = await facebookListingFor(skrivJobb(JOBS, { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1", price: null }));
  assert.equal(utanPris.ok, false);
  if (!utanPris.ok) assert.match(utanPris.reason, /inget pris/i);
  const utanBilder = await facebookListingFor(skrivJobb(JOBS, { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2", images: 0 }));
  assert.equal(utanBilder.ok, false);
  if (!utanBilder.ok) assert.match(utanBilder.reason, /inga bilder/i);
});

test("adminens rättelse av rubriken går ut på Facebook — samma rubrik som produktsidan", async () => {
  const job = skrivJobb(JOBS, { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3" });
  await overrides.satt(loopaIdFor(job.id), { title: "Sweef Cloud, nyrengjord" }, "admin-1");
  const r = await facebookListingFor(job);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.listing.title, "Sweef Cloud, nyrengjord");
});

test("hjälparna: kapning vid ordslut, kort beskrivning vid meningsslut, adress, kandidater", () => {
  const lång = "Ett mycket långt ord ".repeat(10);
  const kapad = capTitle(lång, 40);
  assert.ok(kapad.length <= 40);
  assert.ok(!kapad.endsWith(" "));
  assert.ok(!/\S+$/.test(kapad) || lång.includes(kapad.split(" ").at(-1)!), "slutar på ett helt ord");

  const kort = shortDescription("Första meningen. Andra meningen som är längre. Hämtas på Södermalm. Tredje meningen.", 60);
  assert.equal(kort, "Första meningen. Andra meningen som är längre.");
  assert.equal(shortDescription("   "), "");

  assert.equal(canonicalListingUrl("LP-ABCD-1234"), "https://loopa.nu/butik/objekt/LP-ABCD-1234");
  // Verifierat 2026-09-25: Marketplace har inga möbelunderkategorier — "Möbler" är lövet för allt.
  assert.deepEqual(marketplaceCategoryCandidates("soffor").slice(0, 1), ["Möbler"]);
  assert.ok(marketplaceCategoryCandidates("belysning").includes("Möbler"), "det breda men aldrig felaktiga valet står med som reserv");
  assert.deepEqual(marketplaceCategoryCandidates("okänd"), marketplaceCategoryCandidates("ovrigt"));
  assert.equal(marketplaceConditionCandidates("A")[0], "Använd – nyskick", "A blir aldrig Nytt");
  assert.equal(marketplaceConditionCandidates("B")[0], "Använd – i gott skick", "B är inte nyskick");
  assert.equal(marketplaceConditionCandidates("F")[0], "Använd – i använt skick");
  assert.deepEqual(marketplaceConditionCandidates(null), []);
  assert.equal(MAX_FACEBOOK_IMAGES, 10);
  assert.match(formatSek(6500), /^6.500 kr$/);
});
