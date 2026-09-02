// ─── Prisbekräftelsen ───────────────────────────────────────────────────────
//
// Två parter, ett belopp, och en runda motbud. Testerna nedan låser fast tre saker som var för sig
// avgör om affären känns rättvis: att Loopa lägger första budet, att vi inte sänker utan en angiven
// orsak, och att ett ja gäller ett TAL — inte en affär.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AFFAR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-pris-test-"));
process.on("exit", () => rmSync(process.env.AFFAR_DATA_DIR!, { recursive: true, force: true }));

const { createDeal, move, store } = await import("../server/src/affar/store.js");
const { openingProposal, acceptPrice, counterPrice, declineDeal, actionsFor, PriceError } =
  await import("../server/src/affar/price.js");
import type { Deal } from "../server/src/affar/types.js";
import type { VerifiedCard } from "../server/src/affar/scan.js";

const card = (over: Partial<VerifiedCard> = {}): VerifiedCard => ({
  jobId: "j", loopaId: "LP-X", brand: "IKEA", model: "EKTORP",
  grade: "C", gradeLabel: "Gott skick", gradeRationale: "R",
  defects: [], measurements: [], suggestedPriceSek: 1200,
  imageCount: 6, reviewed: true, inspectedAt: "2026-09-01T10:00:00Z",
  ...over,
});

function dealWith(over: Partial<Deal> = {}): Deal {
  return {
    id: "d", inviteToken: "t", state: "price_pending",
    buyerId: "k", buyerEmail: null, sellerId: "s", sellerEmail: null,
    submission: { source: "MANUAL_CONTENT", adUrl: null, imagePaths: [], description: null, askingPriceSek: 1500, submittedAt: "" },
    assessment: null, scanJobId: "j", proposals: [], awaiting: null, acceptedBy: [],
    counterRounds: 0, agreedPriceSek: null, buyerPostalCode: "11223", sellerPostalCode: null,
    orderId: null, createdAt: "", updatedAt: "", expiresAt: null, reminderSent: false,
    ...over,
  } as Deal;
}

/** En riktig affär i lagret, i prisläge. */
async function livePriceRound(): Promise<Deal> {
  const d = await createDeal({ buyerId: "k", buyerEmail: null, buyerPostalCode: "11223" });
  await store().put({ ...d, sellerId: "s", scanJobId: "j",
    proposals: [{ amountSek: 1500, by: "loopa", at: new Date().toISOString(), rationale: "r" }] });
  for (const [from, to] of [["created", "invited"], ["invited", "seller_joined"], ["seller_joined", "scanned"], ["scanned", "price_pending"]] as const) {
    await move(d.id, [from], to, { kind: "system", job: "test" }, "");
  }
  return (await store().get(d.id))!;
}

// ─── utgångsbudet ───────────────────────────────────────────────────────────

test("granskningen hittade något nytt — då sänks priset MED ANGIVEN ORSAK", () => {
  const ctx = openingProposal(
    dealWith({ assessment: { observations: [] } as never }),
    card({ suggestedPriceSek: 1200, defects: [{ id: "1", part: "sitsen", description: "nedtryckt stoppning", severity: "S2" }] }),
  );
  assert.equal(ctx.amountSek, 1200);
  assert.equal(ctx.deltaFromAskingSek, -300);
  assert.match(ctx.rationale, /AI-granskningen hittade nedtryckt stoppning/);
  assert.match(ctx.rationale, /−300 kr/);
});

test("granskningen bekräftade annonsen — då sänker vi INTE, hur lågt motorn än räknar", () => {
  // Den viktigaste regeln i filen. Säljaren satte sitt pris med kunskap om sin egen möbel, och en
  // sänkning som bara grundas på att motorn räknat lägre är ett prut utan orsak — precis det
  // Trygg affär ska ta bort.
  const ctx = openingProposal(dealWith(), card({ suggestedPriceSek: 900, defects: [] }));
  assert.equal(ctx.amountSek, 1500, "det begärda priset står kvar");
  assert.equal(ctx.deltaFromAskingSek, 0);
  assert.match(ctx.rationale, /bekräftade annonsen/);
});

test("ett fynd på en del köparen REDAN sett räknas inte som nytt", () => {
  const known = dealWith({
    assessment: { observations: ["Fläck på höger armstöd syns i bilderna"] } as never,
  });
  const ctx = openingProposal(known, card({ suggestedPriceSek: 1200, defects: [{ id: "1", part: "armstöd", description: "fläck", severity: "S2" }] }));
  assert.deepEqual(ctx.newFindings, [], "armstödet var redan känt");
  assert.equal(ctx.amountSek, 1500, "inget nytt -> ingen sänkning");
});

test("värderas möbeln högre än begärt höjer vi inte åt någon", () => {
  const ctx = openingProposal(dealWith(), card({ suggestedPriceSek: 2500 }));
  assert.equal(ctx.amountSek, 1500, "säljarens pris står kvar");
  assert.equal(ctx.deltaFromAskingSek, 0);
});

