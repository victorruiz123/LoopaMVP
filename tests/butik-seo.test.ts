// ─── Butikssidorna som en sökmotor ser dem ──────────────────────────────────
//
// Produktsidorna, kategorisidorna och märkessidorna är den organiska ingången. En ensidig app
// skickar samma tomma skal till varje adress, så det som står i huvudet måste skjutas in på servern.
// Testerna låser fast att det som skjuts in är sant — och att skalets egna taggar försvinner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flyttadAdress, injectSeo, kanoniskVard, seoFor } from "../server/src/butik/seo.js";

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
  assert.equal(await seoFor("/butik/nagot-okant/x", ""), null);
  // Säljflödets egna skärmar ska ingen hitta via en sökmotor — bara roten själv har ett huvud.
  assert.equal(await seoFor("/salj/steg-2", ""), null);
});

/**
 * Startsidan är den sida en sökning på "loopa" landar på, och den gick länge ut som ett tomt skal.
 * Testerna nedan låser fast det som gör den till en sida: en kanonisk adress, en kropp som nämner
 * företaget vid namn ihop med vad det gör, och entitetsmarkeringen som skiljer Loopa från verbet.
 */
test("startsidan bär sitt eget huvud, inte butikens", async () => {
  const head = await seoFor("/", "");
  assert.ok(head, "roten måste ha ett sidhuvud sedan den flyttade hit");
  assert.match(head.title, /^Loopa/, "märkesnamnet först — frågan som ska träffa är namnet");
  assert.ok(!head.title.includes("Butik"), "roten är sajten, inte avdelningen");
  assert.match(head.canonical, /\/$/);
  assert.ok(!head.noindex);
  assert.equal(head.ogType, "website", "startsidan är ingen produkt");
});

test("startsidan bär Organization och WebSite — och ingen annan sida gör det", async () => {
  const rot = await seoFor("/", "");
  const grafer = JSON.parse(rot!.jsonLd!) as Array<Record<string, unknown>>;
  const typer = grafer.map((g) => g["@type"]);
  assert.ok(typer.includes("Organization"));
  assert.ok(typer.includes("WebSite"), "sökfältsmarkeringen läses bara på startsidan");

  const org = grafer.find((g) => g["@type"] === "Organization")!;
  assert.equal(org.name, "Loopa");
  assert.match(String(org.url), /\/$/, "Organization pekar på roten, inte på /butik");
  assert.ok(!("sameAs" in org), "tomt sameAs utelämnas hellre än skickas tomt");

  const butik = await seoFor("/butik", "");
  assert.ok(!String(butik!.jsonLd).includes('"WebSite"'), "sajtgrafen ska stå på EN sida");
});

