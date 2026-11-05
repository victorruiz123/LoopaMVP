/**
 * Den dagliga hälsokontrollen av robotarna: Blocket, Tradera och Facebook.
 *
 * Robotarna går sönder tyst. En session som gått ut, ett formulär som byggts om, en kö som slutat
 * röra sig — inget av det syns förrän en säljare undrar varför annonsen aldrig kom upp. Blocket-vakten
 * (blocket/vakt.ts) täcker EN sak på EN kanal. Den här kontrollen tittar på alla tre en gång om dagen,
 * på två sätt:
 *
 *   PRÖVNINGAR — går det att komma in? Blocket-sessionen, Traderas nycklar mot en riktig annons,
 *   Tradera-inkorgen, Gmail-bevakaren och Facebook-sessionen. De dyra (Chromium) körs EN I TAGET.
 *
 *   UTFALLET I DATAN — har det gått? Publiceringar som föll eller fastnat senaste dygnet, annonser som
 *   tagits ner för omläggning och inte kommit upp igen, Facebook-poster som behöver en människa. Det
 *   fångar det en sessionskontroll aldrig ser: inloggningen gäller, men knappen har flyttat.
 *
 * Rapporten skrivs till data/robothalsa.json där panelen läser den, och mejlas adminadresserna när
 * något inte är grönt — och en gång till när allt blivit grönt igen. Ett brev varje morgon om att allt
 * är bra lär mottagaren att inte läsa dem (ROBOT_HALSA_BREV=alltid om man ändå vill ha det).
 *
 * Bedömningen av datan är ren och prövas utan webbläsare; prövningarna är injicerbara.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, listJobs } from "./jobStore.js";
import type { ConditionJob } from "./types.js";
import type { GroupPublication, ManualAction, MarketplacePublication } from "./integrations/facebook/types.js";
import type { SenasteSvep } from "./kanalStatistik.js";

export type Utfall = "ok" | "varning" | "fel" | "av";
export type Robot = "blocket" | "tradera" | "facebook";

export interface Kontroll {
  namn: string;
  utfall: Utfall;
  text: string;
}

export interface RobotBesked {
  robot: Robot;
  utfall: Utfall;
  kontroller: Kontroll[];
}

export interface RobotRapport {
  kordAt: string;
  /** Hur lång tid hela kontrollen tog, i sekunder. */
  sekunder: number;
  utfall: Utfall;
  robotar: RobotBesked[];
}

/** Så långt bakåt ett fel räknas som nytt. Kontrollen går en gång per dygn. */
const DYGN_MS = 24 * 60 * 60_000;
/** En publicering som stått på "publishing" längre än så har fastnat — en körning tar minuter. */
const FASTNAT_MS = 2 * 60 * 60_000;
/** Så många rapporter sparas för panelen. En månad. */
const MAX_HISTORIK = 30;

const NAMN: Record<Robot, string> = { blocket: "Blocket", tradera: "Tradera", facebook: "Facebook" };

// ---------------------------------------------------------------------------
// Sammanvägning
// ---------------------------------------------------------------------------

const RANG: Record<Utfall, number> = { av: 0, ok: 1, varning: 2, fel: 3 };

/** Det värsta utfallet vinner. Bara "av" = allt avstängt; en enda påslagen kontroll räknas. */
export function sammanvag(utfall: Utfall[]): Utfall {
  return utfall.reduce<Utfall>((varst, u) => (RANG[u] > RANG[varst] ? u : varst), "av");
}

function besked(robot: Robot, kontroller: Kontroll[]): RobotBesked {
  return { robot, utfall: sammanvag(kontroller.map((k) => k.utfall)), kontroller };
}

// ---------------------------------------------------------------------------
// Bedömningen av datan — ren
// ---------------------------------------------------------------------------

function sedan(iso: string | null | undefined, nu: Date): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? nu.getTime() - t : Infinity;
}

function datum(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });
}

/** Upp till tre exempel, så brevet går att agera på utan att öppna panelen. */
function exempel(rader: string[]): string {
  if (rader.length === 0) return "";
  const visa = rader.slice(0, 3).join("; ");
  return rader.length > 3 ? ` — ${visa} (+${rader.length - 3} till)` : ` — ${visa}`;
}

/**
 * Tradera och Blocket ur jobben: föll, fastnat, nere för omläggning, senast lyckade.
 *
 * Tradera och Blocket bokförs på samma sätt på jobbet (`tradera`/`blocket` med status och tider), så
 * samma bedömning gäller båda. Torrkörningar räknas inte som fel — de stannade med flit.
 */
