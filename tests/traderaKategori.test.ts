// ─── Tradera-kategorin: speglar är inte möbler ───────────────────────────────
//
// En spegel hamnade i "Övriga möbler" — Hem & Hushåll > Möbler — där ingen som letar spegel tittar.
// Säljarna på Tradera lägger dem i Inredningsdetaljer > Övriga inredningsdetaljer (340959). Men en
// möbel MED spegel är fortfarande en möbel, och den regeln får inte gå förlorad på vägen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { traderaCategoryFor } from "../server/src/integrations/tradera/mapping.js";

test("en väggspegel blir en inredningsdetalj, inte en möbel", () => {
  // Fälten precis som Anjelikas Chilli-spegel har dem.
  const c = traderaCategoryFor({
    strong: ["Spegel", "Väggspegel", "Stor silvrig väggspegel från Chilli", null],
    weak: ["Säljer en fin och stilren väggspegel från Chilli med dekorativ silverfärgad ram."],
  });
  assert.equal(c.id, 340959);
});

test("golvspegel och hallspegel likaså", () => {
  assert.equal(traderaCategoryFor({ strong: ["Golvspegel i ek"] }).id, 340959);
  assert.equal(traderaCategoryFor({ strong: ["Hallspegel med guldram"] }).id, 340959);
});

test("en möbel med spegel är fortfarande möbeln", () => {
  assert.equal(traderaCategoryFor({ strong: ["Garderob med spegeldörrar"] }).id, 302548);
  assert.equal(traderaCategoryFor({ strong: ["Byrå med spegel"] }).id, 302547);
  assert.equal(traderaCategoryFor({ strong: ["Spegelskåp till badrummet"] }).id, 302547);
});

test("en spegel som bara nämns i brödtexten flyttar inte en soffa", () => {
  assert.equal(
    traderaCategoryFor({ strong: ["3-sits soffa"], weak: ["Passar fint under en stor spegel"] }).id,
    302537,
  );
});
