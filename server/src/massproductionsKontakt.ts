/**
 * Kontaktbrevet till Massproductions: när en möbel som säljaren valt credits för är SÅLD får vår
 * kontakt där säljarens namn och e-post.
 *
 * NÄR: vid försäljningen (butik/store.ts, claimForSale), samtidigt som säljarens credits blir
 * tillgodo — inte när säljaren trycker "Sälj med Loopa". Först då har säljaren credits att lösa in.
 * NAMNET skriver säljaren själv i valfönstret (web/src/components/ErsattningsVal.tsx) och det står
 * på möbelns villkor. Telefonnumret ingår inte.
 *
 * VARFÖR. Credits är Massproductions valuta, inte vår. De behöver veta vem som har dem för att kunna
 * lösa in dem, och brevet är hur de får veta det. Ett brev som tyst inte kommer fram betyder att en
 * säljare har credits som ingen hos Massproductions känner till. Därför finns allt nedanför
 * själva skickandet: loggen, omförsöken, larmet och kontrollen.
 *
 * VÄGEN. Samma one.com-konto som lösenordsbreven och utskicket (utskick.ts, skickaEttBrev). Det
 * skickar på riktigt. Notisadaptern (notify/outbox.ts) används INTE för själva brevet, eftersom dess
 * förval skriver till en fil på servern. Det duger för en påminnelse men inte för det här. Svar från
 * Massproductions går direkt till säljaren (Reply-To).
 *
 * ETT BREV PER MÖBEL. Varje möbel har en post i data/massproductions/kontaktbrev.json, och posten
 * avgör: ett brev som har gått iväg skickas aldrig igen. Ett nytt tryck efter ett avslag i
 * granskningen, eller en omstart mitt i, ger alltså inget andra brev till Magnus.
 *
 * NÄR DET INTE GÅR:
 *   1. Posten markeras "misslyckat" med serverns orsak.
 *   2. Admin larmas direkt (ADMIN_EMAILS), en gång per möbel, och en gång till om vi ger upp.
 *   3. Svepet försöker igen var 15:e minut, upp till MAX_FORSOK gånger.
 *   4. Robothälsan (robotHalsa.ts, raden "E-post") visar varje brev som inte gått fram, varje dag,
 *      i panelen och i adminbrevet, tills det är löst.
 *
 * E-posten sparas INTE i posten. Bara säljarens id, så hämtas den färskt vid varje försök. Ett konto
 * som raderas mellan försöken får inget brev skickat om sig. Namnet säljaren skrev står i posten.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./jobStore.js";

/** Vår kontakt på Massproductions. MASSPRODUCTIONS_KONTAKT_EPOST pekar om, t.ex. i en testmiljö. */
export const MASSPRODUCTIONS_KONTAKT_STANDARD = "magnus.eleback@massproductions.se";

export function kontaktAdress(): string {
  return process.env.MASSPRODUCTIONS_KONTAKT_EPOST?.trim() || MASSPRODUCTIONS_KONTAKT_STANDARD;
}

/** Så många försök innan vi ger upp och larmar en sista gång. 8 × 15 min ≈ två timmar. */
export const MAX_FORSOK = 8;
const SVEP_MS = 15 * 60_000;
/** En post som står på "vantar" längre än så har fastnat (servern startades om mitt i). */
const FASTNAT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Brevet — rent
// ---------------------------------------------------------------------------

export interface Kontaktuppgifter {
  namn: string | null;
  epost: string | null;
  telefon: string | null;
}

export interface Underlag {
  loopaId: string;
  titel: string;
  mobelprisSek: number;
  credits: number;
  saljare: Kontaktuppgifter;
}

