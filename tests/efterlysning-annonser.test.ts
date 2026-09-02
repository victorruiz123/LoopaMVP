// ─── Efterfrågeannonser: aldrig autonoma ────────────────────────────────────
//
// Det som genereras är en SPEC, inte en publicering. En annons är Loopas ord i offentligheten på en
// budget som är riktiga pengar, och ett system som formulerar OCH publicerar dem själv kan säga
// saker vi inte står för till en publik vi inte valt.
//
// Två grindar bär det, med flit överlappande: flaggan skyddar mot att någon råkar slå på
// automatiken, godkännandet mot att automatiken kör på något ingen läst.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-annonser-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.DEMAND_ADS_MIN_UNMET = "2";
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const ads = await import("../server/src/efterlysning/demandAds.js");

const spec = (over = {}) => ({
  userId: "u1", email: "hemlig@example.com",
  filter: { categorySlug: "forvaring", brands: ["String"], maxPriceSek: 4000 },
  styleTags: [], deadline: null, urgency: "none" as const,
  note: "Måste gå in genom en smal dörr i Vasastan",
  summary: "", parseMethod: "chat" as const, area: "Södermalm",
  ...over,
});

test("utkast genereras bara över tröskeln för omättad efterfrågan", async () => {
  await store.create(spec({ userId: "a" }));
  assert.deepEqual(await ads.generateDrafts(), { created: 0, skipped: 0 }, "en ensam väntande räcker inte");
  await store.create(spec({ userId: "b" }));
  assert.equal((await ads.generateDrafts()).created, 1);
});

test("ett utkast ligger som DRAFT — ingenting publiceras", async () => {
  const [a] = await ads.list();
  assert.equal(a.state, "draft");
});

test("texten nämner aldrig en köpare", async () => {
  const [a] = await ads.list();
  const text = `${a.headline} ${a.body}`;
  assert.doesNotMatch(text, /hemlig@example\.com/);
  assert.doesNotMatch(text, /smal dörr/);
  assert.doesNotMatch(text, /Södermalm/, "ingen stadsdel — den pekar ut var köparen bor");
  assert.match(text, /2 köpare väntar/, "bara antalet");
});

test("budgeten är ett förslag, och ett lågt", async () => {
  const [a] = await ads.list();
  assert.ok(a.suggestedBudgetSek > 0 && a.suggestedBudgetSek <= 2000);
});

test("varje utkast bär en spårningsparameter", async () => {
  // En kampanj vars effekt inte går att mäta är en kampanj man inte kan avsluta.
  const [a] = await ads.list();
  assert.match(a.utm, /utm_campaign=/);
});

test("kampanjnamnet är läsbart i en URL", async () => {
  // Prisbandet skrivs med toLocaleString, som skiljer tusental med ett HÅRT mellanslag — det blev
  // %C2%A0 mitt i utm_campaign, giltigt men oläsligt i varje rapport parametern dyker upp i.
  const [a] = await ads.list();
  assert.doesNotMatch(a.utm, /%/, "inga procentkodade tecken i kampanjnamnet");
  assert.match(a.utm, /utm_campaign=[a-z0-9åäö-]+$/);
});

test("rubriken frågar efter EN möbel, på svenska", async () => {
  // Katalogens etiketter är plural ("Soffor & fåtöljer") eftersom de står över ett rutnät. "Har du
  // en soffor & fåtöljer?" är svenska ingen skriver.
  const [a] = await ads.list();
  assert.doesNotMatch(a.headline, /Har du en \w+or\b/, "ingen plural efter 'en'");
  assert.match(a.headline, /^Har du en /);
});

test("en andra körning fyller inte kön med dubbletter", async () => {
  const innan = (await ads.list()).length;
  await ads.generateDrafts();
  assert.equal((await ads.list()).length, innan);
});

test("ett kastat utkast kommer inte tillbaka", async () => {
  // Den som kastat en kampanj ska slippa se den igen nästa gång jobbet kör.
  const [a] = await ads.list("draft");
  await ads.decide(a.id, "rejected", "admin@loopa.nu");
  await ads.generateDrafts();
  assert.equal((await ads.list("draft")).length, 0);
});

test("ett beslut fattas en gång", async () => {
  const kastad = (await ads.list("rejected"))[0];
  const igen = await ads.decide(kastad.id, "approved", "admin@loopa.nu");
  assert.equal(igen?.state, "rejected", "ett godkännande i efterhand är ett annat beslut");
});

// ─── de två grindarna ───────────────────────────────────────────────────────

test("publicering är AV som förval", () => {
  assert.equal(ads.publishingEnabled(), false);
});

test("med flaggan av publiceras ingenting, ens en godkänd kampanj", async () => {
  await store.create(spec({ userId: "c", filter: { categorySlug: "bord", maxPriceSek: 3000 } }));
  await store.create(spec({ userId: "d", filter: { categorySlug: "bord", maxPriceSek: 3000 } }));
  await ads.generateDrafts();
  const utkast = (await ads.list("draft"))[0];
  await ads.decide(utkast.id, "approved", "admin@loopa.nu");
  assert.equal(await ads.markPublished(utkast.id), null, "flaggan är grinden");
});

test("med flaggan PÅ krävs fortfarande ett godkännande", async () => {
  const had = process.env.DEMAND_ADS_PUBLISH;
  process.env.DEMAND_ADS_PUBLISH = "1";
  try {
    await store.create(spec({ userId: "e", filter: { categorySlug: "stolar", maxPriceSek: 1500 } }));
    await store.create(spec({ userId: "f", filter: { categorySlug: "stolar", maxPriceSek: 1500 } }));
    await ads.generateDrafts();
    const oGodkand = (await ads.list("draft"))[0];
    assert.equal(await ads.markPublished(oGodkand.id), null, "utkast publiceras aldrig");
    await ads.decide(oGodkand.id, "approved", "admin@loopa.nu");
    assert.equal((await ads.markPublished(oGodkand.id))?.state, "published");
  } finally {
    if (had === undefined) delete process.env.DEMAND_ADS_PUBLISH; else process.env.DEMAND_ADS_PUBLISH = had;
  }
});

test("exporten bär bara godkända, och ingen köparidentitet", async () => {
  const csv = ads.toCsv((await ads.list()).filter((a) => a.state === "approved"));
  assert.doesNotMatch(csv, /hemlig@example\.com/);
  assert.doesNotMatch(csv, /smal dörr/);
  assert.match(csv.split("\n")[0], /^rubrik;text;malgrupp/);
});
