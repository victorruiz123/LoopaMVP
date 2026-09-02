/**
 * Butikens sidor som en sökmotor ser dem.
 *
 * Appen är en ensidig React-app: servern skickar samma index.html för varje adress och webbläsaren
 * ritar resten (se static.ts). Det duger för säljflödet, som ingen ska hitta via Google. Det duger
 * inte för butiken, vars produktsidor, kategorisidor och märkessidor ÄR den organiska ingången —
 * en robot som får ett tomt skal indexerar en tom sida.
 *
 * LÖSNINGEN ÄR INTE SSR. Att rendera React på servern hade betytt ett andra byggmål, en andra
 * ingång och en klass av buggar där servern och klienten ritar olika saker. Det som faktiskt
 * behövs är mindre: en titel, en beskrivning, en kanonisk adress, delningskort och strukturerad
 * data — plus tillräckligt med läsbar text i kroppen för att sidan ska ha ett innehåll även utan
 * JavaScript. Det injiceras här, i skalet, innan det skickas.
 *
 * React tar sedan över och ritar om kroppen. Innehållet nedan är alltså både robotens version och
 * det som syns under den halvsekund appen startar — därför är det riktig text, inte nyckelord.
 */

import { brandSlug, CATEGORIES, categoryBySlug } from "./catalog.js";
import { allProducts, productById } from "./inventory.js";
import type { Product } from "./types.js";

const SITE = "Loopa Butik";
const MOTTO = "Köp begagnat. Handla som nytt.";

function baseUrl(): string {
  return (process.env.LOOPA_PUBLIC_URL || "https://app.loopa.nu").replace(/\/+$/, "");
}

/** XML/HTML-escape. Titlar kommer ur annonsgeneratorn och kan innehålla vad som helst. */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SeoHead {
  title: string;
  description: string;
  canonical: string;
  /** Absolut bild-URL för delningskortet, när sidan har en. */
  image?: string | null;
  /** JSON-LD, redan serialiserad. */
  jsonLd?: string | null;
  /** Läsbar text i <body> för robotar och för sekunden innan appen startat. */
  body?: string;
  /** Sant när sidan inte ska indexeras — en såld möbel eller en tom kategori. */
  noindex?: boolean;
}

/**
 * Loopas betyg -> schema.org:s villkorsvokabulär.
 *
 * schema.org har fyra värden och vi har sex betyg, så mappningen är grov med flit. `NewCondition`
 * används ALDRIG: möbeln är begagnad, och att påstå något annat i strukturerad data vore att ljuga
 * på ett ställe där bara maskiner läser — vilket inte gör det bättre.
 */
function schemaCondition(grade: string): string {
  if (grade === "A" || grade === "B") return "https://schema.org/UsedCondition";
  if (grade === "F") return "https://schema.org/DamagedCondition";
  return "https://schema.org/UsedCondition";
}

function availability(state: Product["state"]): string {
  switch (state) {
    case "live": return "https://schema.org/InStock";
    case "reserved": return "https://schema.org/LimitedAvailability";
    default: return "https://schema.org/SoldOut";
  }
}

/**
 * Strukturerad data för EN möbel.
 *
 * Bara för Loopa-varor. En Tradera-annons är någon annans produkt på någon annans sida, och att
 * lägga ut vår egen Product-markering för den vore att göra anspråk på ett utbud vi inte har.
 */
function productJsonLd(p: Product): string {
  const url = `${baseUrl()}/butik/objekt/${encodeURIComponent(p.id)}`;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    url,
    ...(p.brand ? { brand: { "@type": "Brand", name: p.brand } } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.imageUrl ? { image: p.imageUrl.startsWith("http") ? p.imageUrl : `${baseUrl()}${p.imageUrl}` } : {}),
    ...(p.color ? { color: p.color } : {}),
    ...(p.material ? { material: p.material } : {}),
    // Loopa-ID:t är artikelnumret: unikt, publikt och det köparen kan slå upp besiktningen på.
    sku: p.id,
    itemCondition: schemaCondition(p.condition?.grade ?? "C"),
    description: p.condition
      ? `${p.condition.label}. ${p.condition.rationale} AI-granskad ${new Date(p.condition.inspectedAt).toLocaleDateString("sv-SE")}.`
      : p.title,
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: "SEK",
      ...(p.priceSek !== null ? { price: p.priceSek } : {}),
      availability: availability(p.state),
      itemCondition: schemaCondition(p.condition?.grade ?? "C"),
      seller: { "@type": "Organization", name: "Loopa" },
      areaServed: { "@type": "City", name: "Stockholm" },
      /**
       * INGEN returpolicy i den strukturerade datan.
       *
       * Här stod `hasMerchantReturnPolicy` med 14 dagar. Löftet är borttaget ur gränssnittet, och då
       * måste det bort här också — annars står det kvar i Googles produktkort, där det syns för fler
       * och går att lita på lika mycket. Strukturerad data är inte en beskrivning av sidan utan ett
       * påstående om affären.
       */
    },
  };
  // Måtten som riktiga QuantitativeValue — bara de som faktiskt är uppmätta.
  const dims: Record<string, number | null> = { width: p.dimensions.widthMm, depth: p.dimensions.depthMm, height: p.dimensions.heightMm };
  for (const [key, mm] of Object.entries(dims)) {
    if (mm !== null) data[key] = { "@type": "QuantitativeValue", value: mm / 10, unitCode: "CMT" };
  }
  return JSON.stringify(data);
}

