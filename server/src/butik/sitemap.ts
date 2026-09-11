/**
 * robots.txt och sitemap.xml — de två filerna som gör butiken upptäckbar.
 *
 * VARFÖR DE MÅSTE FINNAS. Produktsidorna bor på /butik/objekt/<loopa-id>, och de länkas bara från
 * ett rutnät som React ritar efter att JavaScript kört. Den förrenderade kroppen (se seo.ts) bar
 * länge bara rubriker — en robot som landade på /butik såg alltså åtta kategorilänkar och inte en
 * enda möbel. Kategorisidorna listar varor numera, men en sitemap är ändå det enda som säger
 * "de här adresserna finns, och den här ändrades senast då". Utan den är upptäckten beroende av att
 * någon råkar länka rätt.
 *
 * Byggs vid varje förfrågan ur lagerindexet, som ändå hålls i minnet med sin egen TTL
 * (inventory.ts). Ingen fil att generera, inget bygg-steg att glömma, och en möbel som publiceras
 * står i sitemapen inom TTL:en.
 */

import { BROWSABLE_STATES, type Product } from "./types.js";
import { allProducts } from "./inventory.js";
import { brandSlug, CATEGORIES } from "./catalog.js";
import { typeFacetsMerged } from "./inventory.js";
import { arIndexerbar, baseUrl } from "./seo.js";

/** XML-escape. Titlar och märkesnamn kommer ur genererad text och kan innehålla vad som helst. */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * robots.txt.
 *
 * TVÅ RADER SOM MÅSTE STÅ I RÄTT ORDNING. `Disallow: /api/` stänger säljverktygets portar för
 * robotar, men /api/cards/<id>/cover ÄR produktbilden — den enda publika bilden av säljarens möbel
 * (se server.ts). Blockeras den ser Google en produktsida utan bild, och Merchant Center avvisar
 * varan helt. `Allow` står därför före och är mer specifik, vilket är det som avgör hos Google.
 *
 * Säljflödet och kassan är uttryckligen bortstängda: de har inget att indexera, och varje besök en
 * robot lägger där är ett besök den inte lägger på en möbel.
 */
