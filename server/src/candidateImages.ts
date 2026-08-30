import type { ListingAttribute, ModelCandidate } from "./types.js";
import { countDimensions, harvestSpecs } from "./specHarvest.js";

/** En källa den grundade sökningen pekade ut. */
export interface SourceRef {
  title: string;
  url: string;
  qualityTier?: 1 | 2 | 3;
  /**
   * Sidan är en genväg vi själva byggt, inte en källa någon pekat ut — bara dess LÄNKAR duger.
   *
   * Butikens träfflista på "Oxford" visar soffan, fotpallen och klädseln bredvid varandra, och dess
   * första bild är vilken som helst av dem. Att låna den vore att gissa vilken av träffarna som är
   * möbeln — och gissningen syns som en bild säljaren tror på. Länkarna därifrån leder däremot till
   * riktiga produktsidor, och de får väljas med omsorg (se hopTargets).
   */
  linksOnly?: boolean;
}

/**
 * Rundligt, för hämtningen ligger inte på någons kritiska väg: kandidaterna är redan sparade och
 * visade när den startar. Fyra sekunder räckte inte för en kall butikssida — och en källa som föll på
 * tiden blev en tom bildruta hos säljaren, vilket är precis det vi försöker undvika.
 */
const PAGE_TIMEOUT_MS = 8000;
/**
 * Så långt in vi läser för BILDEN. og-taggarna sitter i <head>, alltså direkt.
 */
const MAX_HTML_BYTES = 512 * 1024;
/**
 * Så långt in vi läser för SPECIFIKATIONERNA — måtten står inte i huvudet.
 *
 * Mätt på elva skarpa kandidatsidor: sex av dem bär måtten i sin HTML, men bara två inom de första
 * 512 KB. IKEA lägger specifikationstabellen ungefär 1,05 MB in i ett dokument på 1,1 MB, och med det
 * gamla taket lästes den aldrig — NORDVIKEN gav noll mått fem körningar i rad trots att sidan stod
 * öppen med "Bredd 40 cm | Djup 45 cm | Höjd 88 cm | Sitshöjd 62 cm".
 *
 * Läsningen avbryts så fort måtten passerat, så det vanliga fallet laddar inte mer än förut. Taket
 * gäller den som aldrig visar några: en 27 MB-sida läses till 2 MB och inte längre.
 */
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
/** Hur ofta vi tittar efter måtten under läsningen. Ett svep över 1,3 MB kostar 39 ms. */
const SPEC_PROBE_STEP = 256 * 1024;
/** Så många mått som ska ha passerat innan vi slutar läsa — en tabell, inte ett ensamt tal i löptext. */
const SPEC_PROBE_HITS = 3;

/** Så många bildadresser vi behåller per sida. Fler än så är varianter av samma bild. */
const MAX_IMAGES_PER_PAGE = 4;
/** Så många av dem som får kontrolleras innan sidan ger upp. */
const MAX_IMAGE_CHECKS = 3;
/** Kontrollen av en bildadress är ett litet anrop, men det ligger sist i kedjan och får inte hänga. */
const IMAGE_CHECK_TIMEOUT_MS = 4000;
/** En UTSKRIVEN miniatyr är inte produktbilden. Står ingen storlek säger det ingenting, och den passerar. */
const MIN_IMG_PX = 200;

/**
 * Var produktbilden faktiskt står.
 *
 * og:image var länge det enda vi läste, och på de stora butikssidorna räcker det. Men sidorna
 * hämtningen landar på är oftare mindre: en återförsäljare, varumärkets egen katalog, en
 * inredningsblogg. De bär lika gärna bilden någon annanstans — i JSON-LD:ns `Product.image`, i
 * `link rel="image_src"`, eller helt enkelt i sidans egen `<img>`. Sidan var alltså hämtad,
 * kontrollerad mot modellnamnet och full av rätt bild, och lämnade ändå ifrån sig en tom ruta för
 * att en tagg i huvudet saknades.
 *
 * Listan är ordnad efter fallande tillförlitlighet, och den första adressen som svarar som en bild
 * vinner. Kravet på att sidan ska HANDLA om modellen är orört — det är sidan som väljs, aldrig
 * bilden, och en sida som inte klarar det kravet får fortfarande inte ge något alls.
 */
const META_IMAGE: RegExp[] = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["']/gi,
  /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/gi,
  /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
];

const LD_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,120000}?)<\/script>/gi;
/** Sista utvägen när JSON-LD:n inte går att tolka — den är trasig oftare än man tror. */
const LD_IMAGE_RAW = /"(?:image|contentUrl|thumbnailUrl)"\s*:\s*(?:\[\s*)?(?:\{[^{}]{0,300}?"(?:url|contentUrl)"\s*:\s*)?"(https?:\/\/[^"]+)"/gi;

const IMG_TAG = /<img\b[^>]*>/gi;
/**
 * Adresser, klasser och alt-texter som skriker "inte produktbilden".
 *
 * En sida har trettio bilder och en av dem är möbeln. De andra är loggan, betalsymbolerna,
 * fraktikonen och en genomskinlig pixel — och att visa någon av dem som kandidatens bild vore samma
 * fel som att visa fel möbel: säljaren väljer på bilden.
 */
const JUNK_IMAGE = /(logo|logga|logotyp|icon|ikon|favicon|sprite|placeholder|spinner|loader|avatar|flagg|badge|payment|betal|klarna|swish|mastercard|trustpilot|pixel|1x1|blank|transparent|banner)/i;

/**
 * Tyget, fodralet och kudden är inte möbeln.
 *
 * Säljaren ska känna igen sin soffa på bilden, och en butik säljer lika gärna klädseln till den som
 * soffan själv: IKEA:s "EKTORP Klädsel för 3-sitssoffa" är en egen produkt med en egen sida och en
 * egen bild, och den bilden visar ett hopvikt tygstycke. Sidan nämner modellen, den klarar alltså
 * namnkontrollen — och en kandidat fick ett tygprov där möbeln skulle stått.
 *
 * Uttrycket används på två ställen: en sida om ett tillbehör rankas under möbelns egen sida, och en
 * bildadress som ser ut som ett tillbehör läggs sist bland sidans bilder. Ingetdera kastas: är det
 * enda som finns är en tygbild fortfarande bättre än en tom ruta, och letar säljaren efter en
 * klädsel är klädselsidan rätt sida.
 */
const ACCESSORY =
  /(tygprov|tygprover|fabric[ -]sample|swatch|klädsel|klaedsel|kladsel|överdrag|oeverdrag|fodral|cover[ -]for|slipcover|kuddfodral|kudde|cushion|armskydd|reservdel|spare[ -]part|tillbehör|tillbehoer|skötsel|skoetsel|care[ -]kit|monteringsanvisning)/i;

/**
 * `&amp;` i ett attribut är HTML, inte adress.
 *
 * Det här var en tyst bildtjuv. En butikslänk bär sina varianter i frågesträngen —
 * `?ck_sofaLegs=500989&amp;ck_sofaUpholster=…` — och hämtas adressen med taggarna kvar svarar
 * servern 200 på något helt annat: Mio lämnade ut rätt titel men en halv sida, utan en enda
 * produktbild. Kandidaten hade alltså sin egen produktsida och blev ändå utan bild.
 */
