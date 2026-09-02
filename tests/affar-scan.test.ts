// ─── Säljarens skanning: förifyllning, medlemskap, verifierat kort ──────────
//
// Två saker låses fast här. Att säljaren får hjälp med IDENTIFIERINGEN men aldrig ser vår gissning
// om skicket innan de filmat — och att en skanning bara kan knytas till en affär av dess egen
// säljare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AFFAR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-scan-test-"));
process.on("exit", () => rmSync(process.env.AFFAR_DATA_DIR!, { recursive: true, force: true }));

const { createDeal, move, store } = await import("../server/src/affar/store.js");
const { prefillFor, joinAsSeller, attachScan } = await import("../server/src/affar/scan.js");
import type { Deal } from "../server/src/affar/types.js";

/** En affär med full bedömning — allt vi vet om annonsen. */
async function dealWithAssessment(): Promise<Deal> {
  const d = await createDeal({ buyerId: "kopare", buyerEmail: "k@x.se", buyerPostalCode: "11223" });
  const full: Deal = {
    ...d,
    submission: {
      source: "MANUAL_CONTENT", adUrl: "https://blocket.se/x", imagePaths: ["a.jpg"],
      description: "Fin soffa, lite slitage på armstödet.", askingPriceSek: 4500,
      submittedAt: new Date().toISOString(),
    },
    assessment: {
      brand: "IKEA", model: "EKTORP", categorySlug: "soffor-fatoljer", categoryNoun: "soffa",
      grade: "C", gradeNote: "Ser sliten ut på bilderna.",
      observations: ["Fläck på höger armstöd", "Nedsutten sits"],
      confidence: "medium", marketLowSek: 1200, marketHighSek: 2000,
      questions: ["Finns det fler skador?"],
      redFlags: ["Priset är påfallande lågt"],
      assessedAt: new Date().toISOString(),
    },
  };
  await store().put(full);
  return full;
}

// ─── förifyllningen ─────────────────────────────────────────────────────────

test("säljaren får identifieringen — det de redan skrivit i sin egen annons", async () => {
  const deal = await dealWithAssessment();
  const p = prefillFor(deal);
  assert.equal(p.brand, "IKEA");
  assert.equal(p.model, "EKTORP");
  assert.equal(p.categoryNoun, "soffa");
  assert.equal(p.askingPriceSek, 4500);
  assert.equal(p.descriptionDraft, "Fin soffa, lite slitage på armstödet.");
});

test("säljaren får ALDRIG vår gissning om skicket före sin egen skanning", async () => {
  // Den viktigaste raden i filen. Säljaren ska filma sin möbel utan att först ha läst vad vi trodde
  // om den — och köparens prisunderlag är köparens, inte något säljaren ska förhandla emot.
  const deal = await dealWithAssessment();
  const p = prefillFor(deal) as Record<string, unknown>;
  const leaked = JSON.stringify(p);

  assert.ok(!("grade" in p), "inget uppskattat betyg");
  assert.ok(!("observations" in p), "inga iakttagelser");
  assert.ok(!("redFlags" in p), "inga varningsflaggor");
  assert.ok(!("marketLowSek" in p) && !("marketHighSek" in p), "inget marknadsspann");
  assert.ok(!/Fläck på höger armstöd/.test(leaked), "iakttagelsen får inte läcka via något fält");
  assert.ok(!/påfallande lågt/.test(leaked), "varningen får inte läcka");
  assert.ok(!/1200|2000/.test(leaked), "prisspannet får inte läcka");
});

test("förifyllningen klarar en affär utan bedömning", async () => {
  const bare = await createDeal({ buyerId: "k", buyerEmail: null, buyerPostalCode: "11223" });
  assert.deepEqual(prefillFor(bare), {
    brand: null, model: null, categoryNoun: null, askingPriceSek: null, descriptionDraft: null,
  });
});

// ─── att gå med ─────────────────────────────────────────────────────────────

test("säljaren går med med sitt konto, och tillståndet flyttas", async () => {
  const deal = await dealWithAssessment();
  await move(deal.id, ["created"], "invited", { kind: "buyer", userId: "kopare" }, "");
  const out = await joinAsSeller(deal.inviteToken, "saljare", "s@x.se");
  assert.ok(!("error" in out));
  assert.equal(out.deal.state, "seller_joined");
  assert.equal(out.deal.sellerId, "saljare");
  assert.ok(out.prefill.brand, "förifyllningen följer med direkt");
});

test("köparen kan inte sälja till sig själv", async () => {
  const deal = await dealWithAssessment();
  await move(deal.id, ["created"], "invited", { kind: "buyer", userId: "kopare" }, "");
  const out = await joinAsSeller(deal.inviteToken, "kopare", "k@x.se");
  assert.ok("error" in out && out.status === 409);
});

test("en andra säljare kan inte ta en affär som redan har en", async () => {
  const deal = await dealWithAssessment();
  await move(deal.id, ["created"], "invited", { kind: "buyer", userId: "kopare" }, "");
  assert.ok(!("error" in (await joinAsSeller(deal.inviteToken, "saljare-1", null))));
  const second = await joinAsSeller(deal.inviteToken, "saljare-2", null);
  assert.ok("error" in second && second.status === 409);
});

test("att ladda om sidan är inte att gå med igen", async () => {
  const deal = await dealWithAssessment();
  await move(deal.id, ["created"], "invited", { kind: "buyer", userId: "kopare" }, "");
  await joinAsSeller(deal.inviteToken, "saljare", null);
  const again = await joinAsSeller(deal.inviteToken, "saljare", null);
  assert.ok(!("error" in again), "samma säljare igen ska bara få affären tillbaka");
  assert.equal((await store().events(deal.id)).filter((e) => e.to === "seller_joined").length, 1,
    "medlemskapet ska loggas EN gång — måttet inbjudan → säljaren med räknar på det");
});

test("en okänd token går inte att gå med i", async () => {
  const out = await joinAsSeller("finns-inte-alls", "nagon", null);
  assert.ok("error" in out && out.status === 404);
});

// ─── skanningen knyts till affären ──────────────────────────────────────────

test("bara affärens egen säljare kan knyta en skanning till den", async () => {
  const deal = await dealWithAssessment();
  await move(deal.id, ["created"], "invited", { kind: "buyer", userId: "kopare" }, "");
  await joinAsSeller(deal.inviteToken, "saljare", null);

  await attachScan(deal.id, "jobb-fran-framling", "en-framling");
  assert.equal((await store().get(deal.id))!.scanJobId, null, "en främling ska inte kunna hänga sitt jobb här");

  await attachScan(deal.id, "jobb-fran-saljaren", "saljare");
  assert.equal((await store().get(deal.id))!.scanJobId, "jobb-fran-saljaren");
});
