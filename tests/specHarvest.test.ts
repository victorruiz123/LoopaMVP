// Måtten läses ur produktsidan, inte ur en gissning.
//
// Skörden är det enda steget i specifikationskedjan som inte är en modell: sidan är redan hämtad och
// redan kontrollerad mot modellnamnet, så det som står i dess tabell går att läsa rakt av. Testerna
// nedan är därför inte "hittar den något" utan "hittar den bara det som faktiskt står där" — ett
// påhittat mått på en annons är värre än ett tomt fält.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harvestSpecs, htmlToText, mergeSpecs } from "../server/src/specHarvest.js";
import type { ListingAttribute } from "../server/src/types.js";

const PAGE = "https://www.exempel.se/produkt/soffa";
const value = (specs: ListingAttribute[], key: string) => specs.find((s) => s.key === key)?.value ?? null;

test("specifikationstabellen läses cell för cell", () => {
  const html = `
    <h1>SÖDERHAMN 3-sits</h1>
    <table class="specs">
      <tr><th>Bredd</th><td>198 cm</td></tr>
      <tr><th>Djup</th><td>99 cm</td></tr>
      <tr><th>Höjd</th><td>83 cm</td></tr>
      <tr><th>Sitthöjd</th><td>40 cm</td></tr>
      <tr><th>Material</th><td>Massiv furu, spånskiva</td></tr>
    </table>`;
  const specs = harvestSpecs(html, PAGE);
  assert.equal(value(specs, "bredd"), "198 cm");
  assert.equal(value(specs, "djup"), "99 cm");
  assert.equal(value(specs, "hojd"), "83 cm");
  // Sitthöjd är inte höjd. Utan ordgränsen hade "höjd" matchat inuti "sitthöjd" och satt fel värde.
  assert.equal(value(specs, "sitthojd"), "40 cm");
  assert.equal(value(specs, "material"), "Massiv furu, spånskiva");
  assert.equal(specs[0].sourceUrl, PAGE, "varje värde bär sidan det lästes på");
});

test("millimeter och meter räknas om till centimeter", () => {
  const specs = harvestSpecs("<ul><li>Bredd: 1200 mm</li><li>Höjd: 0,75 m</li></ul>", PAGE);
  assert.equal(value(specs, "bredd"), "120 cm");
  assert.equal(value(specs, "hojd"), "75 cm");
});

test("enheten i etiketten räknas också", () => {
  const specs = harvestSpecs("<tr><td>Djup (cm)</td><td>92</td></tr>", PAGE);
  assert.equal(value(specs, "djup"), "92 cm");
});

test("sammanskrivet mått läses i den ordning etiketterna anger", () => {
  const specs = harvestSpecs("<p>Mått: B120 x D80 x H75 cm</p>", PAGE);
  assert.equal(value(specs, "bredd"), "120 cm");
  assert.equal(value(specs, "djup"), "80 cm");
  assert.equal(value(specs, "hojd"), "75 cm");
});

test("löptext utan mått ger inga mått", () => {
  const html = `<p>Höjden på soffan gör den luftig och lätt att kombinera med resten av serien.</p>
    <p>Fri frakt över 500 kr och 25 års garanti.</p>`;
  const specs = harvestSpecs(html, PAGE);
  assert.deepEqual(specs, [], "ett tal i en mening är inte ett mått");
});

test("orimliga tal kastas", () => {
  // 5000 cm är ingen möbel, och 1 cm är ingen bredd — båda är tal som råkat stå efter etiketten.
  const specs = harvestSpecs("<tr><td>Bredd</td><td>5000 cm</td></tr><tr><td>Djup</td><td>1 cm</td></tr>", PAGE);
  assert.deepEqual(specs, []);
});

