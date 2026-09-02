// ─── Trygg affär: affärsrummets tillståndsmaskin ────────────────────────────
//
// Två parter tittar på samma affär samtidigt, och en av dem har alltid något att förlora på att den
// andra hann först. Testerna nedan låser fast det som gör den situationen ofarlig — och de två
// reglerna som håller affären privat, som är hela skälet att den inte får bete sig som en annons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AFFAR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-affar-test-"));
process.on("exit", () => rmSync(process.env.AFFAR_DATA_DIR!, { recursive: true, force: true }));

const { createDeal, move, store, sweepExpired, purgeSubmissionMedia } = await import("../server/src/affar/store.js");
const { canTransition, ALLOWED_TRANSITIONS, TERMINAL, CANCELLABLE, MAX_COUNTER_ROUNDS } = await import("../server/src/affar/types.js");
const { makeInviteToken, maskPersonalData, expiryFor, hasExpired, mayCounter, TransitionError, makeEvent } =
  await import("../server/src/affar/state.js");

const buyer = { kind: "buyer", userId: "k1" } as const;
const seller = { kind: "seller", userId: "s1" } as const;

const newDeal = () => createDeal({ buyerId: "k1", buyerEmail: "k@x.se", buyerPostalCode: "11223" });

// ─── vägen genom affären ────────────────────────────────────────────────────

test("övergångstabellen tillåter bara det den räknar upp", () => {
  assert.equal(canTransition("created", "invited"), true);
  assert.equal(canTransition("invited", "seller_joined"), true);
  assert.equal(canTransition("delivered", "approved"), true);
  // Det som INTE får gå:
  assert.equal(canTransition("created", "paid"), false, "man kan inte betala för en affär ingen tackat ja till");
  assert.equal(canTransition("invited", "scanned"), false, "säljaren måste gå med innan de kan filma");
  assert.equal(canTransition("paid_out", "declined"), false);
  assert.deepEqual(ALLOWED_TRANSITIONS.paid_out, [], "utbetald är slutstation");
});

test("efter betalningen går affären inte att avbryta — då är det en tvist", () => {
  // Att ångra sig är gratis så länge inga pengar rört sig. Efteråt är det ops sak.
  for (const s of CANCELLABLE) assert.equal(canTransition(s, "declined"), true, `${s} ska gå att avbryta`);
  for (const s of ["paid", "pickup_booked", "picked_up", "delivered", "approved"] as const) {
    assert.equal(canTransition(s, "declined"), false, `${s} ska INTE gå att avbryta`);
    assert.equal(canTransition(s, "expired"), false, `${s} ska inte kunna löpa ut`);
  }
});

test("makeEvent vägrar bygga en händelse för en omöjlig övergång", () => {
  assert.throws(() => makeEvent("d1", "paid_out", "created", buyer), TransitionError);
});

test("hela vägen fram, och varje steg i huvudboken", async () => {
  const d = await newDeal();
  const steps: Array<[string[], string]> = [
    [["created"], "invited"], [["invited"], "seller_joined"], [["seller_joined"], "scanned"],
    [["scanned"], "price_pending"], [["price_pending"], "price_agreed"], [["price_agreed"], "paid"],
    [["paid"], "pickup_booked"], [["pickup_booked"], "picked_up"], [["picked_up"], "delivered"],
    [["delivered"], "approved"], [["approved"], "paid_out"],
  ];
  for (const [from, to] of steps) {
    assert.ok(await move(d.id, from as never, to as never, buyer, `-> ${to}`), `fastnade på ${to}`);
  }
  const log = await store().events(d.id);
  assert.equal(log.length, steps.length + 1, "skapandet plus varje övergång");
  assert.equal(log.at(-1)!.to, "paid_out");
});

test("ETT accepterande vinner när båda trycker samtidigt", async () => {
  // Det verkliga fallet: prisförslaget ligger ute och båda parter godkänner i samma sekund.
  const d = await newDeal();
  await move(d.id, ["created"], "invited", buyer, "");
  await move(d.id, ["invited"], "seller_joined", seller, "");
  await move(d.id, ["seller_joined"], "scanned", seller, "");
  await move(d.id, ["scanned"], "price_pending", seller, "");

  const both = await Promise.all([
    move(d.id, ["price_pending"], "price_agreed", buyer, "köparen accepterade"),
    move(d.id, ["price_pending"], "price_agreed", seller, "säljaren accepterade"),
  ]);
  assert.equal(both.filter(Boolean).length, 1, "exakt en övergång får gå igenom");
  assert.equal((await store().get(d.id))!.state, "price_agreed");
  assert.equal((await store().events(d.id)).filter((e) => e.to === "price_agreed").length, 1);
});

// ─── klockan ────────────────────────────────────────────────────────────────

