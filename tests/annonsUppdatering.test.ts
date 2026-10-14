// ─── En ändrad annons ut till marknadsplatserna ──────────────────────────────
//
// När säljaren rättar en annons som ligger ute ska varje kanal uppdateras — Tradera tas ner och
// läggs upp igen, Blocket och Facebook ändras på plats av robotar. Testerna låser fast det som måste
// hålla oavsett kanal:
//
// BARA ANNONSER SOM LIGGER UTE. En annons som bara finns hos Loopa har ingenting att uppdatera.
// EN OMGÅNG ÄNDRINGAR = EN UPPDATERING. Tradera tar betalt per uppläggning.
// VARJE KANAL FÅR ETT ÄRLIGT UTFALL. Saknas nycklarna blir det "för hand", inte ett tyst ingenting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-uppdatering-"));
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.FACEBOOK_DATA_DIR = path.join(rot, "facebook");
process.env.BLOCKET_DATA_DIR = path.join(rot, "blocket");
// Inga kanaler konfigurerade: ingenting skarpt kan köras härifrån.
for (const k of ["TRADERA_APP_ID", "TRADERA_APP_KEY", "TRADERA_USER_ID", "TRADERA_USER_TOKEN", "BLOCKET_SESSION", "BLOCKET_STORAGE_STATE_GZIP", "BLOCKET_STORAGE_STATE", "FACEBOOK_ENABLED"]) delete process.env[k];
process.env.ANNONS_UPPDATERING = "1";
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { schemalaggAnnonsUppdatering, korAnnonsUppdatering } = await import("../server/src/integrations/annonsUppdatering.js");
const { createJob, persist, getJob } = await import("../server/src/jobStore.js");

const vanta = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("en annons som inte ligger ute schemaläggs inte", async () => {
  const job = await createJob(null, null, "agare", null);
  await schemalaggAnnonsUppdatering(job, 10);
  assert.equal((await getJob(job.id))?.annonsUppdatering ?? null, null);
});

test("en annons ute på Tradera och Blocket: varje kanal får ett ärligt utfall", async () => {
  const job = await createJob(null, null, "agare", null);
  job.tradera = { status: "published", requestId: 1, itemId: 123456, url: "https://www.tradera.com/item/1/123456/x", error: null, startedAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z" } as never;
  job.blocket = { status: "published", url: "https://www.blocket.se/26725957", receiptUrl: null, dryRun: false, error: null, startedAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z", steps: [] } as never;
  await persist(job);

  await schemalaggAnnonsUppdatering(job, 60_000);
  assert.equal((await getJob(job.id))?.annonsUppdatering?.status, "vantar");

  await korAnnonsUppdatering(job.id);
  const u = (await getJob(job.id))?.annonsUppdatering;
  assert.equal(u?.status, "klar");
  assert.equal(u?.kanaler.tradera?.status, "manuell", "Tradera utan nycklar ska bli en uppgift för hand");
  assert.equal(u?.kanaler.blocket?.status, "manuell", "Blocket utan session ska bli en uppgift för hand");
  assert.equal(u?.kanaler.facebook, undefined, "Facebook är avstängt och annonsen ligger inte där");
});

test("snabba ändringar i följd blir en uppdatering", async () => {
  const job = await createJob(null, null, "agare", null);
  job.blocket = { status: "published", url: "https://www.blocket.se/26725958", receiptUrl: null, dryRun: false, error: null, startedAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z", steps: [] } as never;
  await persist(job);
  await schemalaggAnnonsUppdatering(job, 150);
  await vanta(50);
  await schemalaggAnnonsUppdatering(job, 150);
  await vanta(50);
  await schemalaggAnnonsUppdatering(job, 150);
  // Inte körd än: varje ändring sköt fram körningen.
  assert.equal((await getJob(job.id))?.annonsUppdatering?.status, "vantar");
  await vanta(400);
  const u = (await getJob(job.id))?.annonsUppdatering;
  assert.equal(u?.status, "klar");
  assert.equal(u?.kanaler.blocket?.status, "manuell");
});

test("huvudbrytaren av: ingenting schemaläggs, inte ens för en annons som ligger ute", async () => {
  const job = await createJob();
  job.tradera = { status: "published", itemId: 123, url: null } as never;
  await persist(job);
  delete process.env.ANNONS_UPPDATERING;
  try {
    await schemalaggAnnonsUppdatering(job, 10);
  } finally {
    process.env.ANNONS_UPPDATERING = "1";
  }
  assert.equal((await getJob(job.id))?.annonsUppdatering ?? null, null);
});