test("kartongens mått är inte möbelns — även när rubriken står på engelska", () => {
  // Sidan är NORDVIKEN barstol, ord för ord som IKEA skriver den. Stolen är 40 cm bred och väger
  // inget vi vet; kartongen är 90 cm lång och väger 5,8 kg. Läses gränsen inte blir stolen kartongen.
  const html = `<p>Measurements | Width 40 cm | Depth 45 cm | Height 88 cm | Seat depth 34 cm |
    Packaging | Width: 47 cm | Height: 10 cm | Length: 90 cm | Weight: 5.80 kg</p>`;
  const specs = harvestSpecs(html, PAGE);
  assert.equal(value(specs, "bredd"), "40 cm");
  assert.equal(value(specs, "hojd"), "88 cm");
  assert.equal(value(specs, "langd"), null, "90 cm är kartongens längd");
  assert.equal(value(specs, "vikt"), null, "5,8 kg är kartongens vikt");
});

test("ordet förpackning i löptext flyttar inte gränsen", () => {
  // Gränsen är avsnittet, inte ordet. Står "förpackning" i en säljande mening före tabellen får den
  // inte kapa sidan där — då hade måtten den skyddar aldrig blivit lästa.
  const html = `<p>Levereras i plastfri förpackning.</p>
    <table><tr><th>Bredd</th><td>198 cm</td></tr><tr><th>Höjd</th><td>83 cm</td></tr></table>
    <p>Förpackning | Bredd: 47 cm | Längd: 210 cm</p>`;
  const specs = harvestSpecs(html, PAGE);
  assert.equal(value(specs, "bredd"), "198 cm");
  assert.equal(value(specs, "hojd"), "83 cm");
  assert.equal(value(specs, "langd"), null);
});

test("delens mått är inte möbelns, också när engelskan skriver isär det", () => {
  // "Seat height 62 cm" är samma påstående som "sitthöjd" — men utan sammanskrivningen som
  // ordgränsen känner igen. Utan delgränsen blir barstolens höjd sitthöjden.
  const specs = harvestSpecs("<p>Seat width 40 cm | Seat height 62 cm | Height 88 cm | Width 45 cm</p>", PAGE);
  assert.equal(value(specs, "hojd"), "88 cm");
  assert.equal(value(specs, "sitthojd"), "62 cm");
  assert.equal(value(specs, "bredd"), "45 cm", "sitsens bredd är inte stolens");
});

test("måttet i produktnamnet läses inte som möbelns höjd", () => {
  // IKEA:s eget namn på varianten bär sitthöjden: "counter height/black, 62 cm". Den står först på
  // sidan, långt före tabellen, så utan delgränsen vann den över de 88 cm som faktiskt är höjden.
  const html = `<title>NORDVIKEN bar stool with backrest, counter height/black, 62 cm - IKEA</title>
    <p>Measurements | Height 88 cm</p>`;
  assert.equal(value(harvestSpecs(html, PAGE), "hojd"), "88 cm");
});

test("skript och stilar läses aldrig", () => {
  const html = `<script>var spec = {"bredd":"999 cm"}</script><style>.x{height:400cm}</style><p>Bredd: 81 cm</p>`;
  const specs = harvestSpecs(html, PAGE);
  assert.equal(value(specs, "bredd"), "81 cm");
  assert.equal(specs.length, 1);
});

test("radbrytningar skiljer etikett från nästa rad", () => {
  assert.match(htmlToText("<td>Bredd</td><td>81 cm</td>"), /Bredd \| 81 cm/);
});

test("mergeSpecs rör aldrig det generatorn redan belagt", () => {
  const existing: ListingAttribute[] = [{ key: "bredd", label: "Bredd", value: "80–82 cm", sourceUrl: "https://k.se" }];
  const merged = mergeSpecs(existing, harvestSpecs("<tr><td>Bredd</td><td>81 cm</td><td>Djup</td><td>92 cm</td></tr>", PAGE));
  assert.equal(merged.length, 2);
  assert.equal(value(merged, "bredd"), "80–82 cm", "generatorns egen källa vinner");
  assert.equal(value(merged, "djup"), "92 cm", "luckan fylls");
});

