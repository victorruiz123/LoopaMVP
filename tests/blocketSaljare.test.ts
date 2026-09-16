// ─── Säljarens postnummer på Blocket ─────────────────────────────────────────
//
// Annonsen ligger på ett delat Blocket-konto, men möbeln står hos säljaren. Postnumret var förut en
// serverinställning, ett för alla annonser — och placerade därmed varje möbel på samma adress. Nu är
// det säljarens, och tre saker måste hålla:
//
// JOBBETS EGET GÄLLER FÖRST. Det skrevs när säljaren själv tryckte "Sälj med Loopa", med deras token.
//
// UTAN SERVICENYCKEL GÖRS INGET ANROP. Den publika nyckeln får inte läsa andras konton; en uppslagning
// utan nyckeln är ett misstag, inte en reservväg.
//
// ETT HALVT POSTNUMMER ÄR INGET POSTNUMMER. Det står utåt, under möbeln — ett gissat är värre än inget.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-saljare-jobs-"));
process.on("exit", () => rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true }));

const { normaliseraPostnummer, postnummerUrMetadata, saljarensPostnummer } = await import(
  "../server/src/integrations/blocket/saljare.js"
);
import type { ConditionJob } from "../server/src/types.js";

function jobb(patch: Partial<ConditionJob> = {}): ConditionJob {
  return {
    id: "job-1",
    createdAt: "2026-09-15T09:00:00.000Z",
    error: null,
    result: null,
    progress: { stage: "done", message: "Klar" },
    ...patch,
  } as ConditionJob;
}

test("postnumret skrivs på ett sätt, hur säljaren än skrev det", () => {
  assert.equal(normaliseraPostnummer("112 23"), "11223");
  assert.equal(normaliseraPostnummer("112-23"), "11223");
  assert.equal(normaliseraPostnummer(11223), "11223");
});

test("ett halvt postnummer är inget postnummer", () => {
  assert.equal(normaliseraPostnummer("1122"), null);
  assert.equal(normaliseraPostnummer("112233"), null);
  assert.equal(normaliseraPostnummer(""), null);
  assert.equal(normaliseraPostnummer(null), null);
});

test("postnumret läses där registreringen lade det", () => {
  assert.equal(postnummerUrMetadata({ adress: { postnummer: "11223", ort: "Stockholm" } }), "11223");
  // Konton skapade i Vips saknar adressen helt.
  assert.equal(postnummerUrMetadata({ full_name: "Någon" }), null);
  assert.equal(postnummerUrMetadata(null), null);
});

test("jobbets eget postnummer gäller — två möbler, två adresser", async () => {
  const fore = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.equal(await saljarensPostnummer(jobb({ ownerId: "a", sellerPostalCode: "11223" })), "11223");
    assert.equal(await saljarensPostnummer(jobb({ ownerId: "b", sellerPostalCode: "41301" })), "41301");
  } finally {
    if (fore !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = fore;
  }
});

test("utan postnummer på jobbet och utan servicenyckel frågas ingen — och inget gissas", async () => {
  const fore = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const riktigFetch = globalThis.fetch;
  let anrop = 0;
  globalThis.fetch = (async () => {
    anrop += 1;
    throw new Error("inget anrop ska göras utan servicenyckel");
  }) as typeof fetch;
  try {
    assert.equal(await saljarensPostnummer(jobb({ ownerId: "a" })), null);
    assert.equal(anrop, 0);
  } finally {
    globalThis.fetch = riktigFetch;
    if (fore !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = fore;
  }
});

test("med servicenyckel slås ägarens konto upp när jobbet saknar postnummer", async () => {
  const fore = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-nyckel";
  const riktigFetch = globalThis.fetch;
  let fraga = "";
  globalThis.fetch = (async (url: string | URL) => {
    fraga = String(url);
    return new Response(JSON.stringify({ user_metadata: { adress: { postnummer: "753 20" } } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await saljarensPostnummer(jobb({ ownerId: "agare-42" })), "75320");
    assert.match(fraga, /\/auth\/v1\/admin\/users\/agare-42$/);
  } finally {
    globalThis.fetch = riktigFetch;
    if (fore === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = fore;
  }
});