const decodeEntities = (s: string): string =>
  s.replace(/&amp;/gi, "&").replace(/&#(?:38|x26);/gi, "&").replace(/&#(?:39|x27);/gi, "'");

function attr(tag: string, name: string): string {
  const raw = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1]?.trim();
  return raw ? decodeEntities(raw) : "";
}

/** Största bilden i ett srcset. Butikerna listar samma bild i fem storlekar; vi vill ha den skarpaste. */
function fromSrcset(srcset: string): string {
  let best = "";
  let bestWidth = -1;
  for (const part of srcset.split(",")) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const width = Number((size ?? "").replace(/\D+/g, "")) || 0;
    if (width >= bestWidth) {
      best = url;
      bestWidth = width;
    }
  }
  return best;
}

/**
 * Sidans egna bilder, störst först.
 *
 * Storleken är det enda måttet vi har på vilken bild sidan själv tycker är viktigast, och den största
 * är produktbilden på varenda produktsida vi mätt. Skriver sidan ingen storlek får bilden vara med i
 * dokumentets egen ordning — huvudbilden ligger före galleriet.
 */
function scanImgTags(html: string): string[] {
  const found: Array<{ url: string; area: number; order: number }> = [];
  let order = 0;
  for (const m of html.matchAll(IMG_TAG)) {
    if (order >= 300) break;
    const tag = m[0];
    order++;
    // Lata bilder står i data-attribut; `src` är då en platshållare eller tom.
    const url =
      fromSrcset(attr(tag, "srcset") || attr(tag, "data-srcset")) ||
      attr(tag, "src") ||
      attr(tag, "data-src") ||
      attr(tag, "data-original") ||
      attr(tag, "data-lazy-src");
    if (!url || url.startsWith("data:") || /\.svg(\?|#|$)/i.test(url)) continue;
    if (JUNK_IMAGE.test(`${url} ${attr(tag, "class")} ${attr(tag, "id")} ${attr(tag, "alt")}`)) continue;
    const width = Number(attr(tag, "width").replace(/\D+/g, "")) || 0;
    const height = Number(attr(tag, "height").replace(/\D+/g, "")) || 0;
    if ((width > 0 && width < MIN_IMG_PX) || (height > 0 && height < MIN_IMG_PX)) continue;
    found.push({ url, area: width * height, order });
  }
  found.sort((a, b) => b.area - a.area || a.order - b.order);
  return found.map((f) => f.url);
}

/** Plockar ut adressen ur ett JSON-LD-värde: en sträng, en lista, eller ett ImageObject. */
function pushLdImage(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) pushLdImage(v, out);
  else if (value && typeof value === "object") {
    const obj = value as { url?: unknown; contentUrl?: unknown };
    const url = typeof obj.url === "string" ? obj.url : typeof obj.contentUrl === "string" ? obj.contentUrl : null;
    if (url) out.push(url);
  }
}

function collectLdImages(node: unknown, out: string[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 6 || out.length >= MAX_IMAGES_PER_PAGE) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLdImages(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/^(image|contentUrl|thumbnailUrl)$/i.test(key)) pushLdImage(value, out);
    else collectLdImages(value, out, depth + 1);
  }
}

/**
 * Tom og:image är vanligare än man tror — en död produktsida som omdirigerats till en kategorisida
 * svarar `content=""`. Utan den här kontrollen blir `new URL("", finalUrl)` sidans EGEN adress, och
 * säljaren får en trasig bildruta där produktbilden skulle stått.
 */