/** Sidhuvudet för en adress under /butik, eller null när adressen inte är butikens. */
export async function seoFor(pathname: string, search: string): Promise<SeoHead | null> {
  // Grinden först. Utan den blev "/" till rest === "" och fick butikens landningssidehuvud —
  // säljverktygets förstasida hade då presenterat sig som en möbelbutik för varje sökmotor.
  if (pathname !== "/butik" && !pathname.startsWith("/butik/")) return null;
  const rest = pathname.slice("/butik".length).replace(/^\/+|\/+$/g, "");
  const canonical = `${baseUrl()}${pathname}`;

  if (rest === "") {
    return {
      title: `${SITE} – ${MOTTO}`,
      description:
        "Begagnade möbler i Stockholm, besiktigade av AI. Du ser varje skada och exakta mått innan du köper. Fast pris och hemleverans i Stockholm.",
      canonical,
      body: `<h1>${MOTTO}</h1><p>Begagnade möbler i Stockholm. Varje Loopa-granskad möbel är filmad, besiktigad och prissatt efter skick.</p>` +
        `<ul>${CATEGORIES.map((c) => `<li><a href="/butik/kategori/${c.slug}">${esc(c.label)}</a></li>`).join("")}</ul>`,
    };
  }

  const [head, tail] = rest.split("/");

  if (head === "kategori" && tail) {
    const category = categoryBySlug(decodeURIComponent(tail));
    if (!category) return null;
    return {
      title: `Begagnade ${category.label.toLowerCase()} i Stockholm – ${SITE}`,
      description: `${category.blurb} Besiktigade av Loopa, med mått och skick redovisat. Hemleverans i Stockholm.`,
      canonical,
      body: `<h1>${esc(category.label)}</h1><p>${esc(category.blurb)}</p>`,
    };
  }

  if (head === "marke" && tail) {
    const slug = decodeURIComponent(tail);
    /**
     * Märkets namn hämtas ur LAGRET, inte ur adressen.
     *
     * Slugen är gemener, och att versalisera första bokstaven gör "ikea" till "Ikea" — vilket är fel
     * namn på ett företag som skriver sig IKEA, och dessutom står i strid med rubriken på samma
     * sida, som läser det riktiga namnet ur produkterna. Adressen är en identifierare, inte en
     * stavning. Finns märket inte i lager får det titelversalisering som sista utväg.
     */
    const name =
      (await allProducts()).find((p) => p.brand && brandSlug(p.brand) === slug)?.brand ??
      slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    /**
     * "IKEA secondhand" och inte "Begagnat från IKEA".
     *
     * Det är så folk söker — "ikea secondhand", "mio second hand" — och titeln är det enda i
     * sökresultatet som kan matcha den frasen ordagrant. Sidan heter samma sak i rubriken, så det
     * som klickades på är det som möter.
     */
    return {
      title: `${name} secondhand i Stockholm – ${SITE}`,
      description: `${name} secondhand: begagnade ${name}-möbler besiktigade av Loopa. Skick, mått och pris redovisat innan du köper. Hemleverans i Stockholm.`,
      canonical,
      body:
        `<h1>${esc(name)} secondhand</h1>` +
        `<p>Begagnade möbler från ${esc(name)}, granskade av Loopa och klara att köpa i Stockholm.</p>`,
    };
  }

  if (head === "objekt" && tail) {
    const product = await productById(decodeURIComponent(tail));
    if (!product) {
      return { title: `Möbeln finns inte – ${SITE}`, description: "Möbeln är såld eller borttagen.", canonical, noindex: true };
    }
    const price = product.priceSek !== null ? `${product.priceSek} kr` : "Pris saknas";
    const cond = product.condition ? `${product.condition.label}.` : "";
    const dims = [product.dimensions.widthMm, product.dimensions.depthMm, product.dimensions.heightMm]
      .map((mm) => (mm === null ? null : Math.round(mm / 10)))
      .filter((v): v is number => v !== null);
    return {
      title: `${product.title} – ${price} – ${SITE}`,
      description:
        `${product.title}, ${price}. ${cond} ${dims.length ? `Mått ${dims.join(" × ")} cm. ` : ""}` +
        `Besiktigad av Loopa med varje skada utpekad. Hemleverans i Stockholm.`.trim(),
      canonical,
      image: product.imageUrl,
      // Strukturerad data bara för det vi själva säljer och kan svara för.
      jsonLd: product.source === "loopa" ? productJsonLd(product) : null,
      // En såld möbel ska inte ligga kvar som en träff i sökresultatet.
      noindex: product.state !== "live" && product.state !== "reserved",
      body:
        `<h1>${esc(product.title)}</h1><p>${esc(price)}</p>` +
        (product.condition ? `<p>Skick: ${esc(product.condition.label)} — ${esc(product.condition.rationale)}</p>` : "") +
        (dims.length ? `<p>Mått: ${dims.join(" × ")} cm</p>` : ""),
    };
  }

  if (head === "sok") {
    const q = new URLSearchParams(search).get("q") ?? "";
    return {
      title: q ? `${q} – ${SITE}` : `Alla möbler – ${SITE}`,
      description: "Sök bland begagnade möbler i Stockholm, besiktigade av Loopa.",
      canonical: `${baseUrl()}/butik/sok`,
      // En sökträffsida är inte ett innehåll att indexera — kategorierna och produkterna är det.
      noindex: true,
    };
  }

  return null;
}

