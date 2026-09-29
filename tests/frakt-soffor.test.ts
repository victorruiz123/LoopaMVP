/**
 * Sofffrakten: 700 kr för soffor, 600 för allt annat (2026-09-29).
 *
 * Det som prövas är att talet följer MÖBELN hela vägen — kassan, leveransbeskedet och annonserna —
 * och att en annons som redan gått ut behåller det belopp som står i dess text och pris.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryQuote, fraktFor, zoneFor } from "../server/src/butik/delivery.js";
import { annonsensFrakt, prisMedHemleverans, SHIPPING_INCLUDED_SEK } from "../server/src/hemleverans.js";
import type { ConditionJob, TraderaPublication } from "../server/src/types.js";

test("soffor kostar 700 kr att leverera, allt annat 600", () => {
  assert.equal(fraktFor("soffor"), 700);
  assert.equal(fraktFor("fatoljer"), 600);
  assert.equal(fraktFor("bord"), 600);
  assert.equal(fraktFor(null), 600, "okänd kategori får grundpriset");
  assert.equal(SHIPPING_INCLUDED_SEK, 600);
});

test("leveransbeskedet och zonen bär möbelns avgift — samma tal i varje zon", () => {
  for (const pn of ["11223", "13145", "18732"]) {
    assert.equal(zoneFor(pn, "soffor")!.feeSek, 700, pn);
    assert.equal(zoneFor(pn)!.feeSek, 600, pn);
    assert.equal(deliveryQuote(pn, "soffor").zone!.feeSek, 700, pn);
  }
  assert.match(deliveryQuote("11223", "soffor").message, /700 kr/);
  // Tiden hänger på zonen, inte på kategorin.
  assert.equal(zoneFor("18732", "soffor")!.leadDays, zoneFor("18732")!.leadDays);
});

function pub(p: Partial<TraderaPublication>): TraderaPublication {
  return { status: "published", requestId: 1, itemId: 1, url: null, error: null, startedAt: "2026-09-01T00:00:00Z", publishedAt: "2026-09-01T00:00:00Z", ...p };
}

test("en ny sofffannons får 700 kr inbakat", () => {
  const job = {} as Pick<ConditionJob, "tradera" | "blocket">;
  assert.equal(annonsensFrakt(job, "soffor"), 700);
  assert.equal(prisMedHemleverans(1000, annonsensFrakt(job, "soffor")), 1700);
  // Väntar på godkännande = inte ute än, alltså ny taxa.
  assert.equal(annonsensFrakt({ tradera: pub({ status: "pending", itemId: null, publishedAt: null }) }, "soffor"), 700);
});

test("en soffa som redan ligger ute behåller 600 kr — prissänkningen lägger inte på mellanskillnaden", () => {
  assert.equal(annonsensFrakt({ tradera: pub({}) }, "soffor"), 600, "Tradera-annons från före fältet");
  assert.equal(
    annonsensFrakt({ blocket: { status: "published", url: null, receiptUrl: null, dryRun: false, error: null, startedAt: "", publishedAt: "", steps: [] } }, "soffor"),
    600,
    "Blocket-annons från före fältet",
  );
});

test("det sparade beloppet vinner, åt båda hållen", () => {
  assert.equal(annonsensFrakt({ tradera: pub({ shippingSek: 700 }) }, "soffor"), 700);
  assert.equal(annonsensFrakt({ tradera: pub({ shippingSek: 700 }) }, "bord"), 700, "kategorin ändrad efteråt — annonsen lovar fortfarande 700");
});
