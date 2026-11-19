// ─── Tradera: hemleveransen i kassan, inte i priset ─────────────────────────
//
// Från 2026-11-19 går möbelpriset till Tradera och hemleveransen som Traderas fraktkostnad. Före dess
// låg frakten i priset (gamingstolen: 500 kr möbel stod som 1 100 kr), och köparen såg ett annat pris
// än på hemsidan. Här prövas hela publiceringen mot en falsk Tradera: vad som skickas, vad som sparas
// på jobbet, och reserven när Tradera nekar fraktkostnaden.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-tradera-frakt-"));
const JOBS = path.join(rot, "jobs");
process.env.LOOPA_JOBS_DIR = JOBS;
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.OUTBOX_DIR = path.join(rot, "outbox");
process.env.TRADERA_APP_ID = "1";
process.env.TRADERA_APP_KEY = "k";
process.env.TRADERA_USER_ID = "2";
process.env.TRADERA_USER_TOKEN = "t";
process.env.TRADERA_LISTING_MODE = "fixed";
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { skrivJobb } = await import("./facebookFixtur.js");
const { getJob, persist } = await import("../server/src/jobStore.js");
const { markTraderaPublishing, planTraderaPublish, runTraderaPublish } = await import("../server/src/integrations/tradera/publish.js");

let lopnr = 0;
async function nyttJobb() {
  lopnr += 1;
  const id = `22222222-3333-4444-8555-${String(lopnr).padStart(12, "0")}`;
  skrivJobb(JOBS, { id });
  const job = (await getJob(id))!;
  job.sellerPostalCode = "11122";
  await persist(job);
  return job;
}

/** Falsk Tradera. `nekaFrakt` = första annonsen med fraktkostnad avvisas som ett riktigt valideringsfel. */
function falskTradera(opts: { nekaFrakt?: boolean } = {}) {
  const riktig = globalThis.fetch;
  const skickade: Array<Record<string, unknown>> = [];
  let publicerad: number | null = null;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const svar = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (u.endsWith("/listings/items") && init?.method === "POST") {
      const kropp = JSON.parse(String(init.body)) as Record<string, unknown>;
      skickade.push(kropp);
      const kostnad = (kropp.shippingOptions as Array<{ cost: number }>)[0].cost;
      if (opts.nekaFrakt && kostnad > 0) return svar({ errors: ["ShippingOptions: cost is not allowed for this shipping type"] }, 400);
      return svar({ requestId: 70 + skickade.length, itemId: 0 });
    }
    if (u.includes("/images")) return svar(null);
    if (u.endsWith("/commit")) {
      publicerad = 900 + skickade.length;
      return svar(null);
    }
    if (u.includes("/request-results")) return svar([]);
    if (u.endsWith("/listings/seller-items")) {
      const refs = skickade.at(-1)?.ownReferences;
      return svar(publicerad ? [{ id: publicerad, ownReferences: refs, itemLink: `https://www.tradera.com/item/1/${publicerad}/x` }] : []);
    }
    throw new Error(`oväntat anrop: ${init?.method ?? "GET"} ${u}`);
  }) as typeof fetch;
  return { skickade, aterstall: () => (globalThis.fetch = riktig) };
}

test("en ny Tradera-annons: möbelpriset i priset, hemleveransen som fraktkostnad, och texten säger det", async () => {
  const job = await nyttJobb();
  const plan = await planTraderaPublish(job);
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  const t = falskTradera();
  try {
    await markTraderaPublishing(job);
    await runTraderaPublish(job.id);
    const tr = (await getJob(job.id))!.tradera!;
    assert.equal(tr.status, "published", tr.error ?? "");
    assert.equal(t.skickade.length, 1);
    assert.equal(t.skickade[0].buyItNowPrice, plan.plan.itemPrice, "priset är bara möbeln");
    assert.deepEqual(t.skickade[0].shippingOptions, [{ shippingOptionId: 6, cost: plan.plan.shippingSek }]);
    assert.match(String(t.skickade[0].description), /tillkommer i kassan/);
    assert.doesNotMatch(String(t.skickade[0].description), /inräknad i priset/);
    assert.equal(tr.fraktSeparat, true);
    assert.equal(tr.pris?.bekraftat, plan.plan.itemPrice, "kvittot är möbelpriset, som förut");
  } finally {
    t.aterstall();
  }
});

test("nekar Tradera fraktkostnaden läggs annonsen upp på det gamla sättet — möbeln försvinner inte", async () => {
  const job = await nyttJobb();
  const plan = await planTraderaPublish(job);
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  const t = falskTradera({ nekaFrakt: true });
  try {
    await markTraderaPublishing(job);
    await runTraderaPublish(job.id);
    const tr = (await getJob(job.id))!.tradera!;
    assert.equal(tr.status, "published", tr.error ?? "");
    assert.equal(t.skickade.length, 2, "ett nekat försök, ett på det gamla sättet");
    assert.equal(t.skickade[1].buyItNowPrice, plan.plan.itemPrice + plan.plan.shippingSek, "frakten i priset");
    assert.deepEqual(t.skickade[1].shippingOptions, [{ shippingOptionId: 6, cost: 0 }]);
    assert.match(String(t.skickade[1].description), /inräknad i priset/);
    assert.equal(tr.fraktSeparat, false, "stegen ska sänka den här annonsen med frakten i priset");
  } finally {
    t.aterstall();
  }
});