export interface Kontaktbrev {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

const kr = (n: number) => `${Math.round(n).toLocaleString("sv-SE")} kr`;

/**
 * Brevet som Magnus får. Ren funktion, så det går att läsa och testa utan att något skickas.
 *
 * Saknas ett fält står det "saknas" i stället för en tom rad. Det är en uppgift Magnus inte har,
 * och den ska synas som det.
 */
export function byggKontaktbrev(u: Underlag, till = kontaktAdress()): Kontaktbrev {
  const s = u.saljare;
  const namn = s.namn?.trim() || null;
  const text = [
    "Hej Magnus,",
    "",
    `${namn ?? "En säljare"} har sålt en Massproductions-möbel via Loopa och valt att få credits hos er i stället för pengar.`,
    "",
    "Säljarens kontaktuppgifter",
    `  Namn:     ${namn ?? "saknas"}`,
    `  E-post:   ${s.epost?.trim() || "saknas"}`,
    "",
    "Möbeln",
    `  ${u.titel}`,
    `  Loopa-ID:   ${u.loopaId}`,
    `  Möbelpris:  ${kr(u.mobelprisSek)}`,
    `  Credits:    ${u.credits.toLocaleString("sv-SE")} (möbeln är såld, och credits är säljarens)`,
    "",
    "Svarar du på det här mejlet går svaret direkt till säljaren.",
    "",
    "Vänliga hälsningar,",
    "Loopa",
  ].join("\n");
  return {
    to: till,
    subject: `Såld via Loopa – credits till ${namn ?? s.epost ?? u.loopaId}`,
    text,
    ...(s.epost?.trim() ? { replyTo: s.epost.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Posterna
// ---------------------------------------------------------------------------

export type KontaktStatus = "vantar" | "skickat" | "misslyckat" | "gav-upp";

export interface KontaktPost {
  jobId: string;
  userId: string;
  /** Namnet säljaren skrev i valfönstret. Null = ta kontots namn, om det finns. */
  namn?: string | null;
  loopaId: string;
  titel: string;
  mobelprisSek: number;
  credits: number;
  till: string;
  status: KontaktStatus;
  forsok: number;
  senasteFel: string | null;
  skapad: string;
  senastForsok: string | null;
  skickadAt: string | null;
  messageId: string | null;
  /** När admin larmades om att brevet inte gått fram. Null = inget larm ännu. */
  larmatAt: string | null;
}

const FIL = () => path.join(process.env.MP_KONTAKT_DIR?.trim() || path.join(DATA_DIR, "massproductions"), "kontaktbrev.json");

let kedja: Promise<unknown> = Promise.resolve();

/**
 * Läses från filen VARJE gång, utan cache. Provskriptet (massproductionsKontakt-kor.ts) är en egen
 * process som kan skicka om och skriva filen; en cache i servern hade skrivit över det.
 */
async function allaPoster(): Promise<KontaktPost[]> {
  try {
    const lista = JSON.parse(await readFile(FIL(), "utf-8")) as KontaktPost[];
    return Array.isArray(lista) ? lista.filter((p) => p && typeof p.jobId === "string") : [];
  } catch {
    return [];
  }
}

async function skriv(lista: KontaktPost[]): Promise<void> {
  await mkdir(path.dirname(FIL()), { recursive: true });
  const tmp = `${FIL()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(lista, null, 2), "utf-8");
  await rename(tmp, FIL());
}

/** Kör `f` i tur, så att två samtidiga tryck aldrig läser samma lista och skriver över varandra. */
function iTur<T>(f: () => Promise<T>): Promise<T> {
  const jobb = kedja.then(f);
  kedja = jobb.catch(() => undefined);
  return jobb;
}

async function uppdatera(jobId: string, falt: Partial<KontaktPost>): Promise<KontaktPost | null> {
  return iTur(async () => {
    const lista = await allaPoster();
    const i = lista.findIndex((p) => p.jobId === jobId);
    if (i < 0) return null;
    const ny = { ...lista[i], ...falt };
    await skriv(lista.map((p, j) => (j === i ? ny : p)));
    return ny;
  });
}

export async function listaPoster(): Promise<KontaktPost[]> {
  return [...(await allaPoster())].sort((a, b) => b.skapad.localeCompare(a.skapad));
}

/** Bara för tester. */
export function nollstall(): void {
  kedja = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Beroenden — injicerbara, så att testerna aldrig skickar något på riktigt
// ---------------------------------------------------------------------------

export interface Beroenden {
  hamtaKontakt: (userId: string) => Promise<Kontaktuppgifter | null>;
  skicka: (brev: Kontaktbrev) => Promise<{ messageId: string | null; accepted: string[]; rejected: string[] }>;
  larma: (subject: string, body: string) => Promise<void>;
  nu: () => Date;
}

/** Namn, e-post och telefon ur Supabase: samma källor och samma företräde som adminpanelens kontosida. */
async function hamtaKontaktStandard(userId: string): Promise<Kontaktuppgifter | null> {
  const { kontoDetalj } = await import("./admin.js");
  const konto = await kontoDetalj(userId);
  if (!konto) return null;
  return { namn: konto.name ?? null, epost: konto.email ?? null, telefon: konto.telefon ?? null };
}

async function skickaStandard(brev: Kontaktbrev) {
  const { skickaEttBrev } = await import("./utskick.js");
  return skickaEttBrev({ ...brev, headers: { "X-Loopa-Kind": "massproductions-kontakt" } });
}

/**
 * Larmet till admin. Först genom one.com, samma väg som brevet. Går inte den (vilket ju kan vara
 * själva felet) tas notisadaptern (Gmail eller /outbox). Och loggen får det alltid.
 */
async function larmaStandard(subject: string, body: string): Promise<void> {
  console.error(`[massproductions-kontakt] LARM: ${subject}`);
  const { adminEmails } = await import("./admin.js");
  const { skickaEttBrev, smtpKonfigurerat } = await import("./utskick.js");
  const { sendLetter } = await import("./efterlysning/notify.js");
  for (const to of adminEmails()) {
    let gick = false;
    if (smtpKonfigurerat()) {
      try {
        await skickaEttBrev({ to, subject, text: body });
        gick = true;
      } catch {
        // Faller till notisadaptern nedan.
      }
    }
    if (!gick) await sendLetter({ to, subject, body, kind: "massproductions-larm" });
  }
}

const standard: Beroenden = {
  hamtaKontakt: hamtaKontaktStandard,
  skicka: skickaStandard,
  larma: larmaStandard,
  nu: () => new Date(),
};

let beroenden: Beroenden = standard;

/** Bara för tester och provskriptet. Utelämnade fält behåller standarden. */
export function anvandBeroenden(b: Partial<Beroenden> | null): void {
  beroenden = b ? { ...standard, ...b } : standard;
}

// ---------------------------------------------------------------------------
// Skickandet
// ---------------------------------------------------------------------------

const felText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Ett försök för en post. Kastar aldrig; utfallet står i posten. */
async function forsok(post: KontaktPost): Promise<KontaktPost> {
  const d = beroenden;
  const nu = d.nu().toISOString();
  let fel: string | null = null;
  let messageId: string | null = null;

  try {
    const konto = await d.hamtaKontakt(post.userId);
    if (!konto) throw new Error(`Säljarens konto (${post.userId}) gick inte att läsa.`);
    if (!konto.epost?.trim()) throw new Error("Säljaren har ingen e-postadress. Det finns ingen att skicka vidare.");
    const kontakt: Kontaktuppgifter = { namn: post.namn?.trim() || konto.namn, epost: konto.epost, telefon: null };
    const brev = byggKontaktbrev(
      { loopaId: post.loopaId, titel: post.titel, mobelprisSek: post.mobelprisSek, credits: post.credits, saljare: kontakt },
      post.till,
    );
    const kvitto = await d.skicka(brev);
    // "Skickat" betyder att SMTP-servern tog emot brevet TILL MAGNUS. En server som svarar men
    // avvisar mottagaren är ett fel, inte ett lyckat brev.
    const mottagen = kvitto.accepted.some((a) => a.toLowerCase() === post.till.toLowerCase());
    if (!mottagen) {
      throw new Error(`SMTP-servern tog inte emot brevet till ${post.till}${kvitto.rejected.length ? ` (avvisad: ${kvitto.rejected.join(", ")})` : ""}.`);
    }
    messageId = kvitto.messageId;
  } catch (err) {
    fel = felText(err);
  }

  const antal = post.forsok + 1;
  if (!fel) {
    console.info(`[massproductions-kontakt] skickat till ${post.till} för ${post.loopaId} (${messageId ?? "utan id"}).`);
    const klar = await uppdatera(post.jobId, { status: "skickat", forsok: antal, senastForsok: nu, skickadAt: nu, messageId, senasteFel: null });
    // Hade admin larmats tidigare ska de också få veta att det löste sig, annars väntar de på ett fel som inte finns.
    if (post.larmatAt) {
      await d.larma(
        `Massproductions: brevet om ${post.loopaId} gick fram`,
        `Brevet till ${post.till} om "${post.titel}" (${post.loopaId}) gick fram efter ${antal} försök. Inget mer behöver göras.`,
      ).catch(() => undefined);
    }
    return klar ?? post;
  }

  const gavUpp = antal >= MAX_FORSOK;
  console.warn(`[massproductions-kontakt] försök ${antal}/${MAX_FORSOK} för ${post.loopaId} föll: ${fel}`);
  const ny = await uppdatera(post.jobId, { status: gavUpp ? "gav-upp" : "misslyckat", forsok: antal, senastForsok: nu, senasteFel: fel });

  // Larm vid första felet, och igen när vi ger upp. Inte vid varje försök däremellan.
  if (!post.larmatAt || gavUpp) {
    const body = [
      `Kontaktbrevet till Massproductions (${post.till}) gick INTE fram.`,
      "",
      `Möbel:    ${post.titel} (${post.loopaId})`,
      `Säljare:  konto ${post.userId}. Kontaktuppgifterna står i adminpanelen.`,
      `Credits:  ${post.credits.toLocaleString("sv-SE")}`,
      `Försök:   ${antal} av ${MAX_FORSOK}`,
      `Orsak:    ${fel}`,
      "",
      gavUpp
        ? "Servern har slutat försöka. Skicka uppgifterna till Massproductions för hand, eller rätta felet och kör: npm run massproductions:kontakt -- --skicka-om"
        : "Servern försöker igen var 15:e minut. Du får ett nytt brev om det går fram eller om vi ger upp.",
    ].join("\n");
    try {
      await d.larma(`${gavUpp ? "GAV UPP" : "FEL"}: brevet till Massproductions om ${post.loopaId} gick inte fram`, body);
      await uppdatera(post.jobId, { larmatAt: nu });
    } catch (err) {
      console.error(`[massproductions-kontakt] larmet gick inte heller iväg: ${felText(err)}`);
    }
  }
  return ny ?? post;
}

/**
 * Möbeln är såld och säljaren hade valt credits: skapa posten och skicka. Anropas från butik/store.ts
 * (claimForSale) när krediterna blivit tillgodo. Idempotent per möbel: finns posten redan görs
 * ingenting, vilket betyder att Magnus aldrig får två brev om samma möbel.
 */
export async function kontaktVidCreditsVal(in_: {
  userId: string;
  jobId: string;
  loopaId: string;
  titel: string;
  mobelprisSek: number;
  credits: number;
  /** Namnet säljaren skrev i valfönstret. */
  namn?: string | null;
}): Promise<KontaktPost> {
  const uppgifter = in_;
  const { post, ny } = await iTur(async () => {
    const lista = await allaPoster();
    const fanns = lista.find((p) => p.jobId === in_.jobId);
    if (fanns) return { post: fanns, ny: false };
    const post: KontaktPost = {
      ...uppgifter,
      namn: in_.namn?.trim().slice(0, 80) || null,
      titel: in_.titel.trim().slice(0, 140) || "Möbel",
      mobelprisSek: Math.round(in_.mobelprisSek),
      till: kontaktAdress(),
      status: "vantar",
      forsok: 0,
      senasteFel: null,
      skapad: beroenden.nu().toISOString(),
      senastForsok: null,
      skickadAt: null,
      messageId: null,
      larmatAt: null,
    };
    await skriv([post, ...lista]);
    return { post, ny: true };
  });
  return ny ? forsok(post) : post;
}

/** Ska posten provas igen nu? Misslyckade alltid; väntande bara om de fastnat. */
export function behoverForsok(p: KontaktPost, nu: Date): boolean {
  if (p.forsok >= MAX_FORSOK) return false;
  if (p.status === "misslyckat") return true;
  if (p.status === "vantar") return nu.getTime() - new Date(p.senastForsok ?? p.skapad).getTime() > FASTNAT_MS;
  return false;
}

/**
 * Försöker igen med allt som inte gått fram. `alla` tar även de vi gett upp om (för hand, efter att
 * felet rättats). De får då nya försök från noll.
 */
export async function skickaOm(opts: { alla?: boolean } = {}): Promise<KontaktPost[]> {
  const nu = beroenden.nu();
  const ut: KontaktPost[] = [];
  for (const p of await allaPoster()) {
    if (opts.alla && p.status === "gav-upp") {
      const nollad = await uppdatera(p.jobId, { status: "misslyckat", forsok: 0, larmatAt: null });
      if (nollad) ut.push(await forsok(nollad));
    } else if (behoverForsok(p, nu)) {
      ut.push(await forsok(p));
    }
  }
  return ut;
}

// ---------------------------------------------------------------------------
// Kontrollen — för robothälsan
// ---------------------------------------------------------------------------

export type Utfall = "ok" | "varning" | "fel" | "av";
export interface Kontroll {
  namn: string;
  utfall: Utfall;
  text: string;
}

/**
 * Bedömningen av posterna. Ren. Varje brev som inte gått fram är ett fel, oavsett hur gammalt:
 * en säljare med credits som Massproductions inte känner till blir inte mindre fel med tiden.
 */
export function bedomPoster(poster: KontaktPost[], nu: Date): Kontroll {
  const namn = "Brev till Massproductions";
  const ej = poster.filter((p) => p.status === "misslyckat" || p.status === "gav-upp");
  const fast = poster.filter((p) => p.status === "vantar" && nu.getTime() - new Date(p.senastForsok ?? p.skapad).getTime() > FASTNAT_MS);
  if (ej.length > 0) {
    const ex = ej.slice(0, 3).map((p) => `${p.loopaId} (${p.forsok} försök: ${p.senasteFel ?? "okänt fel"})`);
    return { namn, utfall: "fel", text: `${ej.length} brev har inte gått fram: ${ex.join("; ")}${ej.length > 3 ? " …" : ""}` };
  }
  if (fast.length > 0) return { namn, utfall: "varning", text: `${fast.length} brev väntar längre än väntat: ${fast.map((p) => p.loopaId).join(", ")}` };
  const manad = poster.filter((p) => p.status === "skickat" && p.skickadAt && nu.getTime() - new Date(p.skickadAt).getTime() < 30 * 24 * 60 * 60_000);
  return { namn, utfall: "ok", text: poster.length ? `Alla brev har gått fram (${manad.length} senaste 30 dagarna).` : "Inga brev ännu. Ingen har valt credits." };
}

/**
 * Hela kontrollen: går det att logga in på brevlådan (utan att skicka något), och har alla brev
 * gått fram? `provaInloggning` injiceras i testerna.
 */
export async function kontrollera(
  provaInloggning?: () => Promise<void>,
  nu = new Date(),
): Promise<Kontroll[]> {
  const { provaSmtpInloggning, smtpKonfigurerat, avsandare } = await import("./utskick.js");
  let inloggning: Kontroll;
  if (!provaInloggning && !smtpKonfigurerat()) {
    inloggning = { namn: "Brevlådan (SMTP)", utfall: "fel", text: "SMTP_USER och SMTP_PASS saknas. Inga brev till Massproductions kan skickas." };
  } else {
    try {
      await (provaInloggning ?? provaSmtpInloggning)();
      inloggning = { namn: "Brevlådan (SMTP)", utfall: "ok", text: `Inloggningen gick igenom (${avsandare()}). Inget brev skickades.` };
    } catch (err) {
      inloggning = { namn: "Brevlådan (SMTP)", utfall: "fel", text: `Inloggningen nekades: ${felText(err)}` };
    }
  }
  return [inloggning, bedomPoster(await allaPoster(), nu)];
}

// ---------------------------------------------------------------------------
// Svepet
// ---------------------------------------------------------------------------

let svepPagar = false;

/** Startas i serverprocessen. Försöker igen med det som inte gått fram, var 15:e minut. */
export function startMassproductionsKontakt(): void {
  const svep = async () => {
    if (svepPagar) return;
    svepPagar = true;
    try {
      const gjorda = await skickaOm();
      if (gjorda.length) console.info(`[massproductions-kontakt] svepet provade ${gjorda.length} brev igen.`);
    } catch (err) {
      console.warn(`[massproductions-kontakt] svepet föll: ${felText(err)}`);
    } finally {
      svepPagar = false;
    }
  };
  void import("./utskick.js").then(({ smtpKonfigurerat }) => {
    if (!smtpKonfigurerat()) {
      console.warn(
        "[massproductions-kontakt] VARNING: SMTP_USER/SMTP_PASS saknas. Väljer en säljare credits går brevet till " +
          `${kontaktAdress()} INTE iväg. Admin larmas, och felet syns under Robotar → E-post.`,
      );
    }
  });
  setTimeout(() => void svep(), 60_000).unref();
  setInterval(() => void svep(), SVEP_MS).unref();
  console.info(`[massproductions-kontakt] brev till ${kontaktAdress()} vid credits-val; omförsök var 15:e minut.`);
}