/**
 * Skjuter in huvudet i det byggda skalet.
 *
 * Byter ut <title> och beskrivningen som redan står där, och lägger resten före </head>. Kroppen
 * skrivs in i #root, som React sedan ritar om — innehållet är alltså en verklig första rendering och
 * inte en dold kopia. Dolda dubbletter av innehåll är dessutom precis vad sökmotorer straffar.
 */
export function injectSeo(html: string, head: SeoHead): string {
  const tags = [
    `<meta name="description" content="${esc(head.description)}" />`,
    `<link rel="canonical" href="${esc(head.canonical)}" />`,
    head.noindex ? `<meta name="robots" content="noindex,follow" />` : `<meta name="robots" content="index,follow" />`,
    `<meta property="og:type" content="${head.jsonLd ? "product" : "website"}" />`,
    `<meta property="og:title" content="${esc(head.title)}" />`,
    `<meta property="og:description" content="${esc(head.description)}" />`,
    `<meta property="og:url" content="${esc(head.canonical)}" />`,
    `<meta property="og:site_name" content="${SITE}" />`,
    `<meta property="og:locale" content="sv_SE" />`,
    `<meta name="twitter:card" content="${head.image ? "summary_large_image" : "summary"}" />`,
    head.image ? `<meta property="og:image" content="${esc(head.image.startsWith("http") ? head.image : baseUrl() + head.image)}" />` : "",
    head.jsonLd ? `<script type="application/ld+json">${head.jsonLd.replace(/</g, "\\u003c")}</script>` : "",
  ].filter(Boolean).join("\n    ");

  /**
   * Skalets EGNA taggar tas bort först.
   *
   * index.html bär redan en beskrivning och ett og-kort — för säljverktyget ("Sälj med Loopa: filma
   * ett varv…"). Läggs butikens taggar bara till står sidan med två og:title och två beskrivningar,
   * och vilken som vinner är upp till den som läser. Taggarna är dessutom skrivna över flera rader,
   * så mönstren måste tåla radbrytningar inuti taggen — `[^>]` gör det, `.` hade inte gjort det.
   */
  const stripped = html
    .replace(/<meta\s[^>]*name="description"[^>]*>/gi, "")
    .replace(/<meta\s[^>]*property="og:[^"]*"[^>]*>/gi, "")
    .replace(/<meta\s[^>]*name="twitter:[^"]*"[^>]*>/gi, "")
    .replace(/<link\s[^>]*rel="canonical"[^>]*>/gi, "");

  let out = stripped.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(head.title)}</title>`);
  out = out.replace(/<\/head>/i, `  ${tags}\n  </head>`);

  if (head.body) {
    out = out.replace(/<div id="root">\s*<\/div>/i, `<div id="root">${head.body}</div>`);
  }
  return out;
}
