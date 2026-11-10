/**
 * Verifiering av påståenden mot källorna — i kod, efter modellen.
 *
 * EN ADRESS ÄR INTE ETT BELÄGG, men en död adress är inte heller ett bevis mot ett påstående. Den första
 * versionen sållade bort allt vars adress modellen bara påstod sig ha sett och vars sida vi inte kunde
 * hämta. Mätt på de riktiga körningarna (NORRNÄS, INGEMAR) kastade det 9 av 12 respektive 5 av 5
 * uppgifter — katalogcitat ur arkiverade PDF:er, återförsäljarsidor, Scribd-dokument — för att
 * adresserna idag svarar 404, 403 eller en JS-skal. Tomma måttlistor blev resultatet av ett verktyg
 * som skulle skydda säljaren mot påhitt.
 *
 * Nu skiljer vi på TRE saker, och säger vilken det var:
 *
 *   page_confirmed  vi hämtade sidan, fann modellnamnet OCH värdet. Det enda som får heta verifierat.
 *   cited           modellen pekade ut en källa som sökningen eller modellens egen källista känner till och
 *                   som inte motsägs: sidan är blockerad, JS-renderad, en PDF/bild, eller den läses men
 *                   tabellen står någon annanstans. Visas med länk, märkt "ej bekräftad mot sidan".
 *   unverified      vi har inget som belägger källan: adressen svarar inte alls, svarar 404, är en
 *                   bildfil, eller en sida som handlar om något annat. Uppgiften BEHÅLLS men märks som
 *                   osäker, och en död adress visas aldrig som länk.
 *
 * Det som fortfarande avvisas: en uppgift utan både adress och citat. Ingen kan kontrollera den, och
 * det är den enda kategorin där ett tomt fält är bättre än ett påstående.
 *
 * Begagnatsajter hämtar vi aldrig själva (villkoren förbjuder det); Google får läsa dem.
 */

import { htmlToText } from "../specHarvest.js";
import { PAGE_VERIFY_BUDGET_MS, PAGE_VERIFY_ENABLED, PAGE_VERIFY_MAX_PAGES, PAGE_VERIFY_TIMEOUT_MS } from "./config.js";
import { isMarketplace, slugKey } from "./normalize.js";
import type { ResearchDimension, ResearchFact, ResearchMaterial, VerificationLevel } from "./types.js";

/**
 * Utbytbar i tester: adress → vad hämtningen gav.
 *
 *   text         sidans läsbara text
 *   "unsupported"  dokumentet finns (200) men är inte text vi tolkar — en PDF-manual, en bild — eller en
 *                  begagnatsajt som vi aldrig hämtar
 *   "blocked"      servern finns men släpper inte in oss (401/403/429/5xx): säger ingenting om påståendet
 *   "gone"         404/410: sidan finns inte (längre) på den adressen
 *   null           nätverksfel eller tidsgräns: vi vet inget
 *
 * Skillnaden spelar roll. Ett dokument som finns får stå kvar som citerat, en blockerad sida är ingen
 * invändning, och en död adress får aldrig visas som en länk säljaren kan klicka på.
 */
export type PageFetchResult = string | "unsupported" | "blocked" | "gone" | null;
export type PageFetcher = (url: string) => Promise<PageFetchResult>;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_BYTES = 2 * 1024 * 1024;

/** En bildfil eller ett bild-CDN är inget man kan läsa ett mått ur och inget man länkar till som källa. */
export function isImageAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (/\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i.test(u.pathname)) return true;
    return /(^|\.)scribdassets\.com$/i.test(u.hostname) || /\/img\/document\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Sidor som är ett skal utan innehåll för en vanlig hämtning (JS-renderade): kortare än så säger inget om modellen. */
const THIN_PAGE_CHARS = 4000;

/**
 * Hämtar HTML (eller ren text) och gör den läsbar. PDF:er hoppas över — de bekräftas inte här.
 *
 * ALDRIG BEGAGNATSAJTER. Blocket, Tradera, Facebook Marketplace och liknande förbjuder automatiserad
 * hämtning i sina villkor (se AFFAR_LINK_FETCH_IGNORE_ROBOTS i server/.env.example, där Blockets egna
 * ord citeras), och en annons på en sådan sida är dessutom inte en specifikationskälla. Googles sök
 * och URL-verktyg får läsa dem — det är deras index och deras hämtning, och en annonsrubrik är bra
 * belägg för VILKEN modell det är — men vår server gör det aldrig. Ett påstående som pekar dit blir
 * "cited", aldrig "page_confirmed".
 */
