/**
 * Tradera som lagerkälla — SOAP v3 SearchService.
 *
 * ETT ANNAT API ÄN GRANNFILEN. tradera.ts talar REST v4 och gör en enda sak: lägger upp och sköter
 * Loopas EGNA annonser på Loopas konto. Det API:t kan inte söka. Sökningen bor i den äldre v3-SOAP:en,
 * som är den enda vägen att läsa andras annonser, och den har egna operationer, eget kuvert och egna
 * huvuden. De två delar bara appnyckeln.
 *
 * VAD SOM HÄMTAS: möbelkategorier, Stockholms län (CountyId 1, bekräftat mot GetCounties 2026-08-31),
 * bara aktiva annonser. Bilderna HOTLÄNKAS från img.tradera.net som API-villkoren föreskriver — vi
 * laddar aldrig ner dem, cachar dem inte och lägger dem inte på vår egen domän. Klicket går till
 * Traderas annons; vi proxar aldrig deras kassa.
 *
 * VAD SOM ALDRIG HÄNDER: en Tradera-vara får aldrig ett Loopa-betyg. Deras annonser bär säljarens
 * egen skickuppgift i attribut 121 ("Gott skick"), och den läses in — men som ett PÅSTÅENDE av
 * säljaren, aldrig som något vi granskat. Skillnaden är hela produkten.
 */

import { fold, resolveCategorySlug } from "../../butik/catalog.js";
import type { Product } from "../../butik/types.js";

const ENDPOINT = "https://api.tradera.com/v3/searchservice.asmx";
const NS = "http://api.tradera.com";

/** Stockholms län. Bekräftat mot PublicService.GetCounties 2026-08-31: 1 = Stockholm, 0 = Hela Sverige. */
export const STOCKHOLM_COUNTY_ID = 1;

/**
 * Kill switch. Källan är PÅ som förval; `TRADERA_SOURCE=0` stänger av den helt.
 *
 * Finns för att villkorsdiskussionen kan landa i att vi inte får visa deras annonser. Då ska det vara
 * en miljövariabel och en omstart — inte en utrullning — och rutnätet ska fortsätta fungera med bara
 * Loopa-varor. Se `traderaSourceEnabled` i browse.ts.
 */
export function traderaSourceEnabled(): boolean {
  return process.env.TRADERA_SOURCE !== "0" && !!process.env.TRADERA_APP_ID?.trim() && !!process.env.TRADERA_APP_KEY?.trim();
}

/**
 * Hur länge ett sökresultat får återanvändas.
 *
 * Två skäl, och det andra är det viktiga. Rate limit: varje sidladdning i butiken får inte bli ett
 * anrop till Tradera. Och färskhet: en auktion som gått ut ska inte ligga kvar och se köpbar ut — se
 * `isLive`, som slår ifrån även på en cachad post vars EndDate hunnit passera.
 */
const CACHE_TTL_MS = Number(process.env.TRADERA_SEARCH_TTL_MS ?? 5 * 60_000);

/** Traderas egen cache-ålder, i sekunder. Att be om en cachad träff avlastar dem och oss. */
const MAX_RESULT_AGE_S = Math.round(CACHE_TTL_MS / 1000);

/**
 * Möbelkategorierna vi läser, och vilken butikshylla de hamnar på.
 *
 * Id:na är desamma som publiceringen använder (mapping.ts), hämtade ur v4:s referensdata och därmed
 * inte gissade. Riktningen är den motsatta här: mapping.ts svarar "vart ska VÅR annons", den här
 * svarar "vad är DERAS annons".
 */
const CATEGORY_SOURCES: Array<{ id: number; slug: string }> = [
  { id: 302537, slug: "soffor" }, // Vardagsrum > Soffor
  { id: 302538, slug: "fatoljer" }, // Vardagsrum > Fåtöljer
  { id: 302539, slug: "soffor" }, // Vardagsrum > Soffgrupper
  { id: 302540, slug: "bord" },            // Vardagsrum > Soffbord
  { id: 302532, slug: "stolar" },          // Matsal (Traderas enda stolkategori)
  { id: 302542, slug: "forvaring" },       // Vardagsrum > Bokhyllor
  { id: 302547, slug: "forvaring" },       // Förvaring > Byråer & skåp
  { id: 302551, slug: "forvaring" },       // Förvaring > Hyllor
  { id: 302548, slug: "forvaring" },       // Förvaring > Garderober
  { id: 302543, slug: "sangar" },          // Sovrum > Sängar
  { id: 160407, slug: "skrivbord-kontor" },// Kontor
  { id: 160402, slug: "ovrigt" },          // Övriga möbler
];

const SLUG_BY_CATEGORY = new Map(CATEGORY_SOURCES.map((c) => [c.id, c.slug]));

export class TraderaSearchError extends Error {}

