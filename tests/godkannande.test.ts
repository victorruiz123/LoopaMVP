// ─── Godkännandesteget: "Sälj med Loopa" är en beställning, inte en publicering ─────────────────
//
// Säljarens tryck ställer annonsen i kö. Det som får möbeln att ligga ute — i Butiken och på
// Tradera — är adminens godkännande. Två saker måste hålla:
//
// KÖN SYNS. Ett jobb med `tradera.status === "pending"` ska läsas som "väntar" i panelen, även när
// det redan finns som utkast i lagret — det är i första hand något som väntar på oss.
//
// BUTIKEN LYDER GODKÄNNANDET, INTE TRADERA. `godkand()` är det butiken läser. Ett Tradera-fel efter
// godkännandet tar inte ner möbeln, och en annons publicerad före steget fanns räknas som godkänd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-godkann-test-"));
process.env.ANALYS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-godkann-analys-"));
process.on("exit", () => {
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.ANALYS_DATA_DIR!, { recursive: true, force: true });
});

const { lageAv } = await import("../server/src/adminAnnonser.js");
const { godkand } = await import("../server/src/integrations/tradera/publish.js");
import type { ConditionJob, TraderaPublication } from "../server/src/types.js";
import type { ButikRecord } from "../server/src/butik/store.js";

function pub(patch: Partial<TraderaPublication>): TraderaPublication {
  return {
    status: "pending",
    requestId: null,
    itemId: null,
    url: null,
    error: null,
    startedAt: "2026-09-07T10:00:00.000Z",
    publishedAt: null,
    approvedAt: null,
    approvedBy: null,
    ...patch,
  };
}

function jobb(patch: Partial<ConditionJob>): ConditionJob {
  return { id: "job-1", createdAt: "2026-09-07T09:00:00.000Z", error: null, result: {} as never, ...patch } as ConditionJob;
}

function post(state: ButikRecord["state"]): ButikRecord {
  return {
    id: "LP-TEST-0001",
    source: "loopa",
    jobId: "job-1",
    state,
    reservedUntil: null,
    reservationToken: null,
    reservedPriceSek: null,
    listedAt: "2026-09-07T09:00:00.000Z",
    soldAt: null,
    soldChannel: null,
    traderaItemId: null,
    updatedAt: "2026-09-07T09:00:00.000Z",
  };
}

test("ett tryck på Sälj med Loopa läses som 'väntar' i panelen", () => {
  assert.equal(lageAv(jobb({ tradera: pub({}) }), undefined), "vantar");
});

test("väntar går före utkast — möbeln kan redan finnas i lagret", () => {
  assert.equal(lageAv(jobb({ tradera: pub({}) }), post("draft")), "vantar");
});

test("men aldrig före en affär som pågår", () => {
  assert.equal(lageAv(jobb({ tradera: pub({}) }), post("live")), "live");
  assert.equal(lageAv(jobb({ tradera: pub({}) }), post("sold")), "sald");
});

test("utan tryck är ett jobb med resultat fortfarande 'utan annons'", () => {
  assert.equal(lageAv(jobb({}), undefined), "utan-annons");
});

test("butiken lyder godkännandet, inte Traderas svar", () => {
  assert.equal(godkand(jobb({})), false, "aldrig tryckt");
  assert.equal(godkand(jobb({ tradera: pub({}) })), false, "väntar");
  assert.equal(godkand(jobb({ tradera: pub({ status: "publishing", approvedAt: "2026-09-07T11:00:00.000Z" }) })), true, "godkänd, Tradera köar");
  assert.equal(
    godkand(jobb({ tradera: pub({ status: "error", error: "only auctions allowed", approvedAt: "2026-09-07T11:00:00.000Z" }) })),
    true,
    "Traderas nej tar inte ner möbeln",
  );
});

test("en annons publicerad innan steget fanns räknas som godkänd", () => {
  assert.equal(godkand(jobb({ tradera: pub({ status: "published", itemId: 1, approvedAt: undefined }) })), true);
});
