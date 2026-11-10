/**
 * REFERENSBILDER TILL MODELLKORTEN — kedjan A → C → B (SerpApi-flödet, 2026-11-09).
 *
 * Ett kort ska visa HUR MODELLEN SER UT, så att säljaren kan känna igen sin möbel. Färg och utförande spelar ingen roll (UI:t säger det); fel möbel, fel märke eller fel typ gör det. Därför är varje steg
 * byggt av två delar: något som FINNER kandidatbilder, och regler + ett jämförande AI-val som avgör om någon av dem duger. "Ingen bild" är ett godkänt svar: hellre en tom ruta än fel möbel.
 *
 *   A  Produktlänken AI-läget gav för modellen (gratis, ~2–6 s). Bara om länken är en RIKTIG produktsida för just modellen (inte startsida, kategori, kollektion, annons, prisjämförare). Sidans bilder
 *      (JSON-LD Product.image, og:image, twitter:image) hämtas, och ett jämförande AI-val tar den bästa.
 *   C  Googles bildsök via SerpApi ("märke modell typ produktbild framifrån"), bara för modeller A inte klarade (appen söker bara dem). Regler först (externalImages.pickReferenceRows: märket i titel/adress,
 *      ingen prisjämförare, inget andrahandsfoto), därefter samma jämförande val bland högst fem. Körs i identify.applyExternalImages.
 *   B  Gemini med Googles webbsök (~0,3 kr per modell: sökavgiften dominerar) SIST, bara för det som fortfarande saknar bild när appen skickat sin slutgiltiga lista. Tas bara emot om märket OCH modellen står
 *      i bildens eller sidans ADRESS (inte i brödtext: "sits" är också svenska för "seat"), och bilden klarar valet.
 *
 * MÄTT (2026-11-09, sparade sökningar, se docs/bildstrategi-2026-11-09.md): produktsidor ger katalogbild varje gång men ungefär hälften av AI-lägets länkar är inga produktsidor; Gemini + webbsök gav
 * en hämtbar bildlänk för 16 av 16 modeller men tre hade FEL MÄRKE (Jackie, Logan, Madison) och fångades av adressregeln; en fri bildanalys utan AI valde soffor, en kudde och en baksida, så AI behövs
 * för att se VAD som avbildas; det jämförande valet valde rent där en bra bild fanns bland kandidaterna men tog fel märke när urvalet var naivt (därav reglerna först).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { allowanceFor, withCostScope } from "./cost/jobCost.js";
import { callGeminiStructured } from "./gemini.js";
import { kandidatbilderDir, lokalKandidatbild } from "./kandidatbild.js";
import { motsagerTyp, motsagerUndertyp, typfamilj, type Typfamilj, type Undertyp } from "./candidateType.js";
import { runInteraction } from "./research/geminiInteractions.js";

const log = (...a: unknown[]) => console.log("[referens]", ...a);

/** Kedjan är PÅ som förval; LOOPA_REFERENCE_CHAIN=0 stänger av den (då gäller bara de gamla vägarna). */
export const referensKedjaPa = (): boolean => process.env.LOOPA_REFERENCE_CHAIN !== "0";

/** Det kedjan behöver veta om en kandidat. */
export interface RefKandidat {
  brand: string;
  model: string;
  productType: string | null;
  undertyp: Undertyp | null;
  sourceUrl?: string | null;
}

/** Ett val: den lokala miniatyren (`/api/kandidatbild/<sha1>.jpg`) och var den kom ifrån. */
export interface RefTraff {
  url: string;
  source: string;
  steg: "A" | "C" | "B";
}

const norm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const ord = (s: string): string => ` ${norm(s)} `;

const TYPORD: Record<Typfamilj, string> = { fatolj: "fåtölj", soffa: "soffa", stol: "stol", bord: "bord", sang: "säng" };
/** Typens svenska ord för frågorna: undertypen först ("barstol"), annars familjen. */
export function typOrd(c: { productType?: string | null; undertyp?: Undertyp | null }): string {
  if (c.undertyp === "barstol") return "barstol";
  const fam = typfamilj(c.productType);
  return fam ? TYPORD[fam] : "möbel";
}