export const fetchPageText: PageFetcher = async (url) => {
  if (isMarketplace(url)) return "unsupported";
  if (isImageAssetUrl(url)) return "unsupported";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PAGE_VERIFY_TIMEOUT_MS),
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5", "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" },
      redirect: "follow",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 404 || res.status === 410) return "gone";
      return "blocked";
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      return "unsupported";
    }
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let html = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      html += decoder.decode(value, { stream: true });
      size += value.length;
      if (size >= MAX_BYTES) break;
    }
    await reader.cancel().catch(() => {});
    html += decoder.decode();
    return /text\/plain/i.test(type) ? html : htmlToText(html);
  } catch {
    return null;
  }
};

/** Gemener, inga diakriter, bara bokstäver/siffror och mellanslag — så "NORRNÄS" möter "norrnas". */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // "85 %" och "85%" är samma procentsats; "35 kg/m³" ska inte tappa talet.
    .replace(/(\d)\s*%/g, "$1%")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

function num(n: number): string[] {
  const forms = new Set<string>();
  const add = (v: number) => {
    const r1 = Math.round(v * 10) / 10;
    forms.add(String(r1).replace(".", ","));
    forms.add(String(r1));
    if (Number.isInteger(r1)) forms.add(`${r1},0`), forms.add(`${r1}.0`);
    else forms.add(String(Math.round(r1)));
  };
  add(n);
  return [...forms];
}

