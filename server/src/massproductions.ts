/**
 * Massproductions-erbjudandet: välj pengar eller credits när möbeln lämnas över.
 *
 * REGELN, i en mening: säljer man en möbel av märket Massproductions får man i slutet välja mellan
 * vanliga pengar (möbelpriset minus Loopas del, alltså 80 %) och credits till ett värde 10 % ÖVER
 * möbelpriset. 5 000 kr → antingen 4 000 kr eller 5 500 credits.
 *
 * BARA MÄRKET AVGÖR. Det är märket säljaren valde i början (job.identity.brand) — inte hur säljaren
 * kom hit, inte kampanjlänken. Alla andra märken går igenom flödet precis som förut, utan något val.
 *
 * VALET GÖRS EN GÅNG, när säljaren trycker "Sälj med Loopa" (server.ts, handlePublishTradera), och
 * står sedan på möbelns villkor (ConditionJob.saleTerms.ersattning) — låst, precis som
 * gratisförsäljningen.
 *
 * CREDITS RÄKNAS PÅ FÖRSÄLJNINGSPRISET. Prisstegen sänker annonsens pris varje vecka, så priset vid
 * överlämningen är inte priset möbeln säljs för. Vid överlämningen räknas ett preliminärt belopp; i
 * profilen följer det annonsens aktuella pris; och när möbeln säljs räknas det om på vad den faktiskt
 * såldes för (tillgodoVidForsaljning). En soffa utlagd för 5 000 kr som säljs för 4 000 kr ger alltså
 * 4 400 credits, inte 5 500.
 *
 * CREDITS BLIR SÄLJARENS FÖRST NÄR MÖBELN ÄR SÅLD. Valde säljaren credits skrivs en post vid
 * överlämningen, men den VÄNTAR — den syns i profilen och räknas inte i saldot. Först när möbeln
 * säljs (butik/store.ts, claimForSale — den enda vägen till "såld", vilken kanal det än är) blir
 * posten tillgodo och räknas. Returneras möbeln efteråt annulleras posten: köparen fick pengarna
 * tillbaka, och då finns det inget att få credits för.
 *
 * Talen finns också i web/src/lib/massproductions.ts, för klientens texter. Beloppen säljaren ser
 * räknas ändå alltid här och skickas med villkoren — klienten räknar aldrig själv.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_DIR, getJob } from "./jobStore.js";

/** Märkets namn, som det står i märkeslistan (web/src/lib/brands.ts). */
export const MASSPRODUCTIONS_NAMN = "Massproductions";

/** Credits-påslaget: 10 % över möbelpriset. */
export const CREDITS_PASLAG = 0.1;

export type ErsattningsTyp = "pengar" | "credits";

/**
 * Sant när märket är Massproductions. Förlåtande mot hur namnet skrivs — "Massproductions",
 * "Mass Productions", "massproduction", "Massproductions AB" — men inte mot ett annat märke.
 */
export function arMassproductions(brand: string | null | undefined): boolean {
  if (typeof brand !== "string") return false;
  const ren = brand.toLowerCase().replace(/[^a-z]/g, "").replace(/ab$/, "");
  return ren === "massproductions" || ren === "massproduction";
}

/** Credits för ett möbelpris: 10 % över, i hela credits. 5 000 kr → 5 500 credits. */
export function creditsFor(mobelprisSek: number): number {
  if (!Number.isFinite(mobelprisSek) || mobelprisSek < 0) throw new RangeError(`Ogiltigt möbelpris: ${mobelprisSek}`);
  return Math.round(Math.round(mobelprisSek) * (1 + CREDITS_PASLAG));
}

export function arErsattningsTyp(v: unknown): v is ErsattningsTyp {
  return v === "pengar" || v === "credits";
}

/** Utfallet "pengar" — samma form som provision.ts `Uppdelning`, så att klienten kan visa det som vanligt. */
interface PengarUtfall {
  mobelprisSek: number;
  andel: number;
  loopaSek: number;
  saljarenSek: number;
  tak: boolean;
}

