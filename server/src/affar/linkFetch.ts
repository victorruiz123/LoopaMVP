/**
 * LINK_FETCH — servern hämtar annonssidan själv.
 *
 * ⚠️ LÄS DETTA FÖRST. Blockets robots.txt förbjuder uttryckligen automatiserad hämtning:
 *
 *     "Crawling blocket.se is prohibited unless you have written permission."
 *     "Användning av automatiserade tjänster såsom robotar, spindlar, indexering eller liknande,
 *      samt andra metoder för systematisk användning av innehållet på Webbplatsen är inte tillåtet
 *      utan föregående skriftligt tillstånd från Blocket."
 *
 * Modulen respekterar därför robots.txt som FÖRVAL (se `robotsAllows`). Den som har skriftligt
 * tillstånd slår av kontrollen med AFFAR_LINK_FETCH_IGNORE_ROBOTS=1 — ett medvetet klumpigt namn,
 * för det ska inte gå att sätta av misstag. Utan tillstånd är rätt beteende att falla tillbaka på
 * att köparen laddar upp sina egna skärmbilder, vilket fungerar i dag.
 *
 * SSRF ÄR DEN ANDRA HALVAN, och den är inte förhandlingsbar. Adressen kommer från en användare och
 * pekar var som helst — inklusive på vårt eget nät, på molnleverantörens metadatatjänst
 * (169.254.169.254) och på tjänster som bara lyssnar på loopback. Kontrollen sker på den UPPSLAGNA
 * IP-adressen, inte på värdnamnet: ett publikt namn kan peka på 127.0.0.1, och varje omdirigering
 * prövas om av samma skäl.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Vad en hämtning gav. Formen är avsiktligt densamma oavsett vilken sida som lästes. */
export interface FetchedAd {
  title: string | null;
  description: string | null;
  priceSek: number | null;
  /** Skickuppgift ur annonsen, när säljaren angett en. Säljarens ord, aldrig vårt betyg. */
  condition: string | null;
  imageUrls: string[];
  finalUrl: string;
}

export class LinkFetchError extends Error {
  constructor(message: string, public reason: "robots" | "network" | "blocked" | "unsupported") {
    super(message);
    this.name = "LinkFetchError";
  }
}

/**
 * ENDAST ASCII. Det är inte en stilfråga.
 *
 * Strängen bar först "köparinitierad annonsanalys", och `ö` i ett headervärde fick Traderas server
 * att svara 500 på varje hämtning — headervärden ska vara US-ASCII enligt RFC 7230, och en server
 * som tar det på allvar avvisar resten. Felet såg ut som att sidan var trasig, inte som att vi
 * skickade fel.
 */
const USER_AGENT = "LoopaBot/1.0 (+https://loopa.nu; buyer-initiated listing analysis)";
const TIMEOUT_MS = Number(process.env.AFFAR_LINK_TIMEOUT_MS ?? 12_000);
/** Sidor större än så är inte annonser. Taket finns för att en hämtning inte ska kunna äta minnet. */
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_IMAGES = 8;

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

/**
 * Adressintervall en användare aldrig ska kunna få oss att hämta från.
 *
 * Loopback, privata nät, link-local (där molnens metadatatjänst bor) och delad adressrymd. Listan
 * gäller den UPPSLAGNA adressen — ett värdnamn säger ingenting om var det pekar.
 */
function isForbiddenAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast och broadcast
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    // IPv4-mappade adresser bär samma risk som sin IPv4-form.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isForbiddenAddress(mapped[1]);
    return false;
  }
  return true;
}

/** Slår upp värdnamnet och avvisar om NÅGON av adresserna är förbjuden. */
async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LinkFetchError("Bara http och https går att hämta.", "unsupported");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new LinkFetchError("Adressen gick inte att slå upp.", "network");
  }
  // ALLA måste vara publika. En värd med både en publik och en privat adress är inte säkrare för
  // att den första råkade svara.
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      throw new LinkFetchError("Adressen pekar på ett internt nät.", "blocked");
    }
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

const robotsCache = new Map<string, { at: number; allowed: boolean }>();
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;

/** Skriftligt tillstånd finns. Klumpigt namn med flit — det ska inte gå att sätta av misstag. */
export function ignoringRobots(): boolean {
  return process.env.AFFAR_LINK_FETCH_IGNORE_ROBOTS === "1";
}