/** Talet som det kan stå på sidan: 42 cm, 42,0 cm, 420 mm, 0,42 m, 16.5 in. */
export function dimensionNeedles(d: ResearchDimension): RegExp[] {
  const out: RegExp[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unitRe = (units: string) => `\\s*(?:${units})(?![a-z])`;
  const pushForms = (values: number[], units: string) => {
    for (const v of values) for (const f of num(v)) out.push(new RegExp(`(?<![\\d,.])${esc(f)}${unitRe(units)}`, "i"));
  };
  if (d.unit === "kg") {
    pushForms([d.value], "kg|kilo");
    pushForms([d.value * 1000], "g|gram");
  } else {
    pushForms([d.value], "cm|centimeter");
    pushForms([d.value * 10], "mm|millimeter");
    pushForms([d.value / 100], "m|meter");
    pushForms([d.value / 2.54], "in|inch|inches|\"|”|''");
  }
  // Citatet självt, när modellen gav ett: ett ordagrant utdrag ur sidan är den starkaste nålen.
  if (d.quote && d.quote.length >= 6) out.push(new RegExp(esc(foldText(d.quote)).replace(/\s+/g, "\\s+"), "i"));
  // Spann: "65-85 cm" eller "65–85 cm".
  if (d.valueMax !== null) out.push(new RegExp(`${esc(num(d.value)[0])}\\s*[–-]\\s*${esc(num(d.valueMax)[0])}${unitRe("cm|mm|m")}`, "i"));
  return out;
}

/** Materialets bärande ord: "Massiv björk" → ["massiv","bjork"]; "85 % polyester" → ["85 %","polyester"]. */
export function materialNeedles(m: ResearchMaterial): string[] {
  // Två bokstäver räcker: "ek" är ett träslag, och utan det hade "massiv ek" bekräftats av vilken
  // massiv björk som helst.
  const words = foldText(m.material)
    .split(" ")
    .filter((w) => w.length >= 2 && !/^(och|eller|med|and|or|with|samt|av|of|the|in|i|m|m2|m3)$/.test(w));
  const quote = m.quote && m.quote.length >= 6 ? [foldText(m.quote)] : [];
  return [...quote, ...words.slice(0, 4)];
}

function modelOnPage(page: string, model: string, brand: string | null): boolean {
  const m = foldText(model).split(" ").filter((w) => w.length >= 2);
  if (m.length === 0) return true;
  // Hela namnet, eller — för långa namn ("Söderhamn 3-sits") — det bärande första ordet.
  if (page.includes(m.join(" "))) return true;
  if (m[0].length >= 4 && page.includes(m[0])) return true;
  if (brand && page.includes(foldText(brand)) && m.some((w) => w.length >= 4 && page.includes(w))) return true;
  return false;
}

export interface VerifyInput {
  brand: string | null;
  model: string;
  /** Adresser anropet bevisligen besökte eller citerade (verktygens egna steg). */
  knownUrls: Set<string>;
  /**
   * Adresser modellen själv räknar upp som använda. Svagare än knownUrls: de räknas som "citerade" när
   * sidan inte går att läsa, men aldrig som bekräftade utan att vår egen hämtning funnit värdet.
   */
  claimedUrls?: Set<string>;
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  fetchPage?: PageFetcher;
  budgetMs?: number;
  enabled?: boolean;
}

export interface VerifyResult {
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  /** Påståenden vi inte kunde behålla alls: varken adress eller citat. Visas aldrig. */
  rejected: Array<{ what: string; why: string }>;
  /** Hur många sidor som hämtades och hur många som gick att läsa — för spåret. */
  pagesTried: number;
  pagesRead: number;
  /** Adresser som visade sig döda (404) eller vara bildfiler: länkas inte, men påståendet står kvar. */
  unlinkable: string[];
}

interface Judgement {
  level: VerificationLevel;
  /** Adressen får visas som länk. */
  link: boolean;
  /** Varför det blev som det blev — för loggen. */
  why: string;
}

/**
 * Hämtar varje unik källsida (högst PAGE_VERIFY_MAX_PAGES, inom en samlad budget) och sätter nivå
 * per påstående. Sidor hämtas parallellt; en sida som inte svarar i tid lämnar sina påståenden på
 * nivån "cited" om källan är känd.
 */
export async function verifyClaims(input: VerifyInput): Promise<VerifyResult> {
  const fetchPage = input.fetchPage ?? fetchPageText;
  const enabled = input.enabled ?? PAGE_VERIFY_ENABLED;
  const budgetMs = input.budgetMs ?? PAGE_VERIFY_BUDGET_MS;
  const rejected: VerifyResult["rejected"] = [];
  const claimed = input.claimedUrls ?? new Set<string>();
  const toolConfirmed = (url: string) => input.knownUrls.has(url);
  const known = (url: string) => toolConfirmed(url) || claimed.has(url);

  // Steg 1: bara det som saknar både adress och citat avvisas. Allt annat behålls och får en nivå.
  const hasBasis = (url: string | null, quote: string | null) => !!url || !!(quote && quote.trim().length >= 6);
  const dims = input.dimensions.filter((d) => {
    if (hasBasis(d.sourceUrl, d.quote)) return true;
    rejected.push({ what: `${d.label} ${d.display}`, why: "varken källa eller citat" });
    return false;
  });
  const mats = input.materials.filter((m) => {
    if (hasBasis(m.sourceUrl, m.quote)) return true;
    rejected.push({ what: `${m.component}: ${m.material}`, why: "varken källa eller citat" });
    return false;
  });

  // Steg 2: sidorna. Unika adresser; begagnatsajter och bildfiler hämtas aldrig av oss.
  const claimUrls = [...new Set([...dims, ...mats, ...input.facts].map((x) => x.sourceUrl).filter((u): u is string => !!u))];
  const toFetch = enabled ? claimUrls.filter((u) => !isMarketplace(u) && !isImageAssetUrl(u)).slice(0, PAGE_VERIFY_MAX_PAGES) : [];
  const pages = new Map<string, PageFetchResult>();
  for (const u of claimUrls) if (isMarketplace(u) || isImageAssetUrl(u)) pages.set(u, "unsupported");
  let pagesRead = 0;
  if (toFetch.length > 0) {
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.());
    await Promise.race([
      Promise.all(
        toFetch.map(async (url) => {
          const text = await fetchPage(url).catch(() => null);
          const isText = typeof text === "string" && text !== "unsupported" && text !== "blocked" && text !== "gone";
          pages.set(url, isText ? foldText(text) : text);
          if (isText) pagesRead++;
        }),
      ),
      deadline,
    ]);
  }

  const unlinkable = new Set<string>();

  /**
   * Nivån för ett påstående med adress `url` (eller bara ett citat, när adress saknas):
   *
   *   sidan läst, modellen nämnd, värdet funnet       → page_confirmed
   *   sidan läst, modellen nämnd, värdet inte funnet  → cited om källan är känd (JS-tabell, annan form)
   *   sidan läst, kort (ett skal)                     → cited om känd — saknad modell säger inget om ett skal
   *   sidan läst, lång, nämner inte modellen          → unverified och OLÄNKAD: det är en annan sida
   *   blockerad / dokument som inte tolkas            → cited om känd
   *   404 / 410                                       → unverified och OLÄNKAD (tool-besökt: cited)
   *   nätverksfel, tidsgräns, hann inte               → cited om verktyget besökte den, annars unverified
   *   bildfil                                         → unverified och OLÄNKAD
   *   ingen adress, bara citat                        → unverified
   * "Känd" = verktygen besökte den eller modellen listade den bland sina källor.
   */
  const judge = (url: string | null, test: (page: string) => boolean): Judgement => {
    if (!url) return { level: "unverified", link: false, why: "ingen adress, bara citat" };
    if (isImageAssetUrl(url)) return { level: "unverified", link: false, why: "adressen är en bildfil" };
    const byTool = toolConfirmed(url);
    const isKnown = known(url);
    if (!enabled) return { level: isKnown ? "cited" : "unverified", link: true, why: "verifiering av" };
    const page = pages.get(url);
    // `undefined` = hann inte hämtas inom budgeten: det säger inget om adressen, bara om tiden.
    if (page === undefined) return { level: isKnown ? "cited" : "unverified", link: true, why: "hann inte hämtas" };
    if (page === "unsupported" || page === "blocked") {
      return { level: isKnown ? "cited" : "unverified", link: true, why: page === "blocked" ? "sidan blockerar hämtning" : "dokument som inte tolkas" };
    }
    if (page === "gone") {
      return byTool ? { level: "cited", link: true, why: "404 nu, men verktyget besökte den" } : { level: "unverified", link: false, why: "adressen svarar 404" };
    }
    if (page === null) return { level: byTool ? "cited" : "unverified", link: true, why: "hämtningen föll" };
    if (!modelOnPage(page, input.model, input.brand)) {
      if (page.length < THIN_PAGE_CHARS) return { level: isKnown ? "cited" : "unverified", link: true, why: "sidan är ett skal utan innehåll" };
      return byTool
        ? { level: "cited", link: true, why: "modellen nämns inte, men verktyget besökte sidan" }
        : { level: "unverified", link: false, why: "sidan handlar inte om modellen" };
    }
    if (test(page)) return { level: "page_confirmed", link: true, why: "värdet funnet på sidan" };
    return { level: isKnown ? "cited" : "unverified", link: true, why: "modellen nämns men värdet hittades inte" };
  };

  const apply = <T extends { sourceUrl: string | null }>(claim: T, j: Judgement): T => {
    if (!j.link && claim.sourceUrl) {
      unlinkable.add(claim.sourceUrl);
      return { ...claim, sourceUrl: null };
    }
    return claim;
  };

  const dimensions: ResearchDimension[] = dims.map((d) => {
    const needles = dimensionNeedles(d);
    const j = judge(d.sourceUrl, (page) => needles.some((re) => re.test(page)));
    return apply({ ...d, verification: j.level, verified: j.level === "page_confirmed" }, j);
  });
  const materials: ResearchMaterial[] = mats.map((m) => {
    const needles = materialNeedles(m);
    const j = judge(m.sourceUrl, (page) => needles.length > 0 && needles.every((n) => page.includes(n)));
    return apply({ ...m, verification: j.level, verified: j.level === "page_confirmed" }, j);
  });
  const factsOut: ResearchFact[] = input.facts.map((f) => {
    if (!f.sourceUrl) return { ...f, verification: "unverified" as const };
    const needle = foldText(f.value).split(" ").filter((w) => w.length >= 3).slice(0, 3);
    const j = judge(f.sourceUrl, (page) => needle.length > 0 && needle.every((w) => page.includes(w)));
    return apply({ ...f, verification: j.level }, j);
  });

  return { dimensions, materials, facts: factsOut, rejected, pagesTried: toFetch.length, pagesRead, unlinkable: [...unlinkable] };
}

/** Modellnamn som nyckel för jämförelser — samma regel som slugKey, exporterad för pipeline-tester. */
export const modelKey = (s: string): string => slugKey(s);
