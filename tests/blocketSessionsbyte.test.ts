// ─── Sessionsbytet ───────────────────────────────────────────────────────────
//
// `npm run blocket:byt-session` loggar in lokalt och skickar sessionen till servern, där
// installeraSession tar den i bruk. Det som prövas här, utan webbläsare:
//
// FEL FIL STOPPAS. En session utan Blocket- eller inloggningskakor är ett misstag, och den ska inte
// få ersätta en som kanske fortfarande gäller.
//
// RÄTT FIL SKRIVS, och vaktens gamla dom glöms — annars står "sessionen har gått ut" kvar i panelen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const katalog = mkdtempSync(path.join(tmpdir(), "blocket-byte-"));
process.env.BLOCKET_DATA_DIR = katalog;
process.env.BLOCKET_SESSION = path.join(katalog, "session.json");

const { felISession, installeraSession } = await import("../server/src/integrations/blocket/sessionsbyte.js");

const GILTIG = JSON.stringify({
  cookies: [
    { name: "flid", domain: ".blocket.se", value: "x" },
    { name: "id-session", domain: "login.vend.se", value: "y" },
  ],
  origins: [],
});

test("en riktig inloggning godtas", () => {
  assert.equal(felISession(GILTIG), null);
});

test("fel underlag stoppas", () => {
  assert.match(felISession("inte json") ?? "", /inte JSON/);
  assert.match(felISession("{}") ?? "", /saknar kakor/);
  assert.match(felISession(JSON.stringify({ cookies: [{ domain: "login.vend.se" }] })) ?? "", /blocket\.se/);
  assert.match(felISession(JSON.stringify({ cookies: [{ domain: ".blocket.se" }] })) ?? "", /vend\.se/);
  assert.match(felISession(JSON.stringify({ cookies: [{ domain: "127.0.0.1" }] })) ?? "", /blocket\.se/);
});

test("bytet skriver sessionen och glömmer vaktens dom", () => {
  writeFileSync(process.env.BLOCKET_SESSION!, "gammal");
  writeFileSync(path.join(katalog, "halsa.json"), JSON.stringify({ kontrolleradAt: "x", ok: false }));

  const fil = installeraSession(GILTIG);

  assert.equal(fil, process.env.BLOCKET_SESSION);
  assert.equal(readFileSync(fil, "utf8"), GILTIG);
  assert.equal(existsSync(path.join(katalog, "halsa.json")), false);
});

test("ett ogiltigt byte lämnar den gamla sessionen orörd", () => {
  writeFileSync(process.env.BLOCKET_SESSION!, "gammal");
  assert.throws(() => installeraSession("{}"));
  assert.equal(readFileSync(process.env.BLOCKET_SESSION!, "utf8"), "gammal");
});

// VILKET KONTO. Blocket väljer konto efter mejladressen, och BankID väljer inget — därför läses
// kontot av från "Mitt konto" och visas innan sessionen går till servern.

const { kontoText, tolkaKonto } = await import("../server/src/integrations/blocket/inloggning.js");

test("kontot läses ur Mitt konto", () => {
  const konto = tolkaKonto(
    ["Du är här", "Hej Anna Andersson", "Blocket kontodetaljer", "Vend-inställningar"],
    "Mejladress\nanna.andersson@example.se\nTelefon",
  );
  assert.deepEqual(konto, { namn: "Anna Andersson", mejl: "anna.andersson@example.se" });
  assert.equal(kontoText(konto), "Anna Andersson <anna.andersson@example.se>");
});

test("en sida utan konto ger inget namn — och det sägs rakt ut", () => {
  const konto = tolkaKonto(["Logga in"], "Ange din mejladress");
  assert.deepEqual(konto, { namn: null, mejl: null });
  assert.match(kontoText(konto), /okänt konto/);
});
