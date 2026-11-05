/**
 * Hur annonsen går på Tradera och Blocket, för säljaren — allt marknadsplatserna själva visar säljaren.
 *
 * KÄLLORNA, UPPMÄTTA 2026-10-29:
 *
 *   Tradera   Säljarsidornas lista (tradera/saljarsidor.ts): visningar, bevakare, bud, pris, sluttid
 *             och läge per annons — aktiva och avslutade. Inkorgen (tradera/inkorg.ts): köparnas
 *             konversationer om just den annonsen. Tradera själv sparar ingen historik vi kan läsa,
 *             så vi sparar en punkt per dag och räknar visningar per dag ur dem.
 *
 *   Blocket   Statistiksidan per annons (blocket/statistik.ts): klick, kontakter, favoriter, besökare
 *             och hur ofta de kommer tillbaka, bevakningsmejl, pushnotiser, klick från synlighet — och
 *             Blockets EGEN historik dag för dag sedan annonsen lades upp. Dagar kvar ur /my-items.
 *
 * Allt läses av robotar i en webbläsare, i ett SVEP var tredje timme (KANAL_STATISTIK_TIMMAR). Säljaren
 * ser senaste avläsningen med tidpunkten; ingenting läses när vyn öppnas. En annons som inte gick att
 * läsa behåller sina förra siffror — de nollas aldrig.
 *
 * Varje annons räknas: den aktuella OCH de som fått ligga kvar efter en omläggning för att en köpare
 * skrivit (`kvarlamnadeAnnonser`) — köparnas intresse för möbeln sitter i dem också.
 *
 * Siffrorna sparas i data/kanalstatistik/<jobId>.json och INTE på jobbet: svepet skriver medan
 * prisstegen, publiceringen och redigeringen skriver jobbet, och två skrivare på samma fil tappar
 * varandras ändringar.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, listJobs } from "./jobStore.js";
import type { ConditionJob } from "./types.js";
import type { TraderaWebAnnons } from "./integrations/tradera/saljarsidor.js";
import type { BlocketAnnonsStatistik } from "./integrations/blocket/statistik.js";

export interface TraderaAnnonsSiffror extends Omit<TraderaWebAnnons, "ownReference"> {
  /** Den annons som gäller nu, och inte en som ligger kvar efter en omläggning. */
  aktuell: boolean;
  /** Köparkonversationer i inkorgen om annonsen. Null = inkorgen gick inte att läsa. */
  konversationer: number | null;
}

export interface BlocketAnnonsSiffror extends BlocketAnnonsStatistik {
  adId: string;
  aktuell: boolean;
  url: string | null;
  dagarKvar: number | null;
}

export interface TraderaSumma {
  visningar: number;
  bevakare: number;
  bud: number;
}

type Punkt<T> = T & { at: string };

export interface KanalStatistik {
  tradera: {
    at: string;
    annonser: TraderaAnnonsSiffror[];
    /** En punkt per dag i svensk tid, dagens senaste avläsning. Äldst först, högst 90. */
    historik: Array<Punkt<TraderaSumma>>;
  } | null;
  blocket: {
    at: string;
    annonser: BlocketAnnonsSiffror[];
  } | null;
}

const MAX_DAGAR = 90;

// ---------------------------------------------------------------------------
// Lagret
// ---------------------------------------------------------------------------

function katalog(): string {
  return path.join(DATA_DIR, "kanalstatistik");
}

function fil(jobId: string): string {
  // Jobb-id:n är uuid:er; allt annat avvisas hellre än blir en sökväg.
  if (!/^[\w-]+$/.test(jobId)) throw new Error(`Ogiltigt jobb-id: ${jobId}`);
  return path.join(katalog(), `${jobId}.json`);
}

export function lasKanalStatistik(jobId: string): KanalStatistik {
  try {
    if (!existsSync(fil(jobId))) return { tradera: null, blocket: null };
    const s = JSON.parse(readFileSync(fil(jobId), "utf8")) as Partial<KanalStatistik>;
    // Filer från första versionen (en serie per kanal) har inga `annonser` och läses som tomma.
    return {
      tradera: Array.isArray(s.tradera?.annonser) ? s.tradera! : null,
      blocket: Array.isArray(s.blocket?.annonser) ? s.blocket! : null,
    };
  } catch {
    return { tradera: null, blocket: null };
  }
}

function skriv(jobId: string, s: KanalStatistik): void {
  mkdirSync(katalog(), { recursive: true });
  writeFileSync(fil(jobId), JSON.stringify(s, null, 2), "utf8");
}

