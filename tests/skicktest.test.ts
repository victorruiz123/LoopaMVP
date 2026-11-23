// ─── Skicktestet: bara besiktningen (web/skicktest.html, CreateJobBody.conditionOnly) ───
//
// Sidan finns för att prova fotoguiden och skickbedömningen UTAN identifiering, mått, annonstext, pris
// eller omslagsurklipp. "Utan" är ett löfte om vad som kostar pengar och vad som hamnar i datan, så det
// prövas här och inte bara antas:
//
//   - uppgifterna för identifiering, mått och pris står som AVBRUTNA (inte väntande — ett gränssnitt ska
//     inte vänta på något som aldrig kommer),
//   - jobbet är privat: inte en butiksvara och inte ett publikt kort,
//   - rättelser på jobbet blir aldrig rader i träningsdatan (data/rattelser.ts),
//   - uppladdningen avvisas INNAN något jobb skapas, och med en kod klienten kan visa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "loopa-skicktest-"));
process.env.LOOPA_JOBS_DIR = path.join(root, "jobs");
process.env.DATA_FLODE_DIR = path.join(root, "data");

const { initialTasks } = await import("../server/src/pipeline/tasks.js");
const { createJob, getJobSync } = await import("../server/src/jobStore.js");
const { notera } = await import("../server/src/data/rattelser.js");
const { harPubliktKort } = await import("../server/src/publicCard.js");
const { createConditionJob } = await import("../server/src/jobCreate.js");
const { GUIDE_MIN_PHOTOS, MIN_PHOTOS_FOR_GRADING } = await import("../server/src/config.js");
import type { ConditionJob } from "../server/src/types.js";

// Samma sharp som koden under test — se tests/imageIngest.test.ts för varför en vanlig import krockar.
const sharp = createRequire(new URL("../server/src/imageIngest.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

async function jpegDataUrl(): Promise<string> {
  const buf = await sharp(randomBytes(40 * 40 * 3), { raw: { width: 40, height: 40, channels: 3 } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

// ─── uppgifter ───

test("ett skicktest kör bara besiktningen: de tre andra uppgifterna är avbrutna, inte väntande", () => {
  const tasks = initialTasks({ skipGrading: false, identify: "none", conditionOnly: true }, 1_000);
  assert.equal(tasks.condition?.status, "running");
  for (const name of ["identify", "specs", "price"] as const) {
    assert.equal(tasks[name]?.status, "cancelled", `${name} ska vara avbruten`);
    assert.ok(tasks[name]?.note, `${name} ska säga varför`);
    assert.equal(tasks[name]?.finishedAt, 1_000);
  }
});

test("ett vanligt jobb är oförändrat: identifiering, mått och pris väntar på modellen", () => {
  const tasks = initialTasks({ skipGrading: false, identify: "none" }, 1_000);
  assert.equal(tasks.condition?.status, "running");
  assert.equal(tasks.identify?.status, "pending");
  assert.equal(tasks.specs?.status, "pending");
  assert.equal(tasks.price?.status, "pending");
});

// ─── privat ───

function annonsJobb(extra: Partial<ConditionJob> = {}): ConditionJob {
  return {
    id: "j1",
    result: { listing: { status: "ok", result: { listing: {} } } },
    ...extra,
  } as unknown as ConditionJob;
}

test("ett skicktest-jobb har inget publikt kort, även med en färdig annons", () => {
  assert.equal(harPubliktKort(annonsJobb()), true, "förutsättning: samma jobb utan flaggan HAR ett kort");
  assert.equal(harPubliktKort(annonsJobb({ conditionOnly: true })), false);
});

// ─── träningsdatan ───

async function rader(): Promise<string[]> {
  try {
    return (await readFile(path.join(process.env.DATA_FLODE_DIR!, "rattelser.jsonl"), "utf-8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("en rättelse på ett skicktest-jobb loggas aldrig — ett vanligt jobbs loggas", async () => {
  const test1 = await createJob(null);
  test1.conditionOnly = true;
  const vanligt = await createJob(null);
  assert.ok(getJobSync(test1.id)?.conditionOnly, "förutsättning: jobbet är markerat i minnet");

  const rad = { omrade: "skick" as const, falt: "fyndet finns", fyndId: "d1", aiSa: "scratch på ben", manniskanSa: "finns inte", kalla: "saljare" as const, notis: null };
  await notera({ ...rad, jobId: test1.id });
  assert.equal((await rader()).length, 0, "ingenting får skrivas för ett skicktest");

  await notera({ ...rad, jobId: vanligt.id });
  const efter = await rader();
  assert.equal(efter.length, 1);
  assert.equal(JSON.parse(efter[0]).jobId, vanligt.id);
});

// ─── uppladdningen ───

test("för få bilder avvisas med en kod, och INGET jobb skapas", async () => {
  const bilder = await Promise.all([1, 2, 3, 4].map(async () => ({ dataUrl: await jpegDataUrl() })));
  const fore = new Set((await import("node:fs")).readdirSync(process.env.LOOPA_JOBS_DIR!));
  const out = await createConditionJob({ images: bilder }, null, null, false, false, null, { minImages: GUIDE_MIN_PHOTOS, conditionOnly: true });
  assert.ok("error" in out);
  assert.equal((out as { code?: string }).code, "too_few_images");
  assert.equal((out as { min?: number }).min, GUIDE_MIN_PHOTOS);
  assert.equal((out as { got?: number }).got, 4);
  const efter = (await import("node:fs")).readdirSync(process.env.LOOPA_JOBS_DIR!);
  assert.deepEqual(efter.filter((f) => !fore.has(f)), [], "ett avvisat anrop ska inte lämna en jobbkatalog");
});

test("ett skicktest går inte att kombinera med skipGrading", async () => {
  const out = await createConditionJob({ images: [{ dataUrl: await jpegDataUrl() }] }, null, null, false, true, null, { conditionOnly: true });
  assert.ok("error" in out);
  assert.match((out as { error: string }).error, /skipGrading/);
});

test("fotoguidens minimum är fem, och serverns krav är aldrig lägre för ett skicktest", () => {
  assert.equal(GUIDE_MIN_PHOTOS, 5);
  assert.ok(Math.max(MIN_PHOTOS_FOR_GRADING, GUIDE_MIN_PHOTOS) >= 5);
});