test("startsidans kropp skiljer företaget Loopa från verbet loopa", async () => {
  const head = await seoFor("/", "");
  const body = head!.body ?? "";
  assert.match(body, /<h1>Loopa<\/h1>/);
  assert.match(body, /begagnade möbler/i);
  assert.match(body, /Stockholm/, "orten är det som gör namnet till en entitet och inte ett ord");
  assert.match(body, /href="\/butik"/, "vägen in i butiken får inte kräva JavaScript");
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


// ─── En adress per sida ─────────────────────────────────────────────────────
//
// Butiken nås under marknadsdomänen via en router hos Cloudflare, men servern svarar fortfarande på
// sitt eget värdnamn — tunneln kräver det. Utan omdirigeringen låg varje butikssida på två adresser
// med identiskt innehåll, och Google delar värdet mellan sådana i stället för att räkna ihop det.

const MED_KANONISK = (host: string, fn: () => void) => {
  const fore = process.env.LOOPA_PUBLIC_URL;
  process.env.LOOPA_PUBLIC_URL = host;
  try { fn(); } finally {
    if (fore === undefined) delete process.env.LOOPA_PUBLIC_URL;
    else process.env.LOOPA_PUBLIC_URL = fore;
  }
};

test("en butikssida på fel värdnamn skickas till den kanoniska adressen", () => {
  MED_KANONISK("https://loopa.nu", () => {
    assert.equal(
      flyttadAdress("app.loopa.nu", "/butik/objekt/LP-1", ""),
      "https://loopa.nu/butik/objekt/LP-1",
    );
    assert.equal(flyttadAdress("app.loopa.nu", "/butik/sok", "?q=stol"), "https://loopa.nu/butik/sok?q=stol");
  });
});

test("samma sida på RÄTT värdnamn omdirigeras inte — annars blir det en oändlig slinga", () => {
  MED_KANONISK("https://loopa.nu", () => {
    assert.equal(flyttadAdress("loopa.nu", "/butik", ""), null);
    // Routern framför oss anropar servern på dess eget namn och sätter x-forwarded-host. Läses det
    // huvudet ser servern "loopa.nu" och svarar 200 — det är hela skyddet mot slingan.
    assert.equal(flyttadAdress("LOOPA.NU", "/butik", ""), null, "värdnamn är skiftlägesokänsliga");
  });
});

test("hela appen flyttar — allt utom maskinvägarna och sanningskorten", () => {
  MED_KANONISK("https://loopa.nu", () => {
    /*
     * ROTEN FLYTTADE 2026-09-11 och är inte längre ett undantag. Den var det ända fram till dess,
     * bakom flaggan LOOPA_ROT_FLYTTAD: loopa.nu/ visade marknadssajtens företagssida, och en
     * kanonisering av roten gav kedjan app.loopa.nu/ → 301 → loopa.nu/ → 302 → /company —
     * säljflödet gick inte att nå från någon adress alls. Det hände i drift.
     *
     * Skyddet mot att det händer igen sitter numera i UTRULLNINGSORDNINGEN och inte i en flagga:
     * omdirigeringsregeln tas bort före servern rullas. Se deploy/cloudflare/wrangler.toml.
     */
    assert.equal(flyttadAdress("app.loopa.nu", "/", ""), "https://loopa.nu/");
    assert.equal(flyttadAdress("app.loopa.nu", "/efterlyses/stolar", ""), "https://loopa.nu/efterlyses/stolar");
    assert.equal(flyttadAdress("app.loopa.nu", "/sitemap.xml", ""), "https://loopa.nu/sitemap.xml");
    assert.equal(flyttadAdress("app.loopa.nu", "/kop/analysera", ""), "https://loopa.nu/kop/analysera");
    assert.equal(flyttadAdress("app.loopa.nu", "/villkor", ""), "https://loopa.nu/villkor");

    // MASKINVÄGARNA STÅR KVAR. En omdirigering här flyttar inte en läsare utan bryter en
    // integration — och den som anropar API:t har fått sin adress av oss.
    assert.equal(flyttadAdress("app.loopa.nu", "/api/butik/produkter", ""), null);
    assert.equal(flyttadAdress("app.loopa.nu", "/v1/condition", ""), null);
    // Övervakningen frågar maskinen, inte domänen.
    assert.equal(flyttadAdress("app.loopa.nu", "/health", ""), null);
    /*
     * robots.txt gäller värdnamnet den hämtas från. Omdirigerades den svarade Cloudflare med sin
     * egen fil i stället — utan våra direktiv och utan Sitemap-raden. Sitemapen får däremot flytta:
     * den är en lista över adresser, inte en regel om en värd.
     */
    assert.equal(flyttadAdress("app.loopa.nu", "/robots.txt", ""), null);
    assert.equal(flyttadAdress("app.loopa.nu", "/sitemap.xml", ""), "https://loopa.nu/sitemap.xml");
  });
});

test("sanningskortet flyttar ALDRIG — adressen står inbakad i publicerade Tradera-annonser", () => {
  MED_KANONISK("https://loopa.nu", () => {
    assert.equal(flyttadAdress("app.loopa.nu", "/c/LP-ABCD-1234", ""), null);
  });
});

test("undantagen får inte träffa en adress som bara börjar likadant", () => {
  MED_KANONISK("https://loopa.nu", () => {
    // Gränsen sitter numera på UNDANTAGEN, inte på det som flyttar — allt flyttar. "/carport" är
    // inte ett sanningskort och "/apiary" är inte API:t; båda ska flytta med resten.
    assert.equal(flyttadAdress("app.loopa.nu", "/carport", ""), "https://loopa.nu/carport");
    assert.equal(flyttadAdress("app.loopa.nu", "/apiary", ""), "https://loopa.nu/apiary");
    // Men de riktiga undantagen står kvar.
    assert.equal(flyttadAdress("app.loopa.nu", "/c/LP-1", ""), null);
    assert.equal(flyttadAdress("app.loopa.nu", "/api/jobs", ""), null);
  });
});

test("utan känd värd händer ingenting", () => {
  MED_KANONISK("https://loopa.nu", () => {
    assert.equal(flyttadAdress(null, "/butik", ""), null);
  });
  assert.equal(kanoniskVard(), kanoniskVard(), "ska inte kasta");
});

test("loopback och IP-adresser kanoniseras aldrig", () => {
  MED_KANONISK("https://loopa.nu", () => {
    // Utrullningsskriptet frågar servern på 127.0.0.1 och ska få sidan, inte en 301. Utan det här
    // underkände skriptet en fullt korrekt utrullning — och riktiga besökare, som kommer via
    // tunneln med rätt värdnamn, märkte ingenting alls.
    assert.equal(flyttadAdress("127.0.0.1:8799", "/butik", ""), null);
    assert.equal(flyttadAdress("localhost:8799", "/sitemap.xml", ""), null);
    assert.equal(flyttadAdress("[::1]:8799", "/butik", ""), null);
    assert.equal(flyttadAdress("82.70.45.236", "/butik", ""), null, "en IP är inget sökresultat");
    // Men ett riktigt värdnamn ska fortfarande flyttas.
    assert.equal(flyttadAdress("app.loopa.nu", "/butik", ""), "https://loopa.nu/butik");
  });
});

/**
 * Roten har flyttat, och ingen flagga styr det längre.
 *
 * Testet står kvar med omvänt påstående i stället för att raderas: det var det här beteendet som en
 * gång sköt ned säljflödet i drift, och en rad som säger vad som gäller nu är billigare än att
 * någon om ett halvår undrar varför roten behandlas som allt annat.
 */
test("roten kanoniseras som varje annan sida, oavsett miljövariabler", () => {
  const fore = process.env.LOOPA_ROT_FLYTTAD;
  // Den gamla flaggan ska inte längre kunna hålla kvar roten på app.loopa.nu.
  delete process.env.LOOPA_ROT_FLYTTAD;
  try {
    MED_KANONISK("https://loopa.nu", () => {
      assert.equal(flyttadAdress("app.loopa.nu", "/", ""), "https://loopa.nu/");
      assert.equal(flyttadAdress("app.loopa.nu", "/", "?utm=x"), "https://loopa.nu/?utm=x");
      // Undantagen gäller fortfarande — flytten rör inte maskinvägarna.
      assert.equal(flyttadAdress("app.loopa.nu", "/c/LP-1", ""), null);
    });
  } finally {
    if (fore !== undefined) process.env.LOOPA_ROT_FLYTTAD = fore;
  }
});
