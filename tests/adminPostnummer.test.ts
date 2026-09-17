// ─── Panelen sätter säljarens postnummer ─────────────────────────────────────
//
// Blocket-annonsen läggs på säljarens postnummer. Det kommer från kontot, men konton registrerade
// före adressfältet (16 september) har inget — och då står Blocket stilla. Admin ska kunna fylla i
// det efter ett samtal, utan att säljaren registrerar om sig. Tre saker måste hålla:
//
// DET SPARAS PÅ JOBBET, NORMALISERAT. "112 23" och "11223" är samma postnummer, och det som skrivs
// är det formuläret på Blocket får.
//
// ETT HALVT POSTNUMMER AVVISAS. Det står utåt, under möbeln, som om det vore sant.
//
// NULL TÖMMER. Skilt från osatt, som lämnar fältet i fred — samma regel som rättelserna följer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna datamappar, satta INNAN modulerna läses in — sökvägarna läses vid import.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-postnummer-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-postnummer-butik-"));
process.env.ANALYS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-postnummer-analys-"));
// Ingen servicenyckel: uppslagningen mot kontot ska inte ske här, bara jobbets eget fält prövas.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.on("exit", () => {
  for (const k of ["LOOPA_JOBS_DIR", "BUTIK_DATA_DIR", "ANALYS_DATA_DIR"] as const) {
    rmSync(process.env[k]!, { recursive: true, force: true });
  }
});

const { createJob, getJob } = await import("../server/src/jobStore.js");
const { andraAnnons, AndringsFel } = await import("../server/src/adminAnnonser.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

test("admin sätter postnumret, det normaliseras och står på jobbet", async () => {
  const job = await createJob(null);
  const detalj = await andraAnnons(loopaIdFor(job.id), { postnummer: "112 23" }, "admin-1");

  assert.equal(detalj.postnummer, "11223");
  assert.equal(detalj.postnummerKalla, "jobb", "satt av admin räknas som jobbets eget, inte kontots");
  assert.equal((await getJob(job.id))!.sellerPostalCode, "11223", "det är jobbet Blocket-planen läser");
});

test("fyra siffror avvisas — och jobbet rörs inte", async () => {
  const job = await createJob(null);
  await assert.rejects(() => andraAnnons(loopaIdFor(job.id), { postnummer: "1122" }, "admin-1"), AndringsFel);
  assert.equal((await getJob(job.id))!.sellerPostalCode ?? null, null);
});

test("null tömmer postnumret; osatt lämnar det i fred", async () => {
  const job = await createJob(null);
  const id = loopaIdFor(job.id);
  await andraAnnons(id, { postnummer: "75320" }, "admin-1");

  const orort = await andraAnnons(id, {}, "admin-1");
  assert.equal(orort.postnummer, "75320", "en patch utan fältet ska inte röra det");

  const tomt = await andraAnnons(id, { postnummer: null }, "admin-1");
  assert.equal(tomt.postnummer, null);
  assert.equal(tomt.postnummerKalla, null);
});
