// ─── Var data bor: nyckeln får inte flytta butiken ───────────────────────────
//
// Det här testet finns för ETT fel, och det felet har redan hänt. Den 20 september lades
// SUPABASE_SERVICE_ROLE_KEY in i driften för att adminpanelen skulle kunna läsa säljarens adress ur
// Auth. Butiken, affärerna och inbjudningarna valde alla tre rygg på just den variabeln, bytte till
// Postgres i samma sekund, och eftersom tabellerna inte fanns gick servern i kraschloop. Loopa.nu
// svarade 502 tills nyckeln togs bort.
//
// En nyckel är en BEHÖRIGHET, inte ett beslut om var data ska ligga. Ett test som bara läser
// förvalet hade inte fångat det — det som måste hållas är att nyckeln ensam inte räcker.

import { test } from "node:test";
import assert from "node:assert/strict";

const { supabaseLagring } = await import("../server/src/datalagring.js");

/** Kör kroppen med en viss miljö, och lämnar tillbaka den som den var. */
function medMiljo(env: Record<string, string | undefined>, fn: () => void) {
  const fore: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    fore[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(fore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("servicenyckeln ensam flyttar INTE data till Supabase", () => {
  medMiljo({ SUPABASE_SERVICE_ROLE_KEY: "en-riktig-nyckel", LOOPA_LAGRING: undefined }, () => {
    assert.equal(
      supabaseLagring(),
      false,
      "nyckeln lades in för att få läsa konton — den får inte flytta butiken, affärerna och inbjudningarna",
    );
  });
});

test("flytten kräver att någon skrivit att den ska ske", () => {
  medMiljo({ SUPABASE_SERVICE_ROLE_KEY: "en-riktig-nyckel", LOOPA_LAGRING: "supabase" }, () => {
    assert.equal(supabaseLagring(), true);
  });
});

test("valt men utan nyckel: filryggen, inte ett halvt Postgres", () => {
  medMiljo({ SUPABASE_SERVICE_ROLE_KEY: undefined, LOOPA_LAGRING: "supabase" }, () => {
    // Varningen skrivs av funktionen; det som prövas här är att den inte påstår sig ligga i Postgres
    // utan en väg dit. Ett "ja" här hade blivit ett kast vid första frågan i stället.
    assert.equal(supabaseLagring(), false);
  });
});

test("okända värden betyder filer, inte en gissning", () => {
  for (const val of ["", "fil", "postgres", "SUPABASE ", "ja"]) {
    medMiljo({ SUPABASE_SERVICE_ROLE_KEY: "en-riktig-nyckel", LOOPA_LAGRING: val }, () => {
      assert.equal(supabaseLagring(), val.trim().toLowerCase() === "supabase", `oväntat för "${val}"`);
    });
  }
});