export function bedomKanal(kanal: "tradera" | "blocket", jobs: ConditionJob[], nu: Date): Kontroll[] {
  const fallna: string[] = [];
  const fastnade: string[] = [];
  const nere: string[] = [];
  let senast: string | null = null;

  for (const job of jobs) {
    const pub = job[kanal];
    if (pub) {
      if (pub.status === "error" && sedan(pub.startedAt, nu) <= DYGN_MS) {
        fallna.push(`${job.id}: ${(pub.error ?? "okänt fel").slice(0, 140)}`);
      }
      if (pub.status === "publishing" && sedan(pub.startedAt, nu) > FASTNAT_MS) {
        fastnade.push(`${job.id} sedan ${datum(pub.startedAt)}`);
      }
      if (pub.status === "published" && pub.publishedAt && (!senast || pub.publishedAt > senast)) senast = pub.publishedAt;
    }
    const om = job.priceLadder?.omlaggning?.[kanal];
    if (om && !om.gamlaKvar && sedan(om.nedtagenAt, nu) > DYGN_MS) {
      nere.push(`${job.id} nere sedan ${datum(om.nedtagenAt)}${om.fel ? ` (${om.fel.slice(0, 100)})` : ""}`);
    }
  }

  return [
    fallna.length
      ? { namn: "Publiceringar", utfall: "fel", text: `${fallna.length} föll senaste dygnet${exempel(fallna)}` }
      : { namn: "Publiceringar", utfall: "ok", text: "Inga fel senaste dygnet." },
    fastnade.length
      ? { namn: "Fastnade körningar", utfall: "fel", text: `${fastnade.length} har stått på "publicerar" i över två timmar${exempel(fastnade)}` }
      : { namn: "Fastnade körningar", utfall: "ok", text: "Inga." },
    nere.length
      ? { namn: "Omläggningar", utfall: "fel", text: `${nere.length} annonser togs ner för omläggning och har inte kommit upp igen${exempel(nere)}` }
      : { namn: "Omläggningar", utfall: "ok", text: "Inga annonser hänger nere." },
    { namn: "Senast publicerad", utfall: "ok", text: senast ? datum(senast) : "Ingen annons publicerad ännu." },
  ];
}

export interface FacebookUnderlag {
  marketplace: MarketplacePublication[];
  grupper: GroupPublication[];
  atgarder: ManualAction[];
}

/** Facebook ur sitt eget lager (server/data/facebook): föll, kräver en människa, kön står still. */
export function bedomFacebook(u: FacebookUnderlag, nu: Date): Kontroll[] {
  const poster = [
    ...u.marketplace.map((p) => ({ ...p, var: `Marketplace ${p.listingId}`, uppdaterad: p.updatedAt })),
    ...u.grupper.map((p) => ({ ...p, var: `grupp ${p.groupId} ${p.listingId}`, uppdaterad: p.attemptedAt ?? p.queuedAt })),
  ];
  const fallna = poster.filter((p) => p.status === "FAILED" && sedan(p.uppdaterad, nu) <= DYGN_MS);
  const stilla = poster.filter((p) => p.status === "QUEUED" && sedan(p.queuedAt, nu) > DYGN_MS);
  const oppna = u.atgarder.filter((a) => !a.resolvedAt);
  const senast = poster
    .filter((p) => p.status === "PUBLISHED" && p.publishedAt)
    .reduce<string | null>((s, p) => (!s || p.publishedAt! > s ? p.publishedAt : s), null);

  return [
    fallna.length
      ? { namn: "Publiceringar", utfall: "fel", text: `${fallna.length} föll senaste dygnet${exempel(fallna.map((p) => `${p.var}: ${(p.failureReason ?? "okänt fel").slice(0, 120)}`))}` }
      : { namn: "Publiceringar", utfall: "ok", text: "Inga fel senaste dygnet." },
    oppna.length
      ? { namn: "Kräver en människa", utfall: "varning", text: `${oppna.length} öppna i Facebook-fliken${exempel(oppna.map((a) => `${a.kind}: ${a.reason.slice(0, 100)}`))}` }
      : { namn: "Kräver en människa", utfall: "ok", text: "Inget öppet." },
    stilla.length
      ? { namn: "Kön", utfall: "varning", text: `${stilla.length} poster har väntat i kön i över ett dygn — står arbetaren still?` }
      : { namn: "Kön", utfall: "ok", text: "Rör sig." },
    { namn: "Senast publicerad", utfall: "ok", text: senast ? datum(senast) : "Ingen post publicerad ännu." },
  ];
}

