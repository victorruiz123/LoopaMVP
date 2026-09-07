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

import { brandSlug, CATEGORIES, categoryBySlug, categoryLabel, categoryNoun as categoryNounOf, furnitureTypeBySlug, furnitureTypesIn, MOBELTYPER, resolveTypeSlug, typeHeading, type FurnitureType } from "./catalog.js";
import { typeFacetsMerged } from "./inventory.js";
import { allProducts, applyFilter, productById } from "./inventory.js";
import { BROWSABLE_STATES, type Product } from "./types.js";

const SITE = "Loopa Butik";
const MOTTO = "Köp begagnat. Handla som nytt.";

export function baseUrl(): string {
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

/**
 * Om möbeln ska ligga i sökresultatet.
 *
 * EN REGEL, TVÅ LÄSARE. Sidhuvudet nedan sätter noindex utifrån den, och sitemap.ts avgör med samma
 * funktion vilka adresser vi ber Google hämta. Skulle de svara olika hade sitemapen pekat på sidor
 * som säger noindex — vilket Search Console rapporterar som fel, och de felen dränker de riktiga.
 *
 * En såld möbel finns i ett exemplar och kommer aldrig tillbaka. Sidan svarar fortfarande 200 och
 * går att läsa, men den ska inte vara en träff man klickar på och möts av "såld".
 */
export function arIndexerbar(p: Product): boolean {
  return BROWSABLE_STATES.includes(p.state);
}

/** Priset som text, med samma "Pris saknas" som produktsidan säger. */
function prisText(p: Product): string {
  return p.priceSek !== null ? `${p.priceSek} kr` : "Pris saknas";
}

/**
 * Varorna som en läsbar lista i kroppen.
 *
 * DET HÄR ÄR SIDANS FAKTISKA INNEHÅLL. Kategorisidan bar tidigare en rubrik och en blurb, punkt —
 * två meningar som ska ranka på "begagnade stolar" mot sidor med hundra varor på. Värre: eftersom
 * rutnätet ritas av React var det HÄRIFRÅN ingen länk gick vidare till en enda produktsida, och en
 * robot som inte kör JavaScript hittade därför aldrig till möblerna alls.
 *
 * Listan är riktiga länkar med riktiga priser, och den är samma innehåll React strax ritar om — inte
 * en dold kopia för robotar. Antalet är tilltaget för att sidan ska ha tyngd men inte bli en vägg:
 * de 48 första i samma ordning som rutnätet visar dem.
 */
const MAX_I_LISTAN = 48;

function varulista(items: Product[]): string {
  if (items.length === 0) return "";
  return (
    `<ul>` +
    items
      .slice(0, MAX_I_LISTAN)
      .map((p) => {
        const href = `/butik/objekt/${encodeURIComponent(p.id)}`;
        const skick = p.condition ? ` – ${esc(p.condition.label)}` : "";
        return `<li><a href="${esc(href)}">${esc(p.title)}</a> – ${esc(prisText(p))}${skick}</li>`;
      })
      .join("") +
    `</ul>`
  );
}

/**
 * Rutnätets varor för ett filter, i rutnätets egen ordning.
 *
 * Går genom `applyFilter` och inte genom en egen slinga, för att listan roboten ser och listan
 * besökaren ser MÅSTE vara samma urval. Två filtreringar av samma lager är två sanningar, och den
 * ena hade blivit fel den dag någon rör vid den andra.
 */
async function varorFor(filter: { categorySlug?: string; typeSlug?: string; brands?: string[] }): Promise<Product[]> {
  const alla = await allProducts();
  return applyFilter(alla, { ...filter, limit: MAX_I_LISTAN, sort: "relevans" }).items;
}

/**
 * ItemList — listan som strukturerad data.
 *
 * Talar om för Google att sidan ÄR en lista av produkter och vilka de är, i vilken ordning. Det som
 * gör en kategorisida till en kategorisida i deras ögon i stället för en artikel som råkar nämna
 * möbler.
 */
function itemListJsonLd(items: Product[], name: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.slice(0, MAX_I_LISTAN).map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${baseUrl()}/butik/objekt/${encodeURIComponent(p.id)}`,
      name: p.title,
    })),
  };
}

/**
 * Prisspannet i lagret, som text: "från 400 kr till 6 500 kr".
 *
 * Ett faktiskt spann ur hyllan och inte en påhittad prisbild. Det är den uppgift en sida om
 * "begagnad soffa" oftast saknar och den som oftast avgör klicket. Null när ingen vara har pris.
 */
function prisSpann(items: Product[]): { min: number; max: number } | null {
  const priser = items.map((p) => p.priceSek).filter((v): v is number => v !== null);
  if (priser.length === 0) return null;
  return { min: Math.min(...priser), max: Math.max(...priser) };
}

function kr(n: number): string {
  return `${n.toLocaleString("sv-SE").replace(/\u00a0/g, " ")} kr`;
}

/**
 * Frågorna en sida om en möbeltyp ska kunna svara på — och svaren är SANNA för just den hyllan.
 *
 * Prisfrågan bär det verkliga spannet, skickfrågan beskriver besiktningen som den görs, och
 * leveransfrågan lovar det kassan faktiskt gör: Stockholm, inte "hela landet". Frågorna står i
 * kroppen som text OCH som FAQPage — markeringen får bara beskriva det som syns på sidan.
 */
function vanligaFragor(what: string, whatPlural: string, span: { min: number; max: number } | null): Array<{ q: string; a: string }> {
  const fragor: Array<{ q: string; a: string }> = [];
  if (span) {
    fragor.push({
      q: `Vad kostar en begagnad ${what} hos Loopa?`,
      a: span.min === span.max
        ? `Just nu ${kr(span.min)}. Priset är satt efter skick och marknadspris för samma modell, och det står fast — ingen budgivning.`
        : `Just nu från ${kr(span.min)} till ${kr(span.max)}. Varje pris är satt efter skick och marknadspris för samma modell, och det står fast — ingen budgivning.`,
    });
  }
  fragor.push({
    q: `Hur vet jag vilket skick en begagnad ${what} är i?`,
    a: `Varje Loopa-granskad möbel är filmad runt om och besiktigad av AI. Skador, slitage och fläckar pekas ut på produktsidan med bild, och skicket får ett betyg från A till F. Måtten står i centimeter.`,
  });
  fragor.push({
    q: `Levererar ni ${whatPlural} hem?`,
    a: `Ja. Hemleverans i Stockholm ingår i köpet, och du väljer dag och tid efter betalningen. Betalningen hålls tills möbeln är levererad.`,
  });
  return fragor;
}

function faqJsonLd(fragor: Array<{ q: string; a: string }>): Record<string, unknown> | null {
  if (fragor.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: fragor.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

function faqHtml(fragor: Array<{ q: string; a: string }>): string {
  if (fragor.length === 0) return "";
  return `<h2>Vanliga frågor</h2>` + fragor.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("");
}

/** Märkena i ett urval, med antal, flest först. Länkarna gör typsidan till en väg vidare in i märkena. */
function markenI(items: Product[]): Array<{ brand: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of items) if (p.brand) counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
  return [...counts].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, "sv"));
}

/** Typerna i en kategori som FAKTISKT har varor, ur samma urval som sidan visar. */
function typerMedVaror(items: Product[], categorySlug: string): Array<FurnitureType & { count: number }> {
  const counts = new Map<string, number>();
  for (const p of items) {
    const t = resolveTypeSlug(p);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return furnitureTypesIn(categorySlug)
    .filter((t) => counts.has(t.slug))
    .map((t) => ({ ...t, count: counts.get(t.slug)! }));
}

/**
 * Brödsmulorna.
 *
 * Ger sökresultatet "loopa.nu › Butik › Stolar" i stället för en naken URL, vilket är den enda
 * gratis ytan man har för att säga var på sajten träffen sitter. Trappan skrivs som par av namn och
 * adress; sista steget är sidan man står på.
 */
function breadcrumbJsonLd(steg: Array<{ name: string; path: string }>): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: steg.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: s.name,
      item: `${baseUrl()}${s.path}`,
    })),
  };
}

/**
 * Flera grafer i EN script-tagg.
 *
 * injectSeo skjuter in `jsonLd` som den är, och en JSON-LISTA är giltig JSON-LD — Google läser varje
 * post för sig. Alternativet, flera script-taggar, hade krävt att skalet kan ta emot en lista och
 * gav ingenting tillbaka.
 */
function grafer(...delar: Array<Record<string, unknown> | null>): string {
  const kvar = delar.filter((d): d is Record<string, unknown> => d !== null);
  if (kvar.length === 0) return "";
  return JSON.stringify(kvar.length === 1 ? kvar[0] : kvar);
}

/**
 * Vem butiken är. Ligger på landningssidan, en gång.
 *
 * Organization knyter ihop sajten med företaget, och `WebSite` med `SearchAction` är det som kan ge
 * ett sökfält direkt i Googles träff. Båda är billiga och båda står på EN sida — upprepade på varje
 * produktsida blir de brus utan att bli sannare.
 */
function sajtJsonLd(): Record<string, unknown>[] {
  const base = baseUrl();
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Loopa",
      url: base,
      areaServed: { "@type": "City", name: "Stockholm" },
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE,
      url: `${base}/butik`,
      inLanguage: "sv-SE",
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${base}/butik/sok?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
  ];
}

/** Värden butiken ska bo på, härledd ur LOOPA_PUBLIC_URL. Null när adressen inte går att tolka. */
export function kanoniskVard(): string | null {
  try {
    return new URL(baseUrl()).host;
  } catch {
    return null;
  }
}

/**
 * Sökvägar som ALDRIG kanoniseras.
 *
 * Allt annat flyttar. Listan är vänd sedan butiken flyttade ensam: nu bor hela appen på
 * marknadsdomänen, och en tillåtelselista över det som flyttat hade behövt uppdateras varje gång
 * appen fick en ny sida — och glömts, tyst, med en sida på fel domän som följd.
 *
 * `/c/` — sanningskorten. Publicerade Tradera-annonser bär `app.loopa.nu/c/LP-XXXX` inbakat i sin
 * annonstext. Adressen svarar där den står, utan omväg, för all framtid.
 *
 * `/api/` och `/v1/` — maskinvägar. En omdirigering här flyttar inte en läsare utan bryter en
 * integration, och den som anropar API:t har fått sin adress av oss.
 *
 * `/health` — övervakningen frågar servern, inte domänen. Svaret ska komma från maskinen som
 * tillfrågas, annars mäter man något annat än det man tror.
 *
 * `/robots.txt` — filen gäller det värdnamn den hämtas från, och varje värdnamn ska kunna svara på
 * sin egen. Den omdirigerades först, och då svarade Cloudflare med sin egen robots.txt i stället —
 * utan våra direktiv och utan Sitemap-raden, eftersom det inte fanns något ursprungssvar att lägga
 * dem till. En robot som frågar den gamla domänen ska få ett riktigt svar som pekar vidare, inte en
 * omväg. Sitemapen får däremot flytta: den är en lista över adresser, inte en regel om en värd.
 */
const ALDRIG = ["/c/", "/api/", "/v1/", "/health", "/robots.txt"];

/**
 * Är värdnamnet ett publikt namn en besökare kan ha skrivit in?
 *
 * BARA SÅDANA SKA KANONISERAS. Utan den här kontrollen omdirigerade servern varje förfrågan mot
 * 127.0.0.1 till app.loopa.nu — hälsokontroller, interna anrop och utrullningsskriptets egen
 * verifiering, som därför underkände en fullt korrekt utrullning. Riktiga besökare kommer via
 * tunneln med rätt värdnamn och märkte ingenting, vilket är precis varför felet var lätt att missa.
 *
 * Loopback och rena IP-adresser räknas bort. Ingen surfar till en butik via en IP-adress, och den
 * som gör det har inte kommit dit från ett sökresultat — vilket är det enda omdirigeringen finns för.
 */
function arPublikVard(host: string): boolean {
  const namn = host.split(":")[0].trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (namn === "localhost" || namn.endsWith(".localhost")) return false;
  if (namn === "::1" || namn.startsWith("127.")) return false;
  // Ren IPv4. Ett namn utan bokstäver är ingen domän.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(namn)) return false;
  return namn.includes(".");
}

/**
 * Har roten flyttat än?
 *
 * `loopa.nu/` visar marknadssajtens företagssida fram till lansering — en Cloudflare-regel som
 * ligger kvar med flit. Kanoniserades roten ändå fick en säljare den här kedjan:
 * app.loopa.nu/ → 301 → loopa.nu/ → 302 → /company. Säljflödet gick inte att nå från någon adress
 * alls, och det var precis vad som hände i drift innan den här raden fanns.
 *
 * Roten är den ENDA sökvägen där de två sajterna gör anspråk på samma adress, och därför den enda
 * som behöver ett datum. Resten flyttade direkt.
 *
 * Vid lansering: sätt LOOPA_ROT_FLYTTAD=1 i server/.env, ta bort omdirigeringsregeln i Cloudflare,
 * starta om. Ordningen spelar roll — regeln körs före Workers, så tas den inte bort når förfrågan
 * aldrig appen.
 */
function rotFlyttad(): boolean {
  return process.env.LOOPA_ROT_FLYTTAD?.trim() === "1";
}

/**
 * Adressen en förfrågan ska omdirigeras till, eller null när den redan står rätt.
 *
 * DUBBELPUBLICERING ÄR DET SOM SKA UNDVIKAS. Ligger samma butikssida på två värdnamn räknar Google
 * dem som två sidor med samma innehåll, och delar värdet mellan dem — vilket är precis motsatsen
 * till varför vi flyttade.
 *
 * `host` ska vara den värd BESÖKAREN bad om, inte den servern råkar lyssna på. Går förfrågan genom
 * en router framför oss är det routern som vet det, och den skickar det i `x-forwarded-host`. Utan
 * den skulle servern se sitt eget namn, omdirigera dit den redan står, och göra en oändlig slinga.
 */
export function flyttadAdress(host: string | null, pathname: string, search: string): string | null {
  const kanonisk = kanoniskVard();
  if (!kanonisk || !host) return null;
  if (!arPublikVard(host)) return null;
  if (host.toLowerCase() === kanonisk.toLowerCase()) return null;
  if (pathname === "/" && !rotFlyttad()) return null;
  if (ALDRIG.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p))) return null;
  return `${baseUrl()}${pathname}${search}`;
}

/** Sidhuvudet för en adress under /butik, eller null när adressen inte är butikens. */
export async function seoFor(pathname: string, search: string): Promise<SeoHead | null> {
  /*
   * KÖPSIDANS SIDHUVUD ÄR BORTTAGET MED SIDAN.
   *
   * /kop bar en egen titel, en beskrivning och tre frågor som strukturerad FAQ. Adressen 301:as nu
   * till butiken (se server.ts), och ett sidhuvud för en adress som svarar 301 vore ett löfte till
   * sökmotorn om en sida som inte finns. Butikens egna sidor och efterfrågeväggen har sina kvar.
   */

  /**
   * Efterlysningsväggen, renderad per kategori.
   *
   * "sökes string hylla stockholm" är en fråga folk faktiskt ställer, och varje kategori är en egen
   * sida som svarar på den. Sidan vänder sig till SÄLJARE — den som söker efter att sälja något ska
   * hitta hit — och kroppen listar riktig, anonymiserad efterfrågan så att en robot ser innehåll
   * och inte en tom app.
   *
   * INGEN KÖPARIDENTITET, av samma skäl som på väggen själv: raderna kommer ur `wall()`, som redan
   * aggregerat bort dem.
   */
  if (pathname === "/efterlyses" || pathname.startsWith("/efterlyses/")) {
    const slug = pathname.slice("/efterlyses".length).replace(/^\/+|\/+$/g, "") || null;
    const { wall } = await import("../efterlysning/wall.js");
    const rows = await wall(slug);
    const label = slug ? categoryLabel(slug) : null;
    const what = label ? label.toLowerCase() : "möbler";
    return {
      title: label ? `Sökes: ${label.toLowerCase()} i Stockholm – ${SITE}` : `Sökes just nu i Stockholm – ${SITE}`,
      description: `Riktiga köpare i Stockholm som söker ${what}. Har du en i förrådet? Filma den på tre minuter — Loopa besiktigar, prissätter och hämtar hem den.`,
      canonical: `${baseUrl()}${pathname}`,
      // Tom vägg = ingenting att indexera. Bättre än en sida som lovar efterfrågan och visar noll.
      noindex: rows.length === 0,
      body:
        `<h1>Sökes: ${esc(what)} i Stockholm</h1>` +
        `<p>Riktiga köpare som väntar. Har du en av dem? Sälj den med Loopa.</p>` +
        `<ul>${rows.map((r) => `<li>${esc(r.title)}${r.area ? ` – ${esc(r.area)}` : ""}</li>`).join("")}</ul>` +
        `<ul>${CATEGORIES.map((c) => `<li><a href="/efterlyses/${c.slug}">Sökes: ${esc(c.label.toLowerCase())}</a></li>`).join("")}</ul>`,
    };
  }

  // Grinden först. Utan den blev "/" till rest === "" och fick butikens landningssidehuvud —
  // säljverktygets förstasida hade då presenterat sig som en möbelbutik för varje sökmotor.
  if (pathname !== "/butik" && !pathname.startsWith("/butik/")) return null;
  const rest = pathname.slice("/butik".length).replace(/^\/+|\/+$/g, "");
  const canonical = `${baseUrl()}${pathname}`;

  if (rest === "") {
    const marken = [
      ...new Set(
        (await allProducts())
          .filter((p) => arIndexerbar(p) && p.brand)
          .map((p) => p.brand as string),
      ),
    ].sort((a, b) => a.localeCompare(b, "sv"));
    const typer = typeFacetsMerged(await allProducts()).map((f) => furnitureTypeBySlug(f.slug)!);
    return {
      title: `${SITE} – ${MOTTO}`,
      description:
        "Begagnade möbler i Stockholm, besiktigade av AI. Du ser varje skada och exakta mått innan du köper. Fast pris och hemleverans i Stockholm.",
      canonical,
      jsonLd: grafer(...sajtJsonLd()),
      /**
       * Landningssidan är navet, och den ska LÄNKA som ett nav.
       *
       * Kategorierna stod här ensamma. Märkeslänkarna är tillagda för att märkessidorna annars bara
       * nås via ett filter React ritar — de fanns i adressrymden men inte i länkgrafen, och en sida
       * ingenting länkar till hittas inte. Märkena hämtas ur lagret så att listan aldrig lovar en
       * sida för ett märke vi inte har i hyllan.
       */
      body:
        `<h1>${MOTTO}</h1><p>Begagnade möbler i Stockholm. Varje Loopa-granskad möbel är filmad, besiktigad och prissatt efter skick.</p>` +
        `<ul>${CATEGORIES.map((c) => `<li><a href="/butik/kategori/${c.slug}">${esc(c.label)}</a></li>`).join("")}</ul>` +
        /**
         * Möbeltyperna, bara de med varor. Typsidorna är de som ska ranka på "begagnad soffa" och
         * "begagnat matbord", och en sida ingenting länkar till rankar inte alls. Räknas ur lagret av
         * samma skäl som märkena: listan får inte lova en sida för en typ hyllan saknar.
         */
        (typer.length
          ? `<h2>Begagnade möbler efter typ</h2><ul>${typer
              .map((t) => `<li><a href="/butik/mobel/${t.slug}">${esc(typeHeading(t))}</a></li>`)
              .join("")}</ul>`
          : "") +
        (marken.length
          ? `<h2>Märken i butiken</h2><ul>${marken
              .map((m) => `<li><a href="/butik/marke/${brandSlug(m)}">${esc(m)} secondhand</a></li>`)
              .join("")}</ul>`
          : ""),
    };
  }

  const [head, tail] = rest.split("/");

  if (head === "kategori" && tail) {
    const category = categoryBySlug(decodeURIComponent(tail));
    if (!category) return null;
    const items = await varorFor({ categorySlug: category.slug });
    const rubrik = `Begagnade ${category.label.toLowerCase()} i Stockholm`;
    const typer = typerMedVaror(items, category.slug);
    const fragor = items.length ? vanligaFragor(categoryNounOf(category.slug), category.label.toLowerCase(), prisSpann(items)) : [];
    return {
      /**
       * Antalet i titeln, när vi har ett.
       *
       * "Begagnade stolar i Stockholm – 23 st" säger något en konkurrents titel inte gör, och det är
       * en uppgift och inte en påhittad superlativ. Faller lagret till noll faller siffran bort med
       * det — en titel som lovar varor på en tom sida är sämre än ingen siffra alls.
       */
      title: items.length
        ? `${rubrik} – ${items.length} st – ${SITE}`
        : `${rubrik} – ${SITE}`,
      description: `${category.blurb} Besiktigade av Loopa, med mått och skick redovisat. Hemleverans i Stockholm.`,
      canonical,
      // En tom kategori har ingenting att indexera. Samma regel som efterlysningsväggens tomma vägg.
      noindex: items.length === 0,
      jsonLd: grafer(
        breadcrumbJsonLd([
          { name: SITE, path: "/butik" },
          { name: category.label, path: `/butik/kategori/${category.slug}` },
        ]),
        items.length ? itemListJsonLd(items, rubrik) : null,
        faqJsonLd(fragor),
      ),
      body:
        `<h1>${esc(rubrik)}</h1><p>${esc(category.blurb)}</p>` +
        varulista(items) +
        /**
         * Typerna under kategorin, bara de med varor. "begagnad byrå" ska landa på byråsidan, och
         * vägen dit går via kategorin — det här är den länken.
         */
        (typer.length
          ? `<h2>${esc(category.label)} efter typ</h2><ul>${typer
              .map((t) => `<li><a href="/butik/mobel/${t.slug}">${esc(typeHeading(t))} (${t.count})</a></li>`)
              .join("")}</ul>`
          : "") +
        faqHtml(fragor) +
        `<h2>Fler kategorier</h2><ul>${CATEGORIES.filter((c) => c.slug !== category.slug)
          .map((c) => `<li><a href="/butik/kategori/${c.slug}">${esc(c.label)}</a></li>`)
          .join("")}</ul>`,
    };
  }

  /**
   * Typsidan — den som ska ranka på "begagnad soffa".
   *
   * Det är så folk söker: singular, obestämd form, ordet för möbeln. Kategorisidan heter "Begagnade
   * soffor" och det är rätt över ett rutnät, men frasen i sökrutan är "begagnad soffa", och titeln
   * är det enda i träffen som kan matcha den ordagrant. Därför står den först i titeln, i rubriken
   * och i adressen.
   *
   * ALLT PÅ SIDAN ÄR HÄMTAT UR HYLLAN: antalet, prisspannet, märkena, varorna. Det är det som skiljer
   * den från en tunn nyckelordssida — och en tom hylla ger noindex, aldrig en sida som lovar soffor
   * och visar ingenting.
   */
  if (head === "mobel" && tail) {
    const type = furnitureTypeBySlug(decodeURIComponent(tail));
    if (!type) return null;
    const category = categoryBySlug(type.categorySlug);
    const items = await varorFor({ typeSlug: type.slug });
    const heading = typeHeading(type);
    const rubrik = `${heading} i Stockholm`;
    const span = prisSpann(items);
    const fragor = items.length ? vanligaFragor(type.noun, type.label.toLowerCase(), span) : [];
    const marken = markenI(items);
    const syskon = furnitureTypesIn(type.categorySlug).filter((t) => t.slug !== type.slug);
    const lagerrad = items.length
      ? `Just nu ${items.length} ${items.length === 1 ? `begagnad ${type.noun}` : `begagnade ${type.label.toLowerCase()}`} till salu hos Loopa` +
        (span ? (span.min === span.max ? `, ${kr(span.min)}.` : `, från ${kr(span.min)} till ${kr(span.max)}.`) : ".") +
        ` Alla är filmade, besiktigade och prissatta efter skick, och levereras hem i Stockholm.`
      : "";
    return {
      title: items.length
        ? `${heading} i Stockholm – ${items.length} till salu – ${SITE}`
        : `${heading} i Stockholm – ${SITE}`,
      description:
        `${heading} i Stockholm: ${items.length ? `${items.length} begagnade ${type.label.toLowerCase()}` : `begagnade ${type.label.toLowerCase()}`}` +
        (span ? ` från ${kr(span.min)}` : "") +
        `, besiktigade av Loopa med skick och mått redovisat. Fast pris och hemleverans.`,
      canonical,
      noindex: items.length === 0,
      jsonLd: grafer(
        breadcrumbJsonLd([
          { name: SITE, path: "/butik" },
          ...(category ? [{ name: category.label, path: `/butik/kategori/${category.slug}` }] : []),
          { name: heading, path: `/butik/mobel/${type.slug}` },
        ]),
        items.length ? itemListJsonLd(items, rubrik) : null,
        faqJsonLd(fragor),
      ),
      body:
        `<h1>${esc(rubrik)}</h1><p>${esc(type.blurb)}</p>` +
        (lagerrad ? `<p>${esc(lagerrad)}</p>` : "") +
        varulista(items) +
        (marken.length
          ? `<h2>${esc(heading)} efter märke</h2><ul>${marken
              .map((m) => `<li><a href="/butik/marke/${brandSlug(m.brand)}">${esc(heading)} från ${esc(m.brand)} (${m.count})</a></li>`)
              .join("")}</ul>`
          : "") +
        faqHtml(fragor) +
        // "Fler övrigt" är inte svenska; hyllan utan eget namn får ett allmänt ord.
        (category
          ? `<h2>${category.slug === "ovrigt" ? "Fler möbler" : `Fler ${esc(category.label.toLowerCase())}`}</h2><ul>` +
            syskon.map((t) => `<li><a href="/butik/mobel/${t.slug}">${esc(typeHeading(t))}</a></li>`).join("") +
            `<li><a href="/butik/kategori/${category.slug}">Alla begagnade ${esc(category.label.toLowerCase())}</a></li></ul>`
          : ""),
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
    const items = await varorFor({ brands: [name] });
    /**
     * Kategorierna märket FAKTISKT har varor i.
     *
     * "begagnad mio madison" och "ikea stolar begagnat" är märke + kategori, och den korsningen har
     * ingen egen adress än. Tills den finns är de här länkarna det som för en robot vidare från
     * märket till rätt kategori — och listan räknas ur lagret, så den lovar aldrig en korsning som
     * är tom.
     */
    const kategorier = [...new Set(items.map((p) => p.categorySlug))];
    return {
      title: items.length
        ? `${name} secondhand i Stockholm – ${items.length} möbler – ${SITE}`
        : `${name} secondhand i Stockholm – ${SITE}`,
      description: `${name} secondhand: begagnade ${name}-möbler besiktigade av Loopa. Skick, mått och pris redovisat innan du köper. Hemleverans i Stockholm.`,
      canonical,
      // Ett märke utan varor är en tom sida. Den ska inte ligga i sökresultatet i väntan på lager.
      noindex: items.length === 0,
      jsonLd: grafer(
        breadcrumbJsonLd([
          { name: SITE, path: "/butik" },
          { name: `${name} secondhand`, path: `/butik/marke/${slug}` },
        ]),
        items.length ? itemListJsonLd(items, `${name} secondhand i Stockholm`) : null,
      ),
      body:
        `<h1>${esc(name)} secondhand</h1>` +
        `<p>Begagnade möbler från ${esc(name)}, granskade av Loopa och klara att köpa i Stockholm.</p>` +
        varulista(items) +
        (kategorier.length
          ? `<h2>${esc(name)} per kategori</h2><ul>${kategorier
              .map((c) => `<li><a href="/butik/kategori/${c}">${esc(categoryLabel(c))} från ${esc(name)}</a></li>`)
              .join("")}</ul>`
          : ""),
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
      /**
       * Strukturerad data bara för det vi själva säljer och kan svara för.
       *
       * Brödsmulorna gäller däremot BÅDA källorna: de beskriver var sidan sitter på vår sajt, inte
       * vems möbeln är, och det är sant även för en Tradera-vara vi visar.
       */
      jsonLd: grafer(
        breadcrumbJsonLd([
          { name: SITE, path: "/butik" },
          { name: categoryLabel(product.categorySlug), path: `/butik/kategori/${product.categorySlug}` },
          { name: product.title, path: `/butik/objekt/${encodeURIComponent(product.id)}` },
        ]),
        product.source === "loopa" ? (JSON.parse(productJsonLd(product)) as Record<string, unknown>) : null,
      ),
      // En såld möbel ska inte ligga kvar som en träff i sökresultatet.
      noindex: !arIndexerbar(product),
      /**
       * Kroppen bär också VÄGEN VIDARE.
       *
       * En produktsida är en återvändsgränd för en robot om den bara beskriver sin egen möbel: den
       * enda vägen ut går genom rutnätet, som React ritar. Länkarna till kategorin och märket är
       * därför inte dekoration — de är det som gör att lagret hänger ihop som en graf. De hjälper
       * dessutom en människa som landat på en möbel som just blivit såld.
       */
      body:
        `<h1>${esc(product.title)}</h1><p>${esc(price)}</p>` +
        (product.condition ? `<p>Skick: ${esc(product.condition.label)} — ${esc(product.condition.rationale)}</p>` : "") +
        (dims.length ? `<p>Mått: ${dims.join(" × ")} cm</p>` : "") +
        `<p><a href="/butik/kategori/${product.categorySlug}">Fler begagnade ${esc(categoryLabel(product.categorySlug).toLowerCase())} i Stockholm</a>` +
        (product.brand ? ` · <a href="/butik/marke/${brandSlug(product.brand)}">${esc(product.brand)} secondhand</a>` : "") +
        `</p>`,
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
