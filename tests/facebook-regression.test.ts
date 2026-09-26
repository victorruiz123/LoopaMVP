// ─── Facebook rör inte de andra kanalerna ───────────────────────────────────
//
// Tradera och Blocket publiceras som förut: planen för "Godkänn och lägg ut" känner fortfarande bara
// till de två, och Facebook hakar på butikens live-övergång i stället för att stå i planen. Ett
// Facebook-fel får aldrig hindra möbeln från att bli live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbreg-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbreg-butik-"));
process.env.FACEBOOK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fbreg-fb-"));
const SESSIONSFIL = path.join(process.env.LOOPA_JOBS_DIR, "blocket-session.json");
writeFileSync(SESSIONSFIL, "{}");
process.on("exit", () => {
  for (const d of [process.env.LOOPA_JOBS_DIR!, process.env.BUTIK_DATA_DIR!, process.env.FACEBOOK_DATA_DIR!]) rmSync(d, { recursive: true, force: true });
});

const { planAutoPublish } = await import("../server/src/integrations/autoPublish.js");
const { ensureRecord, publish, onPublished } = await import("../server/src/butik/store.js");
const { enqueueMarketplace, getMarketplace } = await import("../server/src/integrations/facebook/store.js");
import type { ConditionJob } from "../server/src/types.js";

test("publiceringsplanen: Tradera och Blocket som förut, Facebook som en tredje rad som aldrig körs härifrån", async () => {
  process.env.BLOCKET_SESSION = SESSIONSFIL;
  const job = { id: "job-reg", createdAt: "2026-09-11T09:00:00.000Z", error: null, result: null, progress: { stage: "done", message: "Klar" } } as unknown as ConditionJob;
  const plan = await planAutoPublish(job);
  assert.deepEqual(plan.channels.map((c) => c.channel), ["tradera", "blocket", "facebook"]);
  assert.equal(plan.channels.find((c) => c.channel === "blocket")?.dryRun, true, "Blockets torrkörning är fortfarande förvalet");
  // Utan FACEBOOK_ENABLED är Facebook-raden avstängd och står inte bland dem som körs.
  const fb = plan.channels.find((c) => c.channel === "facebook")!;
  assert.equal(fb.configured, false);
  assert.deepEqual(fb.missingEnv, ["FACEBOOK_ENABLED"]);
  assert.ok(!plan.willPublish.includes("facebook"));
  // runAutoPublish rör aldrig Facebook — kön gör det. Låst i källan, som server.ts-kopplingen.
  const src = (await import("node:fs")).readFileSync((await import("node:path")).resolve("server/src/integrations/autoPublish.ts"), "utf-8");
  assert.ok(src.includes('if (channel === "facebook") continue;'), "Facebook hoppas över i runAutoPublish");
});

test("live-övergången kallar lyssnarna, och en lyssnare som faller fäller inte publiceringen", async () => {
  const hört: string[] = [];
  const av1 = onPublished(() => {
    throw new Error("Facebook nere");
  });
  const av2 = onPublished((r) => {
    hört.push(r.id);
  });
  try {
    await ensureRecord("LP-REG-0001", "job-reg", "loopa", new Date().toISOString());
    const moved = await publish("LP-REG-0001", { kind: "admin", userId: "a" });
    assert.equal(moved?.state, "live", "möbeln är live trots att en lyssnare kastade");
    assert.deepEqual(hört, ["LP-REG-0001"], "de andra lyssnarna nås ändå");
    const igen = await publish("LP-REG-0001", { kind: "admin", userId: "a" });
    assert.equal(igen, null, "andra publiceringen är ingen övergång och kallar ingen");
    assert.equal(hört.length, 1);
  } finally {
    av1();
    av2();
  }
});

test("utan FACEBOOK_ENABLED köas ingenting — och Facebook-lagret rörs inte", async () => {
  delete process.env.FACEBOOK_ENABLED;
  const { onListingLive, enqueueForListing } = await import("../server/src/integrations/facebook/queue.js");
  onListingLive("LP-REG-0002", "job-x");
  const r = await enqueueForListing("LP-REG-0002", "job-x");
  assert.equal(r.marketplace, "skipped");
  assert.match(r.reason ?? "", /FACEBOOK_ENABLED/);
  assert.equal(await getMarketplace("LP-REG-0002"), null);
  // Lagret själv fungerar oberoende av flaggan.
  const { created } = await enqueueMarketplace("LP-REG-0003", "job-y", true);
  assert.equal(created, true);
});
