// ─── Adminpanelens kontosida: uppgifterna om säljaren ────────────────────────
//
// Sidan öppnas från en annons för att svara på EN fråga: vem är säljaren, och var står möbeln. Tre
// saker måste därför hålla, och alla tre går sönder tyst.
//
// SAKNAT OCH OLÄSBART ÄR INTE SAMMA SAK. En adress som saknas för att säljaren aldrig angett någon
// ska svara annat än en adress som saknas för att Supabase inte gick att nå. Plattas de till
// varandra får adminen en tom ruta att gissa utifrån — och gissningen står sedan under möbeln som
// ett postnummer.
//
// ETT TOMT ADRESSOBJEKT ÄR INGEN ADRESS. Registreringen kan ha skrivit fälten som tomma strängar.
// Skickas de vidare som en adress ritar panelen en adressruta där varje rad är ett streck.
//
// SIFFRORNA RÄKNAS PÅ ÄGAREN. Kontosidan får aldrig visa någon annans annonser — det är samma fel
// som att visa fel adress, fast svårare att upptäcka.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egen jobbmapp, satt INNAN modulerna läses in: sökvägen läses vid import.
const JOBB = mkdtempSync(path.join(tmpdir(), "loopa-konto-test-"));
process.env.LOOPA_JOBS_DIR = JOBB;
process.env.SUPABASE_URL = "https://exempel.supabase.co";
process.on("exit", () => rmSync(JOBB, { recursive: true, force: true }));

const { kontoDetalj } = await import("../server/src/admin.js");

/** Ett jobb på disk, så magert som `listJobs` accepterar det. */
function skrivJobb(id: string, ownerId: string | null, patch: Record<string, unknown> = {}) {
  mkdirSync(path.join(JOBB, id), { recursive: true });
  writeFileSync(
    path.join(JOBB, id, "job.json"),
    JSON.stringify({ id, ownerId, createdAt: "2026-09-01T10:00:00.000Z", status: "done", ...patch }),
  );
}

/** Svaret från Supabase Auth, som `kontoDetalj` läser det. */
function medAuth(user: Record<string, unknown> | null, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-nyckel";
  globalThis.fetch = (async () =>
    user
      ? { ok: true, json: async () => user }
      : { ok: false, json: async () => ({}) }) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
}

test("adressen läses ur kontots user_metadata", async () => {
  await medAuth(
    {
      id: "u1",
      email: "saljare@exempel.se",
      created_at: "2026-08-01T09:00:00.000Z",
      user_metadata: {
        full_name: "Säljaren",
        adress: { gatuadress: "Storgatan 1", postnummer: "11223", ort: "Stockholm", boende: "lagenhet", vaning: "3" },
      },
    },
    async () => {
      const konto = await kontoDetalj("u1");
      assert.equal(konto?.adress?.postnummer, "11223");
      assert.equal(konto?.adress?.gatuadress, "Storgatan 1");
      assert.equal(konto?.adress?.boende, "lagenhet");
      // Portkoden var inte ifylld: fältet finns, uppgiften gör det inte.
      assert.equal(konto?.adress?.portkod, null);
      assert.equal(konto?.kalla, "auth");
      assert.equal(konto?.name, "Säljaren");
    },
  );
});

test("ett adressobjekt där allt är tomt är ingen adress", async () => {
  await medAuth(
    { id: "u2", email: null, user_metadata: { adress: { gatuadress: "", postnummer: "  ", ort: null } } },
    async () => {
      const konto = await kontoDetalj("u2");
      assert.equal(konto?.adress, null, "tomma fält får inte bli en adressruta full av streck");
    },
  );
});

test("Supabase svarar inte: kontot finns ändå, men säger varifrån uppgifterna kom", async () => {
  skrivJobb("jobb-1", "u3");
  await medAuth(null, async () => {
    const konto = await kontoDetalj("u3");
    assert.equal(konto?.kalla, "jobb", "en adress vi inte fick läsa är inte en adress som saknas");
    assert.equal(konto?.adress, null);
    assert.equal(konto?.jobCount, 1);
    // Utan registreringsdatum ur Auth är första jobbet det närmaste vi kommer — och det ska märkas.
    assert.equal(konto?.signupApproximate, true);
  });
});

test("siffrorna räknas på ägaren, inte på alla jobb", async () => {
  skrivJobb("jobb-2", "u4");
  skrivJobb("jobb-3", "u4");
  skrivJobb("jobb-4", "nagon-annan");
  await medAuth({ id: "u4", email: "fyra@exempel.se", created_at: "2026-07-01T00:00:00.000Z" }, async () => {
    const konto = await kontoDetalj("u4");
    assert.equal(konto?.jobCount, 2);
    assert.equal(konto?.signupApproximate, false, "Auth vet när kontot skapades — då gissar vi inte");
  });
});

test("ett konto som varken finns i Auth eller äger något jobb finns inte", async () => {
  await medAuth(null, async () => {
    assert.equal(await kontoDetalj("finns-inte"), null);
  });
});
