// ─── Annonstexten som köparen får se ─────────────────────────────────────────
//
// Köparens annonssida CITERAR annonsen: bilden är säljarens, och stycket under den är säljarens ord.
// Två saker kan förstöra det citatet, och båda har hänt skarpt:
//
//   1. og:description är på många marknadsplatser butikens egen reklam, inte annonsen. Traderas
//      lyder "Utropspris: 500 kr. Typ: Auktion. Köp & sälj begagnade Soffor på Tradera." — noll ord
//      om möbeln, och under rubriken "Ur annonsen" ser den ut som något säljaren skrivit.
//   2. Maskningen läste auktionens sluttid som ett telefonnummer och lämnade "2[telefonnummer]
//      :26:14" i texten — både för köparens ögon och för modellen som ska läsa märket ur den.

import { test } from "node:test";
import assert from "node:assert/strict";

const { descriptionFrom } = await import("../server/src/affar/linkFetch.js");
const { maskPersonalData } = await import("../server/src/affar/state.js");

// ─── vilken text som väljs ──────────────────────────────────────────────────

const TRADERA_OG =
  '<meta property="og:description" content="Utropspris: 500 kr. Typ: Auktion. Slutar: 2026-09-05 20:26:14. K&ouml;p &amp; s&auml;lj begagnade &amp; oanv&auml;nda Soffor p&aring; Tradera.">';

test("säljarens egen text i JSON-LD slår marknadsplatsens og:description", () => {
  const nodes = [{ description: "Madison 3-sits soffa inköpt 2023, använd i cirka 2 år. Sedan magasinerad." }];
  assert.match(descriptionFrom(TRADERA_OG, nodes)!, /^Madison 3-sits soffa inköpt 2023/);
});

test("utan JSON-LD blir marknadsplatsens boilerplate ingen text alls", () => {
  // Hellre en annonssida utan stycke än butikens reklam citerad som säljarens ord.
  assert.equal(descriptionFrom(TRADERA_OG, []), null);
});

test("en riktig og:description används när JSON-LD saknas", () => {
  const html = '<meta property="og:description" content="Soffan är 220 cm bred och har avtagbar klädsel.">';
  assert.equal(descriptionFrom(html, []), "Soffan är 220 cm bred och har avtagbar klädsel.");
});

test("ett tomt JSON-LD-fält faller vidare i stället för att vinna", () => {
  const html = '<meta property="og:description" content="Soffan är 220 cm bred och har avtagbar klädsel.">';
  assert.equal(descriptionFrom(html, [{ description: "Soffa" }]), "Soffan är 220 cm bred och har avtagbar klädsel.");
});

// ─── maskningen ─────────────────────────────────────────────────────────────

test("auktionens sluttid är inget telefonnummer", () => {
  assert.equal(maskPersonalData("Slutar: 2026-09-05 20:26:14."), "Slutar: 2026-09-05 20:26:14.");
});

test("mått med fyra siffror maskas inte", () => {
  assert.equal(maskPersonalData("Bredd 2026 mm, höjd 850 mm"), "Bredd 2026 mm, höjd 850 mm");
});

test("riktiga nummer maskas fortfarande", () => {
  assert.equal(maskPersonalData("Ring 070-123 45 67 om du vill titta"), "Ring [telefonnummer] om du vill titta");
  assert.equal(maskPersonalData("Nå mig på 08-123 45 67"), "Nå mig på [telefonnummer]");
  assert.equal(maskPersonalData("maila isac@example.com"), "maila [e-post]");
});
