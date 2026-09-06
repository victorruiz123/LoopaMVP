// ─── Butikssidorna som en sökmotor ser dem ──────────────────────────────────
//
// Produktsidorna, kategorisidorna och märkessidorna är den organiska ingången. En ensidig app
// skickar samma tomma skal till varje adress, så det som står i huvudet måste skjutas in på servern.
// Testerna låser fast att det som skjuts in är sant — och att skalets egna taggar försvinner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { injectSeo, seoFor } from "../server/src/butik/seo.js";

/** Skalet som det faktiskt ser ut i web/index.html: taggar över flera rader, och redan med og-kort. */
const SHELL = `<!doctype html>
<html lang="sv">
  <head>
    <title>Loopa – Sälj din möbel</title>
    <meta
      name="description"
      content="Sälj med Loopa: filma ett varv runt möbeln."
    />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Loopa – sälj din begagnade möbel" />
    <meta
      property="og:description"
      content="Filma ett varv runt möbeln."
    />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const HEAD = {
  title: "Sits Impulse – 2633 kr – Loopa Butik",
  description: "Sits Impulse, 2633 kr.",
  canonical: "https://app.loopa.nu/butik/objekt/LP-1",
  jsonLd: '{"@type":"Product"}',
  body: "<h1>Sits Impulse</h1>",
};

test("skalets egen titel och beskrivning ersätts, inte kompletteras", () => {
  const html = injectSeo(SHELL, HEAD);
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.ok(html.includes("<title>Sits Impulse – 2633 kr – Loopa Butik</title>"));
  assert.ok(!html.includes("Sälj med Loopa: filma ett varv runt möbeln."), "säljverktygets beskrivning ska bort");
});

test("og-taggarna blir en uppsättning, inte två", () => {
  // Skalet bär redan ett og-kort för säljverktyget. Läggs butikens till utan att ta bort dem står
  // sidan med två og:title, och vilken som vinner är upp till den som läser.
  const html = injectSeo(SHELL, HEAD);
  assert.equal((html.match(/property="og:title"/g) ?? []).length, 1);
  assert.equal((html.match(/property="og:description"/g) ?? []).length, 1);
  assert.equal((html.match(/name="twitter:card"/g) ?? []).length, 1);
  assert.equal((html.match(/name="description"/g) ?? []).length, 1, "flerradiga taggar måste också träffas");
});

test("kroppen får läsbart innehåll i stället för ett tomt skal", () => {
  const html = injectSeo(SHELL, HEAD);
  assert.ok(html.includes('<div id="root"><h1>Sits Impulse</h1></div>'));
});

test("JSON-LD:n kan inte bryta sig ur sin script-tagg", () => {
  // Titlar kommer ur annonsgeneratorn. Ett "</script>" i en möbeltitel hade annars stängt taggen och
  // låtit resten av namnet bli körbar markup.
  const html = injectSeo(SHELL, { ...HEAD, jsonLd: '{"name":"</script><img onerror=x>"}' });
  assert.ok(!html.includes("</script><img"), "vinkelparentesen ska vara escapad");
  assert.ok(html.includes("\\u003c/script"));
});

test("titeln escapas — den kommer ur genererad text", () => {
  const html = injectSeo(SHELL, { ...HEAD, title: 'Soffa "bäst" & <b>fin</b>' });
  assert.ok(html.includes("&quot;bäst&quot; &amp; &lt;b&gt;"));
});

test("landningssidan beskriver butiken, inte säljverktyget", async () => {
  const head = await seoFor("/butik", "");
  assert.ok(head);
  assert.match(head.title, /Loopa Butik/);
  assert.match(head.description, /Stockholm/);
  assert.ok(head.body?.includes("/butik/kategori/"), "kategorierna ska vara länkade för en robot");
});

test("kategorisidan får en egen titel med orten i", async () => {
  const head = await seoFor("/butik/kategori/stolar", "");
  assert.ok(head);
  assert.match(head.title, /stolar/i);
  assert.match(head.title, /Stockholm/);
  // Fältet sätts numera uttryckligen — en kategori med varor är indexerbar, en tom är det inte.
  assert.ok(!head.noindex);
});

test("en okänd kategori får inget huvud alls — skalet skickas orört", async () => {
  assert.equal(await seoFor("/butik/kategori/finns-inte", ""), null);
});

test("sökträffsidor indexeras inte", async () => {
  const head = await seoFor("/butik/sok", "?q=soffa");
  assert.ok(head);
  assert.equal(head.noindex, true, "en sökträffsida är inte ett innehåll — kategorierna är det");
});

test("en möbel som inte finns markeras noindex i stället för att svara 200 med tomt", async () => {
  const head = await seoFor("/butik/objekt/LP-FINNS-INTE", "");
  assert.ok(head);
  assert.equal(head.noindex, true);
});

test("adresser utanför butiken rör inte skalet", async () => {
  assert.equal(await seoFor("/", ""), null);
  assert.equal(await seoFor("/butik/nagot-okant/x", ""), null);
});


// ─── Kroppen som länkgraf ───────────────────────────────────────────────────
//
// Det som avgör om en produktsida hittas är inte dess egen markering utan om något länkar till den
// utan att JavaScript kört. Kategorisidan och märkessidan bar tidigare bara en rubrik: adresserna
// fanns, men ingen väg gick dit. Testerna nedan låser fast att vägen finns.

test("kategorisidan listar varorna som riktiga länkar", async () => {
  const head = await seoFor("/butik/kategori/stolar", "");
  assert.ok(head);
  assert.match(head.body ?? "", /href="\/butik\/objekt\//, "utan produktlänkar hittar en robot aldrig till en möbel");
});

test("kategorisidan säger i strukturerad data att den ÄR en lista av produkter", async () => {
  const head = await seoFor("/butik/kategori/stolar", "");
  assert.ok(head?.jsonLd);
  const grafer = JSON.parse(head.jsonLd);
  const typer = (Array.isArray(grafer) ? grafer : [grafer]).map((g) => g["@type"]);
  assert.ok(typer.includes("BreadcrumbList"));
  assert.ok(typer.includes("ItemList"));
});

test("produktsidan bär brödsmulor OCH sin produktmarkering i samma tagg", async () => {
  const { allProducts } = await import("../server/src/butik/inventory.js");
  const vara = (await allProducts()).find((p) => p.source === "loopa" && p.state === "live");
  if (!vara) return; // Tomt lager i den här körningen — inget att pröva mot.
  const head = await seoFor(`/butik/objekt/${vara.id}`, "");
  assert.ok(head?.jsonLd);
  const grafer = JSON.parse(head.jsonLd);
  assert.ok(Array.isArray(grafer), "två grafer ska ligga som en lista i en enda script-tagg");
  const typer = grafer.map((g) => g["@type"]);
  assert.ok(typer.includes("BreadcrumbList"));
  assert.ok(typer.includes("Product"));
});

test("produktsidan länkar vidare till kategorin i stället för att bli en återvändsgränd", async () => {
  const { allProducts } = await import("../server/src/butik/inventory.js");
  const vara = (await allProducts()).find((p) => p.source === "loopa" && p.state === "live");
  if (!vara) return;
  const head = await seoFor(`/butik/objekt/${vara.id}`, "");
  assert.match(head?.body ?? "", /href="\/butik\/kategori\//);
});

// ─── robots.txt och sitemap.xml ─────────────────────────────────────────────

test("robots.txt släpper igenom produktbilderna innan den stänger API:t", async () => {
  const { robotsTxt } = await import("../server/src/butik/sitemap.js");
  // Bara direktiven. Kommentarraderna i filen NÄMNER "Disallow: /api/" när de förklarar varför
  // ordningen spelar roll, och en rå indexOf hade läst förklaringen som regeln.
  const direktiv = robotsTxt().split("\n").filter((r) => r.trim() && !r.trimStart().startsWith("#"));
  const txt = robotsTxt();
  // Ordningen ÄR regeln: Allow måste stå före Disallow för att bilderna ska nås. Blockeras de har
  // varje möbel en trasig bild i sökresultatet, och Merchant Center avvisar varan.
  assert.ok(
    direktiv.indexOf("Allow: /api/cards/") < direktiv.indexOf("Disallow: /api/"),
    "produktbilderna måste släppas igenom innan API:t stängs",
  );
  assert.match(txt, /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
});

test("sitemapen ber aldrig om indexering av en sida som säger noindex", async () => {
  const { sitemapXml } = await import("../server/src/butik/sitemap.js");
  const { allProducts } = await import("../server/src/butik/inventory.js");
  const xml = await sitemapXml();
  const salda = (await allProducts()).filter((p) => p.state === "sold" || p.state === "delivered");
  for (const p of salda) {
    assert.ok(!xml.includes(`/butik/objekt/${p.id}<`), `${p.id} är såld och ska inte stå i sitemapen`);
  }
});

test("sitemapen listar bara våra egna möbler, inte Traderas annonser", async () => {
  const { sitemapXml } = await import("../server/src/butik/sitemap.js");
  const xml = await sitemapXml();
  assert.ok(!xml.includes("tradera%3A"), "någon annans annons är inte vårt innehåll att be om indexering för");
});

test("sitemapen är välformad XML med bilderna på plats", async () => {
  const { sitemapXml } = await import("../server/src/butik/sitemap.js");
  const xml = await sitemapXml();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<urlset/g) ?? []).length, 1);
  assert.equal((xml.match(/<url>/g) ?? []).length, (xml.match(/<\/url>/g) ?? []).length);
  assert.ok(xml.includes("/butik/kategori/"));
});
