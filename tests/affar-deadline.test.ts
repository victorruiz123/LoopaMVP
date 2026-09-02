// ─── Klockan som fällde varje köparanalys ────────────────────────────────────
//
// `watchJobDeadline` finns för att binda ett jobb som HÄNGER. Köparens väg genom en inklistrad
// annons bröt mot båda dess antaganden:
//
//   1. Den blev aldrig klar. `completeJob` anropas av skickbedömningen, och köparens jobb har ingen
//      (`skipGrading`). Jobbet stod kvar i `identifying` med annonsen färdig på skärmen, och 240
//      sekunder efter inklistringen fälldes den med "Analysen tog längre än 240 s och avbröts".
//      Varje köparanalys dog så — inte bara de sena.
//   2. Den står och väntar på svar. Märkesfrågan och modellvalet är MÄNNISKOTID, och en klocka som
//      mäter vårt arbete ska inte räkna den.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConditionJob } from "../server/src/types.js";

const { persist, getJob, watchJobDeadline, jobDir } = await import("../server/src/jobStore.js");
const { rm } = await import("node:fs/promises");

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-deadline-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

function jobIn(stage: string, over: Partial<ConditionJob> = {}): ConditionJob {
  return {
    id: `deadline-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    progress: { stage, message: "" },
    result: null,
    error: null,
    productContext: null,
    identity: null,
    ...over,
  } as ConditionJob;
}

/** Väntar ut vaktens korta gräns och låter dess asynkrona skrivning bli klar. */
async function letItFire(ms: number) {
  await new Promise((r) => setTimeout(r, ms + 60));
}

test("ett jobb som väntar på köparens märkessvar fälls inte", async () => {
  const job = jobIn("identifying", { adDerived: true, identity: null, identityStatus: undefined });
  await persist(job);
  const stop = watchJobDeadline(job.id, 40);
  await letItFire(120); // hinner lösa ut flera gånger
  stop();

  const after = await getJob(job.id);
  assert.equal(after?.progress.stage, "identifying", "märkesfrågan är inte en hängning");
  assert.equal(after?.error, null);
  await rm(jobDir(job.id), { recursive: true, force: true });
});

test("ett jobb som väntar på köparens modellval fälls inte", async () => {
  const job = jobIn("identifying", {
    adDerived: true,
    identity: { brand: "Mio", model: "" },
    identityStatus: "needs_selection",
  });
  await persist(job);
  const stop = watchJobDeadline(job.id, 40);
  await letItFire(120);
  stop();

  assert.equal((await getJob(job.id))?.progress.stage, "identifying");
  await rm(jobDir(job.id), { recursive: true, force: true });
});

test("SÄLJARENS jobb i samma läge fälls fortfarande — där kör besiktningen bakom skärmen", async () => {
  // Avgränsningen är hela poängen: `adDerived` skiljer ett jobb där ingenting arbetar från ett där
  // skickbedömningen är igång och ska förbli bunden.
  const job = jobIn("identifying", { identity: { brand: "IKEA", model: "" }, identityStatus: "needs_selection" });
  await persist(job);
  const stop = watchJobDeadline(job.id, 40);
  await letItFire(60);
  stop();

  const after = await getJob(job.id);
  assert.equal(after?.progress.stage, "error");
  assert.match(after?.error ?? "", /tog längre än/);
  await rm(jobDir(job.id), { recursive: true, force: true });
});

test("ett jobb som HÄNGER i en fas fälls, annonshärlett eller inte", async () => {
  // Ingen väntan på någon: identifieringen är igång och svarar inte. Det är vad vakten finns för.
  const job = jobIn("identifying", {
    adDerived: true,
    identity: { brand: "Mio", model: "County" },
    identityStatus: "identifying",
  });
  await persist(job);
  const stop = watchJobDeadline(job.id, 40);
  await letItFire(60);
  stop();

  const after = await getJob(job.id);
  assert.equal(after?.progress.stage, "error");
  assert.equal(after?.identityStatus, "unavailable");
  await rm(jobDir(job.id), { recursive: true, force: true });
});

test("ett klart jobb rörs inte", async () => {
  const job = jobIn("done", { adDerived: true });
  await persist(job);
  const stop = watchJobDeadline(job.id, 40);
  await letItFire(60);
  stop();

  assert.equal((await getJob(job.id))?.progress.stage, "done");
  await rm(jobDir(job.id), { recursive: true, force: true });
});
