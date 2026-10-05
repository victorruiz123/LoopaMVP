// ─── Annonsgranskaren ────────────────────────────────────────────────────────
//
// Agenten väljer själv sina steg, så testet prövar inte VILKA steg den tar — det prövar loopen runt
// den. Fyra saker måste hålla oavsett vad modellen hittar på:
//
// BARA LÄSVERKTYG. Det finns inget verktyg som publicerar, godkänner eller ändrar. Spärren sitter i
// verktygslådan; en instruktion om att "inte publicera" hade bara varit en förhoppning.
// VARJE STEG HAMNAR I HISTORIKEN. Verktygets svar går tillbaka till modellen, bilderna med.
// REKOMMENDATIONEN AVSLUTAR och sparas.
// TAKET HÅLLER. En modell som aldrig bestämmer sig ger ett fel, inte en evig loop eller en gissning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.GRANSKNING_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-granskning-"));
process.env.GRANSKNING_MAX_VARV = "4";
process.on("exit", () => rmSync(process.env.GRANSKNING_DATA_DIR!, { recursive: true, force: true }));

const { granskaAnnons, VERKTYG, giltigtPostnummer } = await import("../server/src/granskning/agent.js");
const { hamtaGranskning } = await import("../server/src/granskning/store.js");

const underlag = async () => ({
  job: {} as never,
  annons: { rubrik: "Stor silvrig väggspegel från Chilli", annonstext: "En spegel." },
  bilder: [],
  postnummer: { postnummer: "12454", kalla: "jobb" },
});

/** En modell som följer ett manus: ett verktygsanrop per varv. */
function manus(anrop: Array<{ name: string; args?: Record<string, unknown> }>) {
  const historiker: unknown[][] = [];
  let i = 0;
  return {
    historiker,
    nastaDrag: async (historik: unknown[]) => {
      historiker.push(structuredClone(historik));
      const a = anrop[Math.min(i++, anrop.length - 1)];
      const fc = { id: `c${i}`, name: a.name, args: a.args ?? {} };
      return { candidates: [{ content: { role: "model", parts: [{ functionCall: fc }] } }], functionCalls: [fc], usageMetadata: { totalTokenCount: 100 } };
    },
  };
}

test("verktygslådan innehåller bara läsning och ett sätt att avsluta", () => {
  assert.deepEqual(
    VERKTYG.map((v) => v.name).sort(),
    ["kontrollera_postnummer", "lamna_rekommendation", "las_annonsen", "lista_kategorier", "visa_bilder"],
  );
});

test("agenten läser, får svaret i historiken, och avslutar med sin rekommendation", async () => {
  const m = manus([
    { name: "las_annonsen" },
    { name: "kontrollera_postnummer" },
    {
      name: "lamna_rekommendation",
      args: { beslut: "godkann_inte", sammanfattning: "Bilden visar inte möbeln.", problem: [{ omrade: "bilder", vad: "Fel bild", forslag: "Byt bild" }] },
    },
  ]);
  const g = await granskaAnnons("LP-TEST-0001", "test", { hamtaUnderlag: underlag, nastaDrag: m.nastaDrag as never });

  assert.equal(g.status, "klar");
  assert.equal(g.beslut, "godkann_inte");
  assert.deepEqual(g.problem, [{ omrade: "bilder", vad: "Fel bild", forslag: "Byt bild" }]);
  assert.deepEqual(g.steg.map((s) => s.verktyg), ["las_annonsen", "kontrollera_postnummer", "lamna_rekommendation"]);
  assert.equal(g.tokens, 300);

  // Varv 2 såg svaret från varv 1: modellens anrop och verktygets svar ligger sist i historiken.
  const andra = m.historiker[1] as Array<{ role: string; parts: Array<Record<string, any>> }>;
  assert.equal(andra.length, 3);
  assert.equal(andra[2].parts[0].functionResponse.name, "las_annonsen");
  assert.equal(andra[2].parts[0].functionResponse.response.rubrik, "Stor silvrig väggspegel från Chilli");

  assert.equal((await hamtaGranskning("LP-TEST-0001"))?.beslut, "godkann_inte");
});

test("en modell som aldrig bestämmer sig stoppas vid taket och ger ett fel, inte en gissning", async () => {
  const m = manus([{ name: "las_annonsen" }]);
  const g = await granskaAnnons("LP-TEST-0002", "test", { hamtaUnderlag: underlag, nastaDrag: m.nastaDrag as never });
  assert.equal(g.status, "fel");
  assert.equal(g.beslut, null);
  assert.match(g.fel ?? "", /Ingen rekommendation efter 4 varv/);
  assert.equal(m.historiker.length, 4);
});

test("ett okänt beslut tolkas som 'godkänn inte' — tveksamt är inte godkänt", async () => {
  const m = manus([{ name: "lamna_rekommendation", args: { beslut: "kanske", sammanfattning: "?", problem: [] } }]);
  const g = await granskaAnnons("LP-TEST-0003", "test", { hamtaUnderlag: underlag, nastaDrag: m.nastaDrag as never });
  assert.equal(g.beslut, "godkann_inte");
});

test("postnumret: fem siffror, första inte noll", () => {
  assert.equal(giltigtPostnummer("12454"), true);
  assert.equal(giltigtPostnummer("124 54"), true);
  assert.equal(giltigtPostnummer("02454"), false);
  assert.equal(giltigtPostnummer("1245"), false);
  assert.equal(giltigtPostnummer(null), false);
});