function stockholmsDag(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

/** Lägger till dagens punkt, eller ersätter den om dagen redan har en. Ren. */
export function medDagspunkt<T>(historik: Array<Punkt<T>>, siffror: T, at: string, max = MAX_DAGAR): Array<Punkt<T>> {
  const ut = [...historik];
  const punkt = { ...siffror, at } as Punkt<T>;
  const sista = ut[ut.length - 1];
  if (sista && stockholmsDag(sista.at) === stockholmsDag(at)) ut[ut.length - 1] = punkt;
  else ut.push(punkt);
  return ut.slice(-max);
}

export function summaTradera(annonser: TraderaAnnonsSiffror[]): TraderaSumma {
  return annonser.reduce((s, a) => ({ visningar: s.visningar + a.visningar, bevakare: s.bevakare + a.bevakare, bud: s.bud + a.bud }), {
    visningar: 0,
    bevakare: 0,
    bud: 0,
  });
}

// ---------------------------------------------------------------------------
// Vilka annonser hör till jobbet
// ---------------------------------------------------------------------------

/** Jobbets Tradera-annonser: den aktuella först, sedan de kvarlämnade som inte tagits ner. */
export function traderaIdn(job: ConditionJob): Array<{ itemId: number; aktuell: boolean }> {
  const ut: Array<{ itemId: number; aktuell: boolean }> = [];
  if (job.tradera?.status === "published" && typeof job.tradera.itemId === "number") ut.push({ itemId: job.tradera.itemId, aktuell: true });
  for (const k of job.kvarlamnadeAnnonser ?? []) {
    if (k.kanal === "tradera" && typeof k.itemId === "number" && !k.nedtagenAt && !ut.some((u) => u.itemId === k.itemId)) {
      ut.push({ itemId: k.itemId, aktuell: false });
    }
  }
  return ut;
}

/** Blocket-annonsens id ur adressen ("…/26757853"). Samma regel som prisroboten (pris.ts). */
function blocketIdUrUrl(url: string | null | undefined): string | null {
  const m = String(url ?? "").match(/(?:adId=|\/)(\d{6,})(?:[/?#&]|$)/);
  return m ? m[1] : null;
}

/** Jobbets Blocket-annonser: den aktuella först, sedan de kvarlämnade som inte tagits ner. */
export function blocketIdn(job: ConditionJob): Array<{ adId: string; aktuell: boolean; url: string | null }> {
  const ut: Array<{ adId: string; aktuell: boolean; url: string | null }> = [];
  const nu = job.blocket?.status === "published" && !job.blocket.dryRun ? blocketIdUrUrl(job.blocket.url) : null;
  if (nu) ut.push({ adId: nu, aktuell: true, url: job.blocket!.url });
  for (const k of job.kvarlamnadeAnnonser ?? []) {
    const id = k.kanal === "blocket" && !k.nedtagenAt ? blocketIdUrUrl(k.url) : null;
    if (id && !ut.some((u) => u.adId === id)) ut.push({ adId: id, aktuell: false, url: k.url });
  }
  return ut;
}

// ---------------------------------------------------------------------------
// Tradera
// ---------------------------------------------------------------------------

/**
 * Fördelar Traderas lista på jobben och sparar. Ren nog att prövas: läsningarna kommer in som argument.
 * Ett jobb vars annonser inte står i listan rörs inte — förra avläsningen står kvar.
 */
export function bokforTradera(jobs: ConditionJob[], lista: TraderaWebAnnons[], tradar: string[] | null, at: string): number {
  const perId = new Map(lista.map((a) => [a.itemId, a]));
  let bokforda = 0;
  for (const job of jobs) {
    const idn = traderaIdn(job);
    const annonser: TraderaAnnonsSiffror[] = [];
    for (const { itemId, aktuell } of idn) {
      const a = perId.get(itemId);
      if (!a) continue;
      const { ownReference: _ref, ...resten } = a;
      annonser.push({ ...resten, aktuell, konversationer: tradar ? raknaTradar(tradar, itemId) : null });
    }
    if (annonser.length === 0) continue;
    const fore = lasKanalStatistik(job.id);
    // Inkorgen som inte gick att läsa i dag ska inte sudda gårdagens räkning.
    for (const a of annonser) {
      if (a.konversationer === null) a.konversationer = fore.tradera?.annonser.find((f) => f.itemId === a.itemId)?.konversationer ?? null;
    }
    skriv(job.id, {
      ...fore,
      tradera: { at, annonser, historik: medDagspunkt(fore.tradera?.historik ?? [], summaTradera(annonser), at) },
    });
    bokforda++;
  }
  return bokforda;
}

/** Köparnas trådar om annonsen. Kundtjänstens (xcs_) räknas inte. Samma regel som inkorg.ts. */
function raknaTradar(hrefs: string[], itemId: number): number {
  const ids = new Set<string>();
  for (const href of hrefs) {
    const m = href.match(/\/messaging\/threads\/([^/?#]+)/);
    if (m && !m[1].startsWith("xcs_") && m[1].endsWith(`_l${itemId}`)) ids.add(m[1]);
  }
  return ids.size;
}

export interface SvepUtfall {
  status: "klar" | "senare" | "av" | "fel";
  lasta: number;
  detalj: string;
}

export async function svepTradera(jobs: ConditionJob[]): Promise<SvepUtfall> {
  if (!jobs.some((j) => traderaIdn(j).length > 0)) return { status: "klar", lasta: 0, detalj: "Inga Tradera-annonser ute." };
  const { traderaInkorgKonfigurerad, lasTraderaInkorg } = await import("./integrations/tradera/inkorg.js");
  if (!traderaInkorgKonfigurerad()) return { status: "av", lasta: 0, detalj: "Ingen Tradera-session (npm run tradera:logga-in)." };
  const { lasTraderaSaljarAnnonser } = await import("./integrations/tradera/saljarsidor.js");
  try {
    const lista = await lasTraderaSaljarAnnonser();
    // Inkorgen är en egen sida och en egen webbläsare; faller den behålls visningarna ändå.
    const tradar = await lasTraderaInkorg().catch((err) => {
      console.warn(`[kanalstatistik] Tradera-inkorgen gick inte att läsa: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const lasta = bokforTradera(jobs, lista, tradar, new Date().toISOString());
    return { status: "klar", lasta, detalj: `${lista.length} annonser i Traderas lista, ${lasta} ${lasta === 1 ? "möbel" : "möbler"} bokförd${lasta === 1 ? "" : "a"}.` };
  } catch (err) {
    return { status: "fel", lasta: 0, detalj: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Blocket
// ---------------------------------------------------------------------------

/**
 * Läser statistiksidan för varje Blocket-annons, i EN webbläsare, en annons i taget.
 *
 * Delar Blocket-låset med publiceringen, redigeringen och vakten (vakt.ts `arUpptagen`): är någon
 * annan där svarar svepet "senare" och rör ingenting. Publiceringen väntar inte på låset — den går
 * först — så svepet frågar mellan varje annons om någon annan kört igång, och slutar då: det som hunnit
 * läsas sparas, resten läses nästa varv. Två Chromium på samma konto ska inte gå längre än en möbel.
 */
export async function svepBlocket(jobs: ConditionJob[]): Promise<SvepUtfall> {
  const { blocketConfigured } = await import("./integrations/blocket/blocket.js");
  if (!blocketConfigured()) return { status: "av", lasta: 0, detalj: "Ingen Blocket-session konfigurerad." };
  const arbete = jobs.map((job) => ({ job, idn: blocketIdn(job) })).filter((a) => a.idn.length > 0);
  if (arbete.length === 0) return { status: "klar", lasta: 0, detalj: "Inga Blocket-annonser ute." };

  const { andraKorningar, arUpptagen, markeraUpptagen } = await import("./integrations/blocket/vakt.js");
  if (arUpptagen()) return { status: "senare", lasta: 0, detalj: "En annan Blocket-körning pågår." };
  const { ensureSession, saveSessionIfReal, startBrowser } = await import("./integrations/blocket/browser.js");
  const { lasBlocketStatistik, lasDagarKvar } = await import("./integrations/blocket/statistik.js");

  markeraUpptagen(true);
  let session: Awaited<ReturnType<typeof startBrowser>> | null = null;
  let lasta = 0;
  const totalt = arbete.reduce((n, a) => n + a.idn.length, 0);
  try {
    session = await startBrowser();
    await ensureSession(session.page, () => {});
    const page = session.page;
    const dagarKvar = await lasDagarKvar(page).catch(() => new Map<string, number>());
    const at = new Date().toISOString();

    let avbrutet = false;
    for (const { job, idn } of arbete) {
      if (andraKorningar() > 0) {
        avbrutet = true;
        break;
      }
      const fore = lasKanalStatistik(job.id);
      const annonser: BlocketAnnonsSiffror[] = [];
      for (const { adId, aktuell, url } of idn) {
        const s = await lasBlocketStatistik(page, adId).catch((err) => {
          if (/gått ut/i.test(String(err))) throw err;
          return null;
        });
        if (s) {
          annonser.push({ ...s, adId, aktuell, url, dagarKvar: dagarKvar.get(adId) ?? null });
          lasta++;
        } else {
          console.warn(`[kanalstatistik] Blocket ${adId} (${job.id}): statistiksidan gick inte att tolka`);
          const gammal = fore.blocket?.annonser.find((a) => a.adId === adId);
          if (gammal) annonser.push(gammal);
        }
      }
      if (annonser.length > 0) skriv(job.id, { ...fore, blocket: { at, annonser } });
    }
    // Sessionen skrivs inte tillbaka om en publicering kört igång: den skriver sin egen, och två
    // skrivare på samma sessionsfil kan lämna den äldre kvar.
    if (avbrutet) return { status: "senare", lasta, detalj: `En publicering startade — ${lasta} av ${totalt} Blocket-annonser hann läsas.` };
    await saveSessionIfReal(session.context).catch(() => false);
    return { status: "klar", lasta, detalj: `${lasta} av ${totalt} Blocket-annonser lästa.` };
  } catch (err) {
    return { status: "fel", lasta, detalj: err instanceof Error ? err.message : String(err) };
  } finally {
    markeraUpptagen(false);
    await session?.browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Svaret till säljaren
// ---------------------------------------------------------------------------

export interface KanalStatistikSvar {
  tradera: (NonNullable<KanalStatistik["tradera"]> & { igar: TraderaSumma | null }) | null;
  blocket: NonNullable<KanalStatistik["blocket"]> | null;
}

/** Summan som den stod i slutet av gårdagen, eller senast dessförinnan. Null för en annons ny i dag. */
export function igar<T>(historik: Array<Punkt<T>>, nu: Date): Punkt<T> | null {
  const idag = stockholmsDag(nu.toISOString());
  const tidigare = historik.filter((p) => stockholmsDag(p.at) < idag);
  return tidigare[tidigare.length - 1] ?? null;
}

/** Det säljarens annonsvy visar: senaste avläsningen, ur lagret. Ingen webbläsare startas här. */
export function statistikFor(job: ConditionJob, nu = new Date()): KanalStatistikSvar {
  const s = lasKanalStatistik(job.id);
  return {
    tradera: s.tradera && traderaIdn(job).length > 0 ? { ...s.tradera, igar: igar(s.tradera.historik, nu) } : null,
    blocket: s.blocket && blocketIdn(job).length > 0 ? s.blocket : null,
  };
}

// ---------------------------------------------------------------------------
// Svepet i serverprocessen
// ---------------------------------------------------------------------------

export interface SenasteSvep {
  at: string;
  tradera: SvepUtfall;
  blocket: SvepUtfall;
}

function svepFil(): string {
  return path.join(DATA_DIR, "kanalstatistik-svep.json");
}

/** Hur senaste svepet gick. Läses av robotarnas hälsokontroll (robotHalsa.ts). */
export function lasSenasteSvep(): SenasteSvep | null {
  try {
    return existsSync(svepFil()) ? (JSON.parse(readFileSync(svepFil(), "utf8")) as SenasteSvep) : null;
  } catch {
    return null;
  }
}

/** Mellanrummet mellan svepen i timmar; 0 = av. */
export function svepTimmar(): number {
  const timmar = Number(process.env.KANAL_STATISTIK_TIMMAR ?? 3);
  return Number.isFinite(timmar) && timmar > 0 ? timmar : 0;
}

let pagar: Promise<{ tradera: SvepUtfall; blocket: SvepUtfall }> | null = null;

/** Ett varv över allt som ligger ute. Tradera först, sedan Blocket — aldrig två webbläsare samtidigt. */
export function svepAlla(): Promise<{ tradera: SvepUtfall; blocket: SvepUtfall }> {
  if (pagar) return pagar;
  pagar = (async () => {
    const jobs = await listJobs();
    const tradera = await svepTradera(jobs);
    const blocket = await svepBlocket(jobs);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(svepFil(), JSON.stringify({ at: new Date().toISOString(), tradera, blocket } satisfies SenasteSvep, null, 2), "utf8");
    return { tradera, blocket };
  })().finally(() => {
    pagar = null;
  });
  return pagar;
}

/**
 * Startar svepet. KANAL_STATISTIK_TIMMAR är mellanrummet, förval 3; 0 stänger av. Första varvet
 * tio minuter efter start — vakten, Facebook och hälsokontrollen har sina webbläsare tidigare.
 */
export function startKanalStatistik(): void {
  const timmar = svepTimmar();
  if (timmar === 0) {
    console.info("[kanalstatistik] avstängd (KANAL_STATISTIK_TIMMAR=0)");
    return;
  }
  const varv = async () => {
    try {
      const r = await svepAlla();
      console.info(`[kanalstatistik] Tradera ${r.tradera.status}: ${r.tradera.detalj} · Blocket ${r.blocket.status}: ${r.blocket.detalj}`);
    } catch (err) {
      console.warn(`[kanalstatistik] svepet föll: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(() => void varv(), 10 * 60_000).unref();
  setInterval(() => void varv(), timmar * 3_600_000).unref();
  console.info(`[kanalstatistik] läser Tradera och Blocket var ${timmar}:e timme`);
}
