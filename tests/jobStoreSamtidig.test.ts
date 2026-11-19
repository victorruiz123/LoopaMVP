// ─── Jobblagret: samtidiga inläsningar ger samma objekt ─────────────────────
//
// Skarpt 2026-11-19, första varvet efter en omstart: prisstegen och Tradera-publiceringen läste samma
// jobb samtidigt, innan det låg i minnet, och fick var sitt objekt. Publiceringen skrev "publicerad"
// på sitt, varvet sparade sedan sitt gamla ovanpå — annonsen låg uppe hos Tradera medan jobbet sa
// "publishing" utan annonsnummer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-jobstore-"));
const JOBS = path.join(rot, "jobs");
process.env.LOOPA_JOBS_DIR = JOBS;
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { skrivJobb } = await import("./facebookFixtur.js");
const { getJob, listJobs, persist } = await import("../server/src/jobStore.js");

test("samtidiga inläsningar av ett jobb som inte ligger i minnet får samma objekt", async () => {
  const id = "33333333-4444-4555-8666-000000000001";
  skrivJobb(JOBS, { id });
  const [a, b, c, lista] = await Promise.all([getJob(id), getJob(id), getJob(id), listJobs()]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(lista.find((j) => j.id === id), a);
  assert.equal(await getJob(id), a, "och samma objekt efteråt");
});

test("två som läst samtidigt kan inte skriva över varandras ändringar", async () => {
  const id = "33333333-4444-4555-8666-000000000002";
  skrivJobb(JOBS, { id });
  const [varvet, publiceringen] = await Promise.all([getJob(id), getJob(id)]);
  publiceringen!.tradera = { ...(publiceringen!.tradera as object), status: "published", itemId: 762180965 } as never;
  await persist(publiceringen!);
  await persist(varvet!);
  const pa_disk = JSON.parse(readFileSync(path.join(JOBS, id, "job.json"), "utf-8"));
  assert.equal(pa_disk.tradera.status, "published");
  assert.equal(pa_disk.tradera.itemId, 762180965);
});

test("ett jobb som inte finns ger undefined, även för samtidiga anrop", async () => {
  const [a, b] = await Promise.all([getJob("finns-inte"), getJob("finns-inte")]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
});
