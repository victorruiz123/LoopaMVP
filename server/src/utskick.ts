/**
 * Utskicket: ett brev till många, skrivet i adminpanelen.
 *
 * VARFÖR DET LIGGER HÄR OCH INTE I ETT SKRIPT. Listorna gjordes länge som CSV-filer i projektmappen,
 * och varje utskick krävde att någon körde två kommandon i en terminal med personuppgifter i klartext
 * på skärmen. Filen blev dessutom liggande efteråt. Här finns namnen bara bakom inloggningen, och det
 * enda som sparas är VEM som fått vilket brev — det man måste kunna svara på, och inget mer.
 *
 * MOTTAGARNA KOMMER UR PROFILTABELLEN, samma tabell som adminpanelens användarlista läser (admin.ts).
 * Förnamnet är första ordet i `full_name`: ett brev som inleds "Hej Anna Svensson," läser som ett
 * massutskick, vilket det förvisso är, men då behöver det inte se ut så.
 *
 * SKICKET KÖR I BAKGRUNDEN med en paus mellan breven. Åttio brev tar över två minuter, och ett
 * HTTP-anrop som står och väntar så länge dör i någon proxy på vägen. Klienten startar körningen och
 * frågar sedan efter läget.
 *
 * VARJE SKICKAT BREV LOGGAS, en rad JSON per mottagare. Loggen är både kvittot och spärren: samma
 * adress får aldrig samma ämnesrad två gånger, hur många gånger någon än trycker på knappen.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_DIR } from "./jobStore.js";
import { supabaseUrl } from "./supabaseAuth.js";

export interface Mottagare {
  /** Adressen är nyckeln — profiler utan e-post kan inte få brev och finns inte här. */
  epost: string;
  fornamn: string;
  /** Hela namnet, för listan i panelen: två "Anna" ska gå att skilja åt. */
  namn: string | null;
  registrerad: string | null;
}

export interface UtskickLage {
  pagar: boolean;
  amne: string | null;
  totalt: number;
  skickade: number;
  fel: number;
  startad: string | null;
  klar: string | null;
  /** Adresser som föll, med serverns orsak. Namnges för att kunna skickas om för hand. */
  problem: Array<{ epost: string; orsak: string }>;
}

const LOGG_DIR = () => path.join(DATA_DIR, "utskick");
const LOGG_FIL = () => path.join(LOGG_DIR(), "logg.jsonl");

/** Paus mellan breven. one.com stryper den som öser iväg hundra brev på en minut. */
const PAUS_MS = Number(process.env.UTSKICK_PAUS_MS ?? 1500);
const MAX_MOTTAGARE = 500;
const MAX_AMNE = 200;
const MAX_BREV = 20_000;

let lage: UtskickLage = {
  pagar: false,
  amne: null,
  totalt: 0,
  skickade: 0,
  fel: 0,
  startad: null,
  klar: null,
  problem: [],
};

const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Första ordet i namnet. "Anna-Lena Svensson" → "Anna-Lena"; tomt namn ger null. */
function fornamnAv(fullName: string | null | undefined): string | null {
  const delar = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  return delar.length ? delar[0] : null;
}

/**
 * Alla som går att skriva till: har både e-postadress och ett förnamn.
 *
 * Utan förnamn finns ingen personlig hälsning att skriva, och "Hej ," är sämre än att låta bli.
 * Dubbletter på adress rensas: två profilrader med samma e-post är en person.
 */
