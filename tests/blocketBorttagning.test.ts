// ─── Blockets borttagning, körd mot attrappen ────────────────────────────────
//
// Veckans omläggning tar ner Blocket-annonsen och lägger upp den igen med det sänkta priset
// (integrations/omlaggning.ts). Uppläggningen är den vanliga publiceringen. Nedtagningen är en robot
// (integrations/blocket/borttagning.ts), och en borttagen annons går inte att få tillbaka — därför
// sex saker som måste hålla:
//
// RÄTT ANNONS. Bara vårt kort, och bara när rubriken på kortet är vår. En annan annons på kontot rörs
// inte.
//
// ALDRIG "SÅLD". Varken knappen "Markera som såld" eller ett skäl som säger att möbeln sålts.
//
// TORRKÖRNINGEN KLICKAR INTE. Den hittar valet och stannar — även när valet hade verkställt direkt.
//
// VERIFIERAT. Annonsen räknas nere först när den inte längre står bland de aktiva; står den kvar
// kastar roboten, och ingen ny läggs upp.
//
// REDAN BORTA ÄR INGET FEL. En annons som gått ut har inget att ta ner, och omläggningen går vidare.
//
// SPÄRREN. Utan BLOCKET_TA_BORT_ROBOT=1 och skarp publicering läggs Blocket inte om, och roboten startar
// ingen webbläsare.
//
// VAD TESTERNA INTE BEVISAR: att Blockets meny och dialog ser ut så här. Attrappen speglar plattformen
// (FINN: "tre prickar → Slette") och de varianter som är troliga. Torrkörningen mot riktiga Blocket
// (npm run blocket:ta-bort -- <jobId>) är det som svarar på det.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-blocketbort-jobs-"));
process.env.BLOCKET_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-blocketbort-data-"));
const SESSIONSFIL = path.join(process.env.LOOPA_JOBS_DIR, "blocket-session.json");
writeFileSync(SESSIONSFIL, JSON.stringify({ cookies: [], origins: [] }));
process.env.BLOCKET_SESSION = SESSIONSFIL;
delete process.env.BLOCKET_PUBLICERA;
delete process.env.BLOCKET_TA_BORT_ROBOT;
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.BLOCKET_DATA_DIR!, { recursive: true, force: true });
});

const { startaAttrapp } = await import("./blocketAttrapp.js");
const { startBrowser } = await import("../server/src/integrations/blocket/browser.js");
const { blocketOmlaggningKlar, driveBlocketBorttagning, taNerBlocketAnnons } = await import("../server/src/integrations/blocket/borttagning.js");
import type { Attrapp, AttrappOptions } from "./blocketAttrapp.js";
import type { ConditionJob } from "../server/src/types.js";

const ANNONS = { id: "24720589", rubrik: "IKEA Strandmon fåtölj i grått", pris: 1800 };
const ANNAN = { id: "24720590", rubrik: "Bokhylla Karamel från Hannah Home", pris: 900 };

interface Korning {
  attrapp: Attrapp;
  resultat: Awaited<ReturnType<typeof driveBlocketBorttagning>> | null;
  fel: Error | null;
  steg: string[];
}