export interface MassproductionsErbjudande {
  pengar: PengarUtfall;
  credits: number;
  paslag: number;
  valt: ErsattningsTyp | null;
}

type JobbFalt = {
  identity?: { brand: string | null } | null;
  saleTerms?: { ersattning?: { typ: ErsattningsTyp; credits: number | null; mobelprisSek: number; namn?: string | null } | null } | null;
};

/**
 * Erbjudandet som visas säljaren (server.ts, saljvillkor). Null för alla andra märken, och när
 * priset ännu inte är känt. `pengar` är det säljaren annars hade fått; credits räknas på samma
 * möbelpris. Är valet redan gjort står det låsta beloppet kvar, även om priset ändrats sedan.
 */
export function erbjudandeFor(job: JobbFalt, pengar: PengarUtfall | null): MassproductionsErbjudande | null {
  if (!arMassproductions(job.identity?.brand) || !pengar) return null;
  const las = job.saleTerms?.ersattning ?? null;
  return {
    pengar,
    credits: las?.credits ?? creditsFor(pengar.mobelprisSek),
    paslag: CREDITS_PASLAG,
    valt: las?.typ ?? null,
  };
}

/** Namnet säljaren skrev: trimmat, högst 80 tecken, och null när det är tomt. */
export function rensaNamn(namn: unknown): string | null {
  if (typeof namn !== "string") return null;
  const ren = namn.replace(/\s+/g, " ").trim().slice(0, 80);
  return ren.length >= 2 ? ren : null;
}

/**
 * Valet som skrivs på möbelns villkor när säljaren trycker "Sälj med Loopa" (server.ts,
 * handlePublishTradera).
 *
 *   - inte Massproductions → null, och ingenting krävs
 *   - Massproductions utan giltigt val → "saknas": trycket avvisas, möbeln läggs inte ut
 *   - credits utan namn → "saknar-namn": namnet är det Massproductions behöver när möbeln säljs
 *   - annars → valet, med credits räknade på möbelpriset när det är credits
 */
export function ersattningVidTryck(
  job: JobbFalt,
  val: unknown,
  mobelprisSek: number,
  namn: unknown = null,
): null | "saknas" | "saknar-namn" | { typ: ErsattningsTyp; credits: number | null; mobelprisSek: number; namn: string | null } {
  if (!arMassproductions(job.identity?.brand)) return null;
  if (!arErsattningsTyp(val)) return "saknas";
  if (val === "pengar") return { typ: val, credits: null, mobelprisSek: Math.round(mobelprisSek), namn: null };
  const rent = rensaNamn(namn);
  if (!rent) return "saknar-namn";
  return { typ: val, credits: creditsFor(mobelprisSek), mobelprisSek: Math.round(mobelprisSek), namn: rent };
}

// ---------------------------------------------------------------------------
// Saldot
// ---------------------------------------------------------------------------

/**
 * Postens läge. Går bara framåt:
 *
 *   vantar     → möbeln är överlämnad men inte såld. Räknas INTE i saldot.
 *   tillgodo   → möbeln är såld. Räknas i saldot.
 *   annullerad → möbeln returnerades efter försäljningen. Räknas inte.
 */
export type CreditStatus = "vantar" | "tillgodo" | "annullerad";

/** En post i en användares credits. En per möbel: samma möbel kan aldrig ge credits två gånger. */
export interface CreditPost {
  id: string;
  userId: string;
  jobId: string;
  /** Möbelns namn när den lämnades över, för profilen. */
  titel: string;
  /** Möbelpriset credits räknas på, utan frakt. Vid överlämningen preliminärt; vid försäljningen det faktiska. */
  mobelprisSek: number;
  credits: number;
  /** Beloppet som räknades vid överlämningen, innan försäljningspriset var känt. För historiken. */
  preliminaraCredits?: number;
  status: CreditStatus;
  /** När möbeln lämnades över och posten skrevs. */
  skapad: string;
  /** När möbeln såldes och credits blev tillgodo. */
  saldAt: string | null;
  annulleradAt: string | null;
}

