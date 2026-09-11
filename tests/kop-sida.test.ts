// ─── Köpsidans egna löften ──────────────────────────────────────────────────
//
// Sidan lovar två saker i klartext, och båda går att bryta i kod utan att någon märker det:
//
//   "+200 kr serviceavgift + 600 kr frakt. Inga överraskningar."
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
  // ZONE_FEES finns för att köpsidan ska kunna skriva ut fraktpriset utan att skriva talet själv.
  for (const pn of ["11234", "16440", "18131"]) {
    assert.ok(ZONE_FEES.includes(deliveryQuote(pn).zone!.feeSek), `${pn} ska finnas i ZONE_FEES`);
  }
});

/**
 * Fraktpriset är ETT tal i hela produkten.
 *
 * Tradera-annonserna skriver ut det i löptext ("Hemleveransen kostar 600 kr") och räknar in det i
 * annonspriset. Skiljer sig kassans tal från det säger annonsen fel — och det upptäcks av en köpare,
 * inte av oss.
 */
test("kassans frakt är samma tal som annonserna lovar, i varje zon", async () => {
  const { SHIPPING_INCLUDED_SEK } = await import("../server/src/integrations/tradera/shipping.js");
  assert.deepEqual([...new Set(ZONE_FEES)], [SHIPPING_INCLUDED_SEK]);
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
//
// KÖPSIDANS EGET SIDHUVUD ÄR BORTTAGET MED SIDAN. /kop bar en titel, en beskrivning och tre frågor
// som strukturerad FAQ; adressen 301:as numera till butiken (server.ts), och ett sidhuvud för en
// adress som svarar 301 vore ett löfte till sökmotorn om en sida som inte finns. Testerna som
// mätte det huvudet är därför borta — det som står kvar nedan är grinden, som fortfarande gäller.

test("/kop har inget sidhuvud längre — adressen är en omdirigering", async () => {
  assert.equal(await seoFor("/kop", ""), null);
  assert.equal(await seoFor("/kop/", ""), null);
});

test("butiken och efterfrågeväggen har kvar sina huvuden", async () => {
  // Grannarna ska inte ha följt med i raderingen: båda är riktiga sidor med riktiga länkar.
  assert.ok(await seoFor("/butik/sok", ""), "butikens sökning ska ha ett huvud");
  assert.ok(await seoFor("/efterlyses", ""), "efterfrågeväggen ska ha ett huvud");
});

test("säljverktygets startsida får INTE köpsidans huvud", async () => {
  /*
   * Grinden i seoFor. Utan den hade "/" presenterat sig som en köpsida — eller som butiken — för
   * varje sökmotor.
   *
   * Roten SAKNADE tidigare huvud helt, och det här testet låste fast just det. Den har ett eget
   * sedan märkessökningen "loopa" började landa här (se butik-seo.test.ts): påståendet är alltså
   * inte längre "inget huvud" utan "sitt eget huvud". Grinden testas precis lika hårt av det.
   */
  const head = await seoFor("/", "");
  assert.ok(head, "roten är sajtens startsida och måste bära ett huvud");
  assert.match(head.canonical, /\/$/, "roten kanoniseras som roten, inte som /kop eller /butik");
  assert.ok(!head.title.includes("Butik"), "startsidan är inte butikens landningssida");
  assert.ok(!/Köp begagnat/.test(head.description), "och den bär inte köpsidans löfte");
});
