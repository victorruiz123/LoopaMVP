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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { allowanceFor, withCostScope } from "./cost/jobCost.js";
import { callGeminiStructured } from "./gemini.js";
import { getJob, getJobSync, jobDir } from "./jobStore.js";
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
  /** Vad AI-läget skrev om just den här modellen (status, motivering). Bildvalet behöver det för att skilja två möbler som heter lika. Se beskrivningUr. */
  beskrivning?: string | null;
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
/**
 * Det bildvalet vet om möbeln. `beskrivning` är AI-lägets egna ord om just den här modellen och `jobId` pekar ut säljarens foto (omslaget): tillsammans är de det som skiljer en modern PREBEN
 * (stoppad sits, stålunderrede) från den äldre pinnstolen med samma namn (2026-11-12: den gamla pinnstolen valdes och sparades i registret).
 */
export interface ValjCtx {
  brand: string;
  model: string;
  ord: string;
  beskrivning?: string | null;
  jobId?: string | null;
}
/** Ger indexet (0-baserat) på den bästa bilden, eller null när ingen duger. */
export type Bildvaljare = (ctx: ValjCtx, kandidater: ValjKandidat[]) => Promise<number | null>;

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
 *
 * SAMMA NAMN, TVÅ MÖBLER (2026-11-12, IKEA PREBEN): en äldre pinnstol i trä och en nyare stoppad stol med stålunderrede heter lika, och Googles träffar domineras av den äldre. Bildvalet fick bara märke,
 * modell och typ, och instruktionen sa "utförande spelar ingen roll", så det valde pinnstolen. Nu får det AI-lägets beskrivning av modellen och säljarens eget foto (som facit för KONSTRUKTIONEN, inte
 * för färgen), och instruktionen kräver samma konstruktion. Kostnad: en bild och några rader till, ≈0,01 kr per modell.
 */
export function byggValjPrompt(ctx: ValjCtx, kandidater: ValjKandidat[], harFoto: boolean): { system: string; user: string } {
  const lista = kandidater.map((k, i) => `Bild ${i + 1}: "${k.titel.slice(0, 90)}"${k.kalla ? ` (sajt: ${k.kalla})` : ""}`).join("\n");
  const beskr = (ctx.beskrivning ?? "").trim();
  const facit = harFoto ? "säljarens foto" : beskr ? "beskrivningen" : "";
  const system =
    `Du väljer referensbilden till ett modellkort i en app där en säljare ska känna igen sin möbel. Möbeln är ${ctx.brand} ${ctx.model}, en ${ctx.ord}. ` +
    (beskr ? `Så här beskrivs just den modellen (ur en sökning på den): "${beskr}". ` : "") +
    (harFoto ? `Den FÖRSTA bilden är säljarens egen möbel och är inget val: den visar vilken konstruktion det är. Bilderna efter den är kandidaterna, numrerade Bild 1, Bild 2 … i listans ordning. ` : `Bilderna är numrerade i samma ordning som listan. `) +
    `SAMMA NAMN KAN HA ANVÄNTS PÅ TVÅ HELT OLIKA MÖBLER, en äldre och en nyare (till exempel en pinnstol i trä och en stoppad stol med metallunderrede). Välj den bild som visar SAMMA MÖBEL${facit ? ` som ${facit}` : ""}: ` +
    `(1) en ${ctx.ord} av märket ${ctx.brand} och modellen ${ctx.model} — titeln och sajten är ledtrådar, men ett annat märkes namn i titeln betyder fel bild; ` +
    `(2) samma KONSTRUKTION${facit ? ` som ${facit}` : ""}: klädd eller oklädd sits och rygg, material, ryggens form och benens eller underredets form. Färg och tyg spelar INGEN roll, men konstruktionen måste stämma: en trästol med spjälrygg är inte samma möbel som en stoppad stol, även om de heter lika; ` +
    `(3) HELA möbeln syns, helst framifrån eller snett framifrån mot ren eller neutral bakgrund, skarp och tydlig; inte en närbild, en miljöbild där möbeln är liten, en ritning eller en bild med flera olika möbler. ` +
    `Svara 0 om ingen bild visar samma konstruktion. Hellre ingen bild än fel möbel.`;
  return { system, user: `${lista}\nVilken bild är bäst? Svara med bildens nummer (Bild 1 = 1 …), eller 0.` };
}