// ---------------------------------------------------------------------------
// SOAP utan beroenden
// ---------------------------------------------------------------------------

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeXml(v: string): string {
  return v
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * Ett fält ur ett XML-block.
 *
 * Handskrivet i stället för en XML-parser, av samma skäl som resten av servern saknar beroenden:
 * svaret är platt, fälten är kända, och en parser till hade varit ett paket att underhålla för
 * tolv taggar. `xsi:nil="true"` blir null — Tradera markerar ett saknat Köp Nu-pris så, och en
 * tolkning som gör det till 0 hade satt prislappen "0 kr" på varenda auktion.
 */
function field(block: string, tag: string): string | null {
  if (new RegExp(`<${tag}[^>]*xsi:nil="true"`).test(block)) return null;
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeXml(m[1]) : null;
}

function intField(block: string, tag: string): number | null {
  const raw = field(block, tag);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function callSoap(op: string, requestXml: string, signal?: AbortSignal): Promise<string> {
  const appId = process.env.TRADERA_APP_ID?.trim();
  const appKey = process.env.TRADERA_APP_KEY?.trim();
  if (!appId || !appKey) throw new TraderaSearchError("TRADERA_APP_ID/TRADERA_APP_KEY saknas");

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <AuthenticationHeader xmlns="${NS}"><AppId>${escapeXml(appId)}</AppId><AppKey>${escapeXml(appKey)}</AppKey></AuthenticationHeader>
    <ConfigurationHeader xmlns="${NS}"><Sandbox>0</Sandbox><MaxResultAge>${MAX_RESULT_AGE_S}</MaxResultAge></ConfigurationHeader>
  </soap:Header>
  <soap:Body>${requestXml}</soap:Body>
</soap:Envelope>`;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `${NS}/${op}` },
    body: envelope,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new TraderaSearchError(`Tradera ${op} svarade ${res.status}: ${text.slice(0, 200)}`);
  // SOAP lägger fel i kroppen med status 200. Ett tyst fel här hade sett ut som ett tomt lager.
  const fault = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(text);
  if (fault) throw new TraderaSearchError(`Tradera ${op}: ${decodeXml(fault[1])}`);
  return text;
}

// ---------------------------------------------------------------------------
// Normalisering
// ---------------------------------------------------------------------------

/** Bara aktiva annonser med tid kvar. En utgången auktion får aldrig se köpbar ut. */
function isLive(block: string): boolean {
  if (field(block, "IsEnded") === "true") return false;
  const ends = field(block, "EndDate");
  return !ends || new Date(ends).getTime() > Date.now();
}

/** Säljarens EGEN skickuppgift (attribut 121). Ett påstående, inte ett betyg — se filens topp. */
function sellerCondition(block: string): string | null {
  const m = /<Name>condition<\/Name><Values><string>([^<]*)<\/string>/.exec(block);
  return m ? decodeXml(m[1]) : null;
}

/** Bilden i galleriformat, annars miniatyren. Hotlänkas — aldrig nedladdad, aldrig omvärdslagrad. */
function imageOf(block: string): string | null {
  const gallery = /<Url>([^<]+)<\/Url><Format>gallery<\/Format>/.exec(block);
  if (gallery) return decodeXml(gallery[1]);
  return field(block, "ThumbnailLink");
}

/**
 * Hyllan annonsen hamnar på.
 *
 * Traderas kategori går först NÄR den säger något: en annons i "Vardagsrum > Soffor" är en soffa.
 * Men "Övriga möbler" (160402) är deras slaskhylla, och säljare lägger stolar, pallar och bord där
 * i mängd — mätt på den första hämtningen kom alla tolv stolar och pallar in därifrån. Då är
 * RUBRIKEN det enda som vet vad möbeln är, och den läses med samma nyckelordstabell som våra egna
 * varor. Säger ingendera något blir det Övrigt, vilket då är sant.
 */
function categorySlugFor(categoryId: number | null, title: string): string {
  const mapped = categoryId !== null ? SLUG_BY_CATEGORY.get(categoryId) : undefined;
  if (mapped && mapped !== "ovrigt") return mapped;
  return resolveCategorySlug({ title });
}

/** Märket, gissat ur rubriken mot de märken butiken faktiskt bryr sig om. */
function brandFromTitle(title: string, known: string[]): string | null {
  const hay = fold(title);
  for (const b of known) if (hay.includes(fold(b))) return b;
  return null;
}

/**
 * En Tradera-annons som butiksvara.
 *
 * `condition: null` är inte ett fält som glömts. Det ÄR skillnaden mellan de två källorna, och det är
 * vad rutnätet läser för att skriva "ej granskad" i stället för ett betyg.
 */
export function itemToProduct(block: string, knownBrands: string[]): Product | null {
  const id = intField(block, "Id");
  const title = field(block, "ShortDescription");
  if (id === null || !title || !isLive(block)) return null;

  const buyNow = intField(block, "BuyItNowPrice");
  const maxBid = intField(block, "MaxBid");
  const itemType = field(block, "ItemType") ?? "Auction";
  const isAuction = itemType.toLowerCase() !== "shopitem" && buyNow === null;
  const categoryId = intField(block, "CategoryId");
  const url = field(block, "ItemUrl");

  return {
    id: `tradera:${id}`,
    source: "tradera",
    title,
    /**
     * De fyra fälten nedan är TOMMA för Tradera, och det är inte en lucka att fylla igen.
     *
     * Vi har ingen prisuppskattning på någon annans annons (ingen besiktning, inget skick att räkna
     * på), ingen prisstege (deras säljare bestämmer sitt eget pris), och sökresultatet bär varken
     * bildantal eller mått. Att gissa något av det hade gett Tradera-varor fyndpoäng och
     * listningskvalitet de inte förtjänat — och de hade då kunnat sorteras före våra egna, som är de
     * enda vi kan gå i god för.
     */
    estimatedValueSek: null,
    priceHistory: [],
    priceDroppedAt: null,
    imageCount: 0,
    hasMeasurements: false,
    brand: brandFromTitle(title, knownBrands),
    model: null,
    categorySlug: categorySlugFor(categoryId, title),
    color: null,
    material: null,
    // Traderas sökresultat bär inga mått. Måttfiltret utesluter därför Tradera-varor och SÄGER det —
    // se excludedForMissingDimensions i inventory.ts.
    dimensions: { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null, estimated: false },
    // Priset är Köp Nu när det finns, annars det stående budet. Auktionsraden visar detaljerna.
    priceSek: buyNow ?? maxBid,
    retailPriceSek: null,
    imageUrl: imageOf(block),
    condition: null,
    state: "live",
    // Sluttiden är en RIKTIG uppgift ur deras svar; starttiden finns inte där. Se listedAtKnown.
    listedAt: field(block, "EndDate") ?? new Date().toISOString(),
    listedAtKnown: false,
    // https, inte det http Tradera skickar: en extern länk ur vår butik ska inte börja okrypterad.
    externalUrl: url ? url.replace(/^http:\/\//, "https://") : `https://www.tradera.com/item/${id}`,
    auction: {
      isAuction,
      currentBidSek: maxBid,
      bidCount: intField(block, "BidCount"),
      endsAt: field(block, "EndDate"),
      buyNowSek: buyNow,
    },
    region: "Stockholm",
    homeDeliveryAvailable: false,
    returnsAccepted: false,
    jobId: null,
    identity: null,
    sellerCondition: sellerCondition(block),
  };
}

// ---------------------------------------------------------------------------
// Sökningen, med cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  products: Product[];
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Product[]>>();

function buildRequest(opts: {
  categoryId: number;
  words?: string | null;
  page: number;
  perPage: number;
  /**
   * Köparens pristak, nedskjutet i SOAP-anropet i stället för filtrerat efteråt.
   *
   * Fälten fanns redan i kroppen men stod som `xsi:nil`. Skillnaden är inte kosmetisk: en sökning
   * som lämnar tillbaka 24 träffar över taket ger noll användbara kandidater, medan samma sökning
   * med taket satt ger 24 vi kan visa. För en efterlysning med "max 4 000 kr" är det skillnaden
   * mellan ett tomt direktsvep och ett fullt.
   */
  maxPriceSek?: number | null;
}): string {
  const priceMax =
    opts.maxPriceSek && opts.maxPriceSek > 0
      ? `<PriceMaximum>${Math.round(opts.maxPriceSek)}</PriceMaximum>`
      : `<PriceMaximum xsi:nil="true"/>`;
  return `<SearchAdvanced xmlns="${NS}"><request>
  <SearchWords>${escapeXml(opts.words ?? "")}</SearchWords>
  <CategoryId>${opts.categoryId}</CategoryId>
  <SearchInDescription>false</SearchInDescription>
  <PriceMinimum xsi:nil="true"/>${priceMax}
  <BidsMinimum xsi:nil="true"/><BidsMaximum xsi:nil="true"/>
  <ZipCode></ZipCode>
  <CountyId>${STOCKHOLM_COUNTY_ID}</CountyId>
  <Alias></Alias>
  <OrderBy>Relevance</OrderBy>
  <ItemStatus>Active</ItemStatus>
  <ItemType>All</ItemType>
  <OnlyAuctionsWithBuyNow>false</OnlyAuctionsWithBuyNow>
  <OnlyItemsWithThumbnail>true</OnlyItemsWithThumbnail>
  <ItemsPerPage>${opts.perPage}</ItemsPerPage>
  <PageNumber>${opts.page}</PageNumber>
  <SellerType>All</SellerType>
</request></SearchAdvanced>`;
}

async function searchCategory(
  categoryId: number,
  words: string | null,
  perPage: number,
  knownBrands: string[],
  maxPriceSek: number | null = null,
): Promise<Product[]> {
  const xml = await callSoap(
    "SearchAdvanced",
    buildRequest({ categoryId, words, page: 1, perPage, maxPriceSek }),
    AbortSignal.timeout(8000),
  );
  const blocks = xml.split("<Items>").slice(1);
  const products: Product[] = [];
  for (const block of blocks) {
    const p = itemToProduct(block, knownBrands);
    if (p) products.push(p);
  }
  return products;
}

/**
 * Stockholms möbelannonser, hämtade en gång per TTL och sedan filtrerade lokalt.
 *
 * Varför inte ett anrop per sidladdning: rutnätet filtrerar på kategori, pris, märke och sortering,
 * och att översätta varje sådan kombination till en egen sökning hade betytt ett Tradera-anrop per
 * filterklick. Poolen hämtas i stället i klump och filtreras med samma kod som Loopa-varorna.
 *
 * Kategorierna hämtas SEKVENTIELLT med flit. Tolv parallella anrop mot ett API med anropstak är ett
 * bra sätt att bli avstängd; sekventiellt tar det längre tid en gång per TTL och ingen gång alls
 * däremellan.
 */
export async function fetchStockholmFurniture(knownBrands: string[], perCategory = 12): Promise<Product[]> {
  const key = `pool:${perCategory}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const all: Product[] = [];
    const failures: string[] = [];
    for (const source of CATEGORY_SOURCES) {
      try {
        all.push(...(await searchCategory(source.id, null, perCategory, knownBrands)));
      } catch (err) {
        failures.push(`${source.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Alla kategorier föll: det är ett fel och ska bubbla, så rutnätet kan visa sin notis. Föll bara
    // några har vi ett halvt resultat, och ett halvt lager är bättre än ett tomt.
    if (all.length === 0 && failures.length === CATEGORY_SOURCES.length) {
      throw new TraderaSearchError(`Alla kategorisökningar föll. Första: ${failures[0]}`);
    }
    if (failures.length) console.warn(`[tradera] ${failures.length} kategorier föll: ${failures[0]}`);
    // Samma annons kan ligga i flera kategorier vi frågar efter.
    const unique = new Map(all.map((p) => [p.id, p]));
    const products = [...unique.values()];
    cache.set(key, { at: Date.now(), products });
    return products;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/** Fritextsökning mot Tradera. Egen cachenyckel — söktexten är en annan fråga än poolen. */
export async function searchTradera(words: string, knownBrands: string[], perPage = 24): Promise<Product[]> {
  const key = `q:${fold(words)}:${perPage}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  // CategoryId 0 = hela trädet. Sökordet är då det som avgränsar, inte kategorin.
  const products = await searchCategory(0, words, perPage, knownBrands);
  cache.set(key, { at: Date.now(), products });
  return products;
}

/**
 * Sökning för EN efterlysning: rätt kategorier, köparens pristak, köparens ord.
 *
 * Skild från `searchTradera` som söker hela trädet på fri text. En efterlysning har en kategori, och
 * att söka "grön sammetssoffa" över hela Tradera ger lampor och tavlor med gröna soffor på. Här
 * frågas de kategorier som faktiskt svarar mot slugen, en i taget och sekventiellt — parallella
 * anrop mot ett API med anropstak är ett bra sätt att bli avstängd.
 *
 * Pristaket skjuts ned i anropet. Utan det kan hela svaret ligga över köparens gräns, och ett
 * direktsvep som lovar "aldrig noll" hade blivit noll av just den anledningen.
 */
export async function searchForCategory(
  categorySlug: string | null,
  words: string | null,
  knownBrands: string[],
  maxPriceSek: number | null = null,
  perCategory = 12,
): Promise<Product[]> {
  const sources = categorySlug
    ? CATEGORY_SOURCES.filter((c) => c.slug === categorySlug)
    : CATEGORY_SOURCES;
  // Okänd slug: sök hela trädet på orden i stället för att svara tomt.
  const ids = sources.length > 0 ? sources.map((c) => c.id) : [0];

  const all: Product[] = [];
  const failures: string[] = [];
  for (const id of ids) {
    try {
      all.push(...(await searchCategory(id, words, perCategory, knownBrands, maxPriceSek)));
    } catch (err) {
      failures.push(`${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (all.length === 0 && failures.length === ids.length) {
    throw new TraderaSearchError(`Alla kategorisökningar föll. Första: ${failures[0]}`);
  }
  return [...new Map(all.map((p) => [p.id, p])).values()];
}

/** Bara för tester och för en påtvingad omhämtning. */
export function clearTraderaCache(): void {
  cache.clear();
}