test("bara lägen där någon ANNAN förväntas svara har en klocka", () => {
  assert.ok(expiryFor("invited"), "inbjudan går ut");
  assert.ok(expiryFor("price_pending"), "ett obesvarat pris går ut");
  assert.equal(expiryFor("paid"), null, "en betald affär dör inte för att budfirman är sen");
  assert.equal(expiryFor("picked_up"), null);
});

test("inbjudan går ut efter sju dagar, prisförslaget efter 72 timmar", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  assert.equal(expiryFor("invited", now), new Date("2026-09-08T12:00:00Z").toISOString());
  assert.equal(expiryFor("price_pending", now), new Date("2026-09-04T12:00:00Z").toISOString());
});

test("klockan ställs om vid varje steg — annars dör affären mitt i en skanning", async () => {
  const d = await newDeal();
  const invited = (await move(d.id, ["created"], "invited", buyer, ""))!;
  assert.ok(invited.expiresAt, "inbjudan har en klocka");
  const joined = (await move(d.id, ["invited"], "seller_joined", seller, ""))!;
  assert.equal(joined.expiresAt, null, "inbjudans utgångsdatum ska inte följa med in i nästa läge");
});

test("städningen tar bara affärer vars tid faktiskt gått ut", async () => {
  const dead = await newDeal();
  await move(dead.id, ["created"], "invited", buyer, "");
  const live = await newDeal();
  await move(live.id, ["created"], "invited", buyer, "");

  // Backdatera den enas klocka: inbjudan skickades för åtta dagar sedan.
  const rec = (await store().get(dead.id))!;
  await store().put({ ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() });

  const expired = await sweepExpired();
  assert.deepEqual(expired.map((d) => d.id), [dead.id]);
  assert.equal((await store().get(live.id))!.state, "invited", "den andra rörs inte");
});

test("hasExpired säger nej om slutlägen, hur gammal klockan än är", () => {
  const base = { expiresAt: new Date(Date.now() - 99999).toISOString() } as never;
  for (const state of TERMINAL) {
    assert.equal(hasExpired({ ...(base as object), state } as never), false, `${state} kan inte löpa ut igen`);
  }
});

// ─── inbjudan ───────────────────────────────────────────────────────────────

test("inbjudningslänken går inte att gissa och inte att läsa fel", () => {
  const tokens = new Set(Array.from({ length: 500 }, () => makeInviteToken()));
  assert.equal(tokens.size, 500, "inga kollisioner");
  const one = makeInviteToken();
  assert.ok(one.length >= 24, "kort nog att läsa högt, långt nog att inte gissa");
  assert.ok(!/[0O1lI]/.test(one), "inga tecken som blandas ihop när någon skriver av länken");
});

// ─── prisrundan ─────────────────────────────────────────────────────────────

test("ett motbud, inte en förhandling", () => {
  const deal = { counterRounds: 0 } as never;
  assert.equal(mayCounter(deal), true);
  assert.equal(mayCounter({ counterRounds: MAX_COUNTER_ROUNDS } as never), false);
});

// ─── personuppgifter ────────────────────────────────────────────────────────

test("telefonnummer, mejl och personnummer maskas FÖRE lagring", () => {
  const raw = "Säljes av Anna. Ring 070-123 45 67 eller anna.b@example.com. Pnr 900101-1234.";
  const masked = maskPersonalData(raw)!;
  assert.ok(!/070/.test(masked), "telefonnumret ska bort");
  assert.ok(!/example\.com/.test(masked), "mejladressen ska bort");
  assert.ok(!/900101/.test(masked), "personnumret ska bort");
  assert.match(masked, /Säljes av Anna/, "resten av texten står kvar");
});

test("maskningen tål landsnummer och mellanslag", () => {
  assert.ok(!/\d{6}/.test(maskPersonalData("Kontakt: +46 70 123 45 67")!));
  assert.equal(maskPersonalData(null), null);
});

test("bilderna städas men slutsatsen står kvar", async () => {
  const d = await newDeal();
  await store().put({
    ...d,
    submission: { source: "MANUAL_CONTENT", adUrl: "https://blocket.se/x", imagePaths: ["a.jpg", "b.jpg"], description: "Fin soffa", askingPriceSek: 4500, submittedAt: new Date().toISOString() },
    assessment: { brand: "IKEA", model: "Ektorp", categorySlug: "soffor-fatoljer", grade: "C", gradeNote: "n", observations: [], confidence: "low", marketLowSek: 3600, marketHighSek: 4200, questions: [], redFlags: [], assessedAt: new Date().toISOString() },
  });
  await purgeSubmissionMedia(d.id);
  const after = (await store().get(d.id))!;
  assert.deepEqual(after.submission!.imagePaths, [], "annonsens bilder är borta");
  assert.equal(after.assessment!.brand, "IKEA", "vår egen slutsats är kvar — den är affärens underlag");
  assert.equal(after.submission!.askingPriceSek, 4500, "det begärda priset är en uppgift om affären, inte om annonsen");
});