async function kor(opts: { dryRun: boolean; title?: string | null; attrapp?: AttrappOptions; annonser?: AttrappOptions["annonser"] }): Promise<Korning> {
  // Kopior: attrappen märker en borttagen annons inaktiv på objektet.
  const annonser = (opts.annonser ?? [ANNONS, ANNAN]).map((a) => ({ ...a }));
  const attrapp = await startaAttrapp({ annonser, ...(opts.attrapp ?? {}) });
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const steg: string[] = [];
  const session = await startBrowser();
  let resultat: Korning["resultat"] = null;
  let fel: Error | null = null;
  try {
    resultat = await driveBlocketBorttagning(
      session.page,
      { adUrl: `${attrapp.bas}/${ANNONS.id}`, title: opts.title === undefined ? ANNONS.rubrik : opts.title, dryRun: opts.dryRun },
      (name) => steg.push(name),
    );
  } catch (err) {
    fel = err instanceof Error ? err : new Error(String(err));
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
  return { attrapp, resultat, fel, steg };
}

test("torrkörningen hittar 'Ta bort annonsen' i kortets meny och klickar inte", async () => {
  const k = await kor({ dryRun: true });
  assert.equal(k.fel, null, k.fel?.message);
  assert.equal(k.resultat!.status, "torrkorning");
  assert.equal(k.resultat!.vag, "Mina annonser → kortets meny");
  assert.deepEqual(k.attrapp.lage.borttagna, []);
  assert.deepEqual(k.attrapp.lage.markeradeSalda, []);
});

test("torrkörningen klickar inte ens när valet hade verkställt direkt", async () => {
  const k = await kor({ dryRun: true, attrapp: { borttagningUtanDialog: true } });
  assert.equal(k.resultat!.status, "torrkorning");
  assert.deepEqual(k.attrapp.lage.borttagna, []);
});

test("skarpt: menyn → Ta bort → bekräftelsen, och annonsen står inte längre bland de aktiva", async () => {
  const k = await kor({ dryRun: false });
  assert.equal(k.fel, null, k.fel?.message);
  assert.equal(k.resultat!.status, "borttagen");
  assert.deepEqual(k.attrapp.lage.borttagna, [{ id: ANNONS.id, skal: null }]);
  assert.deepEqual(k.attrapp.lage.markeradeSalda, [], "Markera som såld klickas aldrig");
  // Uppmätt 2026-10-20: varje kort har en egen dold <dialog>. Roboten tog förut den första (dolda),
  // såg "ingen dialog", bekräftade aldrig — och annonsen stod kvar på riktiga Blocket.
  assert.ok(k.steg.includes("Bekräftade"), `bekräftelsen i den SYNLIGA dialogen klickades: ${k.steg.join(" | ")}`);
});

test("bara vår annons tas bort — den andra på kontot står kvar", async () => {
  const k = await kor({ dryRun: false });
  assert.equal(k.attrapp.lage.borttagna.length, 1);
  assert.equal(k.attrapp.lage.borttagna[0].id, ANNONS.id);
});

test("frågar dialogen efter ett skäl väljs ett som inte säger 'såld'", async () => {
  const k = await kor({ dryRun: false, attrapp: { borttagningFragarSkal: true } });
  assert.equal(k.fel, null, k.fel?.message);
  assert.deepEqual(k.attrapp.lage.borttagna, [{ id: ANNONS.id, skal: "Vill inte sälja längre" }]);
});

test("verkställer valet direkt, utan bekräftelse, räknas det ändå — efter kontrollen", async () => {
  const k = await kor({ dryRun: false, attrapp: { borttagningUtanDialog: true } });
  assert.equal(k.fel, null, k.fel?.message);
  assert.equal(k.resultat!.status, "borttagen");
});

test("står annonsen kvar bland de aktiva efteråt kastar roboten", async () => {
  const k = await kor({ dryRun: false, attrapp: { borttagningFastnar: true } });
  assert.match(k.fel?.message ?? "", /står kvar bland de aktiva/);
});

test("rubrikvakten: ett kort med en annan rubrik rörs inte", async () => {
  const k = await kor({ dryRun: false, title: "Soffa Ektorp tresits" });
  assert.match(k.fel?.message ?? "", /inte "Soffa Ektorp tresits"/);
  assert.deepEqual(k.attrapp.lage.borttagna, []);
});

test("en annons som inte står bland de aktiva är redan borta — inget fel, inget klick", async () => {
  const k = await kor({ dryRun: false, annonser: [{ ...ANNONS, aktiv: false }, ANNAN] });
  assert.equal(k.fel, null, k.fel?.message);
  assert.equal(k.resultat!.status, "redan-borta");
  assert.deepEqual(k.attrapp.lage.borttagna, []);
});

test("reservvägen: saknar kortets meny valet tas annonsen bort från ägarsidan", async () => {
  const k = await kor({ dryRun: false, attrapp: { borttagningBaraPaAgarsidan: true } });
  assert.equal(k.fel, null, k.fel?.message);
  assert.equal(k.resultat!.vag, "ägarsidan");
  assert.deepEqual(k.attrapp.lage.borttagna, [{ id: ANNONS.id, skal: null }]);
});

test("spärren: skarp publicering krävs alltid; BLOCKET_TA_BORT_ROBOT osatt följer den, 0 stänger av", async () => {
  assert.equal(blocketOmlaggningKlar(), false, "publiceringen torrkör — aldrig en omläggning");
  process.env.BLOCKET_TA_BORT_ROBOT = "1";
  try {
    assert.equal(blocketOmlaggningKlar(), false, "skarp publicering krävs också");
    process.env.BLOCKET_PUBLICERA = "1";
    process.env.BLOCKET_BAS_URL = "http://127.0.0.1:1";
    assert.equal(blocketOmlaggningKlar(), true);
    delete process.env.BLOCKET_TA_BORT_ROBOT;
    assert.equal(blocketOmlaggningKlar(), true, "osatt följer BLOCKET_PUBLICERA — omläggningen ersätter prisändringen");
    process.env.BLOCKET_TA_BORT_ROBOT = "0";
    assert.equal(blocketOmlaggningKlar(), false, "0 stänger av den ensam");
  } finally {
    delete process.env.BLOCKET_TA_BORT_ROBOT;
    delete process.env.BLOCKET_PUBLICERA;
  }
  const job = {
    id: "bort-1",
    blocket: { status: "published", url: "https://www.blocket.se/24720589", receiptUrl: null, dryRun: false, error: null, startedAt: "", publishedAt: "", steps: [] },
  } as unknown as ConditionJob;
  await assert.rejects(taNerBlocketAnnons(job), /Borttagningsroboten är av/);
});