export async function listaMottagare(): Promise<Mottagare[]> {
  const key = serviceRoleKey();
  if (!key) return [];
  const url = `${supabaseUrl()}/rest/v1/profiles?select=full_name,email,created_at&limit=1000`;
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Profiltabellen svarade ${res.status}`);
  const rader = (await res.json()) as Array<{ full_name?: string | null; email?: string | null; created_at?: string | null }>;

  const sedda = new Set<string>();
  const ut: Mottagare[] = [];
  for (const r of rader) {
    const epost = (r.email ?? "").trim().toLowerCase();
    const fornamn = fornamnAv(r.full_name);
    if (!epost || !epost.includes("@") || !fornamn || sedda.has(epost)) continue;
    sedda.add(epost);
    ut.push({ epost, fornamn, namn: (r.full_name ?? "").trim() || null, registrerad: r.created_at ?? null });
  }
  // Nyast först: samma ordning som användarlistan, så de två går att läsa bredvid varandra.
  return ut.sort((a, b) => String(b.registrerad).localeCompare(String(a.registrerad)));
}

/**
 * Brevet med platshållarna ifyllda.
 *
 * `[namn]` är förnamnet, varje gång det står. Formen är den som skrivs för hand i rutan, och både
 * klammer och måsvingar godtas — den som skriver ett brev ska inte behöva minnas vår syntax.
 */
export function fyll(text: string, m: Mottagare): string {
  return text
    .replace(/[[{](namn|förnamn|fornamn)[\]}]/gi, m.fornamn)
    .replace(/[[{](helanamn|fulltnamn)[\]}]/gi, m.namn ?? m.fornamn);
}

/** Vad som redan skickats, som "epost|ämne". Spärren mot att samma brev går ut två gånger. */
async function redanSkickat(): Promise<Set<string>> {
  try {
    const rader = (await readFile(LOGG_FIL(), "utf-8")).trim().split("\n");
    const ut = new Set<string>();
    for (const rad of rader) {
      if (!rad.trim()) continue;
      const post = JSON.parse(rad) as { epost?: string; amne?: string; status?: string };
      if (post.status === "ok" && post.epost) ut.add(`${post.epost.toLowerCase()}|${post.amne ?? ""}`);
    }
    return ut;
  } catch {
    return new Set();
  }
}

async function logga(post: Record<string, unknown>): Promise<void> {
  await mkdir(LOGG_DIR(), { recursive: true });
  await appendFile(LOGG_FIL(), JSON.stringify({ ...post, tid: new Date().toISOString() }) + "\n", "utf-8");
}

export function smtpKonfigurerat(): boolean {
  return !!(process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());
}

/** Avsändaren, som mottagaren ser den. */
export function avsandare(): string {
  return process.env.SMTP_FROM?.trim() || `Loopa <${process.env.SMTP_USER?.trim() ?? ""}>`;
}

async function transport() {
  const nodemailer = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT ?? 465);
  return nodemailer.default.createTransport({
    host: process.env.SMTP_HOST?.trim() || "send.one.com",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER?.trim(), pass: process.env.SMTP_PASS?.trim() },
  });
}

const sov = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kör utskicket. Startas av rutten och lämnas åt sig själv; panelen frågar efter läget.
 *
 * ETT FEL PÅ ETT BREV STOPPAR INTE RESTEN. En adress som studsar är en adress, inte ett utskick, och
 * den som fick tre av åttio brev skickade vill veta vilka tre som föll — inte börja om.
 */
async function kor(amne: string, brev: string, mottagare: Mottagare[]): Promise<void> {
  const from = avsandare();
  const post = await transport();
  for (const [i, m] of mottagare.entries()) {
    try {
      await post.sendMail({ from, to: m.epost, subject: fyll(amne, m), text: fyll(brev, m) });
      lage.skickade += 1;
      await logga({ epost: m.epost, amne, status: "ok" });
    } catch (err) {
      const orsak = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      lage.fel += 1;
      lage.problem.push({ epost: m.epost, orsak });
      await logga({ epost: m.epost, amne, status: "fel", orsak });
    }
    if (i < mottagare.length - 1) await sov(PAUS_MS);
  }
  lage.pagar = false;
  lage.klar = new Date().toISOString();
  console.info(`[utskick] "${amne}": ${lage.skickade} skickade, ${lage.fel} fel.`);
}

/** Segmenten EFTER /api/admin/utskick. Grinden ovanför har redan prövat att anroparen är admin. */
export async function handleUtskick(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  body: () => Promise<unknown>,
): Promise<boolean> {
  if (segments[0] === "mottagare" && req.method === "GET") {
    try {
      json(res, 200, { mottagare: await listaMottagare(), avsandare: avsandare(), konfigurerat: smtpKonfigurerat() });
    } catch (err) {
      json(res, 502, { error: err instanceof Error ? err.message : "Mottagarna kunde inte hämtas." });
    }
    return true;
  }

  if (segments[0] === "lage" && req.method === "GET") {
    json(res, 200, lage);
    return true;
  }

  if (segments.length === 0 && req.method === "POST") {
    if (lage.pagar) return (json(res, 409, { error: "Ett utskick pågår redan." }), true);
    if (!smtpKonfigurerat()) {
      return (json(res, 400, { error: "SMTP_USER och SMTP_PASS saknas på servern — inget kan skickas." }), true);
    }

    const kropp = (await body()) as { amne?: unknown; brev?: unknown; mottagare?: unknown };
    const amne = typeof kropp.amne === "string" ? kropp.amne.trim() : "";
    const brev = typeof kropp.brev === "string" ? kropp.brev.trim() : "";
    const valda = Array.isArray(kropp.mottagare) ? kropp.mottagare.map((v) => String(v).toLowerCase()) : [];
    if (!amne || amne.length > MAX_AMNE) return (json(res, 400, { error: "Ämnesraden saknas eller är för lång." }), true);
    if (!brev || brev.length > MAX_BREV) return (json(res, 400, { error: "Brevet saknas eller är för långt." }), true);
    if (valda.length === 0) return (json(res, 400, { error: "Ingen mottagare vald." }), true);
    if (valda.length > MAX_MOTTAGARE) {
      return (json(res, 400, { error: `Högst ${MAX_MOTTAGARE} mottagare per utskick.` }), true);
    }

    const alla = await listaMottagare();
    const valdSet = new Set(valda);
    const redan = await redanSkickat();
    // Bara adresser som FINNS i listan: klienten skickar adresser, och en adress som inte kommer ur
    // profiltabellen har ingen mottagare bakom sig.
    const mottagare = alla.filter((m) => valdSet.has(m.epost) && !redan.has(`${m.epost}|${amne}`));
    if (mottagare.length === 0) {
      return (json(res, 400, { error: "Alla valda har redan fått det här brevet." }), true);
    }

    lage = {
      pagar: true,
      amne,
      totalt: mottagare.length,
      skickade: 0,
      fel: 0,
      startad: new Date().toISOString(),
      klar: null,
      problem: [],
    };
    json(res, 202, lage);
    void kor(amne, brev, mottagare).catch((err) => {
      lage.pagar = false;
      lage.klar = new Date().toISOString();
      console.error("[utskick] körningen föll:", err instanceof Error ? err.message : err);
    });
    return true;
  }

  return false;
}