export function robotsTxt(): string {
  const base = baseUrl();
  return [
    "User-agent: *",
    "",
    "# Produktbilderna. Måste stå före Disallow: /api/ — utan dem har varje möbel en trasig bild",
    "# i sökresultatet och i Google Shopping.",
    "Allow: /api/cards/",
    "",
    "# Säljverktyget, kassan och API:t har inget publikt innehåll.",
    "Disallow: /api/",
    "Disallow: /butik/order/",
    "Disallow: /butik/profil",
    "Disallow: /kop/analysera",
    "Disallow: /kop/mina-efterlysningar",
    "",
    "# Sökträffsidor är inte ett innehåll — kategorierna och produkterna är det. De bär redan",
    "# noindex (seo.ts); raden här sparar dessutom krypbudget.",
    "Disallow: /butik/sok",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

interface Post {
  loc: string;
  lastmod?: string | null;
  /** 0.0–1.0. Google säger sig ignorera den; Bing gör det inte. Kostar en rad. */
  priority?: string;
  changefreq?: string;
  image?: { loc: string; title: string } | null;
}

function urlTag(p: Post): string {
  const rader = [`    <loc>${esc(p.loc)}</loc>`];
  if (p.lastmod) rader.push(`    <lastmod>${esc(p.lastmod)}</lastmod>`);
  if (p.changefreq) rader.push(`    <changefreq>${p.changefreq}</changefreq>`);
  if (p.priority) rader.push(`    <priority>${p.priority}</priority>`);
  if (p.image) {
    rader.push("    <image:image>");
    rader.push(`      <image:loc>${esc(p.image.loc)}</image:loc>`);
    rader.push(`      <image:title>${esc(p.image.title)}</image:title>`);
    rader.push("    </image:image>");
  }
  return `  <url>\n${rader.join("\n")}\n  </url>`;
}

/** Datumet sitemapen ska uppge, eller null när vi inte VET något. En gissad lastmod är värre än ingen. */
function lastmodOf(p: Product): string | null {
  if (!p.listedAtKnown) return null;
  const d = new Date(p.listedAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function absolut(url: string): string {
  return url.startsWith("http") ? url : `${baseUrl()}${url}`;
}

/**
 * Hela sitemapen.
 *
 * BARA VÅRA EGNA MÖBLER. En Tradera-vara är någon annans annons på någon annans sida, och vår sida
 * för den är en tunn spegling utan eget betyg, utan mått och utan strukturerad data. Att be Google
 * indexera hundra sådana är att be om ett tunnhetsomdöme över hela butiken — och det omdömet
 * drabbar då även de granskade möblerna, som är det vi faktiskt har att erbjuda. De är fortfarande
 * länkade och fullt krypbara; skillnaden är att vi inte BER om indexering av dem.
 */
export async function sitemapXml(): Promise<string> {
  const base = baseUrl();
  const products = await allProducts();
  const synliga = products.filter((p) => BROWSABLE_STATES.includes(p.state));

  /**
   * STARTSIDAN FÖRST, och ensam om 1.0.
   *
   * Sitemapen började på /butik, som om butiken vore sajten. Sedan roten flyttade hit är `/` den
   * sida en märkessökning ska landa på, och den stod inte med alls — Google fick alltså aldrig veta
   * att den fanns annat än genom att någon råkade länka dit.
   *
   * Marknadssidorna står med av samma skäl: de beskriver företaget, och en sökning på "loopa" är en
   * fråga om företaget. De bor på Pages och inte hos oss (se wrangler.toml), men en sitemap listar
   * adresser på en domän — inte sidor en viss server råkar rendera.
   *
   * DE JURIDISKA SIDORNA STÅR MEDVETET INTE MED. /villkor, /integritetspolicy och /cookies får inget
   * eget sidhuvud ur seo.ts än, så alla tre går ut med skalets titel. Tre adresser med identisk titel
   * är tre sidor som konkurrerar om samma märkesfråga, och att be Google indexera dem vore att göra
   * problemet större. De ska in — efter att de fått var sitt huvud.
   */
  const poster: Post[] = [
    { loc: `${base}/`, changefreq: "weekly", priority: "1.0" },
    { loc: `${base}/butik`, changefreq: "daily", priority: "0.9" },
    { loc: `${base}/company`, changefreq: "monthly", priority: "0.8" },
    { loc: `${base}/brands`, changefreq: "monthly", priority: "0.6" },
    { loc: `${base}/secondhand`, changefreq: "monthly", priority: "0.6" },
  ];

  /**
   * Kategorier utan varor står inte med.
   *
   * Samma regel som seo.ts sätter noindex på, och det är ingen tillfällighet att den upprepas: en
   * sitemap som pekar på en sida med noindex är en motsägelse Google rapporterar som fel i Search
   * Console, och felen dränker de riktiga.
   */
  for (const c of CATEGORIES) {
    const antal = synliga.filter((p) => p.categorySlug === c.slug).length;
    if (antal === 0) continue;
    poster.push({ loc: `${base}/butik/kategori/${c.slug}`, changefreq: "daily", priority: "0.9" });
  }

  /**
   * Möbeltyperna, bara de med varor — samma regel som kategorierna, och samma tyngd: "begagnad soffa"
   * är sidan vi helst vill att Google hämtar först.
   */
  for (const t of typeFacetsMerged(synliga)) {
    poster.push({ loc: `${base}/butik/mobel/${t.slug}`, changefreq: "daily", priority: "0.9" });
  }

  // Märkena ur LAGRET, inte ur en lista — ett märke finns som sida bara så länge det finns i hyllan.
  const marken = new Map<string, string>();
  for (const p of synliga) {
    if (p.brand) marken.set(brandSlug(p.brand), p.brand);
  }
  for (const slug of [...marken.keys()].sort()) {
    poster.push({ loc: `${base}/butik/marke/${slug}`, changefreq: "daily", priority: "0.8" });
  }

  for (const p of synliga) {
    if (!arIndexerbar(p)) continue;
    if (p.source !== "loopa") continue;
    poster.push({
      loc: `${base}/butik/objekt/${encodeURIComponent(p.id)}`,
      lastmod: lastmodOf(p),
      changefreq: "weekly",
      priority: "0.7",
      image: p.imageUrl ? { loc: absolut(p.imageUrl), title: p.title } : null,
    });
  }

  /**
   * Efterlysningsväggen. Egen adressrymd, eget sidhuvud i seo.ts, och minst lika sökbar —
   * "sökes string hylla stockholm" är en fråga folk ställer. Kategorierna räknas inte om mot
   * efterfrågan här: väggen sätter själv noindex när den är tom, och en tom vägg är ett
   * övergående tillstånd medan en tom kategori är ett tomt lager.
   */
  poster.push({ loc: `${base}/efterlyses`, changefreq: "daily", priority: "0.6" });
  for (const c of CATEGORIES) {
    poster.push({ loc: `${base}/efterlyses/${c.slug}`, changefreq: "weekly", priority: "0.5" });
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    poster.map(urlTag).join("\n") +
    `\n</urlset>\n`
  );
}
