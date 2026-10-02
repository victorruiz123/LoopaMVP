// ─── Utskick "Till nya" ──────────────────────────────────────────────────────
//
// Admin klistrar in en lista adresser som inte har konto. Tre saker måste hålla:
//
// LISTAN LÄSES SOM MAN KLISTRAR IN DEN. En per rad, komma, semikolon, "Namn <adress>" — dubbletter
// en gång, och ett stavfel syns i stället för att tyst falla bort.
//
// [namn] KRÄVER ETT NAMN PÅ VARJE RAD. Namnet skrivs bredvid adressen; saknas det på en enda rad
// avvisas brevet, för "Hej ," i en inkorg går inte att ta tillbaka.
//
// ADRESSERNA SLÅS INTE UPP I PROFILTABELLEN. Det är hela poängen — de finns inte där.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-utskick-jobs-"));
process.env.UTSKICK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-utskick-logg-"));
// En stängd port: körningen som startas ska falla direkt, inte nå någon riktig inkorg.
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "test@exempel.se";
process.env.SMTP_PASS = "hemligt";
process.env.UTSKICK_PAUS_MS = "0";
// Ingen servicenyckel: profiltabellen ska inte behövas för ett utskick till nya.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.on("exit", () => {
  for (const k of ["LOOPA_JOBS_DIR", "UTSKICK_DATA_DIR"] as const) rmSync(process.env[k]!, { recursive: true, force: true });
});

const { tolkaAdresser, handleUtskick, fyll } = await import("../server/src/utskick.js");

function post(kropp: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = new PassThrough() as unknown as ServerResponse & PassThrough;
    let status = 0;
    (res as any).writeHead = (s: number) => ((status = s), res);
    (res as any).end = (b: string) => resolve({ status, body: JSON.parse(b || "{}") });
    void handleUtskick([], { method: "POST" } as IncomingMessage, res, async () => kropp);
  });
}

test("listan läses i alla vanliga former, dubbletter en gång", () => {
  const r = tolkaAdresser(
    [
      "namn,epost",
      "Anna Svensson, anna@exempel.se",
      "Erik Lind <Erik@Exempel.se>",
      "sara@exempel.se\tSara",
      "a@exempel.se, b@exempel.se",
      "kalle@exempel.se",
      "Kalle Karlsson; kalle@exempel.se",
    ].join("\n"),
  );
  assert.deepEqual(r.giltiga, [
    { epost: "anna@exempel.se", namn: "Anna Svensson" },
    { epost: "erik@exempel.se", namn: "Erik Lind" },
    { epost: "sara@exempel.se", namn: "Sara" },
    // Två adresser på en rad: vems namnet är går inte att veta.
    { epost: "a@exempel.se", namn: null },
    { epost: "b@exempel.se", namn: null },
    // Dubbletten bar namnet som första raden saknade.
    { epost: "kalle@exempel.se", namn: "Kalle Karlsson" },
  ]);
  assert.equal(r.dubbletter, 1);
  assert.deepEqual(r.ogiltiga, []);
});

test("ett stavfel syns i stället för att falla bort", () => {
  const r = tolkaAdresser("anna@exempel\nerik@@exempel.se\nok@exempel.se");
  assert.deepEqual(r.giltiga.map((m) => m.epost), ["ok@exempel.se"]);
  assert.equal(r.ogiltiga.length, 2);
});

test("[namn] avvisas när någon rad saknar namn", async () => {
  const svar = await post({ typ: "nya", amne: "Hej", brev: "Hej [namn]!", adresser: ["Anna, a@exempel.se", "b@exempel.se"] });
  assert.equal(svar.status, 400);
  assert.match(svar.body.error, /1 saknar namn: b@exempel\.se/);
});

test("en ogiltig adress stoppar utskicket", async () => {
  const svar = await post({ typ: "nya", amne: "Hej", brev: "Hej!", adresser: ["a@exempel.se", "trasig@"] });
  assert.equal(svar.status, 400);
  assert.match(svar.body.error, /Ogiltiga/);
});

test("[namn] går ut när varje rad har ett namn — utan profiltabell", async () => {
  const svar = await post({
    typ: "nya",
    amne: "Hej [namn]",
    brev: "Hej [namn]!",
    adresser: ["Anna Svensson, a@exempel.se", "Bo <b@exempel.se>", "Anna Svensson, A@exempel.se"],
  });
  assert.equal(svar.status, 202);
  assert.equal(svar.body.totalt, 2);
  assert.equal(svar.body.pagar, true);
});

test("[namn] blir förnamnet", () => {
  assert.equal(fyll("Hej [namn], {helanamn}", { epost: "a@exempel.se", fornamn: "Anna", namn: "Anna Svensson", registrerad: null }), "Hej Anna, Anna Svensson");
});

test("strypningen från one.com räknas som tillfällig, ett permanent nej gör det inte", async () => {
  const { tillfalligtFel } = await import("../server/src/utskick.js");
  const strypt = Object.assign(
    new Error("Can't send mail - all recipients were rejected: 451 4.7.1 [R2] Too many mails received from x within the last 5 minutes"),
    { responseCode: 451 },
  );
  assert.equal(tillfalligtFel(strypt), true);
  assert.equal(tillfalligtFel(new Error("all recipients were rejected: 451 4.7.1 Too many mails")), true);
  assert.equal(tillfalligtFel(Object.assign(new Error("550 5.1.1 User unknown"), { responseCode: 550 })), false);
  assert.equal(tillfalligtFel(new Error("connect ECONNREFUSED 127.0.0.1:1")), false);
});

test("skickadeFor listar bara lyckade brev med exakt den ämnesraden", async () => {
  const { skickadeFor } = await import("../server/src/utskick.js");
  const { appendFileSync } = await import("node:fs");
  const fil = path.join(process.env.UTSKICK_DATA_DIR!, "logg.jsonl");
  appendFileSync(
    fil,
    [
      { epost: "fick@exempel.se", amne: "En gratis försäljning!", status: "ok" },
      { epost: "foll@exempel.se", amne: "En gratis försäljning!", status: "fel", orsak: "451 4.7.1" },
      { epost: "annat@exempel.se", amne: "Något annat", status: "ok" },
    ].map((r) => JSON.stringify(r) + "\n").join(""),
  );
  assert.deepEqual(await skickadeFor("En gratis försäljning!"), ["fick@exempel.se"]);
});