/**
 * Får vi hämta den här adressen enligt sidans egen robots.txt?
 *
 * Medvetet STRÄNG tolkning: en `Disallow: /` för `*`, eller en rad i filen som säger att crawling
 * kräver tillstånd, räknas som nej. Blocket skriver sitt förbud som en kommentar överst — den syns
 * inte för en regelparser, men den är riktad till oss och ska läsas.
 */
export async function robotsAllows(url: URL): Promise<boolean> {
  if (ignoringRobots()) return true;
  const origin = url.origin;
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.allowed;

  let allowed = true;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(6000),
      redirect: "follow",
    });
    if (res.ok) {
      const text = (await res.text()).slice(0, 100_000);

      // Ett uttalat förbud i klartext väger tyngre än frånvaron av en Disallow-rad.
      if (/crawling[^\n]*prohibited|inte tillåtet utan[^\n]*tillstånd|prohibited unless you have written permission/i.test(text)) {
        allowed = false;
      } else {
        // Reglerna för `*`: gäller någon av dem hela sidan är svaret nej.
        const star = /user-agent:\s*\*([\s\S]*?)(?=\nuser-agent:|$)/i.exec(text);
        if (star && /^\s*disallow:\s*\/\s*$/im.test(star[1])) allowed = false;
      }
    }
  } catch {
    // Ingen robots.txt att läsa. Standardtolkningen är att hämtning är tillåten.
  }
  robotsCache.set(origin, { at: Date.now(), allowed });
  return allowed;
}

// ---------------------------------------------------------------------------
// Hämtningen
// ---------------------------------------------------------------------------

async function getWithGuards(target: URL): Promise<{ body: string; finalUrl: string }> {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Varje hopp prövas om: en omdirigering till 127.0.0.1 är exakt det angreppet skyddet finns för.
    await assertPublicHost(url);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new LinkFetchError("Omdirigering utan adress.", "network");
      url = new URL(location, url);
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      throw new LinkFetchError("Sidan avvisade hämtningen.", "blocked");
    }
    if (!res.ok) throw new LinkFetchError(`Sidan svarade ${res.status}.`, "network");

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new LinkFetchError("Adressen pekar inte på en webbsida.", "unsupported");
    }

    // Läser i bitar med ett tak i stället för res.text(): en sida utan Content-Length kan annars
    // vara hur stor som helst.
    const reader = res.body?.getReader();
    if (!reader) throw new LinkFetchError("Tomt svar.", "network");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { body: Buffer.concat(chunks).toString("utf-8"), finalUrl: url.toString() };
  }
  throw new LinkFetchError("För många omdirigeringar.", "network");
}

// ---------------------------------------------------------------------------
// Utvinning
// ---------------------------------------------------------------------------

function decode(v: string): string {
  return v
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

/** Ett metataggsvärde, oavsett om property eller content står först i taggen. */
function meta(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decode(m[1]);
  }
  return null;
}

function allMeta(html: string, key: string): string[] {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "gi");
  return [...html.matchAll(re)].map((m) => decode(m[1])).filter(Boolean);
}

/** Strukturerad data. Annonssidor bär oftast en Product eller Offer där. */
function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (node && typeof node === "object") out.push(node as Record<string, unknown>);
        const graph = (node as { "@graph"?: unknown })?.["@graph"];
        if (Array.isArray(graph)) for (const g of graph) if (g && typeof g === "object") out.push(g);
      }
    } catch {
      // Trasig JSON-LD är vanligt. Den ska inte fälla resten av utvinningen.
    }
  }
  return out;
}