function absolutise(raw: string, base: string): string | null {
  const trimmed = decodeEntities(raw.trim());
  if (!trimmed) return null;
  try {
    const resolved = new URL(trimmed, base);
    if (!/^https?:$/.test(resolved.protocol) || resolved.href === base) return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function absolutiseAll(raw: string[], finalUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const url = absolutise(candidate, finalUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_IMAGES_PER_PAGE * 3) break;
  }
  // Tillbehörsbilderna sist, möbeln först. Sorteringen är stabil, så ordningen i övrigt står kvar.
  out.sort((a, b) => Number(ACCESSORY.test(a)) - Number(ACCESSORY.test(b)));
  return out.slice(0, MAX_IMAGES_PER_PAGE);
}

/**
 * Bilderna sidan SJÄLV pekar ut som sina: og:image, JSON-LD:ns `Product.image`, `link rel=image_src`.
 *
 * De är sidans eget påstående om vad den handlar om, och kan därför användas så fort sidan klarat
 * namnkontrollen — precis som og:image alltid har fått.
 */
export function extractImages(html: string, finalUrl: string): string[] {
  const raw: string[] = [];
  for (const pattern of META_IMAGE) for (const m of html.matchAll(pattern)) raw.push(m[1]);
  for (const block of html.matchAll(LD_BLOCK)) {
    const ld: string[] = [];
    try {
      collectLdImages(JSON.parse(block[1].trim()), ld);
    } catch {
      for (const m of block[1].matchAll(LD_IMAGE_RAW)) ld.push(m[1]);
    }
    raw.push(...ld);
  }
  return absolutiseAll(raw, finalUrl);
}

/**
 * Bilderna VI plockar ur sidans kropp. Ett kvalificerat val, inte sidans eget — och därför hårdare
 * villkorat (se rankPages: bara när sidans TITEL nämner modellen).
 *
 * Varför skillnaden är nödvändig: IKEA svarar 200 OK på en produktadress som inte finns och lämnar
 * ut hela sortimentssidan. Adressen bär modellnamnet — den kom ur den — men sidan handlar inte om
 * modellen, och dess bilder är kategorifoton på diskmaskiner och soffor. Med bara adresskontrollen
 * hade FRANKLIN barstol fått en bild på ett kök.
 */
export function extractBodyImages(html: string, finalUrl: string): string[] {
  return absolutiseAll(scanImgTags(html), finalUrl);
}

function normalise(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Vad en hämtad källa faktiskt visade sig vara. */
interface FetchedPage {
  source: SourceRef;
  /** Adressen redirecten landade på — den riktiga produktsidan. */
  finalUrl: string;
  /** Sidans egen titel, inte grundningens domännamn. */
  title: string;
  /** Hela sidan, normaliserad — för att kunna se om modellen NÄMNS även utanför titeln. */
  body: string;
  /** Sidans utgående länkar, absoluta. En kategorisida är inte kandidatens sida, men den LÄNKAR dit. */
  links: PageLink[];
  /** Bilderna sidan själv pekar ut, bäst först. Tom lista = sidan deklarerade ingen bild. */
  images: string[];
  /** Bilderna i sidans kropp. Får bara användas när titeln nämner modellen — se rankPages. */
  bodyImages: string[];
  /** Måtten och materialet sidan själv skriver ut — lästa, inte gissade. Se specHarvest.ts. */
  specs: ListingAttribute[];
}

const OG_TITLE = /<meta[^>]+(?:property|name)=["'](?:og:title)["'][^>]+content=["']([^"']+)["']/i;
const TITLE_TAG = /<title[^>]*>([^<]{1,300})<\/title>/i;

/** En utgående länk: adressen, och det som stod skrivet på den. */
interface PageLink {
  url: string;
  /**
   * Länktexten, normaliserad.
   *
   * Modellnamnet står HÄR när adressen bara är ett artikelnummer. Butikerna som numrerar sina sidor
   * (`/p/1043821`) var osynliga för hoppet så länge det bara läste adresser — och det är just de
   * butikerna en kandidat utan bild oftast sitter fast hos.
   */
  label: string;
}

/**
 * Länkens öppningstagg, och det som står efter den — utan att läsa upp det.
 *
 * Texten fångas i en LOOKAHEAD med flit. Läste uttrycket in de 160 tecknen på riktigt åt den samtidigt
 * upp nästa länk: två länkar som stod tätt blev en, och en butiks träfflista lämnade ifrån sig
 * varannan produkt. Kandidaten fick då den första länken som råkade bära namnet — klädseln — i stället
 * för soffan två rader längre ned.
 */
const ANCHOR = /(<a\b[^>]*>)(?=([\s\S]{0,160}))/gi;
/** Så många länkar vi bryr oss om per sida. En butikssida har tusentals; produktlänkarna ligger tidigt. */
const MAX_LINKS = 300;
/** Taket per hopprunda. Det ligger utanför säljarens väntan, men ska inte bli en spindel. */
const MAX_HOP_FETCHES = 8;
/** Två länkar per kandidat och runda: den första är oftast produktsidan, den andra en variant av den. */
const MAX_HOP_PER_CANDIDATE = 2;
/**
 * Vägarna till en bild, i den ordning de prövas — och bara för de kandidater som ännu saknar en.
 *
 * HOPP följer länkar på sidor vi redan hämtat. Billigt och träffsäkert: ett hopp räcker från en
 * kategorisida till produktsidan, två behövs när vi landat på butikens startsida.
 *
 * SÖKNING frågar en sökmotor rakt ut efter modellen. Den står sist för att den kostar mest, men den
 * är den enda vägen när kandidaten inte finns i något vi hämtat — och mätt på riktiga jobb är det
 * det vanligaste fallet av alla. Den grundade sökningen returnerar 4-6 sidor för HELA jobbet, och
 * modellens egen citerade adress är ofta en gissning som svarar 404 (eller, hos IKEA, 200 med hela
 * sortimentet). Kandidaten hade då aldrig någon sida att få en bild ur. Ett HOPP efter sökningen tar
 * hand om träffar som är kategorisidor snarare än produktsidor.
 *
 * Den andra sökningen frågar andra motorer än den första (rotationen fortsätter där den slutade), så
 * den är inte en upprepning utan en ny träfflista. Stegen kostar bara tid för de kandidater som
 * fortfarande saknar bild, och den tiden ligger utanför säljarens väntan: det som hittats skrivs ut
 * efter varje steg.
 */
const STEPS = ["hopp", "hopp", "butikssökning", "hopp", "sökning", "hopp", "sökning", "hopp"] as const;

/** Så många träffar per sökning som får hämtas. Produktsidan ligger först eller inte alls. */
const MAX_SEARCH_HITS = 3;
/** Sökmotorns svar är en sida som alla andra, men den ska aldrig få hålla upp kön. */
const SEARCH_TIMEOUT_MS = 8000;

/**
 * Hela jaktens tak, räknat från att den startar.
 *
 * Varje enskilt anrop hade en gräns, men jakten som helhet hade ingen — och gränserna multiplicerar:
 * åtta steg, var och ett med sina hämtningar på 8 s, plus två sökningar som för VARJE kandidat utan
 * bild prövade fem motorer efter varandra med 8 s var. Fyra kandidater som möter tysta motorer blev
 * tjugo frågor på rad, och hela jakten kunde på sina egna tak hålla på i flera minuter.
 *
 * Under hela den tiden står `imageUrl` som `undefined` — "letar fortfarande" — och väljarskärmen
 * visar en skimrande platshållare. Det var den bild som stod och laddade i evighet: inte en långsam
 * bild, utan en sökning som aldrig sa att den var slut.
 *
 * Taket prövas när ett NYTT steg ska börja, aldrig mitt i ett pågående: en hämtning som är igång får
 * göra klart, så en bild som är på väg in inte kastas på mållinjen. Det som saknas när tiden är ute
 * skrivs som `null`, och skärmen slutar vänta.
 */
const HUNT_BUDGET_MS = 40_000;

function extractLinks(html: string, base: string): PageLink[] {
  const out = new Map<string, PageLink>();
  for (const m of html.matchAll(ANCHOR)) {
    if (out.size >= MAX_LINKS) break;
    const href = attr(m[1], "href");
    if (!href) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      if (out.has(u.href)) continue;
      // Texten läses ur länkens egen etikett OCH ur det som står innanför den — namnet ligger lika
      // ofta i en <span> eller i alt-texten på bilden som i själva länktexten.
      const inner = m[2].split(/<\/a>/i)[0];
      const label = normalise(
        [attr(m[1], "title"), attr(m[1], "aria-label"), inner.match(/alt=["']([^"']*)["']/i)?.[1] ?? "", inner.replace(/<[^>]*>/g, " ")].join(" "),
      );
      out.set(u.href, { url: u.href, label });
    } catch {
      // Trasig href, hoppa.
    }
  }
  return [...out.values()];
}

/**
 * Hämtar en källa och tar reda på vad den ÄR.
 *
 * Källorna från den grundade sökningen är inte produktsidor: `groundingChunks` bär Googles
 * redirect-adress (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) och som titel oftast
 * bara domännamnet. Modellnamnet finns alltså i varken URL eller titel innan sidan hämtats — vilket
 * var precis varför den första versionen aldrig hittade en enda bild.
 */
/** Varför en källa inte gav något. Utan det här är "3/7 hämtade" omöjligt att felsöka. */
function fail(source: SourceRef, why: string): null {
  console.info(`[bild] källan föll (${why}): ${source.url.slice(0, 90)}`);
  return null;
}

/**
 * Två kännetecken, i den ordningen.
 *
 * Det ärliga robotnamnet står först och är det vi helst går som. Men en del butiker svarar 403 på
 * allt som inte ser ut som en webbläsare: sidan finns, den är publik, den öppnas i vilken flik som
 * helst — och hämtningen fick ändå ingenting. Det var en tom bildruta av ren formalia, så det andra
 * försöket frågar som en vanlig besökare.
 *
 * Bara på de statuskoder som ÄR ett avvisande. En 404 är ett riktigt nej och frågas aldrig om igen.
 */
const UA_CRAWLER = "Mozilla/5.0 (compatible; LoopaCondition/1.0)";
const UA_BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const RETRY_STATUS = new Set([401, 403, 405, 406, 429, 503]);

async function fetchPage(source: SourceRef): Promise<FetchedPage | null> {
  let res: Response | null = null;
  let why = "okänt";
  for (const ua of [UA_CRAWLER, UA_BROWSER]) {
    try {
      const attempt = await fetch(source.url, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: {
          "user-agent": ua,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "sv-SE,sv;q=0.9,en;q=0.8",
        },
        redirect: "follow",
      });
      if (attempt.ok) {
        res = attempt;
        break;
      }
      why = `HTTP ${attempt.status}`;
      await attempt.body?.cancel().catch(() => {});
      if (!RETRY_STATUS.has(attempt.status)) break;
    } catch (err) {
      // En timeout frågas inte om: samma adress kostar samma väntan en gång till, och kön bakom är längre.
      why = err instanceof Error ? err.name : "fetch";
      break;
    }
  }
  if (!res) return fail(source, why);

  const contentType = res.headers.get("content-type") ?? "";
  /**
   * Adressen pekar rakt på en bild, inte på en sida.
   *
   * Modellen citerar ibland produktbilden själv i stället för sidan den satt på — sits.eu svarade
   * `ALEX_interior_armchair_classic...webp`. Det ÄR bilden vi letade efter, så att kasta den för att
   * den inte var HTML var att slänga den bästa källan vi hade. Kravet gäller fortfarande: modellnamnet
   * måste synas, nu i bildens egen adress.
   */
  if (contentType.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    const finalUrl = res.url || source.url;
    return { source, finalUrl, title: "", body: normalise(finalUrl), links: [], images: [finalUrl], bodyImages: [], specs: [] };
  }
  if (!contentType.includes("text/html")) return fail(source, contentType.split(";")[0] || "okänd typ");

  /**
   * Läser tills vi har det vi kom för, aldrig hela dokumentet.
   *
   * Bilden är klar efter <head>. Måtten kräver mer — de står i en tabell långt ned — så läsningen
   * fortsätter förbi bildtaket och tittar efter dem var 256:e KB. Så fort tre mått passerat slutar
   * den läsa: den vanliga produktsidan kostar alltså inte mer än förut, medan den som gömmer sina
   * mått på 1 MB djup äntligen lämnar ifrån sig dem.
   */
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;
  let nextProbe = MAX_HTML_BYTES;
  let dimHits = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      html += decoder.decode(value, { stream: true });
      size += value.length;
      if (size >= MAX_SPEC_BYTES) break;
      if (size >= nextProbe) {
        // Bara det nyligen lästa svepas — hela bufferten om och om igen vore samma arbete flera gånger.
        dimHits += countDimensions(html.slice(-SPEC_PROBE_STEP - 4096));
        if (dimHits >= SPEC_PROBE_HITS) break;
        nextProbe += SPEC_PROBE_STEP;
      }
    }
  } catch (err) {
    /**
     * Tidsgränsen slår mitt i kroppen — och det vi hann läsa är oftast allt vi behövde.
     *
     * Hämtningens klocka gäller HELA svaret, kroppen med. En IKEA-sida är 1,1 MB, och när åtta av dem
     * laddas samtidigt hinner någon över gränsen mitt i strömmen. Då kastade `reader.read()` ett fel
     * rakt förbi den här funktionen, ut ur `Promise.all` och vidare till identifieringens tysta
     * `catch` — och EN långsam sida tog därmed bilderna för ALLA kandidater i jobbet. Det var det
     * dyraste felet i hela kedjan: fyra tomma rutor för att en sida var stor.
     *
     * `<head>` kommer först i strömmen, så det halva dokumentet bär nästan alltid bildens adress.
     * Hann vi inte läsa ett tecken är sidan förlorad — men bara den.
     */
    if (!html) return fail(source, err instanceof Error ? err.name : "läsning");
    console.info(`[bild] läsningen bröts efter ${size} tecken, använder det som hanns med: ${source.url.slice(0, 70)}`);
  } finally {
    await reader.cancel().catch(() => {});
  }
  html += decoder.decode();

  const finalUrl = res.url || source.url;
  const title = (html.match(OG_TITLE)?.[1] ?? html.match(TITLE_TAG)?.[1] ?? "").trim();
  // Hela dokumentet, inte bara titeln. Hittade sökningen modellen på sidan står namnet oftast i
  // brödtexten — en produktlista heter "Fåtöljer | Sits" i titeln men nämner Impulse i innehållet.
  // Att bara läsa titeln var därför att leta på fel ställe.
  const body = normalise(html);

  return {
    source,
    finalUrl,
    title,
    body,
    links: extractLinks(html, finalUrl),
    images: extractImages(html, finalUrl),
    bodyImages: extractBodyImages(html, finalUrl),
    specs: harvestSpecs(html, finalUrl),
  };
}

