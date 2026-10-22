// ─── Har en köpare skrivit? Reglerna, utan webbläsare ───────────────────────
//
// Veckans omläggning tar inte ner en annons som en köpare skrivit till (integrations/omlaggning.ts):
// Blocket läser ägarsidans räknare och inkorgen (blocket/meddelanden.ts), Tradera frågemejlen
// (tradera/fragor.ts). Den gamla annonsen ligger då kvar som en kvarlämnad annons, och är samma möbel:
// ett såld-mejl om den säljer möbeln (tradera/mailwatch.ts matchJob).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-meddelanden-jobs-"));
process.on("exit", () => rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true }));

const { bedomMeddelanden, raknareUrText, rubrikIText } = await import("../server/src/integrations/blocket/meddelanden.js");
const { fragorOmAnnonsen } = await import("../server/src/integrations/tradera/fragor.js");
const { matchJob } = await import("../server/src/integrations/tradera/mailwatch.js");
import type { ConditionJob } from "../server/src/types.js";

test("räknaren läses ur ägarsidans text som den såg ut skarpt 2026-10-21", () => {
  const skarp =
    "Hoppa till huvudinnehåll Mitt Blocket Mina annonser Svart IKEA NORDVIKEN barstol (62 cm) Hantera annons Granskas" +
    "Senast ändrad 21:a oktober 2026 Svart IKEA NORDVIKEN barstol (62 cm) Torget säljes 270,− Markera som såld" +
    "Ändra annonsenSe statistikTa bort Statistik Klick på annonsen 0 Sparad som favorit 0 Skickade meddelanden 0";
  assert.equal(raknareUrText(skarp), 0);
  assert.equal(raknareUrText("Statistik\nKlick på annonsen\n12\nSkickade meddelanden\n3"), 3);
  assert.equal(raknareUrText("Hantera annons — ingen statistik här"), null);
});

test("regeln: meddelanden i någon källa, eller en oläslig räknare, håller kvar annonsen", () => {
  assert.equal(bedomMeddelanden(0, 0).harMeddelanden, false);
  assert.equal(bedomMeddelanden(0, null).harMeddelanden, false, "räknaren är huvudkällan");
  assert.equal(bedomMeddelanden(1, 0).harMeddelanden, true);
  assert.equal(bedomMeddelanden(0, 1).harMeddelanden, true);
  assert.equal(bedomMeddelanden(null, 0).harMeddelanden, true, "oläslig räknare = hellre kvar");
});

test("konversationens rad känns igen på rubriken, inte på sista meddelandet", () => {
  assert.equal(rubrikIText("Svart IKEA NORDVIKEN barstol (62 cm)\nHej, finns stolen kvar?", "Svart IKEA NORDVIKEN barstol (62 cm)"), true);
  assert.equal(rubrikIText("(Annons)\nHej, finns stolen kvar?", "Svart IKEA NORDVIKEN barstol (62 cm)"), false);
  assert.equal(rubrikIText("Soffa mörkblå 3-sits\nPing", "Svart IKEA NORDVIKEN barstol (62 cm)"), false);
});

test("Tradera: bara frågor om JUST den annonsen räknas", () => {
  const poster = [
    { kind: "fraga" as const, itemId: 756963802 },
    { kind: "fraga" as const, itemId: 750200316 },
    { kind: "bud" as const, itemId: 756963802 },
  ];
  assert.equal(fragorOmAnnonsen(poster, 756963802), 1);
  assert.equal(fragorOmAnnonsen(poster, 111), 0);
});

test("ett mejl om en kvarlämnad Tradera-annons kopplas till möbeln", () => {
  const job = {
    id: "job-1",
    tradera: { status: "published", itemId: 756963802 },
    kvarlamnadeAnnonser: [{ kanal: "tradera", itemId: 756963478, url: null, pris: 320, lamnadAt: "2026-10-21T12:04:00Z", skal: "fråga" }],
  } as unknown as ConditionJob;
  assert.equal(matchJob({ itemId: 756963802, title: null }, [job])?.id, "job-1", "den aktuella");
  assert.equal(matchJob({ itemId: 756963478, title: null }, [job])?.id, "job-1", "den kvarlämnade");
  assert.equal(matchJob({ itemId: 1, title: null }, [job]), null);
});