test("utan värdering blir det begärda priset budet, och det sägs rakt ut", () => {
  const ctx = openingProposal(dealWith(), card({ suggestedPriceSek: null }));
  assert.equal(ctx.amountSek, 1500);
  assert.match(ctx.rationale, /kunde inte värdera/);
});

// ─── accepterandet ──────────────────────────────────────────────────────────

test("ETT ja räcker inte — båda måste acceptera samma belopp", async () => {
  const deal = await livePriceRound();
  const after = await acceptPrice(deal, "buyer");
  assert.equal(after.state, "price_pending", "affären står kvar tills båda sagt ja");
  assert.deepEqual(after.acceptedBy, ["buyer"]);
  assert.equal(after.awaiting, "seller");
  assert.equal(after.agreedPriceSek, null);

  const locked = await acceptPrice(after, "seller");
  assert.equal(locked.state, "price_agreed");
  assert.equal(locked.agreedPriceSek, 1500, "priset låses vid det belopp båda accepterat");
  assert.equal(locked.awaiting, null);
});

test("samma part som accepterar två gånger låser ingenting", async () => {
  const deal = await livePriceRound();
  const once = await acceptPrice(deal, "buyer");
  const twice = await acceptPrice(once, "buyer");
  assert.equal(twice.state, "price_pending");
  assert.deepEqual(twice.acceptedBy, ["buyer"], "ingen dubblett, och ingen låsning");
});

// ─── motbudet ───────────────────────────────────────────────────────────────

test("ett motbud nollställer tidigare ja — ett ja gäller ett TAL", async () => {
  // Utan nollställningen skulle köparens ja till Loopas 1 500 räknas som ett ja till säljarens
  // motbud på 1 800. Det är att låsa ett pris ingen sagt ja till.
  const deal = await livePriceRound();
  const accepted = await acceptPrice(deal, "buyer");
  assert.deepEqual(accepted.acceptedBy, ["buyer"]);

  const countered = await counterPrice(accepted, "seller", 1800);
  assert.deepEqual(countered.acceptedBy, ["seller"], "bara den som bjöd står som accepterande");
  assert.equal(countered.awaiting, "buyer");
  assert.equal(countered.proposals.at(-1)!.amountSek, 1800);
  assert.equal(countered.state, "price_pending");

  const locked = await acceptPrice(countered, "buyer");
  assert.equal(locked.state, "price_agreed");
  assert.equal(locked.agreedPriceSek, 1800, "det NYA beloppet låses, inte det gamla");
});

test("en runda motbud, sedan är det ja eller nej", async () => {
  const deal = await livePriceRound();
  const first = await counterPrice(deal, "seller", 1800);
  await assert.rejects(() => counterPrice(first, "buyer", 1600), PriceError);
  const actions = actionsFor(first, "buyer");
  assert.equal(actions.canCounter, false, "knappen ska vara borta, inte bara anropet avvisat");
  assert.equal(actions.canAccept, true);
  assert.equal(actions.canDecline, true);
});

test("orimliga motbud avvisas", async () => {
  const deal = await livePriceRound();
  for (const bad of [0, -100, 9_000_000, Number.NaN]) {
    await assert.rejects(() => counterPrice(deal, "buyer", bad), PriceError, `${bad} skulle ha avvisats`);
  }
});

test("den som redan accepterat kan inte lägga ett motbud", async () => {
  const deal = await livePriceRound();
  const accepted = await acceptPrice(deal, "buyer");
  assert.equal(actionsFor(accepted, "buyer").canCounter, false);
});

// ─── att tacka nej ──────────────────────────────────────────────────────────

test("vem som helst av parterna kan tacka nej, och då är affären slut", async () => {
  const deal = await livePriceRound();
  const done = await declineDeal(deal, "seller");
  assert.equal(done.state, "declined");
  await assert.rejects(() => acceptPrice(done, "buyer"), PriceError, "en avslutad affär går inte att acceptera");
});

test("varje steg i prisrundan står i huvudboken", async () => {
  const deal = await livePriceRound();
  const a = await acceptPrice(deal, "buyer");
  const b = await counterPrice(a, "seller", 1800);
  await acceptPrice(b, "buyer");
  // Tusenavskiljaren är ett HÅRT mellanslag (U+00A0) ur toLocaleString("sv-SE"). `\s` matchar det;
  // ett vanligt mellanslag gör det inte.
  const log = (await store().events(deal.id)).map((e) => e.note);
  assert.ok(log.some((n) => /Köparen accepterade 1\s?500 kr/.test(n ?? "")), "köparens ja saknas i loggen");
  assert.ok(log.some((n) => /Säljaren lade ett motbud: 1\s?800 kr/.test(n ?? "")), "motbudet saknas");
  assert.ok(log.some((n) => /Båda har accepterat 1\s?800 kr/.test(n ?? "")), "låsningen saknas");
});