// ---------------------------------------------------------------------------
// Prövningarna — riktiga anrop, en webbläsare i taget
// ---------------------------------------------------------------------------

function felText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Så länge Blocket-kontrollen väntar på att en annan körning ska bli klar. */
const BLOCKET_VANTA_MS = 20 * 60_000;

async function provaBlocketSession(): Promise<Kontroll> {
  const namn = "Inloggningen";
  const { blocketConfigured, skrivHalsa } = await import("./integrations/blocket/blocket.js");
  if (!blocketConfigured()) return { namn, utfall: "av", text: "Ingen Blocket-session konfigurerad." };
  const { arUpptagen, kontrolleraSession } = await import("./integrations/blocket/vakt.js");
  // Väntar ut en pågående körning (publicering, statistiksvep) i stället för att hoppa över: en
  // överhoppad kontroll vore en varning, och en varning är ett brev — om ingenting.
  for (let vantat = 0; arUpptagen() && vantat < BLOCKET_VANTA_MS; vantat += 15_000) {
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (arUpptagen()) return { namn, utfall: "varning", text: "Blocket var upptaget i 20 minuter — sessionen kunde inte prövas i dag." };
  const utfall = await kontrolleraSession();
  // Samma besked som vakten skriver, så att Kanallistan i panelen visar det.
  skrivHalsa({ kontrolleradAt: new Date().toISOString(), ...utfall });
  return utfall.ok
    ? { namn, utfall: "ok", text: "Sessionen gäller." }
    : { namn, utfall: "fel", text: `Sessionen gäller inte: ${utfall.fel ?? "okänt fel"}. Logga in igen med npm run blocket:logga-in.` };
}

async function provaTraderaApi(jobs: ConditionJob[]): Promise<Kontroll> {
  const namn = "API-nycklarna";
  const { traderaConfigured, getTraderaItem } = await import("./integrations/tradera/tradera.js");
  if (!traderaConfigured()) return { namn, utfall: "av", text: "Tradera-nycklarna saknas i server/.env." };
  // Traderas v4 har ingen ren "vem är jag"-fråga; en läsning av vår senaste annons prövar samma nycklar.
  const senaste = jobs
    .filter((j) => j.tradera?.status === "published" && j.tradera.itemId)
    .sort((a, b) => (b.tradera!.publishedAt ?? "").localeCompare(a.tradera!.publishedAt ?? ""))[0];
  if (!senaste) return { namn, utfall: "ok", text: "Nycklarna är satta men ingen publicerad annons finns att pröva dem mot." };
  try {
    await getTraderaItem(senaste.tradera!.itemId!);
    return { namn, utfall: "ok", text: `Tradera svarade på annons ${senaste.tradera!.itemId}.` };
  } catch (err) {
    return { namn, utfall: "fel", text: `Tradera svarade inte: ${felText(err)}` };
  }
}

async function provaTraderaInkorg(): Promise<Kontroll> {
  const namn = "Inkorgen";
  const { traderaInkorgKonfigurerad, lasTraderaInkorg } = await import("./integrations/tradera/inkorg.js");
  if (!traderaInkorgKonfigurerad()) return { namn, utfall: "av", text: "Ingen Tradera-session för meddelandefunktionen." };
  try {
    const tradar = await lasTraderaInkorg();
    return { namn, utfall: "ok", text: `Gick att läsa (${tradar.length} trådar).` };
  } catch (err) {
    return {
      namn,
      utfall: "fel",
      text: `Gick inte att läsa: ${felText(err)}. Omläggningen kan då inte se om en köpare skrivit. Logga in igen med npm run tradera:logga-in.`,
    };
  }
}

async function provaTraderaPost(nu: Date): Promise<Kontroll> {
  const namn = "Gmail-bevakaren";
  const { traderaMailStatus } = await import("./integrations/tradera/mailwatch.js");
  const s = await traderaMailStatus();
  if (!s.configured) return { namn, utfall: "av", text: "GMAIL_USER/GMAIL_APP_PASSWORD saknas — sålda möbler upptäcks inte automatiskt." };
  if (s.lastError) return { namn, utfall: "fel", text: `Senaste läsningen föll: ${s.lastError.slice(0, 200)}` };
  if (sedan(s.lastPollAt, nu) > 3 * s.pollMinutes * 60_000) {
    return { namn, utfall: "fel", text: `Har inte läst posten sedan ${s.lastPollAt ? datum(s.lastPollAt) : "start"} (ska läsa var ${s.pollMinutes}:e minut).` };
  }
  return { namn, utfall: "ok", text: `Läste senast ${datum(s.lastPollAt!)}${s.ohanterade ? `, ${s.ohanterade} ohanterade poster` : ""}.` };
}

async function provaFacebookSession(): Promise<Kontroll> {
  const namn = "Inloggningen";
  const { facebookEnabled, facebookMode } = await import("./integrations/facebook/config.js");
  if (!facebookEnabled()) return { namn, utfall: "av", text: "Facebook-distributionen är av (FACEBOOK_ENABLED)." };
  const { withFacebookBrowser, checkSession } = await import("./integrations/facebook/session.js");
  // Går i Facebook-spåret, efter det som redan kör där — aldrig två Facebook-webbläsare samtidigt.
  const s = await withFacebookBrowser("halsokontroll", (b) => checkSession(b.page));
  const lage = facebookMode() === "mock" ? " (attrappläge)" : "";
  return s.status === "CONNECTED"
    ? { namn, utfall: "ok", text: `Inloggad${lage}.` }
    : { namn, utfall: "fel", text: `${s.status}${lage}: ${s.detail}` };
}

/**
 * Säljarnas siffror (kanalStatistik.ts): gick senaste svepet igenom för kanalen, och är det färskt?
 * Ren — svepets utfall och mellanrummet kommer in som argument.
 */
export function bedomStatistik(kanal: "tradera" | "blocket", svep: SenasteSvep | null, timmar: number, nu: Date): Kontroll {
  const namn = "Säljarnas statistik";
  if (timmar === 0) return { namn, utfall: "av", text: "Svepet är avstängt (KANAL_STATISTIK_TIMMAR=0)." };
  if (!svep) return { namn, utfall: "ok", text: "Inget svep har körts än — första går tio minuter efter start." };
  const u = svep[kanal];
  if (sedan(svep.at, nu) > 3 * timmar * 3_600_000) {
    return { namn, utfall: "fel", text: `Senaste svepet gick ${datum(svep.at)} — det ska gå var ${timmar}:e timme.` };
  }
  if (u.status === "fel") return { namn, utfall: "fel", text: `Senaste svepet föll: ${u.detalj}` };
  if (u.status === "av") return { namn, utfall: "av", text: u.detalj };
  return { namn, utfall: "ok", text: `${u.detalj} (${datum(svep.at)})` };
}

async function lasFacebookUnderlag(): Promise<FacebookUnderlag> {
  const store = await import("./integrations/facebook/store.js");
  const [marketplace, grupper, atgarder] = await Promise.all([store.allMarketplace(), store.allGroupPublications(), store.listManualActions()]);
  return { marketplace, grupper, atgarder };
}

/** En prövning som kastar blir ett fel i rapporten, inte en rapport som aldrig blev av. */
async function sakert(namn: string, prov: () => Promise<Kontroll>): Promise<Kontroll> {
  try {
    return await prov();
  } catch (err) {
    return { namn, utfall: "fel", text: `Kontrollen själv föll: ${felText(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Ett varv
// ---------------------------------------------------------------------------

export interface HalsaBeroenden {
  jobb: () => Promise<ConditionJob[]>;
  blocketSession: () => Promise<Kontroll>;
  traderaApi: (jobs: ConditionJob[]) => Promise<Kontroll>;
  traderaInkorg: () => Promise<Kontroll>;
  traderaPost: (nu: Date) => Promise<Kontroll>;
  facebookSession: () => Promise<Kontroll>;
  facebookUnderlag: () => Promise<FacebookUnderlag>;
  statistikSvep: () => Promise<{ svep: SenasteSvep | null; timmar: number }>;
  nu: () => Date;
}

const standard: HalsaBeroenden = {
  jobb: listJobs,
  blocketSession: provaBlocketSession,
  traderaApi: provaTraderaApi,
  traderaInkorg: provaTraderaInkorg,
  traderaPost: provaTraderaPost,
  facebookSession: provaFacebookSession,
  facebookUnderlag: lasFacebookUnderlag,
  statistikSvep: async () => {
    const { lasSenasteSvep, svepTimmar } = await import("./kanalStatistik.js");
    return { svep: lasSenasteSvep(), timmar: svepTimmar() };
  },
  nu: () => new Date(),
};

/**
 * Hela kontrollen, en gång. Prövningarna körs i följd och inte parallellt: tre Chromium samtidigt på
 * en liten server är ett minnesproblem, och det är ingen brådska — kontrollen går klockan sju.
 */
export async function korRobotHalsa(beroenden: Partial<HalsaBeroenden> = {}): Promise<RobotRapport> {
  const d = { ...standard, ...beroenden };
  const start = d.nu();
  const jobs = await d.jobb();

  // Avstängd kanal: datan är gammal och säger ingenting om i dag. Samma för Facebook nedan.
  const { svep, timmar } = await d.statistikSvep().catch(() => ({ svep: null, timmar: 0 }));
  const bSession = await sakert("Inloggningen", d.blocketSession);
  const blocket =
    bSession.utfall === "av" ? [bSession] : [bSession, ...bedomKanal("blocket", jobs, start), bedomStatistik("blocket", svep, timmar, start)];
  const tradera = [
    await sakert("API-nycklarna", () => d.traderaApi(jobs)),
    await sakert("Inkorgen", d.traderaInkorg),
    await sakert("Gmail-bevakaren", () => d.traderaPost(start)),
    ...bedomKanal("tradera", jobs, start),
    bedomStatistik("tradera", svep, timmar, start),
  ];
  const fbSession = await sakert("Inloggningen", d.facebookSession);
  const facebook = fbSession.utfall === "av" ? [fbSession] : [fbSession, ...bedomFacebook(await d.facebookUnderlag(), start)];

  const robotar = [besked("blocket", blocket), besked("tradera", tradera), besked("facebook", facebook)];
  return {
    kordAt: start.toISOString(),
    sekunder: Math.round((d.nu().getTime() - start.getTime()) / 1000),
    utfall: sammanvag(robotar.map((r) => r.utfall)),
    robotar,
  };
}

// ---------------------------------------------------------------------------
// Lagringen
// ---------------------------------------------------------------------------

export interface HalsaLager {
  senaste: RobotRapport | null;
  /** Äldst först, kapad till 30. */
  historik: RobotRapport[];
}

function lagerFil(): string {
  return path.join(DATA_DIR, "robothalsa.json");
}

export function lasRobotHalsa(): HalsaLager {
  try {
    if (!existsSync(lagerFil())) return { senaste: null, historik: [] };
    const lager = JSON.parse(readFileSync(lagerFil(), "utf8")) as Partial<HalsaLager>;
    return { senaste: lager.senaste ?? null, historik: Array.isArray(lager.historik) ? lager.historik : [] };
  } catch {
    return { senaste: null, historik: [] };
  }
}

function sparaRobotHalsa(rapport: RobotRapport): void {
  const fore = lasRobotHalsa();
  mkdirSync(DATA_DIR, { recursive: true });
  const lager: HalsaLager = { senaste: rapport, historik: [...fore.historik, rapport].slice(-MAX_HISTORIK) };
  writeFileSync(lagerFil(), JSON.stringify(lager, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Brevet
// ---------------------------------------------------------------------------

/**
 * Brev när något inte är grönt, och en gång när det blivit grönt igen. Utan brevet om återhämtningen
 * vet mottagaren inte att gårdagens fel är löst — och slutar lita på tystnaden.
 */
export function skaMejla(rapport: RobotRapport, fore: RobotRapport | null, alltid = false): boolean {
  if (alltid) return true;
  if (rapport.utfall === "fel" || rapport.utfall === "varning") return true;
  return fore !== null && (fore.utfall === "fel" || fore.utfall === "varning");
}

const MARKE: Record<Utfall, string> = { ok: "OK ", varning: "!  ", fel: "FEL", av: "av " };

export function brevFor(rapport: RobotRapport): { subject: string; body: string } {
  const alla = rapport.robotar.flatMap((r) => r.kontroller);
  const fel = alla.filter((k) => k.utfall === "fel").length;
  const varningar = alla.filter((k) => k.utfall === "varning").length;
  const subject =
    fel || varningar
      ? `Robotarna: ${[fel ? `${fel} fel` : "", varningar ? `${varningar} varning${varningar > 1 ? "ar" : ""}` : ""].filter(Boolean).join(", ")}`
      : "Robotarna: allt fungerar igen";

  const rader = [`Daglig hälsokontroll ${datum(rapport.kordAt)}.`, ""];
  for (const r of rapport.robotar) {
    rader.push(`${NAMN[r.robot]} — ${r.utfall.toUpperCase()}`);
    // Det som behöver göras först; det gröna sist så att det inte skymmer.
    const sorterade = [...r.kontroller].sort((a, b) => RANG[b.utfall] - RANG[a.utfall]);
    for (const k of sorterade) rader.push(`  [${MARKE[k.utfall]}] ${k.namn}: ${k.text}`);
    rader.push("");
  }
  rader.push("Hela rapporten finns under Robotar i adminpanelen. Kör om: npm run robotar:halsa");
  return { subject, body: rader.join("\n") };
}

async function mejlaAdmin(rapport: RobotRapport): Promise<void> {
  const { adminEmails } = await import("./admin.js");
  const { sendLetter } = await import("./efterlysning/notify.js");
  const { subject, body } = brevFor(rapport);
  for (const to of adminEmails()) await sendLetter({ to, subject, body, kind: "robothalsa" });
}

// ---------------------------------------------------------------------------
// Körning och schema
// ---------------------------------------------------------------------------

let pagar: Promise<RobotRapport> | null = null;

/**
 * Kör, spara, mejla vid behov. Ett anrop medan en körning pågår får samma körning — knappen i panelen
 * och morgonens schema kan inte starta två varv på samma robotar.
 */
export function korOchRapportera(opts: { mejla?: boolean } = {}): Promise<RobotRapport> {
  if (pagar) return pagar;
  pagar = (async () => {
    const fore = lasRobotHalsa().senaste;
    const rapport = await korRobotHalsa();
    sparaRobotHalsa(rapport);
    if (opts.mejla !== false && skaMejla(rapport, fore, process.env.ROBOT_HALSA_BREV === "alltid")) {
      await mejlaAdmin(rapport).catch((err) => console.warn("[robothalsa] brevet gick inte iväg:", felText(err)));
    }
    return rapport;
  })().finally(() => {
    pagar = null;
  });
  return pagar;
}

export function korPagar(): boolean {
  return pagar !== null;
}

/** "HH:MM" och "YYYY-MM-DD" i svensk tid, oavsett serverns tidszon. */
function stockholm(d: Date): { dag: string; tid: string } {
  const delar = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { dag: `${delar.year}-${delar.month}-${delar.day}`, tid: `${delar.hour}:${delar.minute}` };
}

/**
 * Är det dags? Klockslaget har passerats i dag (svensk tid) och dagens kontroll har inte körts.
 *
 * Frågan ställs mot SENASTE RAPPORTEN och inte mot en timer: en server som startas om klockan nio
 * kör morgonens kontroll då, i stället för att vänta ett dygn — och en som startas om två gånger
 * samma dag kör den inte två gånger.
 */
export function arDags(nu: Date, klockslag: string, senast: string | null): boolean {
  const idag = stockholm(nu);
  if (idag.tid < klockslag) return false;
  return !senast || stockholm(new Date(senast)).dag !== idag.dag;
}

/**
 * Startar schemat i serverprocessen. ROBOT_HALSA_TID är klockslaget i svensk tid, förval 07:00;
 * "0" eller "av" stänger av. Tittar var tionde minut — kontrollen själv körs en gång om dagen.
 */
export function startRobotHalsa(): void {
  const tid = (process.env.ROBOT_HALSA_TID ?? "07:00").trim();
  if (tid === "0" || tid === "av") {
    console.info("[robothalsa] avstängd (ROBOT_HALSA_TID)");
    return;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tid)) {
    console.warn(`[robothalsa] ROBOT_HALSA_TID="${tid}" är inte HH:MM — kontrollen är av`);
    return;
  }

  const titta = async () => {
    if (pagar || !arDags(new Date(), tid, lasRobotHalsa().senaste?.kordAt ?? null)) return;
    try {
      const r = await korOchRapportera();
      console.info(`[robothalsa] ${r.utfall} — ${r.robotar.map((b) => `${b.robot} ${b.utfall}`).join(", ")} (${r.sekunder} s)`);
    } catch (err) {
      console.warn(`[robothalsa] kontrollen föll: ${felText(err)}`);
    }
  };

  // Först efter fem minuter: vid uppstart har Blocket-vakten och Facebook-arbetarna redan sina webbläsare igång.
  setTimeout(() => void titta(), 5 * 60_000).unref();
  setInterval(() => void titta(), 10 * 60_000).unref();
  console.info(`[robothalsa] kontrollerar robotarna varje dag kl. ${tid}`);
}
