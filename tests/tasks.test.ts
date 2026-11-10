// ─── Jobbets uppgifter: lägen, beroenden och att ett sent svar inte skriver över något ─────────────────────────────
//
// Fyra uppgifter (skick, modellförslag, specar, pris) löper parallellt där deras indata tillåter det. Klienten visar det som blir klart först. Här
// prövas övergångarna (rena funktioner), startlägena — specar och pris väntar på en bekräftad modell, ingenting låtsas vara oberoende —
// och vad som krävs för att ett kort ska få publiceras.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "loopa-tasks-"));
process.env.LOOPA_JOBS_DIR = path.join(root, "jobs");

import { initialTasks, missingForPublish, nextTask } from "../server/src/pipeline/tasks.js";

const { createJob, getJob } = await import("../server/src/jobStore.js");
const { setTask, markIncomplete } = await import("../server/src/pipeline/tasks.js");

after(() => rmSync(root, { recursive: true, force: true }));
before(() => {});

test("en uppgift går pending → running → slutläge, med tider", () => {
  const running = nextTask({ status: "pending" }, "running", {}, 1_000)!;
  assert.deepEqual(running, { status: "running", startedAt: 1_000 });
  const done = nextTask(running, "completed", {}, 5_000)!;
  assert.equal(done.status, "completed");
  assert.equal(done.startedAt, 1_000);
  assert.equal(done.finishedAt, 5_000);
});

test("ett slutläge skrivs inte över av ett sent svar — det som ska göras om görs om uttryckligen", () => {
  const failed = nextTask({ status: "running", startedAt: 1 }, "failed", { note: "föll" }, 10)!;
  assert.equal(nextTask(failed, "completed", {}, 20), null, "ett sent 'klart' efter ett fall ändrar ingenting");
  assert.equal(nextTask(failed, "running", {}, 20), null);
  const again = nextTask(failed, "running", { restart: true }, 30)!;
  assert.deepEqual(again, { status: "running", startedAt: 30 });
});

test("orsaken följer med ett slutläge och försvinner när uppgiften startas om", () => {
  const failed = nextTask({ status: "running", startedAt: 1 }, "failed", { note: "tjänsten var nere" }, 10)!;
  assert.equal(failed.note, "tjänsten var nere");
  assert.equal(nextTask(failed, "running", { restart: true }, 20)!.note, undefined);
  assert.equal(nextTask({ status: "running", startedAt: 1 }, "cancelled", { note: "Säljaren hann före." }, 10)!.status, "cancelled");
});

test("startlägen: skick och identifiering körs direkt; specar och pris väntar på en bekräftad modell", () => {
  const t = initialTasks({ skipGrading: false, identify: "run" }, 100);
  assert.equal(t.condition?.status, "running");
  assert.equal(t.identify?.status, "running");
  assert.equal(t.specs?.status, "pending", "modellberoende arbete fabriceras inte för att se oberoende ut");
  assert.equal(t.price?.status, "pending");
});

test("säljaren angav modellen själv: identifieringen är klar, specarna körs; köparens jobb har ingen besiktning", () => {
  const t = initialTasks({ skipGrading: true, identify: "resolved" }, 100);
  assert.equal(t.identify?.status, "completed");
  assert.equal(t.specs?.status, "running");
  assert.equal(t.condition?.status, "cancelled");
});

test("uppgifterna ligger på jobbet, och en som faller tar inte de andras läge med sig", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  job.tasks = initialTasks({ skipGrading: false, identify: "run" });
  await setTask(job.id, "identify", "failed", { note: "tjänsten var nere" });
  await setTask(job.id, "condition", "completed");
  const j = (await getJob(job.id))!;
  assert.equal(j.tasks?.identify?.status, "failed");
  assert.equal(j.tasks?.condition?.status, "completed", "skicket är klart och kan granskas trots att modellsökningen föll");
  assert.equal(j.tasks?.specs?.status, "pending");
});

test("ett sent svar kan inte skriva över ett slutläge via setTask heller", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  assert.equal(await setTask(job.id, "identify", "cancelled", { note: "Säljaren hann före." }), true);
  assert.equal(await setTask(job.id, "identify", "completed"), false);
  assert.equal((await getJob(job.id))!.tasks?.identify?.status, "cancelled");
});

test("ofullständig markeras en gång och skrivs inte bort", async () => {
  const job = await createJob(null, { brand: "IKEA", model: "" });
  await markIncomplete(job.id, "Kostnadstaket nåddes.");
  const first = (await getJob(job.id))!.incomplete!;
  await markIncomplete(job.id, "något annat");
  assert.equal((await getJob(job.id))!.incomplete!.reason, first.reason);
});

// ─── Publicering ────────────────────────────────────────────────────────────

const complete = {
  identityStatus: "resolved",
  identity: { model: "INGEMAR" },
  result: { grade: { grade: "B" }, reviewPending: false, listing: { status: "ok", result: {}, improving: false } },
};

test("ett komplett kort får publiceras", () => {
  assert.deepEqual(missingForPublish(complete), []);
});

test("obligatoriskt: bekräftad modell, skickbedömning och annonstext — var och en stoppar publiceringen", () => {
  assert.ok(missingForPublish({ ...complete, identityStatus: "needs_selection" }).includes("bekräftad modell"));
  assert.ok(missingForPublish({ ...complete, identity: { model: "" } }).includes("bekräftad modell"));
  assert.ok(missingForPublish({ ...complete, result: { ...complete.result, grade: undefined } }).includes("skickbedömning"));
  assert.ok(missingForPublish({ ...complete, result: { ...complete.result, reviewPending: true } }).includes("skickbedömning"));
  assert.ok(missingForPublish({ ...complete, result: { ...complete.result, listing: { status: "pending" } } }).includes("annonstext"));
  assert.ok(missingForPublish({ ...complete, result: { ...complete.result, listing: null } }).includes("annonstext"));
});

test("en annons som fortfarande kompletteras (improving) är inte färdig — säljaren väntar in den", () => {
  const m = missingForPublish({ ...complete, result: { ...complete.result, listing: { status: "ok", result: {}, improving: true } } });
  assert.deepEqual(m, ["pågående komplettering av annonsen"]);
});

test("annonsen kan ligga i pendingListing medan skicket ännu saknas — då saknas skicket, inte annonsen", () => {
  const m = missingForPublish({ identityStatus: "resolved", identity: { model: "X" }, result: null, pendingListing: { status: "ok", result: {}, improving: false } });
  assert.deepEqual(m, ["skickbedömning"]);
});