function priceFrom(html: string, nodes: Record<string, unknown>[]): number | null {
  for (const n of nodes) {
    const offers = (n.offers ?? n) as Record<string, unknown> | undefined;
    const raw = (offers?.price ?? offers?.lowPrice) as unknown;
    const num = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^\d]/g, ""));
    if (Number.isFinite(num) && num > 0 && num <= 500_000) return Math.round(num);
  }
  const og = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  if (og) {
    const n = Number(og.replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  // Sista utvägen: ett belopp i kronor i sidans text. Tar det FÖRSTA, som på en annonssida är priset.
  const m = /(\d[\d\s ]{2,8})\s*kr\b/i.exec(html.replace(/<[^>]+>/g, " "));
  if (m) {
    const n = Number(m[1].replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n > 0 && n <= 500_000) return n;
  }
  return null;
}

/**
 * Annonstexten, helst säljarens egen.
 *
 * JSON-LD FÖRST, og:description sedan. Ordningen är mätt: Traderas og:description är butikens egen
 * boilerplate — "Utropspris: 500 kr. Typ: Auktion. Köp & sälj begagnade Soffor på Tradera." — och
 * säger ingenting om möbeln. Ett strukturerat `description`-fält på en Product-nod är däremot det
 * säljaren skrev.
 *
 * Faller båda blir det null, och köparen får en annonssida utan textstycke i stället för en med
 * marknadsplatsens reklam citerad som säljarens ord.
 */
export function descriptionFrom(html: string, nodes: Record<string, unknown>[]): string | null {
  for (const n of nodes) {
    const d = n.description;
    if (typeof d === "string" && d.trim().length > 30) return decode(d).trim();
  }
  const og = meta(html, "og:description") ?? meta(html, "description");
  return og && !isMarketplaceBoilerplate(og) ? og : null;
}

/**
 * Butikens egen säljtext, inte annonsens.
 *
 * Känns igen på att den talar om SIDAN och inte om möbeln: utropspris, auktionsslut, "köp & sälj på
 * X". Sådana rader har inget värde för en köpare som redan står på annonsen — och citerade under
 * rubriken "Ur annonsen" ser de ut som något säljaren skrivit.
 */
function isMarketplaceBoilerplate(text: string): boolean {
  return /k[öo]p\s*&\s*s[äa]lj|utropspris|auktion|slutar:|handla begagnat/i.test(text);
}

/** Skickuppgiften, som SÄLJAREN angett den. Aldrig vårt betyg — se PreliminaryAssessment. */
function conditionFrom(html: string, nodes: Record<string, unknown>[]): string | null {
  for (const n of nodes) {
    const c = (n.itemCondition ?? (n.offers as Record<string, unknown> | undefined)?.itemCondition) as unknown;
    if (typeof c === "string" && c) return decode(c.replace(/^https?:\/\/schema\.org\//, ""));
  }
  const text = html.replace(/<[^>]+>/g, " ");
  const m = /\b(nyskick|helt ny|som ny|mycket gott skick|gott skick|bra skick|okej skick|välanvänd|sliten|defekt)\b/i.exec(text);
  return m ? m[1] : null;
}

function imagesFrom(html: string, nodes: Record<string, unknown>[], base: string): string[] {
  const urls = new Set<string>();
  for (const u of allMeta(html, "og:image")) urls.add(u);
  for (const n of nodes) {
    const img = n.image as unknown;
    for (const v of Array.isArray(img) ? img : [img]) {
      if (typeof v === "string") urls.add(v);
      else if (v && typeof v === "object" && typeof (v as { url?: string }).url === "string") urls.add((v as { url: string }).url);
    }
  }
  return [...urls]
    .map((u) => { try { return new URL(u, base).toString(); } catch { return null; } })
    .filter((u): u is string => !!u && /^https?:/.test(u))
    .slice(0, MAX_IMAGES);
}

/**
 * Annonsen, hämtad och utvunnen.
 *
 * Kastar hellre än att returnera ett magert resultat: den som anropar ska kunna skilja "vi fick inte
 * hämta" från "vi hämtade men sidan sade ingenting", och falla tillbaka på köparens egna
 * skärmbilder i båda fallen.
 */
export async function fetchAd(rawUrl: string): Promise<FetchedAd> {
  const url = new URL(rawUrl);
  if (!(await robotsAllows(url))) {
    throw new LinkFetchError(
      `${url.hostname} tillåter inte automatisk hämtning i sin robots.txt.`,
      "robots",
    );
  }

  const { body, finalUrl } = await getWithGuards(url);
  const nodes = jsonLd(body);

  const title = meta(body, "og:title") ?? (decode(/<title[^>]*>([^<]*)</.exec(body)?.[1] ?? "") || null);
  const description = descriptionFrom(body, nodes);

  return {
    title,
    description: description?.slice(0, 4000) ?? null,
    priceSek: priceFrom(body, nodes),
    condition: conditionFrom(body, nodes),
    imageUrls: imagesFrom(body, nodes, finalUrl),
    finalUrl,
  };
}

/** Hämtar annonsbilderna. Samma SSRF-regler — bildvärdar är också användarstyrda adresser. */
export async function fetchImages(urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const raw of urls.slice(0, MAX_IMAGES)) {
    try {
      const url = new URL(raw);
      await assertPublicHost(url);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) continue;
      if (!/^image\//i.test(res.headers.get("content-type") ?? "")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > 8 * 1024 * 1024) continue;
      out.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
    } catch {
      // En bild som inte gick att hämta ska inte fälla de andra.
    }
  }
  return out;
}