const standardVaeljare: Bildvaljare = async (ctx, kandidater) => {
  if (!process.env.GEMINI_API_KEY || kandidater.length === 0) return null;
  const bilder = await Promise.all(kandidater.map((k) => readFile(path.join(kandidatbilderDir(), path.basename(k.lokal)))));
  const foto = ctx.jobId ? await saljarbild(ctx.jobId).catch(() => null) : null;
  const { system, user } = byggValjPrompt(ctx, kandidater, !!foto);
  const anrop = () =>
    callGeminiStructured<{ val: number; skal: string }>({
      purpose: "referensbild_valj",
      systemPrompt: system,
      userPrompt: user,
      // Säljarens foto FÖRST (facit för konstruktionen, aldrig ett val), därefter kandidaterna i listans ordning.
      images: [...(foto ? [foto] : []), ...bilder.map((b) => ({ mimeType: "image/jpeg", base64: b.toString("base64") }))],
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
  log(`${ctx.model}: valet av ${kandidater.length} bilder (${foto ? "med säljarens foto" : "utan säljarens foto"}, ${(ctx.beskrivning ?? "").trim() ? "med beskrivning" : "utan beskrivning"}) -> ${v.val >= 1 && v.val <= kandidater.length ? `bild ${v.val}` : "ingen"} (${String(v.skal ?? "").slice(0, 110)})`);
  return v.val >= 1 && v.val <= kandidater.length ? v.val - 1 : null;
};

// --- Säljarens foto, beskrivningen och registernyckeln ----------------------------------------------------------------------------------------------------------------------------------------------------------

const fotoCache = new Map<string, Promise<{ mimeType: string; base64: string } | null>>();

/** Säljarens omslagsbild (annars den skarpaste), nedskalad till ~640 px: bara facit för konstruktionen, så den behöver inte vara stor. Null när jobbet saknar bild. Cachas per jobb. */
export function saljarbild(jobId: string): Promise<{ mimeType: string; base64: string } | null> {
  let p = fotoCache.get(jobId);
  if (!p) {
    p = lasSaljarbild(jobId).catch(() => null);
    fotoCache.set(jobId, p);
    if (fotoCache.size > 30) fotoCache.delete(fotoCache.keys().next().value as string);
  }
  return p;
}

async function lasSaljarbild(jobId: string): Promise<{ mimeType: string; base64: string } | null> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  const bilder = job?.images ?? [];
  if (bilder.length === 0) return null;
  const abs = (p: string) => path.join(jobDir(jobId), p.startsWith("originals/") ? "" : "originals", p);
  const cover =
    bilder.find((i) => i.role === "cover") ??
    (await Promise.all(bilder.map(async (i) => ({ i, size: (await stat(abs(i.path)).catch(() => null))?.size ?? 0 })))).sort((x, y) => y.size - x.size)[0]?.i;
  if (!cover) return null;
  const liten = await sharp(await readFile(abs(cover.path)))
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
  return { mimeType: "image/jpeg", base64: liten.toString("base64") };
}

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * AI-lägets text om EN modell ur identifieringssvaret: avsnittet som börjar vid den numrerade rubriken som nämner modellen ("### 1. PREBEN …") och slutar vid nästa rubrik eller källistan.
 * `beskrivning` är texten utan länkrader, länkar och källhänvisningar (status, motivering), högst ~500 tecken. `generation` är det som skiljer två möbler med samma namn: artikelnumret
 * (602.013.31) om svaret anger ett, annars årtiondet ("2010" ur "såldes under 2010-talet"), annars tomt. Tomt ger samma registernyckel som förut.
 */
export function beskrivningUr(svar: string, model: string): { beskrivning: string; generation: string } {
  const tom = { beskrivning: "", generation: "" };
  if (!svar || !model.trim()) return tom;
  const rader = svar.replace(/\\([()[\]])/g, "$1").split("\n");
  const namn = new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(model.trim())}([^\\p{L}\\p{N}]|$)`, "iu");
  const rubrik = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:\d{1,2}\s*[.)]|förslag\s*\d{1,2}\b)/i;
  const slutPa = /^\s*(?:#{1,6}\s*)?(?:references|referenser|källor)\b|^===\s*FLER/i;
  let start = rader.findIndex((l) => rubrik.test(l) && namn.test(l));
  let slut = rader.length;
  if (start >= 0) {
    for (let i = start + 1; i < rader.length; i++) {
      if (rubrik.test(rader[i]) || slutPa.test(rader[i])) {
        slut = i;
        break;
      }
    }
  } else {
    start = rader.findIndex((l) => namn.test(l));
    if (start < 0) return tom;
    slut = Math.min(rader.length, start + 6);
  }
  const avsnitt = rader.slice(start, slut);
  const heltext = avsnitt.join("\n");
  const artikel = /\b\d{3}\.\d{3}\.\d{2}\b/.exec(heltext)?.[0];
  const artionde = /\b((?:19|20)\d0)\s*-?\s*tal(?:et)?\b/i.exec(heltext)?.[1];
  const generation = artikel ?? artionde ?? "";
  const beskrivning = avsnitt
    .filter((l) => !/^\s*[-*]?\s*(produktsida|länk|link)\b/i.test(l))
    .join(" ")
    .replace(/\[(?:\d+(?:\s*,\s*\d+)*)\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return { beskrivning, generation };
}

/**
 * Registrets nyckeldel för appens bilder: "g:" + undertyp eller typ, och därefter modellens GENERATION när svaret anger en (artikelnummer eller årtionde). Utan den delade två möbler med samma
 * namn en bild: den äldre PREBEN-pinnstolen sparades och återanvändes för den moderna stolen (2026-11-12). Saknar svaret både artikelnummer och årtionde blir nyckeln som förut.
 */
export function registerTyp(c: { undertyp?: Undertyp | null; productType?: string | null; model: string }, svar: string): string {
  const gen = beskrivningUr(svar, c.model).generation;
  return `g:${c.undertyp ?? typfamilj(c.productType ?? null) ?? ""}${gen ? `:${gen}` : ""}`;
}

/** Hur många bilder som går till det jämförande valet (efter att dubbletter tagits bort). Förut fem; rätt PREBEN-bild låg på plats nio. */
export const valMax = (): number => Number(process.env.LOOPA_REFERENS_VAL_MAX ?? 8) || 8;

/**
 * Tar bort dubbletter ur kandidatlistan (behåller den första, alltså den bäst rankade): samma sida (adressen utan sökfråga och fragment) MED samma titel, eller samma titel från samma sajt när sida saknas.
 * Googles träfflista har ofta samma bild flera gånger i olika storlek: samma Instagram-bild tog tre platser av fem (PREBEN, 2026-11-12). Två olika bilder från samma sida (olika titlar) behålls båda.
 * Ordningen bevaras.
 */
export function unikaKallor<T>(rader: T[], info: (r: T) => { sida?: string | null; titel?: string | null; kalla?: string | null }): T[] {
  const sedda = new Set<string>();
  return rader.filter((r) => {
    const { sida, titel, kalla } = info(r);
    let plats = `s|${norm(kalla ?? "")}`;
    if (sida) {
      try {
        const u = new URL(sida);
        plats = `u|${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
      } catch {
        /* ingen adress: sajten får vara platsen */
      }
    }
    const nyckel = `${plats}|${norm(titel ?? "")}`;
    if (sedda.has(nyckel)) return false;
    sedda.add(nyckel);
    return true;
  });
}

let bildvaljare: Bildvaljare = standardVaeljare;
/** För tester: ett eget val i stället för ett betalt anrop. `null` återställer. */
export function settBildvaljare(fn: Bildvaljare | null): void {
  bildvaljare = fn ?? standardVaeljare;
}

/** Laddar ner kandidaterna (parallellt), låter valet avgöra och ger den lokala adressen på vinnaren, eller null. */
export async function valjBland(
  ctx: ValjCtx,
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
    { brand: c.brand, model: c.model, ord: typOrd(c), beskrivning: c.beskrivning, jobId },
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
    { brand: c.brand, model: c.model, ord: typOrd(c), beskrivning: c.beskrivning, jobId },
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