export interface MinaCredits {
  /** Credits på kontot: bara de från sålda möbler. */
  saldo: number;
  /** Credits som blir säljarens när möblerna säljs. Ingår INTE i saldot. */
  vantar: number;
  poster: CreditPost[];
}

const FIL = () => path.join(process.env.CREDITS_DIR?.trim() || path.join(DATA_DIR, "credits"), "credits.json");

let cache: CreditPost[] | null = null;
let kedja: Promise<unknown> = Promise.resolve();

async function allaPoster(): Promise<CreditPost[]> {
  if (cache) return cache;
  try {
    const lista = JSON.parse(await readFile(FIL(), "utf-8")) as CreditPost[];
    cache = Array.isArray(lista)
      ? lista
          .filter((p) => p && typeof p.userId === "string" && Number.isFinite(p.credits))
          // Ett okänt läge räknas som väntande — aldrig som tillgodo. Hellre för lite än för mycket.
          .map((p) => (p.status === "vantar" || p.status === "tillgodo" || p.status === "annullerad" ? p : { ...p, status: "vantar" as const }))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function skriv(lista: CreditPost[]): Promise<void> {
  await mkdir(path.dirname(FIL()), { recursive: true });
  // Via en tillfällig fil: en krasch mitt i skrivningen får aldrig lämna ett halvt saldo efter sig.
  const tmp = `${FIL()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(lista, null, 2), "utf-8");
  await rename(tmp, FIL());
  cache = lista;
}

/**
 * Skriver in credits för en överlämnad möbel. Idempotent per möbel: finns posten redan returneras
 * den som den är — ett andra tryck, eller ett nytt tryck efter ett avslag i granskningen, ger aldrig
 * dubbla credits.
 */
export async function reserveraCredits(in_: { userId: string; jobId: string; titel: string; mobelprisSek: number }): Promise<CreditPost> {
  const jobb = kedja.then(async () => {
    const lista = await allaPoster();
    const fanns = lista.find((p) => p.jobId === in_.jobId);
    if (fanns) return fanns;
    const post: CreditPost = {
      id: randomUUID(),
      userId: in_.userId,
      jobId: in_.jobId,
      titel: in_.titel.trim().slice(0, 140) || "Möbel",
      mobelprisSek: Math.round(in_.mobelprisSek),
      credits: creditsFor(in_.mobelprisSek),
      status: "vantar",
      skapad: new Date().toISOString(),
      saldAt: null,
      annulleradAt: null,
    };
    await skriv([post, ...lista]);
    return post;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/** Flyttar en möbels post från ett läge till nästa. Null när det inte finns någon post i läget `fran`. */
async function flytta(jobId: string, fran: CreditStatus[], till: CreditStatus, falt: Partial<CreditPost>): Promise<CreditPost | null> {
  const jobb = kedja.then(async () => {
    const lista = await allaPoster();
    const i = lista.findIndex((p) => p.jobId === jobId);
    if (i < 0 || !fran.includes(lista[i].status)) return null;
    const ny: CreditPost = { ...lista[i], ...falt, status: till };
    await skriv(lista.map((p, j) => (j === i ? ny : p)));
    return ny;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/**
 * Möbeln är såld: säljarens credits räknas om på FÖRSÄLJNINGSPRISET och blir tillgodo. Anropas av
 * butik/store.ts, claimForSale, med priset möbeln faktiskt såldes för (utan frakt). Utan känt pris
 * står det preliminära beloppet kvar. Idempotent — en möbel utan väntande post (alla andra märken,
 * eller den som valde pengar) ger null.
 */
export async function tillgodoVidForsaljning(jobId: string, forsaljningsprisSek?: number | null): Promise<CreditPost | null> {
  const nu = new Date().toISOString();
  const pris = typeof forsaljningsprisSek === "number" && Number.isFinite(forsaljningsprisSek) && forsaljningsprisSek >= 0 ? Math.round(forsaljningsprisSek) : null;
  const jobb = kedja.then(async () => {
    const lista = await allaPoster();
    const i = lista.findIndex((p) => p.jobId === jobId);
    if (i < 0 || lista[i].status !== "vantar") return null;
    const fore = lista[i];
    const ny: CreditPost = {
      ...fore,
      status: "tillgodo",
      saldAt: nu,
      preliminaraCredits: fore.preliminaraCredits ?? fore.credits,
      ...(pris !== null ? { mobelprisSek: pris, credits: creditsFor(pris) } : {}),
    };
    await skriv(lista.map((p, j) => (j === i ? ny : p)));
    return ny;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/** Möbeln returnerades efter försäljningen: posten annulleras. Anropas av butik/store.ts, markReturned. */
export async function annulleraVidRetur(jobId: string): Promise<CreditPost | null> {
  return flytta(jobId, ["vantar", "tillgodo"], "annullerad", { annulleradAt: new Date().toISOString() });
}

/**
 * Annonsen togs bort: dess credits försvinner med den. Säljaren tar bort sin annons
 * (jobStore.markJobRemoved) eller admin raderar kontot (jobStore.raderaJobb) — en möbel som inte
 * längre är till salu kan aldrig bli såld, och då finns det inget att vänta på.
 *
 * En post som redan är TILLGODO står kvar: möbeln är såld och credits är säljarens. (En såld annons
 * går inte att ta bort — server.ts vägrar — så det händer bara när ett helt konto raderas, och då
 * skickar anroparen `ocksaTillgodo`.)
 */
export async function taBortVidBorttagenAnnons(jobId: string, opts: { ocksaTillgodo?: boolean } = {}): Promise<boolean> {
  const jobb = kedja.then(async () => {
    const lista = await allaPoster();
    const kvar = lista.filter((p) => p.jobId !== jobId || (p.status === "tillgodo" && !opts.ocksaTillgodo));
    if (kvar.length === lista.length) return false;
    await skriv(kvar);
    return true;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/** En användares credits: saldot (bara sålda möbler), det som väntar, och posterna nyast först. */
export async function minaCredits(userId: string): Promise<MinaCredits> {
  const egna = (await allaPoster()).filter((p) => p.userId === userId);
  /**
   * Väntande poster vars annons redan är borttagen visas inte — och städas bort. Det fångar annonser
   * som togs bort innan borttagningen rensade credits, och en borttagning där rensningen föll.
   */
  const synliga: CreditPost[] = [];
  for (const p of egna) {
    const job = p.status === "tillgodo" ? null : await getJob(p.jobId).catch(() => undefined);
    if (p.status !== "tillgodo" && job?.removedAt) {
      void taBortVidBorttagenAnnons(p.jobId).catch(() => undefined);
      continue;
    }
    // Väntande: följer annonsens aktuella pris, som prisstegen sänker. Bara i svaret — posten skrivs
    // om först vid försäljningen, på det faktiska priset.
    if (p.status === "vantar" && job) {
      const { priceOf } = await import("./butik/normalize.js");
      const aktuellt = priceOf(job);
      if (aktuellt !== null && aktuellt !== p.mobelprisSek) {
        synliga.push({ ...p, mobelprisSek: aktuellt, credits: creditsFor(aktuellt) });
        continue;
      }
    }
    synliga.push(p);
  }
  const poster = synliga.sort((a, b) => b.skapad.localeCompare(a.skapad));
  const summa = (status: CreditStatus) => poster.filter((p) => p.status === status).reduce((s, p) => s + p.credits, 0);
  return { saldo: summa("tillgodo"), vantar: summa("vantar"), poster };
}

/** Bara för tester. */
export function nollstall(): void {
  cache = null;
}