// --- Utbytbara delar (tester kör utan nät och utan betalda anrop) --------------------------------------------------------------------------------------------------------------------------------

/** Så nås nätet för sidhämtningen. Ett eget objekt så att testerna kan byta ut det. */
export const nat: { fetch: typeof fetch } = { fetch: (...a) => globalThis.fetch(...a) };

export interface ValjKandidat {
  /** Den lokala miniatyren, `/api/kandidatbild/<sha1>.jpg`. */
  lokal: string;
  titel: string;
  kalla?: string;
}
/** Ger indexet (0-baserat) på den bästa bilden, eller null när ingen duger. */
export type Bildvaljare = (ctx: { brand: string; model: string; ord: string }, kandidater: ValjKandidat[]) => Promise<number | null>;

export interface SokSvar {
  /** Upp till tre alternativ från olika sajter, bästa först (ett skarpt test 2026-11-09: det enda förslaget för Brandon gick inte att hämta, och då hade B inget kvar). */
  alternativ?: Array<{ image_url?: string; page_url?: string }>;
  /** Äldre formen, ETT förslag. Tas emot som ett alternativ. */
  image_url?: string;
  page_url?: string;
}
export type Sokare = (c: RefKandidat, jobId: string, maxSok: number) => Promise<SokSvar | null>;

// --- Det jämförande valet ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * ETT anrop med alla kandidater (mätt 2026-11-09: ~1 500 tokens, ≈0,02 kr per modell) i stället för en ja/nej-fråga per bild (24 anrop vid fyra förslag). Ett jämförande val är stabilare än absoluta
 * omdömen: det väljer den rena framifrån-bilden där en sådan finns, och svarar 0 när ingen duger. Det kan INTE avgöra märket ur pixlarna (det litar på prompten) — märket är reglernas jobb, före valet.
 */
