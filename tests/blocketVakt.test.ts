// ─── Sessionsvakten ──────────────────────────────────────────────────────────
//
// Sessionen är det som går sönder oftast och syns senast: först när en robot står på en
// inloggningssida tre minuter in i ett godkännande. Vakten kontrollerar den i förväg, och fyra saker
// måste hålla — alla prövade utan webbläsare, för det är övergångslogiken som är farlig, inte
// Chromium:
//
// BESKEDET SKRIVS VARJE GÅNG, så att panelen alltid har det senaste.
//
// LARMET GÅR VID ÖVERGÅNG, inte vid varje kontroll. Ett mejl var tolfte timme om samma fel lär
// mottagaren att inte läsa dem.
//
// FÖRSTA FELET LARMAR. Utan besked sedan tidigare finns ingen "övergång", men det är ändå nytt.
//
// UNDER EN PUBLICERING HOPPAR VAKTEN ÖVER. Två Chromium på en liten server är ett minnesproblem, och en
// kontroll mitt i en BankID-väntan kan rotera sessionen under fötterna på roboten.

import { test } from "node:test";
import assert from "node:assert/strict";

const { korBlocketVakt, markeraUpptagen } = await import("../server/src/integrations/blocket/vakt.js");
import type { BlocketHalsa } from "../server/src/integrations/blocket/blocket.js";

const NU = new Date("2026-09-18T06:00:00.000Z");

function besked(ok: boolean): BlocketHalsa {
  return { kontrolleradAt: "2026-09-17T18:00:00.000Z", ok, url: ok ? "https://www.blocket.se/mina-annonser" : "https://login.vend.se/authn", fel: ok ? null : "Blocket-sessionen har gått ut." };
}

/** En rigg per fall: vad som fanns sedan förut, och vad kontrollen svarar nu. */
function rigg(fore: BlocketHalsa | null, ok: boolean) {
  const skrivet: BlocketHalsa[] = [];
  const larm: BlocketHalsa[] = [];
  let kontroller = 0;
  const beroenden = {
    kontroll: async () => {
      kontroller++;
      return ok
        ? { ok: true, url: "https://www.blocket.se/mina-annonser", fel: null }
        : { ok: false, url: "https://login.vend.se/authn", fel: "Blocket-sessionen har gått ut." };
    },
    las: () => fore,
    skriv: (h: BlocketHalsa) => {
      skrivet.push(h);
    },
    larma: async (h: BlocketHalsa) => {
      larm.push(h);
    },
    nu: () => NU,
  };
  return { beroenden, skrivet, larm, kontroller: () => kontroller };
}

test("första kontrollen som faller larmar, och beskedet skrivs med tidpunkten", async () => {
  const r = rigg(null, false);
  const halsa = await korBlocketVakt(r.beroenden);

  assert.equal(halsa?.ok, false);
  assert.equal(halsa?.kontrolleradAt, NU.toISOString());
  assert.equal(r.skrivet.length, 1, "beskedet skrivs så att panelen kan läsa det");
  assert.equal(r.larm.length, 1, "det finns inget tidigare besked — felet är nytt och ska sägas");
  assert.match(r.larm[0].fel ?? "", /gått ut/);
});

test("ok → fel larmar en gång; fel → fel larmar inte igen", async () => {
  const forsta = rigg(besked(true), false);
  await korBlocketVakt(forsta.beroenden);
  assert.equal(forsta.larm.length, 1, "sessionen gick just ut");

  const andra = rigg(besked(false), false);
  await korBlocketVakt(andra.beroenden);
  assert.equal(andra.larm.length, 0, "samma fel som förra gången — inget nytt att säga");
  assert.equal(andra.skrivet.length, 1, "men beskedet skrivs ändå, med ny tidpunkt");
});

test("fel → ok larmar inte, men skrivs — så panelen slutar säga att sessionen gått ut", async () => {
  const r = rigg(besked(false), true);
  const halsa = await korBlocketVakt(r.beroenden);
  assert.equal(halsa?.ok, true);
  assert.equal(r.larm.length, 0);
  assert.deepEqual(r.skrivet.map((h) => h.ok), [true]);
});

test("under en publicering hoppar vakten över varvet helt", async () => {
  const r = rigg(besked(true), false);
  markeraUpptagen(true);
  try {
    assert.equal(await korBlocketVakt(r.beroenden), null);
    assert.equal(r.kontroller(), 0, "ingen webbläsare startas bredvid en körning");
    assert.equal(r.skrivet.length, 0);
    assert.equal(r.larm.length, 0);
  } finally {
    markeraUpptagen(false);
  }
  // Och när körningen är klar går varvet som vanligt.
  await korBlocketVakt(r.beroenden);
  assert.equal(r.kontroller(), 1);
});

test("ett larm som inte går iväg fäller inte vakten", async () => {
  const r = rigg(null, false);
  const halsa = await korBlocketVakt({
    ...r.beroenden,
    larma: async () => {
      throw new Error("SMTP nere");
    },
  });
  assert.equal(halsa?.ok, false);
  assert.equal(r.skrivet.length, 1, "beskedet är skrivet innan larmet försöks");
});
