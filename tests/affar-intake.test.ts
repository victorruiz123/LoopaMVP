// ─── Köparens intag: två adaptrar, ett gränssnitt ───────────────────────────
//
// Poängen med adapterlagret är att LINK_FETCH ska gå att slå på utan att något nedströms ändrar
// form. Testerna nedan låser fast valet mellan adaptrarna, att stubben säger ifrån i stället för att
// tyst falla tillbaka, och att annonsens adress aldrig blir något annat än en referens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AFFAR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-intake-test-"));
process.on("exit", () => rmSync(process.env.AFFAR_DATA_DIR!, { recursive: true, force: true }));

const { normalizeAdUrl, adapterFor, manualContent, linkFetch, linkFetchEnabled, MAX_AD_IMAGES } =
  await import("../server/src/affar/intake.js");
const { priceVerdict } = await import("../server/src/affar/assess.js");
// sharp ligger i server/node_modules och testerna körs från roten. Samma upplösning som
// tests/cutout.test.ts använder — en require som utgår från en fil INNE i server.
const { createRequire } = await import("node:module");
const sharp = createRequire(new URL("../server/src/affar/intake.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

/** En riktig, pytteliten JPEG. getImageDimensions läser den, så den måste vara giltig. */
async function jpegDataUrl(): Promise<string> {
  const buf = await sharp({ create: { width: 12, height: 9, channels: 3, background: "#888" } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

// ─── annonsens adress ───────────────────────────────────────────────────────

test("adressen sparas som referens, inte som något att hämta", () => {
  assert.equal(normalizeAdUrl("https://www.blocket.se/annons/12345"), "https://www.blocket.se/annons/12345");
  assert.equal(normalizeAdUrl("  https://blocket.se/x  "), "https://blocket.se/x");
});

test("bara http och https", () => {
  assert.equal(normalizeAdUrl("javascript:alert(1)"), null);
  assert.equal(normalizeAdUrl("file:///etc/passwd"), null);
  assert.equal(normalizeAdUrl("inte en adress alls"), null);
  assert.equal(normalizeAdUrl(""), null);
  assert.equal(normalizeAdUrl(null), null);
});

test("adresser mot vårt eget nät sparas inte", () => {
  // Vi hämtar dem inte i dag. Men den dagen LINK_FETCH slås på är en sparad adress mot 127.0.0.1
  // redan där, och då är kontrollen för sen.
  for (const bad of ["http://localhost:8799/admin", "http://127.0.0.1/", "http://10.0.0.5/x", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/"]) {
    assert.equal(normalizeAdUrl(bad), null, `${bad} skulle ha avvisats`);
  }
});

// ─── valet mellan adaptrarna ────────────────────────────────────────────────

test("MANUAL_CONTENT är förvalet och alltid tillgängligt", () => {
  assert.equal(manualContent.available(), true);
  assert.equal(adapterFor({ images: [], adUrl: "https://blocket.se/x" }).kind, "MANUAL_CONTENT");
});

test("LINK_FETCH är avstängd utan flaggan", () => {
  assert.equal(linkFetchEnabled(), false);
  assert.equal(linkFetch.available(), false);
});

test("med flaggan på väljs LINK_FETCH bara när köparen INTE laddat upp något", async () => {
  const had = process.env.AFFAR_LINK_FETCH;
  process.env.AFFAR_LINK_FETCH = "1";
  try {
    assert.equal(adapterFor({ adUrl: "https://blocket.se/x" }).kind, "LINK_FETCH", "bara en adress -> hämta");
    assert.equal(
      adapterFor({ images: ["data:image/jpeg;base64,x"], adUrl: "https://blocket.se/x" }).kind,
      "MANUAL_CONTENT",
      "köparens egna bilder är ett bättre underlag än vad vi kan skrapa — och de har redan gjort jobbet",
    );
    // Formen "Bjud in säljaren" skickar: analysen gick på länken, bilderna ligger redan på
    // analysjobbet, och affären får inte falla tillbaka på MANUAL_CONTENT bara för att listan är tom.
    assert.equal(
      adapterFor({ images: [], adUrl: "https://blocket.se/x" }).kind,
      "LINK_FETCH",
      "en tom bildlista är inte 'köparen laddade upp något'",
    );
  } finally {
    if (had === undefined) delete process.env.AFFAR_LINK_FETCH; else process.env.AFFAR_LINK_FETCH = had;
  }
});

test("hämtaren kräver en giltig länk och säger vilket felet är", async () => {
  // Kastar hellre än att returnera ett magert underlag: anroparen ska kunna skilja "vi fick inte
  // hämta" från "vi hämtade men sidan sade ingenting", och säga rätt sak till köparen i båda fallen.
  await assert.rejects(() => linkFetch.collect("d", {}), /giltig länk/i);
  await assert.rejects(() => linkFetch.collect("d", { adUrl: "inte en adress" }), /giltig länk/i);
});

test("hämtaren avvisar adresser mot interna nät", async () => {
  // SSRF. Adressen kommer från en användare och pekar var som helst — inklusive på vårt eget nät och
  // på molnets metadatatjänst. Kontrollen sitter på den UPPSLAGNA adressen, inte på värdnamnet.
  for (const bad of ["http://127.0.0.1:8799/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/"]) {
    await assert.rejects(() => linkFetch.collect("d", { adUrl: bad }), `${bad} skulle ha avvisats`);
  }
});

test("User-Agent är ren ASCII", async () => {
  // Strängen bar först "köparinitierad annonsanalys". `ö` i ett headervärde fick Traderas server att
  // svara 500 på VARJE hämtning, och felet såg ut som att sidan var trasig i stället för som att vi
  // skickade fel. Headervärden ska vara US-ASCII (RFC 7230).
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../server/src/affar/linkFetch.ts", import.meta.url), "utf-8"));
  const ua = /const USER_AGENT = "([^"]+)"/.exec(src)?.[1] ?? "";
  assert.ok(ua.length > 0, "hittade ingen User-Agent");
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7E]+$/.test(ua), `User-Agent innehåller icke-ASCII: ${JSON.stringify(ua)}`);
});

// ─── vad som faktiskt lagras ────────────────────────────────────────────────

test("personuppgifter är borta redan när underlaget skapas", async () => {
  const sub = await manualContent.collect("deal-mask", {
    description: "Säljes av Erik, ring 073-555 12 34 eller erik@example.se",
    askingPriceSek: 2000,
  });
  assert.ok(!/073/.test(sub.description!), "telefonnumret ska aldrig ha lagrats");
  assert.ok(!/example\.se/.test(sub.description!));
  assert.equal(sub.source, "MANUAL_CONTENT");
});

test("orimliga priser kastas i stället för att förstöra jämförelsen", async () => {
  const kast = async (v: unknown) => (await manualContent.collect("deal-p", { askingPriceSek: v as never })).askingPriceSek;
  assert.equal(await kast(4500), 4500);
  assert.equal(await kast(0), null);
  assert.equal(await kast(-100), null);
  assert.equal(await kast(9_000_000), null, "en möbel på Blocket kostar inte nio miljoner — fältet är felskrivet");
  assert.equal(await kast("4500"), null, "en sträng är inte ett pris");
});

test("antalet bilder har ett tak", async () => {
  const one = await jpegDataUrl();
  const sub = await manualContent.collect("deal-many", { images: Array.from({ length: 20 }, () => one) });
  assert.equal(sub.imagePaths.length, MAX_AD_IMAGES);
});

test("en trasig bild hoppas över, resten används", async () => {
  const good = await jpegDataUrl();
  const sub = await manualContent.collect("deal-broken", {
    images: [good, "data:image/jpeg;base64,inte-en-bild", good],
  });
  assert.equal(sub.imagePaths.length, 2, "de två giltiga ska komma igenom");
});

// ─── prisdomen ──────────────────────────────────────────────────────────────

test("prisdomen jämför begärt mot spannet", () => {
  assert.equal(priceVerdict(4500, 3600, 4200).verdict, "over");
  assert.equal(priceVerdict(3000, 3600, 4200).verdict, "under");
  assert.equal(priceVerdict(4000, 3600, 4200).verdict, "inom");
});

test("utan spann påstås ingenting", () => {
  // Mätt: när modellen inte gick att identifiera sökte prismotorn på märket och gav 300–4 250 kr.
  // Ett pris ligger alltid "inom" ett sådant spann, och då är domen värdelös men ser ut som en
  // uppgift. Rätt svar är att vi inte vet.
  assert.equal(priceVerdict(4500, null, null).verdict, "okant");
  assert.equal(priceVerdict(null, 3600, 4200).verdict, "okant");
  assert.match(priceVerdict(4500, null, null).text, /inget marknadsvärde/i);
});

test("prisdomens text är färdig att visa, med svenska tusental", () => {
  const t = priceVerdict(4500, 3600, 4200).text;
  assert.match(t, /Begärt: 4\s?500 kr/);
  assert.match(t, /Marknadsvärde: 3\s?600 kr–4\s?200 kr/);
});
