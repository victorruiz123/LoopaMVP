import type { ModelCandidate } from "./types.js";

/** En källa den grundade sökningen pekade ut. */
export interface SourceRef {
  title: string;
  url: string;
  qualityTier?: 1 | 2 | 3;
}

/**
 * Rundligt, för hämtningen ligger inte på någons kritiska väg: kandidaterna är redan sparade och
 * visade när den startar. Fyra sekunder räckte inte för en kall butikssida — och en källa som föll på
 * tiden blev en tom bildruta hos säljaren, vilket är precis det vi försöker undvika.
 */
const PAGE_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512 * 1024;

const OG_IMAGE = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i;
const OG_IMAGE_REVERSED = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i;

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
  links: string[];
  imageUrl: string | null;
}

const OG_TITLE = /<meta[^>]+(?:property|name)=["'](?:og:title)["'][^>]+content=["']([^"']+)["']/i;
const TITLE_TAG = /<title[^>]*>([^<]{1,300})<\/title>/i;

const HREF = /<a\b[^>]*\bhref=["']([^"'\s>]+)["']/gi;
/** Så många länkar vi bryr oss om per sida. En butikssida har tusentals; produktlänkarna ligger tidigt. */
const MAX_LINKS = 300;
/** Taket för andra hoppet. Det ligger utanför säljarens väntan, men ska inte bli en spindel. */
const MAX_HOP_FETCHES = 8;

function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(HREF)) {
    if (out.size >= MAX_LINKS) break;
    try {
      const u = new URL(m[1], base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      out.add(u.href);
    } catch {
      // Trasig href, hoppa.
    }
  }
  return [...out];
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

async function fetchPage(source: SourceRef): Promise<FetchedPage | null> {
  let res: Response;
  try {
    res = await fetch(source.url, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; LoopaCondition/1.0)", accept: "text/html" },
      redirect: "follow",
    });
  } catch (err) {
    return fail(source, err instanceof Error ? err.name : "fetch");
  }
  if (!res.ok) return fail(source, `HTTP ${res.status}`);

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
    return { source, finalUrl, title: "", body: normalise(finalUrl), links: [], imageUrl: finalUrl };
  }
  if (!contentType.includes("text/html")) return fail(source, contentType.split(";")[0] || "okänd typ");

  // Bara början av dokumentet: og-taggarna sitter i <head>, och en produktsida kan vara megabytes.
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_HTML_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  const html = new TextDecoder().decode(merged);

  const finalUrl = res.url || source.url;
  const title = (html.match(OG_TITLE)?.[1] ?? html.match(TITLE_TAG)?.[1] ?? "").trim();
  // Hela dokumentet, inte bara titeln. Hittade sökningen modellen på sidan står namnet oftast i
  // brödtexten — en produktlista heter "Fåtöljer | Sits" i titeln men nämner Impulse i innehållet.
  // Att bara läsa titeln var därför att leta på fel ställe.
  const body = normalise(html);

  const raw = (html.match(OG_IMAGE)?.[1] ?? html.match(OG_IMAGE_REVERSED)?.[1] ?? "").trim();
  // Tom og:image är vanligare än man tror — en död produktsida som omdirigerats till en kategorisida
  // svarar `content=""`. Utan den här kontrollen blir `new URL("", finalUrl)` sidans EGEN adress, och
  // säljaren får en trasig bildruta där produktbilden skulle stått.
  let imageUrl: string | null = null;
  if (raw) {
    try {
      const resolved = new URL(raw, finalUrl);
      if (/^https?:$/.test(resolved.protocol) && resolved.href !== finalUrl) imageUrl = resolved.href;
    } catch {
      imageUrl = null;
    }
  }
  return { source, finalUrl, title, body, links: extractLinks(html, finalUrl), imageUrl };
}

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
export function matchPage(candidate: ModelCandidate, pages: FetchedPage[], rivals: string[] = []): FetchedPage | null {
  const model = normalise(candidate.model);
  if (!model) return null;
  const others = rivals.map(normalise).filter((m) => m && m !== model);
  const hits: Array<{ p: FetchedPage; rank: number }> = [];
  for (const p of pages) {
    if (!p.imageUrl) continue;
    const named = `${normalise(p.title)} ${normalise(p.finalUrl)}`.includes(model);
    // Nivå 1: modellen står i titeln eller adressen — sidan HANDLAR om den.
    if (named) {
      hits.push({ p, rank: (p.source.qualityTier ?? 3) });
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
      hits.push({ p, rank: 10 + (p.source.qualityTier ?? 3) });
    }
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits[0]?.p ?? null;
}

/**
 * Tilldelar varje kandidat sin bästa sida, starkast match först.
 *
 * En sida används bara en gång så länge det finns alternativ: en kategorisida som nämner alla fyra
 * modellerna skulle annars ge alla fyra samma bild, och fyra likadana bilder är värre än två bilder
 * och två tomma rutor — det är på bilden säljaren skiljer dem åt.
 */
function assignPages(candidates: ModelCandidate[], pages: FetchedPage[]): Map<string, FetchedPage> {
  const out = new Map<string, FetchedPage>();
  const used = new Set<string>();
  const models = candidates.map((c) => c.model);
  const ranked = candidates
    .map((c) => ({ c, p: matchPage(c, pages, models) }))
    .sort((a, b) => (a.p ? 0 : 1) - (b.p ? 0 : 1));
  for (const { c } of ranked) {
    // Bara sidor ingen annan kandidat redan tagit. Att falla tillbaka på en upptagen sida hade
    // gett två kandidater samma bild — precis det den här funktionen finns för att undvika.
    const chosen = matchPage(c, pages.filter((x) => !used.has(x.finalUrl)), models);
    if (!chosen) continue;
    used.add(chosen.finalUrl);
    out.set(c.model, chosen);
  }
  return out;
}

/**
 * Bild per kandidat.
 *
 * Körs EFTER att kandidaterna sparats och visats. Väljarskärmen dyker upp lika snabbt som förut;
 * bilderna tonar in när de landar. En kandidat utan bild är fortfarande fullt valbar.
 */
export async function resolveCandidateImages(
  candidates: ModelCandidate[],
  sources: SourceRef[],
): Promise<ModelCandidate[]> {
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

  const pages = (await Promise.all(toFetch.map(fetchPage))).filter((p): p is FetchedPage => p !== null);
  console.info(
    `[bild] ${pages.length}/${toFetch.length} källor hämtade (${claimed.length} från kandidaterna själva)` +
      (pages.length ? `: ${pages.map((p) => `${p.title.slice(0, 40)}${p.imageUrl ? " [bild]" : ""}`).join(" | ")}` : ""),
  );

  let assigned = assignPages(candidates, pages);

  /**
   * Andra hoppet: kandidaten saknar sida, men någon av de hämtade sidorna LÄNKAR till den.
   *
   * Sökningen landar ofta på en kategorisida ("Fåtöljer | Sits") eller en butiks startsida. Den sidan
   * duger inte själv — dess bild visar någon annan modell — men den innehåller länken till modellens
   * egen produktsida. Att stanna vid första sidan var att stå på tröskeln till svaret.
   *
   * Länken väljs på att modellnamnet står som ett eget ord i adressen, och sidan den leder till går
   * sedan genom exakt samma kontroll som allt annat.
   */
  const missing = candidates.filter((c) => !assigned.has(c.model));
  if (missing.length > 0) {
    const hop: SourceRef[] = [];
    for (const c of missing) {
      const model = normalise(c.model);
      if (!model) continue;
      // Två per kandidat: den första länken är oftast produktsidan, den andra en variant av den. Utan
      // taket hade en enda kandidat kunnat äta upp hela hoppet och lämna de andra utan.
      let taken = 0;
      for (const link of pages.flatMap((p) => p.links)) {
        if (taken >= 2 || hop.length >= MAX_HOP_FETCHES) break;
        if (seen.has(link) || !` ${normalise(link)} `.includes(` ${model} `)) continue;
        seen.add(link);
        hop.push({ title: c.model, url: link, qualityTier: 2 });
        taken++;
      }
    }
    if (hop.length > 0) {
      const extra = (await Promise.all(hop.map(fetchPage))).filter((p): p is FetchedPage => p !== null);
      console.info(`[bild] andra hoppet: ${extra.length}/${hop.length} länkade sidor hämtade för ${missing.map((c) => c.model).join(", ")}`);
      if (extra.length > 0) assigned = assignPages(candidates, [...pages, ...extra]);
    }
  }

  return candidates.map((c) => {
    const page = assigned.get(c.model);
    if (!page) {
      console.info(`[bild] ${c.model}: ingen hämtad sida nämner modellen`);
      return { ...c, imageUrl: null, imageSource: null };
    }
    return { ...c, imageUrl: page.imageUrl, imageSource: page.finalUrl };
  });
}
