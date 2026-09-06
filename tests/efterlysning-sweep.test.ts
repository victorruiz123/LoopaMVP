// ─── Direktsvepet och prognosen ─────────────────────────────────────────────
//
// "Aldrig noll" är ett produktkrav, inte en ambition: den som just beskrivit sin soffa och möts av
// "inga träffar" har fått veta att tjänsten inte fungerar. Men generöst får inte betyda oärligt, och
// framför allt får det inte betyda att en hård gräns böjs — en kompromiss man inte kan ha hemma är
// ingen kompromiss.
//
// Prognosen prövas separat: den ska vara TYST tills den har riktig data att räkna på.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-sweep-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.EFTERLYSNING_FORECAST_MIN = "3";
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const { forecastFor } = await import("../server/src/efterlysning/sweep.js");

const spec = (over = {}) => ({
  userId: "u1", email: null,
  filter: { categorySlug: "soffor", maxPriceSek: 5000 },
  styleTags: [], deadline: null, urgency: "none" as const, note: null,
  summary: "", parseMethod: "form" as const, area: null,
  ...over,
});

test("prognosen är tyst tills den har data — inga påhittade siffror", async () => {
  const e = await store.create(spec());
  assert.equal(await forecastFor(e), null);
});

test("under tröskeln säger vi fortfarande ingenting", async () => {
  const e = await store.create(spec());
  await store.logMatches([{ efterlysningId: e.id, productId: "x", source: "loopa_live", kind: "exact", fitNote: "" }]);
  assert.equal(await forecastFor(e), null, "en mätpunkt är inte en prognos");
});

test("över tröskeln räknas medianen ur riktiga matchningar", async () => {
  // Tre efterlysningar med känd väntetid: 2, 6 och 10 dagar -> median 6.
  const made: string[] = [];
  for (const days of [2, 6, 10]) {
    const e = await store.create(spec());
    const created = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await store.update(e.id, { createdAt: created });
    await store.logMatches([{ efterlysningId: e.id, productId: `p${days}`, source: "tradera", kind: "exact", fitNote: "" }]);
    const m = (await store.matchesFor(e.id))[0];
    m.foundAt = new Date(new Date(created).getTime() + days * 86_400_000).toISOString();
    made.push(e.id);
  }
  const target = await store.create(spec());
  const line = await forecastFor(target);
  assert.ok(line, "nu finns det underlag");
  assert.match(line!, /inom 6 dagar/);
  assert.match(line!, /Soffor/);
  assert.equal(made.length, 3);
});

test("en annan kategoris väntetid smittar inte", async () => {
  const lamp = await store.create(spec({ filter: { categorySlug: "belysning", maxPriceSek: 500 } }));
  assert.equal(await forecastFor(lamp), null, "belysning har ingen egen historik");
});
