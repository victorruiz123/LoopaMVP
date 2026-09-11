// ─── En knapp, två marknadsplatser ───────────────────────────────────────────
//
// "Godkänn och lägg ut" i panelen lägger ut möbeln i Butiken, på Tradera OCH på Blocket. Planen är
// det som avgör vad som faktiskt händer, och den är också grinden: är listan tom avvisas trycket med
// varje kanals eget skäl (se `godkann` i adminAnnonser.ts). Tre saker måste hålla, och alla tre går
// sönder tyst:
//
// EN KANAL FÄLLER INTE DEN ANDRA. Tradera-nycklarna saknas på den här servern. Hade en okonfigurerad
// kanal stoppat hela publiceringen gick ingenting alls att lägga ut — och felet hade sett ut som att
// Blocket inte fungerade.
//
// DET SOM REDAN LIGGER UPPE LÄGGS INTE UPP IGEN. Ett andra tryck ska publicera det som SAKNAS, inte
// dubblera möbeln på den kanal som redan tog emot den.
//
// TORRKÖRNINGEN SYNS I PLANEN. Utan BLOCKET_PUBLICERA=1 fylls Blockets formulär i men sista knappen
// trycks aldrig. Panelen måste kunna säga det INNAN någon godkänner: "publicerad" och "ifylld men
// inte publicerad" är olika besked till en säljare som väntar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna datamappar, satta INNAN modulerna läses in — sökvägarna läses vid import.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-autopub-jobs-"));
process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-autopub-butik-"));
const SESSIONSFIL = path.join(process.env.LOOPA_JOBS_DIR, "blocket-session.json");
writeFileSync(SESSIONSFIL, "{}");
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
});

const { planAutoPublish } = await import("../server/src/integrations/autoPublish.js");
import type { ConditionJob, TraderaPublication } from "../server/src/types.js";

function jobb(patch: Partial<ConditionJob> = {}): ConditionJob {
  return {
    id: "job-1",
    createdAt: "2026-09-11T09:00:00.000Z",
    error: null,
    result: null,
    progress: { stage: "done", message: "Klar" },
    ...patch,
  } as ConditionJob;
}

function traderaPub(patch: Partial<TraderaPublication>): TraderaPublication {
  return {
    status: "pending",
    requestId: null,
    itemId: null,
    url: null,
    error: null,
    startedAt: "2026-09-11T09:00:00.000Z",
    publishedAt: null,
    approvedAt: null,
    approvedBy: null,
    ...patch,
  };
}

/** Miljön nollställd runt varje fall — variablerna läses vid anrop, aldrig som konstanter. */
function medMiljo(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const fore = { ...process.env };
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (fore[k] === undefined) delete process.env[k];
      else process.env[k] = fore[k];
    }
  });
}

test("en okonfigurerad kanal fäller inte den andra — den rapporterar vad som fattas", async () => {
  await medMiljo(
    { BLOCKET_SESSION: undefined, BLOCKET_POSTNUMMER: undefined, TRADERA_APP_ID: undefined },
    async () => {
      const plan = await planAutoPublish(jobb());
      const blocket = plan.channels.find((c) => c.channel === "blocket")!;

      assert.equal(blocket.configured, false);
      assert.deepEqual(
        blocket.missingEnv,
        ["BLOCKET_SESSION", "BLOCKET_POSTNUMMER"],
        "raden ska säga VILKEN variabel som fattas — annars går felet inte att laga",
      );
      // Båda kanalerna finns kvar i listan. Att dölja en okonfigurerad kanal hade gjort en möbel som
      // gick ut på ett ställe mindre till något ingen kunde se.
      assert.deepEqual(plan.channels.map((c) => c.channel), ["tradera", "blocket"]);
    },
  );
});

test("det som redan ligger uppe läggs inte upp igen", async () => {
  await medMiljo({ BLOCKET_SESSION: SESSIONSFIL, BLOCKET_POSTNUMMER: "11234" }, async () => {
    const plan = await planAutoPublish(
      jobb({
        tradera: traderaPub({ status: "published", itemId: 42 }),
        blocket: {
          status: "published",
          url: "https://www.blocket.se/annons/1",
          receiptUrl: null,
          dryRun: false,
          error: null,
          startedAt: "2026-09-11T09:00:00.000Z",
          publishedAt: "2026-09-11T09:10:00.000Z",
          steps: [],
        },
      }),
    );

    for (const kanal of plan.channels) {
      assert.equal(kanal.alreadyRunning, true, `${kanal.channel} ligger uppe och ska hoppas över`);
    }
    assert.deepEqual(plan.willPublish, [], "ingenting att göra — och då avvisar godkännandet trycket");
  });
});

test("en torrkörning som redan gjorts stänger inte kanalen", async () => {
  await medMiljo({ BLOCKET_SESSION: SESSIONSFIL, BLOCKET_POSTNUMMER: "11234" }, async () => {
    const plan = await planAutoPublish(
      jobb({
        blocket: {
          status: "dry-run",
          url: null,
          receiptUrl: null,
          dryRun: true,
          error: null,
          startedAt: "2026-09-11T09:00:00.000Z",
          publishedAt: null,
          steps: [],
        },
      }),
    );
    const blocket = plan.channels.find((c) => c.channel === "blocket")!;
    // Torrkörningen lade inte upp något. Nästa körning ska kunna göra det på riktigt.
    assert.equal(blocket.alreadyRunning, false);
  });
});

test("torrkörningen syns i planen, och BLOCKET_PUBLICERA=1 stänger av den", async () => {
  await medMiljo(
    { BLOCKET_SESSION: SESSIONSFIL, BLOCKET_POSTNUMMER: "11234", BLOCKET_PUBLICERA: undefined },
    async () => {
      const plan = await planAutoPublish(jobb());
      assert.equal(plan.channels.find((c) => c.channel === "blocket")!.dryRun, true, "torrkörning är förvalet");
    },
  );

  await medMiljo(
    { BLOCKET_SESSION: SESSIONSFIL, BLOCKET_POSTNUMMER: "11234", BLOCKET_PUBLICERA: "1" },
    async () => {
      const plan = await planAutoPublish(jobb());
      assert.equal(plan.channels.find((c) => c.channel === "blocket")!.dryRun, false, "skarpt läge");
    },
  );

  // Tradera har ingen torrkörning: där finns ett API som svarar, och en annons går att ta ner igen.
  const plan = await planAutoPublish(jobb());
  assert.equal(plan.channels.find((c) => c.channel === "tradera")!.dryRun, false);
});
