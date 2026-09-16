// ─── Blocket-sessionen ur miljön ─────────────────────────────────────────────
//
// Benjamins BankID-session bodde i Railway som BLOCKET_STORAGE_STATE_GZIP. När appen flyttade följde
// den inte med. Nu läses den i samma form som railway-proxyn läste den, och fyra saker måste hålla:
//
// VÄRDET GÅR ATT KLISTRA ÖVER RAKT AV. Samma namn, samma format — gzip+base64 eller ren JSON.
//
// EN ROTERAD SESSION ÖVERLEVER EN OMSTART. Blocket byter session när BankID slutförs och den skrivs
// då till filen. Skrevs miljövärdet tillbaka vid nästa start vore den gamla, utloggade, tillbaka.
//
// ETT NYTT MILJÖVÄRDE ERSÄTTER FILEN. Annars går det aldrig att byta session.
//
// ETT OLÄSLIGT VÄRDE ÄR INGEN SESSION. Kanalen ska säga att den inte är konfigurerad, inte starta en
// webbläsare mot en inloggningssida.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const KATALOG = mkdtempSync(path.join(tmpdir(), "loopa-blocket-session-"));
process.on("exit", () => rmSync(KATALOG, { recursive: true, force: true }));

const { missingBlocketEnv, sessionFile } = await import("../server/src/integrations/blocket/blocket.js");

const VARIABLER = [
  "BLOCKET_SESSION",
  "BLOCKET_STORAGE_STATE_GZIP",
  "BLOCKET_COMPANY_STORAGE_STATE_GZIP",
  "BLOCKET_STORAGE_STATE",
  "BLOCKET_COMPANY_STORAGE_STATE",
  "BLOCKET_DATA_DIR",
] as const;

function state(varde: string): string {
  return JSON.stringify({ cookies: [{ name: "vend", value: varde, domain: ".vend.se" }], origins: [] });
}

function gz(json: string): string {
  return gzipSync(Buffer.from(json, "utf8")).toString("base64");
}

/** Miljön nollställd runt varje fall, med en egen katalog för den utskrivna sessionen. */
async function med(vars: Partial<Record<(typeof VARIABLER)[number], string>>, fn: (katalog: string) => void | Promise<void>) {
  const fore = Object.fromEntries(VARIABLER.map((k) => [k, process.env[k]]));
  const katalog = mkdtempSync(path.join(KATALOG, "fall-"));
  for (const k of VARIABLER) delete process.env[k];
  Object.assign(process.env, { BLOCKET_DATA_DIR: katalog }, vars);
  try {
    await fn(katalog);
  } finally {
    for (const k of VARIABLER) {
      if (fore[k] === undefined) delete process.env[k];
      else process.env[k] = fore[k];
    }
  }
}

test("railway-proxyns gzip-värde går att klistra över rakt av", async () => {
  const json = state("a");
  await med({ BLOCKET_STORAGE_STATE_GZIP: gz(json) }, () => {
    const fil = sessionFile();
    assert.ok(fil, "sessionen ska ge en fil");
    assert.equal(readFileSync(fil, "utf8"), json);
    assert.deepEqual(missingBlocketEnv(), [], "kanalen är konfigurerad");
  });
});

test("ren JSON fungerar också, liksom företagsvarianten av namnet", async () => {
  const json = state("b");
  await med({ BLOCKET_COMPANY_STORAGE_STATE: json }, () => {
    assert.equal(readFileSync(sessionFile()!, "utf8"), json);
  });
  await med({ BLOCKET_COMPANY_STORAGE_STATE: gz(json) }, () => {
    assert.equal(readFileSync(sessionFile()!, "utf8"), json, "proxyn läste samma namn i båda formaten");
  });
});

test("en roterad session överlever en omstart", async () => {
  const fran = gz(state("gammal"));
  await med({ BLOCKET_STORAGE_STATE_GZIP: fran }, () => {
    const fil = sessionFile()!;
    // Blocket roterade sessionen under en körning, och saveSessionIfReal skrev den nya.
    writeFileSync(fil, state("roterad"));
    // Omstart: miljövärdet är detsamma som förut.
    assert.equal(readFileSync(sessionFile()!, "utf8"), state("roterad"));
  });
});

test("ett nytt miljövärde ersätter den utskrivna sessionen", async () => {
  await med({ BLOCKET_STORAGE_STATE_GZIP: gz(state("forsta")) }, (katalog) => {
    const fil = sessionFile()!;
    writeFileSync(fil, state("roterad"));
    process.env.BLOCKET_STORAGE_STATE_GZIP = gz(state("ny-inloggning"));
    assert.equal(sessionFile(), fil);
    assert.equal(readFileSync(fil, "utf8"), state("ny-inloggning"));
    assert.ok(fil.startsWith(katalog));
  });
});

test("BLOCKET_SESSION vinner när den är satt", async () => {
  await med({ BLOCKET_SESSION: "/tmp/uttrycklig.json", BLOCKET_STORAGE_STATE_GZIP: gz(state("c")) }, () => {
    assert.equal(sessionFile(), "/tmp/uttrycklig.json");
  });
});

test("utan session, eller med ett oläsligt värde, är kanalen inte konfigurerad", async () => {
  await med({}, () => {
    assert.equal(sessionFile(), null);
    assert.deepEqual(missingBlocketEnv(), ["BLOCKET_SESSION"]);
  });
  await med({ BLOCKET_STORAGE_STATE_GZIP: "inte-en-session" }, () => {
    assert.equal(sessionFile(), null);
    assert.deepEqual(missingBlocketEnv(), ["BLOCKET_SESSION"]);
  });
});
