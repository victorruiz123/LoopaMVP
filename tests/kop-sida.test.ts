// ─── Köpsidans egna löften ──────────────────────────────────────────────────
//
// Sidan lovar två saker i klartext, och båda går att bryta i kod utan att någon märker det:
//
//   "+200 kr serviceavgift + frakt från 495 kr. Inga överraskningar."
//        Talen måste komma från koden som RÄKNAR dem. En siffra skriven en gång till i en
//        komponent är en siffra som en dag säger något annat än kassan gör.
//
//   Fångaren tar bara en e-postadress.
//        Kravet var alltid "en väg att nå personen", inte "ett konto". Men sju konsumenter
//        filtrerade på userId, och en e-postefterlysning hade sparats och sedan aldrig bevakats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-kop-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const { SERVICE_FEE_SEK } = await import("../server/src/affar/fees.js");
const { ZONE_FEES, deliveryQuote } = await import("../server/src/butik/delivery.js");
const { nabar } = await import("../server/src/efterlysning/types.js");
const store = await import("../server/src/efterlysning/store.js");
const { seoFor } = await import("../server/src/butik/seo.js");

// ─── priset ─────────────────────────────────────────────────────────────────

test("zonavgifterna kommer ur zonerna, inte ur en lista bredvid", () => {
  // ZONE_FEES finns för att köpsidan ska kunna säga "från 495 kr" utan att skriva talet själv.
  for (const pn of ["11234", "16440", "18131"]) {
    assert.ok(ZONE_FEES.includes(deliveryQuote(pn).zone!.feeSek), `${pn} ska finnas i ZONE_FEES`);
  }
});

test("'frakt från' är den lägsta zonen, inte ett påhittat golv", () => {
  assert.equal(Math.min(...ZONE_FEES), 495);
  assert.ok(ZONE_FEES.every((a, i) => i === 0 || ZONE_FEES[i - 1] <= a), "sorterad");
});

test("serviceavgiften har ett ställe, och det är fees.ts", () => {
  assert.equal(typeof SERVICE_FEE_SEK, "number");
  assert.ok(SERVICE_FEE_SEK > 0);
});

// ─── nåbarhet ───────────────────────────────────────────────────────────────

test("ett konto räcker för att vara nåbar", () => {
  assert.equal(nabar({ userId: "u1", email: null }), true);
});

test("en e-postadress räcker också — det var alltid det kravet handlade om", () => {
  assert.equal(nabar({ userId: null, email: "a@b.se" }), true);
});

test("varken eller är inte nåbar", () => {
  assert.equal(nabar({ userId: null, email: null }), false);
  assert.equal(nabar({ userId: null, email: "   " }), false, "blanksteg är ingen adress");
});

test("fångarens efterlysning bevakas av sveparen", async () => {
  // Utan `nabar` hade den här raden sparats och sedan aldrig setts av någon.
  const e = await store.create({
    userId: null, email: "fangad@example.com",
    filter: { categorySlug: "stolar", maxPriceSek: 1500 },
    styleTags: [], deadline: null, urgency: "none", note: null,
    summary: "Stolar · max 1 500 kr", parseMethod: "form", area: null,
  });
  const oppna = (await store.open()).filter(nabar);
  assert.ok(oppna.some((x) => x.id === e.id));
});

// ─── SEO ────────────────────────────────────────────────────────────────────

test("/kop har titel, beskrivning och strukturerad FAQ", async () => {
  const head = await seoFor("/kop", "");
  assert.ok(head, "sidan ska ha ett huvud");
  assert.match(head!.title, /begagnade möbler tryggt/i);
  assert.match(head!.canonical, /\/kop$/);
  const ld = JSON.parse(head!.jsonLd!);
  assert.equal(ld["@type"], "FAQPage");
  assert.equal(ld.mainEntity.length, 3, "tre frågor, som på sidan");
});

test("FAQ-svaret om priset skriver INTE talen för hand", async () => {
  // Skulle någon hårdkoda 200 eller 495 här hade sökresultatet varit det som blev kvar längst efter
  // att siffran slutat stämma.
  const head = await seoFor("/kop", "");
  const ld = JSON.parse(head!.jsonLd!);
  const pris = ld.mainEntity.find((q: { name: string }) => /kostar/i.test(q.name));
  assert.ok(pris, "det ska finnas en prisfråga");
  assert.match(pris.acceptedAnswer.text, new RegExp(`${SERVICE_FEE_SEK} kr i serviceavgift`));
  assert.match(pris.acceptedAnswer.text, new RegExp(`från ${Math.min(...ZONE_FEES)} kr`));
});

test("brödtexten i kroppen är den enda texten, och den finns", async () => {
  const head = await seoFor("/kop", "");
  assert.match(head!.body!, /<h1>Hittat en möbel\? Köp den tryggt\.<\/h1>/);
  assert.match(head!.body!, /Vanliga frågor/);
});

test("säljverktygets startsida får INTE köpsidans huvud", async () => {
  // Grinden i seoFor. Utan den hade "/" presenterat sig som en köpsida för varje sökmotor.
  assert.equal(await seoFor("/", ""), null);
});
