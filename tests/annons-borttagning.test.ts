// ─── Säljaren tar bort sin annons ────────────────────────────────────────────
//
// Borttagningen är den enda handlingen i produkten som tar bort något säljaren själv lagt in, och
// den ska hålla två löften som drar i olika riktningar. Tre saker prövas här, valda för att de går
// sönder tyst:
//
// BORTA ÄR BORTA — ÖVERALLT. Grinden ligger i `listJobs`, som är det enda stället som räknar upp
// lagret: butikens index, det publika kortet, profilen, datasetet, prisstegen och e-postbevakaren
// går alla genom den. Slutar den filtrera dyker möbeln upp till salu igen, och ingen av de sex
// läsarna hade sagt till.
//
// MEN KVAR I PANELEN. Hela skälet att jobbet behålls på disk är att frågan "vad hände med den
// möbeln" ska ha ett svar. Raden ska läsas som "borttagen" — och det läget måste gå FÖRE butikens
// tillstånd, för posten i butikslagret står kvar som utkast efteråt.
//
// EN BORTTAGNING ÄR INTE TVÅ. Ett andra tryck ska inte flytta tidsstämpeln: den säger när annonsen
// togs ner, och en omskriven stämpel gör "uppe i sex dagar" till "uppe i noll".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egen jobbmapp, satt INNAN modulerna läses in: sökvägen läses vid import, och utan det här skapar
// och märker testet jobb bland de skarpa besiktningarna.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-borttagning-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-borttagning-butik-"));
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
});

const { createJob, getJob, listJobs, listRemovedJobs, markJobRemoved } = await import("../server/src/jobStore.js");
const { lageAv } = await import("../server/src/adminAnnonser.js");
import type { ConditionJob } from "../server/src/types.js";
import type { ButikRecord } from "../server/src/butik/store.js";

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

test("en borttagen annons räknas inte längre upp i lagret", async () => {
  const kvar = await createJob(null);
  const bort = await createJob(null);

  await markJobRemoved(bort.id, "seller");

  const ids = (await listJobs()).map((j) => j.id);
  assert.ok(ids.includes(kvar.id), "den som står kvar ska finnas");
  assert.ok(!ids.includes(bort.id), "den borttagna får inte räknas upp — sex läsare går genom listan");

  const borttagna = (await listRemovedJobs()).map((j) => j.id);
  assert.deepEqual(borttagna, [bort.id], "panelen frågar uttryckligen efter dem");
});

test("märkningen ligger kvar på disk och skrivs inte om av ett andra tryck", async () => {
  const job = await createJob(null);
  const forst = await markJobRemoved(job.id, "seller");
  const igen = await markJobRemoved(job.id, "seller");

  assert.equal(igen?.removedAt, forst?.removedAt, "stämpeln säger NÄR möbeln togs ner");
  assert.equal((await getJob(job.id))?.removedBy, "seller");
});

test("panelen läser läget som borttagen — även före butikens tillstånd", () => {
  const borttagen = jobb({ removedAt: "2026-09-11T08:00:00.000Z", removedBy: "seller" });
  assert.equal(lageAv(borttagen, undefined), "borttagen");
  // Posten står kvar som utkast i butikslagret efter borttagningen, och "utkast" vore raka motsatsen
  // till sanningen: det säger att möbeln är på väg IN.
  assert.equal(lageAv(borttagen, post("draft")), "borttagen");
  assert.equal(lageAv(borttagen, post("live")), "borttagen");
  // Utan märkning gäller butikens tillstånd som förut.
  assert.equal(lageAv(jobb({}), post("live")), "live");
});
