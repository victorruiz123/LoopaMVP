// ─── Redigera sin annons när den ligger ute ──────────────────────────────────
//
// Säljaren (och admin) kan ändra annonsen från annonsvyn även när den ligger ute — ändringen förs ut
// till Tradera, Blocket och Facebook (annonsUppdatering.ts). Det som låses fast:
//
// VEM FÅR. Ägaren allt; admin läsa allt och rätta annonsens uppgifter — inget annat; alla andra inget.
// PENNAN BARA DÄR ÄNDRINGEN NÅR UT. Med uppdateringen av är en publicerad annons låst, som förut.
// VYN VISAR DET SOM GÄLLER. Med uppdateringen på är det den aktuella texten, med frakten annonsen
// gick ut med — inte blocken som låg uppe innan ändringen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-egen-annons-"));
const JOBS = path.join(rot, "jobs");
process.env.LOOPA_JOBS_DIR = JOBS;
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.FACEBOOK_DATA_DIR = path.join(rot, "facebook");
delete process.env.ANNONS_UPPDATERING;
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { maRoraJobb } = await import("../server/src/jobbGrind.js");
const { annonstextForSaljaren } = await import("../server/src/annonsText.js");
const { skrivJobb } = await import("./facebookFixtur.js");
const { getJob, persist } = await import("../server/src/jobStore.js");
const overrides = await import("../server/src/butik/overrides.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const AGARE = { id: "user-1", isAdmin: false };
const ADMIN = { id: "admin-9", isAdmin: true };
const NAGON = { id: "user-2", isAdmin: false };
const jobb = { ownerId: "user-1" };
const v = (...s: string[]) => ["api", "jobs", "abc", ...s];

test("ägaren får allt, admin läser och rättar annonsen, alla andra ingenting", () => {
  assert.equal(maRoraJobb(jobb, AGARE, "POST", v("listing")), true);
  assert.equal(maRoraJobb(jobb, AGARE, "DELETE", v()), true);
  assert.equal(maRoraJobb(jobb, AGARE, "POST", v("tradera")), true);

  assert.equal(maRoraJobb(jobb, ADMIN, "GET", v()), true);
  assert.equal(maRoraJobb(jobb, ADMIN, "GET", v("adtext")), true);
  assert.equal(maRoraJobb(jobb, ADMIN, "POST", v("listing")), true, "admin rättar annonsens uppgifter");
  assert.equal(maRoraJobb(jobb, ADMIN, "POST", v("tradera")), false, "publicera är säljarens sak");
  assert.equal(maRoraJobb(jobb, ADMIN, "DELETE", v()), false, "ta bort är säljarens sak");
  assert.equal(maRoraJobb(jobb, ADMIN, "POST", v("listing", "x")), false);

  assert.equal(maRoraJobb(jobb, NAGON, "GET", v()), false);
  assert.equal(maRoraJobb(jobb, NAGON, "POST", v("listing")), false);
  assert.equal(maRoraJobb(null, ADMIN, "GET", v()), false, "ett jobb som inte finns");
});

let n = 0;
async function nyttJobb() {
  n += 1;
  const id = `22222222-2222-4333-8444-${String(n).padStart(12, "0")}`;
  skrivJobb(JOBS, { id });
  return (await getJob(id))!;
}

test("en annons som inte gått ut: texten som skulle gå upp, och den går att ändra", async () => {
  const job = await nyttJobb();
  const svar = await annonstextForSaljaren(job);
  assert.equal(svar?.published, false);
  assert.equal(svar?.redigerbar, true);
});

test("ute på Tradera med uppdateringen av: blocken som gick upp, låst", async () => {
  const job = await nyttJobb();
  const gamla = [{ kind: "p", text: "Texten som gick upp." }];
  job.tradera = { ...job.tradera!, status: "published", itemId: 1, adBlocks: gamla as never, shippingSek: 600 };
  await persist(job);
  const svar = await annonstextForSaljaren(job);
  assert.deepEqual(svar, { blocks: gamla, published: true, redigerbar: false });
});

test("ute med uppdateringen på: den aktuella texten, med rättelsen, och pennan", async () => {
  const job = await nyttJobb();
  job.tradera = { ...job.tradera!, status: "published", itemId: 1, adBlocks: [{ kind: "p", text: "Texten som gick upp." }] as never, shippingSek: 600 };
  await persist(job);
  await overrides.satt(loopaIdFor(job.id), { description: "Säljarens nya text om soffan." }, "user-1");
  process.env.ANNONS_UPPDATERING = "1";
  try {
    const svar = await annonstextForSaljaren(job);
    assert.equal(svar?.published, true);
    assert.equal(svar?.redigerbar, true);
    assert.match(JSON.stringify(svar?.blocks), /Säljarens nya text om soffan/);
    assert.doesNotMatch(JSON.stringify(svar?.blocks), /Texten som gick upp/);
  } finally {
    delete process.env.ANNONS_UPPDATERING;
  }
});

test("bara på Blocket med uppdateringen av: låst även där", async () => {
  const job = await nyttJobb();
  job.blocket = { status: "published", url: "https://www.blocket.se/1", receiptUrl: null, dryRun: false, error: null, startedAt: "x", publishedAt: "x", steps: [], shippingSek: 600 };
  await persist(job);
  const svar = await annonstextForSaljaren(job);
  assert.equal(svar?.published, true);
  assert.equal(svar?.redigerbar, false);
});