const standardVaeljare: Bildvaljare = async (ctx, kandidater) => {
  if (!process.env.GEMINI_API_KEY || kandidater.length === 0) return null;
  const bilder = await Promise.all(kandidater.map((k) => readFile(path.join(kandidatbilderDir(), path.basename(k.lokal)))));
  const lista = kandidater.map((k, i) => `Bild ${i + 1}: "${k.titel.slice(0, 90)}"${k.kalla ? ` (sajt: ${k.kalla})` : ""}`).join("\n");
  const anrop = () =>
    callGeminiStructured<{ val: number; skal: string }>({
      purpose: "referensbild_valj",
      systemPrompt:
        `Du väljer referensbilden till ett modellkort i en app där en säljare ska känna igen sin möbel. Möbeln är ${ctx.brand} ${ctx.model}, en ${ctx.ord}. Bilderna är numrerade i samma ordning som listan. ` +
        `Välj den bild som BÄST visar just den möbeln: (1) en ${ctx.ord} (inte en soffa, ett bord, ett tillbehör som en kudde eller klädsel, eller en detalj), av märket ${ctx.brand} och modellen ${ctx.model} — titeln och sajten är ledtrådar, ` +
        `ett annat märkes namn i titeln betyder fel bild; (2) HELA möbeln syns, helst framifrån eller snett framifrån mot ren eller neutral bakgrund, skarp och tydlig; ` +
        `(3) inte en närbild, en miljöbild där möbeln är liten, en ritning, en begagnatannons eller en bild med flera olika möbler. Färg, tyg och utförande spelar INGEN roll. Svara 0 om ingen bild duger.`,
      userPrompt: `${lista}\nVilken bild är bäst? Svara med bildens nummer, eller 0.`,
      images: bilder.map((b) => ({ mimeType: "image/jpeg", base64: b.toString("base64") })),
      responseSchema: { type: "OBJECT", properties: { val: { type: "INTEGER" }, skal: { type: "STRING" } }, required: ["val", "skal"] },
      resolution: "low",
      thinkingLevel: "minimal",
      primaryTimeoutMs: 30_000,
      fallbackTimeoutMs: 20_000,
    });
  let svar;
  try {
    svar = await anrop();
  } catch {
    // Ett tillfälligt fel är inget "ingen duger": ett omförsök, sedan nej.
    await new Promise((r) => setTimeout(r, 800));
    try {
      svar = await anrop();
    } catch (err) {
      log(`valet föll för ${ctx.model}: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      return null;
    }
  }
  const v = svar.data;
  log(`${ctx.model}: valet av ${kandidater.length} bilder -> ${v.val >= 1 && v.val <= kandidater.length ? `bild ${v.val}` : "ingen"} (${String(v.skal ?? "").slice(0, 110)})`);
  return v.val >= 1 && v.val <= kandidater.length ? v.val - 1 : null;
};

let bildvaljare: Bildvaljare = standardVaeljare;
/** För tester: ett eget val i stället för ett betalt anrop. `null` återställer. */
export function settBildvaljare(fn: Bildvaljare | null): void {
  bildvaljare = fn ?? standardVaeljare;
}

/** Laddar ner kandidaterna (parallellt), låter valet avgöra och ger den lokala adressen på vinnaren, eller null. */
export async function valjBland(
  ctx: { brand: string; model: string; ord: string },
  kallor: Array<{ src: string; titel: string; kalla?: string; referer?: string | null }>,
): Promise<{ lokal: string; index: number } | null> {
  const lokala = await Promise.all(kallor.map((k) => lokalKandidatbild(k.src, k.referer ?? null).catch(() => null)));
  const pool: Array<{ lokal: string; index: number; v: ValjKandidat }> = [];
  lokala.forEach((l, i) => {
    if (l && !pool.some((p) => p.lokal === l)) pool.push({ lokal: l, index: i, v: { lokal: l, titel: kallor[i].titel, kalla: kallor[i].kalla } });
  });
  log(`${ctx.model}: ${kallor.length} kandidater, ${pool.length} gick att hämta${pool.length < kallor.length ? ` (föll: ${kallor.filter((_, i) => !lokala[i]).map((k) => k.src.slice(0, 60)).join(", ")})` : ""}`);
  if (pool.length === 0) return null;
  const val = await bildvaljare(ctx, pool.map((p) => p.v));
  return val === null ? null : { lokal: pool[val].lokal, index: pool[val].index };
}

// --- A: produktsidan ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const PRISJAMFORARE = /\b(pricerunner|prisjakt|kelkoo|shopzilla|idealo|pricespy|jamforpris|compare)\b/;
const MARKNAD = /\b(tradera|blocket|facebook|ebay|vinted|olx|gumtree|craigslist|sellpy|auctionet|bukowskis|marketplace)\b/;
const EJ_SIDA = /\b(google|youtube|pinterest|instagram|issuu|wikipedia|reddit)\b/;
const KATEGORI = /(^|\/)(cat|category|categories|kategori|kategorier|collection|collections|kollektion|series|serie|search|sok)(\/|$)/;
/** Tillbehör till möbeln (klädsel, kudde, ben) är inte möbeln: en sida om dem ger fel bild. */
const TILLBEHOR = /\b(kladsel|overdrag|slipcover|cover|cushion|kudde|tillbehor|accessories|accessory|reservdel|spare)\b/;

/**
 * Är länken en PRODUKTSIDA för just den här modellen? Mätt på 48 sparade länkar: produktsidor ger katalogbild varje gång, startsidor (sits.eu/), kategorisidor (ikea.com/…/cat/…), kollektionssidor,
 * annonser och prisjämförare ger fel eller ingen bild. Modellens namn ska stå i adressens sökväg, och sökvägen får inte peka på en annan typ (…/soffor/impulse-soffa för en fåtölj).
 */
export function arProduktsida(url: string, c: Pick<RefKandidat, "model" | "productType" | "undertyp">): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = norm(u.hostname.replace(/^www\./i, ""));
  if (PRISJAMFORARE.test(host) || MARKNAD.test(host) || EJ_SIDA.test(host)) return false;
  const p = u.pathname.toLowerCase();
  if (p.replace(/\//g, "") === "" || /\.(pdf|zip)$/.test(p) || KATEGORI.test(p)) return false;
  const pn = norm(p);
  if (!ord(pn).includes(ord(c.model))) return false;
  if (TILLBEHOR.test(pn)) return false;
  const fam = typfamilj(c.productType);
  if (fam && motsagerTyp(p, fam)) return false;
  if (c.undertyp && motsagerUndertyp(p, c.undertyp)) return false;
  return true;
}

export interface SidaInnehall {
  slutUrl: string;
  titlar: string[];
  jsonldMarke: string | null;
  bilder: string[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BILD_BORT = /(logo|favicon|sprite|placeholder|spinner|pixel|banner|\.svg(\?|$))/i;
const absUrl = (u: string, bas: string): string => {
  try {
    return new URL(u.replace(/&amp;/g, "&"), bas).href;
  } catch {
    return "";
  }
};
const text = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();

/** Titlar, märke ur JSON-LD och bildkandidater (JSON-LD Product.image först, sedan og:image och twitter:image). Ren funktion, testas mot exempel-HTML. */
export function lasSida(html: string, slutUrl: string): SidaInnehall {
  const bilder: string[] = [];
  let jsonldMarke: string | null = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        if (o.image) for (const i of ([] as unknown[]).concat(o.image)) {
          const u = typeof i === "string" ? i : (i as { url?: string } | null)?.url;
          if (u) bilder.push(absUrl(u, slutUrl));
        }
        const br = o.brand;
        if (!jsonldMarke && br) jsonldMarke = typeof br === "string" ? br : ((br as { name?: string }).name ?? null);
        for (const k of Object.keys(o)) if (typeof o[k] === "object") walk(o[k]);
      };
      walk(JSON.parse(m[1]));
    } catch {
      /* ogiltig JSON-LD */
    }
  }
  for (const re of [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
  ])
    for (const m of html.matchAll(re)) bilder.push(absUrl(m[1], slutUrl));
  const titlar: string[] = [];
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) titlar.push(text(t[1]));
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (og) titlar.push(text(og[1]));
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) titlar.push(text(h1[1]));
  return { slutUrl, titlar, jsonldMarke, bilder: [...new Set(bilder.filter((u) => /^https?:/.test(u) && !BILD_BORT.test(u)))].slice(0, 6) };
}

/** Står märket OCH modellen i sidans adress, titel eller märkesfält? Brödtexten räknas aldrig ("sits" är också svenska för "seat"). */
export function sidanArModellen(c: Pick<RefKandidat, "brand" | "model">, s: Pick<SidaInnehall, "slutUrl" | "titlar" | "jsonldMarke">): boolean {
  const u = ord(s.slutUrl);
  const t = ord(s.titlar.join(" | "));
  const b = norm(c.brand);
  const modellOk = u.includes(ord(c.model)) || t.includes(ord(c.model));
  const markeOk = !b || u.includes(` ${b} `) || t.includes(` ${b} `) || (!!s.jsonldMarke && norm(s.jsonldMarke).includes(b));
  return modellOk && markeOk;
}

/** Hämtar och läser en sida (8 s tak, högst 2,5 MB). Null när den inte går att få eller inte är HTML (403, 404, JavaScript-ritad utan taggar ger få bilder men inte null). */
async function hamtaSida(url: string): Promise<SidaInnehall | null> {
  try {
    // 15 s: en IKEA-produktsida är 1,1 MB och tog 2,5–7,6 s att hämta (mätt 2026-11-09; en gräns på 8 s föll i det skarpa testet).
    const r = await nat.fetch(url, { headers: { "user-agent": UA, "accept-language": "sv-SE,sv;q=0.9,en;q=0.8", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) return null;
    return lasSida((await r.text()).slice(0, 2_500_000), r.url || url);
  } catch {
    return null;
  }
}
let sidhamtare: (url: string) => Promise<SidaInnehall | null> = hamtaSida;
/** För tester. `null` återställer. */
export function settSidhamtare(fn: ((url: string) => Promise<SidaInnehall | null>) | null): void {
  sidhamtare = fn ?? hamtaSida;
}

/** Steg A för EN kandidat. Null = gå vidare till nästa steg. */
export async function losFranProduktlank(c: RefKandidat, jobId: string): Promise<RefTraff | null> {
  const lank = c.sourceUrl?.trim();
  const id = jobId.slice(0, 8);
  if (!lank) {
    log(`${id} ${c.model}: A hoppas över — ingen länk`);
    return null;
  }
  if (!arProduktsida(lank, c)) {
    log(`${id} ${c.model}: A hoppas över — ${lank.slice(0, 70)} är ingen produktsida för modellen`);
    return null;
  }
  const sida = await sidhamtare(lank);
  if (!sida) {
    log(`${id} ${c.model}: A föll — sidan gick inte att hämta (${lank.slice(0, 60)})`);
    return null;
  }
  // En omdirigering kan ha lett till en startsida eller kategori.
  if (!arProduktsida(sida.slutUrl, c) || !sidanArModellen(c, sida)) {
    log(`${id} ${c.model}: A avvisad — sidan visar inte tydligt ${c.brand} ${c.model} (${sida.slutUrl.slice(0, 70)})`);
    return null;
  }
  if (sida.bilder.length === 0) {
    log(`${id} ${c.model}: A föll — inga bilder på sidan`);
    return null;
  }
  const titel = sida.titlar[0] || sida.slutUrl;
  const vinnare = await valjBland(
    { brand: c.brand, model: c.model, ord: typOrd(c) },
    sida.bilder.slice(0, 5).map((src) => ({ src, titel, kalla: new URL(sida.slutUrl).hostname.replace(/^www\./, ""), referer: sida.slutUrl })),
  );
  if (!vinnare) {
    log(`${id} ${c.model}: A föll — ingen av sidans bilder dög`);
    return null;
  }
  log(`${id} ${c.model}: A klar — ${sida.slutUrl.slice(0, 80)}`);
  return { url: vinnare.lokal, source: sida.slutUrl, steg: "A" };
}

/** Steg A för alla kandidater parallellt, med ett tak för hela steget: de som inte hunnit är inte klara, och nästa steg tar dem. */
export async function losProduktsidor(jobId: string, kandidater: RefKandidat[], budgetMs = 20_000): Promise<Map<string, RefTraff>> {
  const ut = new Map<string, RefTraff>();
  await Promise.all(
    kandidater.map(async (c) => {
      const tak = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
      const t = await Promise.race([losFranProduktlank(c, jobId).catch((err) => (log(`A föll för ${c.model}: ${err instanceof Error ? err.message.slice(0, 80) : err}`), null)), tak]);
      if (t) ut.set(c.model, t);
    }),
  );
  return ut;
}

// --- B: Gemini med webbsök -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Står både märket och modellen i adresserna? Fångade Jackie (NC Nordic Care), Logan (en klädsel hos en annan tillverkare) och Madison (Swedese) i mätningen, och släppte igenom de tio rätta. */
export function belaggIAdress(c: Pick<RefKandidat, "brand" | "model">, adresser: Array<string | undefined>): boolean {
  const u = ord(adresser.filter(Boolean).join(" "));
  const b = norm(c.brand);
  return u.includes(ord(c.model)) && (!b || u.includes(` ${b} `));
}

const standardSokare: Sokare = async (c, jobId, maxSok) => {
  const o = typOrd(c);
  const ut = await withCostScope({ jobId, stage: "identify" }, () =>
    runInteraction({
      purpose: "referensbild_sok",
      label: c.model,
      systemInstruction: "Du hittar officiella produktbilder på webben åt en möbelapp.",
      prompt:
        `Hitta officiella produktbilder på ${c.brand} ${c.model} (${o}) — märkets egen sajt eller återförsäljare. Bilden ska visa HELA möbeln framifrån eller snett framifrån, helst mot ren bakgrund. ` +
        `Gör högst två sökningar. Svara ENDAST med JSON {"alternativ": [{"image_url": "<direkt länk till bildfilen>", "page_url": "<sidan bilden sitter på>"}]} med UPP TILL TRE alternativ från olika sajter, bästa först. ` +
        `Använd bara bildlänkar du faktiskt sett i sökresultaten; hittar du inga, svara med en tom lista.`,
      images: [],
      schema: {
        type: "object",
        properties: { alternativ: { type: "array", items: { type: "object", properties: { image_url: { type: "string" }, page_url: { type: "string" } }, required: ["image_url", "page_url"] } } },
        required: ["alternativ"],
      },
      thinkingLevel: "low",
      timeoutMs: 45_000,
      tools: ["google_search"],
      maxSearchQueries: maxSok,
      maxOutputTokens: 4000,
    }),
  );
  return (ut.json ?? null) as SokSvar | null;
};
let sokare: Sokare = standardSokare;
/** För tester: ett eget sökanrop i stället för ett betalt. `null` återställer. */
export function settSokare(fn: Sokare | null): void {
  sokare = fn ?? standardSokare;
}

/** Högst så många sökfrågor per modell; modellen följer "högst två" i prompten och det här är nätet under (mätt: median 2, som mest 5). */
const MAX_SOK = (): number => Math.max(1, Number(process.env.LOOPA_REFERENS_MAX_SOK ?? 3) || 3);

/** Steg B för EN kandidat. */
export async function losFranSokning(c: RefKandidat, jobId: string): Promise<RefTraff | null> {
  const id = jobId.slice(0, 8);
  let tillat = MAX_SOK();
  try {
    const al = await allowanceFor(jobId, "identify");
    if (al.searchQueries < 1) {
      log(`${id} ${c.model}: B hoppas över — jobbets sökbudget är slut`);
      return null;
    }
    tillat = Math.min(tillat, al.searchQueries);
  } catch {
    /* utan kostnadsbok körs B med taket ovan */
  }
  let svar: SokSvar | null = null;
  try {
    svar = await sokare(c, jobId, tillat);
  } catch (err) {
    log(`${id} ${c.model}: B föll — ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    return null;
  }
  // Upp till tre alternativ (eller den äldre formen med ett). Varje alternativ ska ha märket OCH modellen i sina adresser; de som har det hämtas och det jämförande valet tar den bästa.
  const alla = (svar?.alternativ?.length ? svar.alternativ : svar?.image_url ? [{ image_url: svar.image_url, page_url: svar.page_url }] : [])
    .map((a) => ({ img: a.image_url?.trim() ?? "", sida: a.page_url?.trim() ?? "" }))
    .filter((a) => /^https?:\/\//i.test(a.img))
    .slice(0, 3);
  if (alla.length === 0) {
    log(`${id} ${c.model}: B gav ingen bildlänk`);
    return null;
  }
  const giltiga = alla.filter((a) => belaggIAdress(c, [a.img, a.sida]));
  for (const a of alla) if (!giltiga.includes(a)) log(`${id} ${c.model}: B-alternativ avvisat — märket och modellen står inte i adressen (${a.img.slice(0, 80)})`);
  if (giltiga.length === 0) return null;
  const vinnare = await valjBland(
    { brand: c.brand, model: c.model, ord: typOrd(c) },
    giltiga.map((a) => ({ src: a.img, titel: a.sida || a.img, kalla: (() => { try { return new URL(a.img).hostname.replace(/^www\./, ""); } catch { return undefined; } })(), referer: a.sida || null })),
  );
  if (!vinnare) {
    log(`${id} ${c.model}: B avvisad — ingen av ${giltiga.length} bilder gick att hämta eller dög`);
    return null;
  }
  const v = giltiga[vinnare.index];
  log(`${id} ${c.model}: B klar — ${v.img.slice(0, 80)}`);
  return { url: vinnare.lokal, source: v.sida || v.img, steg: "B" };
}

/** Steg B för flera kandidater parallellt, med ett tak för hela steget. */
export async function losFranSokningar(jobId: string, kandidater: RefKandidat[], budgetMs = 50_000): Promise<Map<string, RefTraff>> {
  const ut = new Map<string, RefTraff>();
  await Promise.all(
    kandidater.map(async (c) => {
      const tak = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
      const t = await Promise.race([losFranSokning(c, jobId).catch((err) => (log(`B föll för ${c.model}: ${err instanceof Error ? err.message.slice(0, 80) : err}`), null)), tak]);
      if (t) ut.set(c.model, t);
    }),
  );
  return ut;
}