/** En sida kandidaten kan använda, och hur bra den passar. Lägre tal är bättre. */
interface Ranked {
  page: FetchedPage;
  rank: number;
  /** Bilderna just den här kandidaten får ta från sidan, bäst först. */
  images: string[];
}

/**
 * Hämtningen som ALDRIG kastar.
 *
 * `fetchPage` svarar med null på allt den känner igen som ett misslyckande, men ett oväntat fel
 * skulle gå rakt ut ur `Promise.all` och ta med sig hela omgången — och då står varje kandidat i
 * jobbet utan bild för att en enda sida betedde sig konstigt. Det har hänt: se läsningens `catch`.
 */
const fetchSafely = (source: SourceRef): Promise<FetchedPage | null> =>
  fetchPage(source).catch((err) => fail(source, err instanceof Error ? err.name : "oväntat fel"));

/**
 * En startsida, inte en produktsida.
 *
 * Ett varumärkes startsida nämner hela sortimentet, så innehållsmatchningen träffar den för VARJE
 * kandidat — och dess og:image är loggan. Kandidaten fick alltså en bild på allt utom sig själv.
 * Nämns modellen bara i innehållet måste sidan åtminstone vara en undersida.
 */
function isSiteRoot(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

/**
 * Sidan som troligast handlar om DEN HÄR kandidaten.
 *
 * Modellnamnet måste finnas i sidans titel eller i den slutliga adressen. Utan det kravet hade första
 * bästa sida lånats ut till alla fyra kandidaterna, och säljaren fått fyra bilder på samma soffa —
 * värre än inga bilder alls, eftersom bilden är det man väljer på.
 */
export function rankPages(candidate: ModelCandidate, pages: FetchedPage[], rivals: string[] = []): Ranked[] {
  const model = normalise(candidate.model);
  if (!model) return [];
  const others = rivals.map(normalise).filter((m) => m && m !== model);
  // Är kandidaten SJÄLV ett tillbehör är en tillbehörssida rätt sida, och straffet nedan gäller inte.
  const wantsAccessory = ACCESSORY.test(`${candidate.model} ${candidate.productType ?? ""}`);
  const hits: Ranked[] = [];
  for (const p of pages) {
    // En genväg vi själva byggt är ingen produktsida. Den finns här för sina länkars skull.
    if (p.source.linksOnly) continue;
    const titleNamed = normalise(p.title).includes(model);
    const named = titleNamed || normalise(p.finalUrl).includes(model);
    /**
     * Vilka bilder den här sidan får ge den här kandidaten.
     *
     * Sidans EGNA utpekade bilder (og:image, JSON-LD) duger så fort sidan klarat namnkontrollen —
     * de är sidans eget påstående om vad den handlar om. De vi själva plockar ur kroppen kräver mer:
     * att sidans TITEL nämner modellen. Skälet står i extractBodyImages — en adress kan bära
     * modellnamnet och ändå leda till en sortimentssida, och då är varje bild på den fel bild.
     */
    const images = [...p.images, ...(titleNamed ? p.bodyImages : [])];
    /**
     * En sida utan bild sorteras SIST, men kastas inte.
     *
     * Förut var bilden ett krav: sidan hämtades, dess specifikationer lästes och sedan slängdes den
     * för att den saknade en og-tagg. Nu bär sidan två saker säljaren har nytta av, och måtten är det
     * viktigare av dem. Straffet gör att den aldrig tar en bildbärande sidas plats — rangordningen
     * mellan sidor MED bild är exakt densamma som förut.
     */
    const noImage = images.length > 0 ? 0 : 100;
    // Möbelns egen sida före sidan om möbelns klädsel. Se ACCESSORY.
    const accessory = !wantsAccessory && ACCESSORY.test(`${p.title} ${p.finalUrl}`) ? 50 : 0;
    // Nivå 1: modellen står i titeln eller adressen — sidan HANDLAR om den.
    if (named) {
      hits.push({ page: p, images, rank: noImage + accessory + (p.source.qualityTier ?? 3) });
      continue;
    }
    /**
     * Nivå 2: modellen nämns bara i innehållet. Då MÅSTE de andra kandidaterna saknas på sidan.
     *
     * Ett varumärkes kollektions- och kategorisidor räknar upp hela sortimentet i sin navigation, så
     * innehållsmatchningen träffade dem för varje kandidat — och deras og:image visar någon ANNAN
     * modell. Säljaren fick Impulse-fåtöljen under rubriken "Julia". En bild på fel möbel är värre än
     * en tom ruta, för bilden är det man väljer på; en tom ruta går fortfarande att klicka på.
     */
    const alsoNamesRivals = others.some((o) => p.body.includes(` ${o} `));
    if (!isSiteRoot(p.finalUrl) && !alsoNamesRivals && p.body.includes(` ${model} `)) {
      hits.push({ page: p, images, rank: noImage + accessory + 10 + (p.source.qualityTier ?? 3) });
    }
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits;
}

/** Den bästa av dem. */
export function matchPage(candidate: ModelCandidate, pages: FetchedPage[], rivals: string[] = []): FetchedPage | null {
  return rankPages(candidate, pages, rivals)[0]?.page ?? null;
}

/**
 * Tilldelar varje kandidat en sida — och fördelar de bildbärande så att FLEST MÖJLIGA får en bild.
 *
 * En sida används bara en gång: en kategorisida som nämner alla fyra modellerna skulle annars ge alla
 * fyra samma bild, och fyra likadana bilder är värre än två bilder och två tomma rutor — det är på
 * bilden säljaren skiljer dem åt.
 *
 * Men "en gång" räcker inte som regel; det avgörande är VEM som får sidan. Girigt, i tur och ordning,
 * tog den kandidat som råkade komma först en sida som var den ENDA en senare kandidat kunde använda —
 * fastän den själv hade två andra att välja på. Den senare blev utan bild av turordningen, inte av
 * brist på sidor. Mätt på en körning med fyra Sits-kandidater och sex hämtade sidor: tre av dem
 * kunde ha fått bild, två fick det.
 *
 * Därför delas sidorna med bild ut som en PARNING i stället: hittar en kandidat bara upptagna sidor
 * får innehavaren först försöka flytta till en annan av sina egna (en alternerande stig), och bara om
 * ingen kan flytta blir kandidaten utan. Resultatet är det största antal kandidater som över huvud
 * taget kan få en bild. Fyra kandidater och en handfull sidor — det kostar mikrosekunder.
 *
 * Den som ändå blev utan får sin bästa lediga sida efteråt, för måttens skull: en sida utan bild är
 * fortfarande kandidatens sida, och specifikationerna står där.
 */
function assignPages(candidates: ModelCandidate[], pages: FetchedPage[]): Map<string, Ranked> {
  const models = candidates.map((c) => c.model);
  const options = new Map<string, Ranked[]>();
  for (const c of candidates) options.set(c.model, rankPages(c, pages, models));
  // Den vars bästa sida är starkast får välja först. Parningen blir maximal oavsett ordning, men
  // ordningen avgör VILKEN maximal parning — och då ska den säkraste matchningen få sitt förstahandsval.
  const best = (m: string) => options.get(m)?.[0]?.rank ?? Number.MAX_SAFE_INTEGER;
  const order = [...new Set(models)].sort((a, b) => best(a) - best(b));

  /** finalUrl -> modellen som håller sidan. */
  const owner = new Map<string, string>();
  const claim = (model: string, tried: Set<string>): boolean => {
    for (const { page, images } of options.get(model) ?? []) {
      if (images.length === 0 || tried.has(page.finalUrl)) continue;
      tried.add(page.finalUrl);
      const holder = owner.get(page.finalUrl);
      // Ledig sida, eller en innehavare som kan flytta. Kan ingen av delarna finns det ingen väg till
      // en bild för den här kandidaten — och ingen annan förlorar sin på försöket.
      if (holder === undefined || claim(holder, tried)) {
        owner.set(page.finalUrl, model);
        return true;
      }
    }
    return false;
  };
  for (const model of order) claim(model, new Set());

  const out = new Map<string, Ranked>();
  for (const [url, model] of owner) {
    const hit = (options.get(model) ?? []).find((r) => r.page.finalUrl === url);
    if (hit) out.set(model, hit);
  }
  const used = new Set(owner.keys());
  for (const model of order) {
    if (out.has(model)) continue;
    const free = (options.get(model) ?? []).find((r) => !used.has(r.page.finalUrl));
    if (!free) continue;
    used.add(free.page.finalUrl);
    out.set(model, free);
  }
  return out;
}

/**
 * Bild per kandidat.
 *
 * Körs EFTER att kandidaterna sparats och visats. Väljarskärmen dyker upp lika snabbt som förut;
 * bilderna tonar in när de landar. En kandidat utan bild är fortfarande fullt valbar.
 *
 * `onPartial` får kandidaterna med de bilder som redan hittats, medan resten fortfarande letas upp.
 * Den finns för att fördjupningen nedan inte ska hålla tillbaka det som redan är klart: utan den syns
 * första rundans bilder först när sista rundan gett upp. En kandidat som fortfarande letas lämnas då
 * utan `imageUrl` — `undefined` betyder "letar", `null` "hittade ingen" (se types.ts), och det är
 * precis den skillnaden väljarskärmens pollning läser för att veta om fler bilder är på väg.
 */
export async function resolveCandidateImages(
  candidates: ModelCandidate[],
  sources: SourceRef[],
  onPartial?: (partial: ModelCandidate[]) => void | Promise<void>,
  budgetMs: number = HUNT_BUDGET_MS,
): Promise<ModelCandidate[]> {
  const deadline = Date.now() + budgetMs;
  /**
   * Grundningens källor RÄCKER INTE.
   *
   * Sökningen returnerar 4-6 sidor totalt, och de täcker sällan alla fyra kandidaterna: hittar den
   * Impulse-sidan får Impulse en bild medan Alex och Julia blir utan, och tvärtom nästa körning.
   * Kandidaterna och deras bilder kom ur samma lilla pool.
   *
   * Därför tas även den sida modellen själv pekat ut per kandidat med i hämtningen. Den är INTE
   * betrodd — den går genom exakt samma kontroll som allt annat: sidan hämtas, och dess titel eller
   * slutliga adress måste nämna modellen. En påhittad adress ger alltså ingen bild, inte fel bild.
   */
  const claimed: SourceRef[] = candidates
    .filter((c) => c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl))
    .map((c) => ({ title: c.model, url: c.sourceUrl!, qualityTier: 2 as const }));
  const seen = new Set<string>();
  const toFetch = [...sources, ...claimed].filter((s) => !seen.has(s.url) && seen.add(s.url));

  const pages = (await Promise.all(toFetch.map(fetchSafely))).filter((p): p is FetchedPage => p !== null);
  console.info(
    `[bild] ${pages.length}/${toFetch.length} källor hämtade (${claimed.length} från kandidaterna själva)` +
      (pages.length ? `: ${pages.map((p) => `${p.title.slice(0, 40)}${p.images.length ? " [bild]" : ""}`).join(" | ")}` : ""),
  );

  let assigned = assignPages(candidates, pages);
  /** Modell -> den bildadress som faktiskt svarade som en bild. */
  const picked = new Map<string, string>();
  /** Adress -> är den bevisat död? Delas mellan rundorna, så ingen adress kontrolleras två gånger. */
  const checked = new Map<string, Promise<boolean>>();
  await pickImages(candidates, assigned, picked, checked);

  /**
   * Hoppen: kandidaten saknar bild, men någon av de hämtade sidorna LEDER till den.
   *
   * Sökningen landar ofta på en kategorisida ("Fåtöljer | Sits") eller en butiks startsida. Den sidan
   * duger inte själv — dess bild visar någon annan modell — men den innehåller länken till modellens
   * egen produktsida. Att stanna vid första sidan var att stå på tröskeln till svaret.
   *
   * Länken väljs på att modellnamnet står som ett eget ord i adressen eller i länktexten, och sidan
   * den leder till går sedan genom exakt samma kontroll som allt annat.
   *
   * SAKNAR BILD är inte samma sak som saknar sida. En kandidat som fått en sida utan bild bär redan
   * dess mått, och hoppet är just till för att hitta en sida som också har en bild. Hade villkoret
   * varit "ingen sida alls" hade måttfyndet kostat bilden.
   */
  let frontier = pages;
  let searchRound = 0;
  for (const [stepIndex, step] of STEPS.entries()) {
    const missing = candidates.filter((c) => !picked.has(c.model));
    if (missing.length === 0) break;
    if (Date.now() >= deadline) {
      console.info(
        `[bild] tiden ute efter ${stepIndex} av ${STEPS.length} steg` +
          ` — ${missing.map((c) => c.model).join(", ")} blir utan bild`,
      );
      break;
    }
    /**
     * Det som redan hittats skrivs ut NU, innan nästa steg ens vet vad det ska hämta.
     *
     * Skrivningen låg förut efter adressletandet och innanför dess tomhandsgren: ett steg som inte
     * hittade några adresser hoppade över den, och en sökning som prövar fem motorer skrev inget
     * förrän den var färdig. En kandidat som fått sin bild i första rundan kunde alltså stå och
     * skimra i en halv minut med bilden färdig i minnet. Nu ligger skrivningen först i steget, så
     * varje ny bild syns hos säljaren inom ett steg från att den hittades.
     */
    if (picked.size > 0) {
      try {
        await onPartial?.(compose(candidates, assigned, picked, false));
      } catch {
        // En misslyckad delskrivning är inte värd att fälla hämtningen för.
      }
    }
    const hop =
      step === "hopp"
        ? hopTargets(missing, frontier, seen)
        : step === "butikssökning"
          ? storeSearchTargets(missing, pages, seen)
          : await searchTargets(missing, seen, searchRound++, deadline);
    // Ett steg som inte hittade något att hämta är inte slutet: nästa steg är en annan väg.
    if (hop.length === 0) continue;
    const extra = (await Promise.all(hop.map(fetchSafely))).filter((p): p is FetchedPage => p !== null);
    console.info(
      `[bild] ${step}: ${extra.length}/${hop.length} sidor hämtade för ${missing.map((c) => c.model).join(", ")}`,
    );
    if (extra.length === 0) continue;
    pages.push(...extra);
    // Nästa runda läser de NYA sidornas länkar först, och fyller på med de gamlas som inte fick plats
    // under taket förra rundan. Redan hämtade adresser står i `seen` och tas aldrig om.
    frontier = [...extra, ...pages];
    assigned = assignPages(candidates, pages);
    // Fördelningen kan ha flyttat sidor mellan kandidaterna, så valet görs om från grunden. Det
    // kostar inga nya anrop: varje redan kontrollerad bildadress ligger kvar i `checked`.
    picked.clear();
    await pickImages(candidates, assigned, picked, checked);
  }

  const out = compose(candidates, assigned, picked, true);
  for (const c of out) {
    const page = assigned.get(c.model)?.page;
    if (!page) {
      console.info(`[bild] ${c.model}: ingen hämtad sida nämner modellen`);
      continue;
    }
    console.info(
      `[bild] ${c.model}: ${new URL(page.finalUrl).hostname}` +
        ` bild=${c.imageUrl ? "ja" : "nej"} specar=${page.specs.map((sp) => sp.label).join("/") || "inga"}`,
    );
  }
  return out;
}

/**
 * Kandidaterna som de ska skrivas ned: samma ordning, samma fält, bara bilden och sidans mått ifyllda.
 *
 * `final` skiljer ett delresultat från ett slutbesked. Den som fortfarande letas lämnas UTAN
 * `imageUrl` i delresultatet — hade den fått `null` hade väljarskärmen läst det som färdigt, slutat
 * polla, och bilden som landade en runda senare hade aldrig nått skärmen.
 */
function compose(
  candidates: ModelCandidate[],
  assigned: Map<string, Ranked>,
  picked: Map<string, string>,
  final: boolean,
): ModelCandidate[] {
  return candidates.map((c) => {
    const page = assigned.get(c.model)?.page ?? null;
    const image = picked.get(c.model) ?? null;
    const base: ModelCandidate = {
      ...c,
      imageSource: page?.finalUrl ?? null,
      pageSpecs: page ? page.specs : null,
    };
    if (image) return { ...base, imageUrl: image };
    if (final) return { ...base, imageUrl: null };
    const { imageUrl: _letarVidare, ...letar } = base;
    return letar;
  });
}

/**
 * Bilden varje kandidat faktiskt får: den första på dess sida som svarar som en bild.
 *
 * Sidan kan erbjuda fyra adresser och den bästa av dem vara borttagen. Att skicka en död adress till
 * säljaren ger exakt den tomma ruta vi försöker bli av med — här kostar det ett HEAD-anrop att i
 * stället ta nästa bild på samma sida.
 */
async function pickImages(
  candidates: ModelCandidate[],
  assigned: Map<string, Ranked>,
  picked: Map<string, string>,
  checked: Map<string, Promise<boolean>>,
): Promise<void> {
  await Promise.all(
    candidates.map(async (c) => {
      if (picked.has(c.model)) return;
      const hit = assigned.get(c.model);
      if (!hit) return;
      const options = hit.images.slice(0, MAX_IMAGE_CHECKS);
      for (const [i, url] of options.entries()) {
        /**
         * Den sista tas utan kontroll.
         *
         * Kontrollen finns för att kunna VÄLJA en annan bild på samma sida — den finns inte för att
         * kasta den enda som erbjuds. En oprövad bild är fortfarande en bild; en kastad är garanterat
         * en tom ruta. Sidor med en enda bildadress kostar därför inte ett enda extra anrop.
         */
        if (i === options.length - 1) {
          picked.set(c.model, url);
          return;
        }
        let verdict = checked.get(url);
        if (!verdict) {
          verdict = imageIsDead(url);
          checked.set(url, verdict);
        }
        if (!(await verdict)) {
          picked.set(c.model, url);
          return;
        }
        console.info(`[bild] ${c.model}: adressen svarade inte som en bild — ${url.slice(0, 80)}`);
      }
    }),
  );
}

/**
 * Svarar adressen som en bild?
 *
 * Bara ett BEVISAT nej diskvalificerar: 404/410, eller ett svar som lämnar ut ett DOKUMENT där en
 * bild skulle stått — en felsida med statuskod 200 är den vanligaste döda bilden av alla.
 *
 * Allt annat får passera. Ett CDN som vägrar HEAD, en timeout, ett 403 eller ett svar utan
 * innehållstyp säger ingenting om bilden, och en del CDN:er skickar riktiga bilder som
 * `application/octet-stream`. Att kasta en fungerande bild på en tveksam signal vore att göra precis
 * det den här funktionen ska förhindra.
 */
const DOCUMENT_TYPE = /^(text\/|application\/(json|xml|xhtml))/;

async function imageIsDead(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
      headers: { "user-agent": UA_BROWSER, accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return true;
    return res.ok && DOCUMENT_TYPE.test((res.headers.get("content-type") ?? "").toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Sökmotorerna, prövade tills en av dem svarar med träffar.
 *
 * Nyckellösa HTML-gränssnitt, en fråga per kandidat som saknar bild — inga modellanrop, ingen
 * API-nyckel, ingenting på säljarens kritiska väg.
 *
 * Fem stycken, för att en enskild motor svarar med en kontrollsida när frågorna kommer tätt. Mätt:
 * fyra frågor i rad till samma motor gav noll träffar på de tre sista, och kandidaterna räddades den
 * gången av det avslutande hoppet. Kandidaterna börjar därför på var sin motor (se rotationen i
 * searchTargets) och går laget runt därifrån — ingen motor får fyra frågor i rad, och det krävs att
 * ALLA fem tystnar för att en kandidat ska bli utan.
 */
const SEARCH_ENGINES: Array<(query: string) => string> = [
  (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=se-sv`,
  (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=sv`,
  (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
  (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
];

/** Sidor som aldrig är en produktsida, hur högt de än ligger i träfflistan. */
const SEARCH_JUNK = /(google\.|gstatic|yahoo|youtube|facebook|instagram|pinterest|tiktok|twitter|x\.com|linkedin|reddit|wikipedia)/i;

/** Domänen bakom en värd: mojeek.com ur www.mojeek.com, duckduckgo.com ur html.duckduckgo.com. */
const baseDomain = (host: string): string => host.split(".").slice(-2).join(".");

/** Träffarna på en sökresultatsida, i sidans egen ordning. */
async function searchOnce(url: string): Promise<string[]> {
  let html: string;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { "user-agent": UA_BROWSER, accept: "text/html", "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" },
      redirect: "follow",
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }
  const out: string[] = [];
  /**
   * Sökmotorns EGNA länkar är inte träffar.
   *
   * En resultatsida är full av dem — inställningar, "om oss", opensearch.xml — och de ligger i samma
   * HTML som svaren. Utan den här spärren åt de upp hela träffbudgeten: en kandidat "hittade tre
   * träffar" som alla var motorns egna sidor, och blev utan bild trots att svaret stod på samma sida.
   */
  const engineDomain = baseDomain(new URL(url).hostname);
  const push = (raw: string): void => {
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol) || SEARCH_JUNK.test(u.hostname)) return;
      if (baseDomain(u.hostname) === engineDomain) return;
      /**
       * En startsida är ingen produktsida.
       *
       * Motorernas annons- och sitelink-block pekar på butikens förstasida — `ikea.com/se/sv/` — och
       * de ligger FÖRE de organiska träffarna i HTML:en. Utan den här spärren åt de upp kandidatens
       * tre platser, och det som faktiskt stod i träfflistan hämtades aldrig.
       */
      if (isSiteRoot(u.href)) return;
      u.hash = "";
      out.push(u.href);
    } catch {
      // Inte en adress.
    }
  };
  /**
   * Träfflistan läses AVKODAD.
   *
   * Sökmotorerna skriver sina omdirigeringar som HTML: `…&amp;u=a1aHR0cHM6…`. Lästes taggarna som de
   * stod satt tecknet före parametern fel, och Bings samtliga träffar var osynliga för uttrycken
   * nedan — motorn svarade med 132 länkar och vi hittade noll.
   */
  const decoded = decodeEntities(html);
  // DuckDuckGo lämnar ut träffen genom sin egen omdirigering: ...?uddg=<adressen, urlkodad>.
  for (const m of decoded.matchAll(/[?&]uddg=([^"&]+)/gi)) {
    try {
      push(decodeURIComponent(m[1]));
    } catch {
      // Trasig kodning.
    }
  }
  // Yahoo skickar sin genom r.search.yahoo.com: .../RU=<adressen, urlkodad>/RK=…
  for (const m of decoded.matchAll(/[?&/]RU=([^/&"]+)/g)) {
    try {
      push(decodeURIComponent(m[1]));
    } catch {
      // Trasig kodning.
    }
  }
  // Bing gör samma sak, men base64-kodat: ...&u=a1<adressen, base64url>.
  for (const m of decoded.matchAll(/[?&]u=a1([A-Za-z0-9_-]{16,})/g)) {
    try {
      push(Buffer.from(m[1], "base64url").toString("utf-8"));
    } catch {
      // Inte base64 trots allt.
    }
  }
  for (const m of decoded.matchAll(/href="(https?:\/\/[^"]+)"/gi)) push(m[1]);
  return [...new Set(out)];
}

/**
 * Sökningen: fråga rakt ut efter modellen och ta de sidor som kan vara dess.
 *
 * Frågan bär märke, modell OCH produkttyp — "IKEA EKTORP soffa", inte bara "EKTORP". Typen är med
 * för att det är MÖBELN vi vill ha bilden på: utan den svarar butikerna lika gärna med klädseln,
 * kudden eller reservdelen, och de sidorna är sorterade sist av samma skäl (se ACCESSORY).
 *
 * Träffar vars adress bär modellnamnet tas först — de är produktsidor så gott som alltid. Resten
 * följer med som andrahandsval, och går genom exakt samma namnkontroll som allt annat: en sökträff
 * är ett förslag, aldrig ett svar.
 */
let searchCursor = 0;

async function searchTargets(
  missing: ModelCandidate[],
  seen: Set<string>,
  round: number,
  deadline: number,
): Promise<SourceRef[]> {
  /**
   * Kandidaterna frågar SAMTIDIGT, var och en från sin egen plats i rotationen.
   *
   * Förut gick de i kö, och var och en prövade upp till fem motorer efter varandra innan den gav upp.
   * Fyra kandidater som möter tysta motorer blev alltså tjugo frågor på rad med 8 s tak var — ett
   * enda steg kunde kosta mer än hela den övriga jakten, och det är det steget som oftast körs, för
   * det är just de kandidater som ingen hämtad sida nämner som hamnar här.
   *
   * Samtidigheten skickar inte fler frågor till samma motor än förut: rotationen gav dem redan var
   * sin startmotor, och den enda skillnaden är att de fyra köerna nu ligger bredvid varandra i
   * stället för efter varandra. Kravet på att ALLA fem ska tystna innan en kandidat blir utan står
   * kvar orört.
   */
  const start = searchCursor;
  // Nästa sökomgång börjar efter den sista kandidatens startmotor, så rotationen fortsätter runt.
  searchCursor = (searchCursor + missing.length) % SEARCH_ENGINES.length;
  const found = await Promise.all(
    missing.map(async (c, slot): Promise<SourceRef[]> => {
      /**
       * Andra omgången frågar bredare.
       *
       * Produkttypen är vår egen läsning av möbeln och ibland fel ord: står det "öronlappsfåtölj" i
       * frågan men "fåtölj" på sidan blir träfflistan tunn. Första frågan är därför den precisa, andra
       * bara märke och modell — samma modell, större nät.
       */
      const query = [c.brand, c.model, round === 0 ? c.productType : ""].filter((s) => s && s.trim()).join(" ").trim();
      if (!query) return [];
      const model = normalise(c.model);
      const out: SourceRef[] = [];
      for (let i = 0; i < SEARCH_ENGINES.length; i++) {
        // En motor till kostar 8 sekunder, och tiden är gemensam: den som redan är förbrukad tillhör
        // inte den här kandidaten utan hela jakten.
        if (Date.now() >= deadline) break;
        const engine = SEARCH_ENGINES[(start + slot + i) % SEARCH_ENGINES.length];
        const hits = (await searchOnce(engine(query))).filter((u) => !seen.has(u));
        if (hits.length === 0) continue;
        const ordered = [
          ...hits.filter((u) => ` ${normalise(u)} `.includes(` ${model} `)),
          ...hits.filter((u) => !` ${normalise(u)} `.includes(` ${model} `)),
        ].slice(0, MAX_SEARCH_HITS);
        console.info(`[bild] sökte "${query}" — ${hits.length} träffar, tar ${ordered.length}`);
        for (const url of ordered) {
          // Läses och skrivs i samma andetag: kandidaterna söker samtidigt, och två som fick samma
          // träff ska inte hämta den var sin gång.
          if (seen.has(url)) continue;
          seen.add(url);
          out.push({ title: c.model, url, qualityTier: 2 });
        }
        break;
      }
      return out;
    }),
  );
  return found.flat();
}

/**
 * Butikens egen sökruta.
 *
 * Modellens citerade adress är ofta en gissning — `mio.se/p/oxford-3-sits-soffa/208882` svarar 404
 * för att artikelnumret är påhittat. Men VÄRDNAMNET i gissningen stämmer nästan alltid: butiken är
 * rätt, bara adressen är fel. Och butiken har en sökruta.
 *
 * Den vägen går direkt till den som faktiskt säljer möbeln, utan att passera någon sökmotor — den
 * kan inte strypas av frågor som kommer tätt, och butiken har garanterat sin egen produkt. Därför
 * står den före webbsökningen. Resultatsidan är sällan kandidatens sida i sig; det är LÄNKARNA på
 * den nästa hopp följer.
 */
const STORE_SEARCH_PATHS = ["/sok?q=", "/search?q="];

/**
 * Värdnamn som inte är någons butik.
 *
 * Kandidatens citerade adress är ofta grundningens omdirigering
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`), och en sökruta på DEN värden finns
 * inte. Utan spärren gick hela butikssökningen åt till två garanterade 404:or, och kandidaten kom
 * aldrig fram till en riktig butik.
 */
const NOT_A_STORE = /(vertexaisearch|googleusercontent|google\.|duckduckgo|bing\.|brave\.com|mojeek|facebook|instagram|pinterest|wikipedia)/i;

function storeSearchTargets(missing: ModelCandidate[], pages: FetchedPage[], seen: Set<string>): SourceRef[] {
  const out: SourceRef[] = [];
  for (const c of missing) {
    const hosts: string[] = [];
    for (const raw of [c.sourceUrl, ...pages.map((p) => p.finalUrl)]) {
      if (!raw) continue;
      try {
        const host = new URL(raw).hostname;
        if (!NOT_A_STORE.test(host) && !hosts.includes(host)) hosts.push(host);
      } catch {
        // Inte en adress.
      }
    }
    for (const path of STORE_SEARCH_PATHS) {
      if (out.length >= MAX_HOP_FETCHES || !hosts[0]) break;
      const url = `https://${hosts[0]}${path}${encodeURIComponent(c.model)}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: c.model, url, qualityTier: 3, linksOnly: true });
    }
  }
  return out;
}

/**
 * Länkarna som kan bära en kandidat vidare till sin egen sida.
 *
 * Taket per kandidat finns för att en enda kandidat annars kunde äta upp hela rundan och lämna de
 * andra utan — och det är just de andra hoppet är till för.
 */
function hopTargets(missing: ModelCandidate[], pages: FetchedPage[], seen: Set<string>): SourceRef[] {
  const hop: SourceRef[] = [];
  const links = pages.flatMap((p) => p.links);
  for (const c of missing) {
    const model = normalise(c.model);
    if (!model) continue;
    const type = normalise(c.productType ?? "");
    /**
     * Vilken av länkarna som bär modellnamnet vi väljer.
     *
     * En butikssökning på "Oxford" svarar med soffan, fotpallen, klädseln och kuddarna — alla fyra
     * heter Oxford, och bara den första är möbeln säljaren ska känna igen. Rangordningen sätter
     * därför möbeltypen först och tillbehören sist, och låter adressen väga tyngre än länktexten:
     * en länk med namnet i URL:en är produktsidan så gott som alltid.
     */
    const scored = links
      .filter((l) => !seen.has(l.url))
      .map((l) => {
        const inUrl = ` ${normalise(l.url)} `.includes(` ${model} `);
        const text = `${normalise(l.url)} ${l.label}`;
        if (!inUrl && !` ${l.label} `.includes(` ${model} `)) return null;
        return { l, rank: (type && !` ${text} `.includes(` ${type} `) ? 2 : 0) + (ACCESSORY.test(text) ? 4 : 0) + (inUrl ? 0 : 1) };
      })
      .filter((x): x is { l: PageLink; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank);
    let taken = 0;
    for (const { l } of scored) {
      if (taken >= MAX_HOP_PER_CANDIDATE || hop.length >= MAX_HOP_FETCHES) break;
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      hop.push({ title: c.model, url: l.url, qualityTier: 2 });
      taken++;
    }
  }
  return hop;
}

/**
 * Produktsidan för den modell säljaren landade på — annonsens omslag OCH dess specifikationer.
 *
 * Samma maskineri som kandidatbilderna, med EN kandidat: sidorna hämtas, och bara en sida vars titel
 * eller slutliga adress nämner modellen får ge sin bild. Kravet är hela poängen — en omslagsbild
 * på fel möbel är värre än ingen omslagsbild, för den är det första en köpare tror på.
 *
 * Körs när kandidatvalet inte redan bar en sida: säljaren skrev modellnamnet själv, eller hämtningen
 * hann aldrig landa innan de tryckte vidare. Källorna kommer från annonsgeneratorns egen grundade
 * sökning, alltså sidor som redan visat sig handla om just den här modellen.
 *
 * Specifikationerna följer med tillbaka av samma skäl som bilden: sidan är hämtad, kontrollerad mot
 * modellnamnet och redan betald. Att läsa måtten ur den kostar ingen sekund extra.
 */
export async function resolveProductPage(
  identity: { brand: string | null; model: string },
  sources: SourceRef[],
): Promise<{ image: { url: string; sourceUrl: string | null } | null; specs: ListingAttribute[] }> {
  if (!identity.model.trim() || sources.length === 0) return { image: null, specs: [] };
  const candidate: ModelCandidate = {
    brand: identity.brand ?? "",
    model: identity.model,
    variant: null,
    productType: null,
    confidence: "strong",
    distinguishingDetail: null,
  };
  const [resolved] = await resolveCandidateImages([candidate], sources);
  return {
    image: resolved?.imageUrl ? { url: resolved.imageUrl, sourceUrl: resolved.imageSource ?? null } : null,
    specs: resolved?.pageSpecs ?? [],
  };
}