/**
 * Uppskattningen är en ställföreträdare, inte ett värde att försvara.
 *
 * Annonsen bär alltid mått: saknas belagda fylls de på med typiska mått för möbeltypen. Sidskörden
 * kommer efteråt och läser produktsidans EGEN HTML — hade uppskattningen fått blockera den hade den
 * stått kvar bredvid det riktiga måttet, eller i stället för det.
 */
test("sidskörden ersätter ett uppskattat mått", () => {
  const existing: ListingAttribute[] = [
    { key: "bredd", label: "Bredd", value: "ca 45 cm", sourceUrl: null, estimated: true },
    { key: "djup", label: "Djup", value: "ca 52 cm", sourceUrl: null, estimated: true },
  ];
  const merged = mergeSpecs(existing, harvestSpecs("<tr><td>Bredd</td><td>40 cm</td></tr>", PAGE));
  assert.equal(value(merged, "bredd"), "40 cm", "produktsidans mått vinner över tabellens");
  assert.equal(merged.filter((a) => a.key === "bredd").length, 1, "bredden får inte stå två gånger");
  assert.equal(value(merged, "djup"), "ca 52 cm", "det sidan inte sa står kvar uppskattat");
});

test("ett sammanskrivet måttfält räknas som alla tre måtten", () => {
  const existing: ListingAttribute[] = [{ key: "matt", label: "Mått", value: "198 x 99 x 83 cm", sourceUrl: null }];
  const merged = mergeSpecs(existing, harvestSpecs("<tr><td>Bredd</td><td>198 cm</td><td>Sitthöjd</td><td>40 cm</td></tr>", PAGE));
  assert.equal(merged.length, 2, "bredden stod redan i måttfältet");
  assert.equal(value(merged, "sitthojd"), "40 cm", "sitthöjden gjorde den inte");
});

/**
 * Vägen hela värdet går: hämtad sida → kontrollerad mot modellnamnet → mått på kandidaten.
 *
 * Hämtningen görs redan för bildens skull. Testet vaktar att den också lämnar ifrån sig
 * specifikationerna, och att en sida som INTE handlar om modellen inte får göra det.
 */
test("kandidatens produktsida bär måtten vidare till kandidaten", async () => {
  const { resolveCandidateImages } = await import("../server/src/candidateImages.js");
  const html = `<html><head><title>NORDVIKEN Barstol | IKEA</title>
    <meta property="og:image" content="https://x.se/bild.jpg"></head>
    <body><table><tr><th>Bredd</th><td>40 cm</td></tr><tr><th>Sitthöjd</th><td>62 cm</td></tr></table></body></html>`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  try {
    const [candidate] = await resolveCandidateImages(
      [{ brand: "IKEA", model: "NORDVIKEN", variant: null, productType: null, confidence: "strong", distinguishingDetail: null }],
      [{ title: "ikea.com", url: "https://www.ikea.com/se/sv/p/nordviken/", qualityTier: 1 }],
    );
    assert.equal(candidate.imageUrl, "https://x.se/bild.jpg", "bilden fungerar som förut");
    assert.deepEqual(
      candidate.pageSpecs?.map((s) => `${s.label}=${s.value}`),
      ["Bredd=40 cm", "Sitthöjd=62 cm"],
    );
    assert.equal(candidate.pageSpecs?.[0].sourceUrl, "https://www.ikea.com/se/sv/p/nordviken/");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("en sida som inte nämner modellen lämnar inga mått", async () => {
  const { resolveCandidateImages } = await import("../server/src/candidateImages.js");
  const html = `<html><head><title>Soffor | Butiken</title><meta property="og:image" content="https://x.se/annan.jpg"></head>
    <body><table><tr><th>Bredd</th><td>240 cm</td></tr></table></body></html>`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  try {
    const [candidate] = await resolveCandidateImages(
      [{ brand: "Mio", model: "Saturday", variant: null, productType: null, confidence: "strong", distinguishingDetail: null }],
      [{ title: "butiken.se", url: "https://butiken.se/soffor", qualityTier: 2 }],
    );
    assert.equal(candidate.pageSpecs, null, "fel möbels mått är värre än inga mått");
    assert.equal(candidate.imageUrl, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
