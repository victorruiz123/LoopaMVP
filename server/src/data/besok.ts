/**
 * Besöksmätningen: varifrån folk kommer, och hur de rör sig mellan sidorna.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Panelen kunde svara på vad som hände med en annons (analys/store.ts)
 * och var säljare tappade tråden i flödet (data/flode.ts), men inte på de två frågor intaget faktiskt
 * hänger på: KOM de från Facebook, Google, en väns inbjudan eller en kampanj — och vad gjorde de
 * sedan? Ingen av de två andra mätningarna bär källan, och ingen av dem ser sidbyten utanför
 * säljflödet. Antingen skrivs källan ned i besökets första sekund eller så finns den inte: den står
 * i `document.referrer` och adressfältet precis då, och aldrig igen.
 *
 * SAMMA SESSION SOM FLÖDET, med flit. Klienten skickar flödets `sess` (web/src/lib/flode.ts), och
 * därför går det att säga "av besöken från Instagram nådde tolv fram till ett intygat kort" utan att
 * någon av mätningarna behöver veta om den andra. Hopkopplingen sker vid läsningen, precis som
 * flödet knyter sina steg till jobbet i efterhand.
 *
 * KANALEN AVGÖRS HÄR, INTE I WEBBLÄSAREN. Klienten skickar råvaran — värdnamnet den kom från och
 * UTM-fälten — och servern sorterar. En klient som fick välja kanal själv hade gjort kanalen till
 * något vem som helst kunde skriva, och en regel som ändras (en ny sökmotor, ett nytt socialt nätverk)
 * hade bara gällt för nya besök. Nu gäller den bakåt också, för hela loggen.
 *
 * INGEN IDENTITET UTÖVER DEN FLÖDET REDAN BÄR. Värdnamnet och aldrig hela adressen besökaren kom
 * från (en sökadress kan bära sökorden, en mejllänk en adress). Ingen IP. `uid` står på raden när
 * kontot är inloggat, under samma villkor som i flödet: påstådd av webbläsaren och bara duglig för en
 * trattmätning. Se `glomKonto` för raderingen.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { KLIENTHANDELSER } from "../analys/store.js";
import { STEG, type FlodesSession } from "./flode.js";

const DATA_KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const BESOK_FIL = () => path.join(DATA_KATALOG(), "besok.jsonl");

/**
 * Händelser som får skrivas. Vägen in är öppen — den som ännu inte har ett konto är själva
 * mätobjektet — och vitlistan är därför säkerheten, samma regel som i flödet.
 */
export const BESOKSHANDELSER = new Set([
  /** Besökets första sidladdning. Bär källan. Bara den FÖRSTA per session räknas — se `bygg`. */
  "landning",
  /** En sida visades. Bär sidan och sidan innan. */
  "sida",
  /** Kontot loggade in. Poängen är `uid` på raden. */
  "konto",
  /**
   * En butikshändelse — `track()` i butiken — speglad hit med sessionen på. Samma namn som i
   * analys/store.ts och samma vitlista. Den mätningen räknar per ANNONS och vet inte vem som gjorde
   * vad; här står händelsen i besöket, så att "kom från Instagram, öppnade tre möbler, gick till
   * kassan" går att läsa som en resa. Se data/kundresa.ts.
   */
  "handling",
  /** En namngiven sektion på sidan syntes. En gång per sidvisning och sektion. Se SEKTIONER. */
  "sektion",
  /** Något inuti en namngiven sektion trycktes. Se SEKTIONER. */
  "klick",
  /** Hur långt ned sidan besökaren kom innan hen lämnade den: 25, 50, 75 eller 100. */
  "scroll",
]);

/**
 * Sektionerna som mäts, sida för sida, i den ordning de står på sidan.
 *
 * NAMNGIVNA OCH INTE "VARJE ELEMENT". Ett klick på en koordinat går inte att läsa; "tryckte i
 * märkesrutnätet" gör det. Namnen sätts i koden med `data-matt="…"` och måste stå här för att räknas
 * — vägen in är öppen, och en lista är vad som hindrar den från att bli en fri textrad in i filen.
 *
 * ORDNINGEN ÄR SIDANS. Panelen ritar sektionerna uppifrån och ned, så att "sågs av 80 %, 40 %, 12 %"
 * läses som hur långt ned folk kommer.
 */
export const SEKTIONER = [
  // Säljarens startsida.
  "salj_hero",
  "salj_hur",
  "salj_marken",
  "salj_avgift",
  "salj_fot",
  // Butikens förstasida.
  "butik_hero",
  "butik_hur",
  "butik_lagret",
  "butik_ai_sok",
  "butik_marken",
  "butik_kategorier",
  "butik_nyinkommet",
  "butik_billigast",
  "butik_hero_liten",
  // Produktsidan.
  "produkt_bilder",
  "produkt_kop",
  "produkt_skick",
  "produkt_om",
  "produkt_matt",
  "produkt_chatt",
  // "Har du en möbel att sälja?" — sist på de flesta butikssidor.
  "salj_cta",
] as const;

const SEKTION_SET = new Set<string>(SEKTIONER);
const SCROLLDJUP = new Set([25, 50, 75, 100]);

const TILLATNA_PROPS = new Set([
  "sida",
  "vy",
  "fran",
  "host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "inbjudan",
  "affiliate",
  "enhet",
  "namn",
  "objekt",
  "djup",
  "kampanjkod",
]);

export interface BesoksRad {
  at: string;
  sess: string;
  uid: string | null;
  event: string;
  props: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Sidan som en etikett
// ---------------------------------------------------------------------------

/**
 * En adress som en sida — med id:n bortslipade.
 *
 * Panelen ska kunna säga "produktsidan visades 400 gånger", inte lista 400 produktsidor med en
 * visning var. Slugs får stå kvar (/butik/mobel/matbord): de är kategorier, och vilken kategori folk
 * landar i är precis vad en kampanj vill veta. Id:n blir `:id`. Görs HÄR och inte bara i klienten,
 * för att en öppen väg inte ska kunna fylla sidlistan med vad som helst.
 */
export function normaliseraSida(rå: unknown, vy?: unknown): string | null {
  if (typeof rå !== "string") return null;
  let s = rå.split(/[?#]/)[0].trim().toLowerCase();
  if (!s.startsWith("/")) return null;
  s = s
    // Inbjudan, affiliate och Trygg affärs inbjudan bär en kod eller ett token i sökvägen. Koden är
    // ingen sida, och token till en affär får inte ligga i en logg någon annan läser.
    .replace(/^\/(i|p|a)\/[^/]+/, "/$1/:kod")
    .replace(/\/lp-[a-z0-9]{4}-[a-z0-9]{4}(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/g, "/:id")
    .replace(/\/(?=[a-z0-9_-]*\d)[a-z0-9_-]{10,}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (!/^[a-z0-9/:._åäö-]{1,80}$/.test(s)) return null;
  // Säljflödet och profilen bor alla på "/" och byter skärm utan att byta adress. Skärmnamnet är
  // det enda som skiljer startsidan från filmningen, så det får stå bredvid — men bara i formen
  // App.tsx faktiskt använder.
  if (s === "/" && typeof vy === "string" && /^[a-z-]{1,24}$/i.test(vy) && vy !== "home") return `/ · ${vy}`;
  return s;
}

// ---------------------------------------------------------------------------
// Kanalen
// ---------------------------------------------------------------------------

export type Kanal =
  | "Direkt"
  | "Sök"
  | "Sociala medier"
  | "Marknadsplatser"
  | "Marknadssajten"
  | "Inbjudan"
  | "Affiliate"
  | "E-post"
  | "Offline"
  | "Kampanj"
  | "Övrigt";

const SOK = /(^|\.)(google|bing|duckduckgo|ecosia|yahoo|yandex|startpage|qwant|brave)\./;
const SOCIALT = /(^|\.)(facebook|fb|instagram|tiktok|linkedin|lnkd|twitter|x|t|reddit|pinterest|snapchat|youtube|threads|messenger|whatsapp)\.(com|co|me|net|se)$/;
const MARKNAD = /(^|\.)(blocket|tradera|sellpy|vinted|plick|ebay)\./;
const EPOST = /(^|\.)(mail\.google|outlook\.live|outlook\.office|mail\.yahoo|mail\.proton)\./;
const SOCIAL_KALLA = /^(facebook|fb|ig|instagram|tiktok|linkedin|twitter|x|reddit|pinterest|snapchat|youtube|meta|threads)$/;

/** Rensar ett värdnamn till det som går att gruppera på: utan www, utan l./m./lm.-omvägar. */
export function rensaHost(host: string | null): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/^(www|m|l|lm|mobile)\./, "");
  return /^[a-z0-9.-]{3,80}$/.test(h) ? h : null;
}

/**
 * Kanalen ett besök hör till, och källan inom den.
 *
 * ORDNINGEN ÄR REGELN. En inbjudan väger tyngst — den är en person som pekat på oss, oavsett om
 * länken delades på Facebook eller i ett sms — sedan affiliate, sedan en uttalad kampanj (UTM), och
 * först därefter värdnamnet. Ett besök utan något av det är Direkt: en inskriven adress, ett
 * bokmärke, eller en app som inte skickar referrer. Det sista är vanligare än man tror — många
 * länkar i Instagram och Messenger landar som Direkt — och därför finns UTM-fälten.
 */
export function kanalFor(props: Record<string, unknown>): { kanal: Kanal; kalla: string } {
  const str = (k: string) => (typeof props[k] === "string" && (props[k] as string).trim() ? (props[k] as string).trim().toLowerCase() : null);
  if (props.inbjudan === true) return { kanal: "Inbjudan", kalla: "inbjudningslänk" };
  if (props.affiliate === true) return { kanal: "Affiliate", kalla: "affiliatelänk" };

  const kalla = str("utm_source");
  const medium = str("utm_medium");
  if (kalla || medium) {
    const namn = kalla ?? medium ?? "okänd";
    if (medium && /e-?mail|mejl|nyhetsbrev|newsletter/.test(medium)) return { kanal: "E-post", kalla: namn };
    // Affischen och QR-koden har ingen referrer alls — utan märkningen är de omätbara.
    if (medium && /offline|print|qr|affisch|flyer/.test(medium)) return { kanal: "Offline", kalla: namn };
    if ((medium && /marknadsplats/.test(medium)) || MARKNAD.test(`${namn}.`)) return { kanal: "Marknadsplatser", kalla: namn };
    if (SOCIAL_KALLA.test(namn) || (medium && /social|paid_social|cpc_social/.test(medium))) return { kanal: "Sociala medier", kalla: namn };
    if (/google|bing/.test(namn) && medium && /cpc|ppc|paid|sok/.test(medium)) return { kanal: "Sök", kalla: `${namn} (betald)` };
    return { kanal: "Kampanj", kalla: namn };
  }

  const host = rensaHost(str("host"));
  if (!host) return { kanal: "Direkt", kalla: "direkt" };
  if (host === "loopa.nu") return { kanal: "Marknadssajten", kalla: host };
  if (host.endsWith(".loopa.nu")) return { kanal: "Direkt", kalla: "direkt" };
  if (EPOST.test(host)) return { kanal: "E-post", kalla: host };
  if (SOK.test(host)) return { kanal: "Sök", kalla: host };
  if (SOCIALT.test(host) || host === "t.co") return { kanal: "Sociala medier", kalla: host };
  if (MARKNAD.test(host)) return { kanal: "Marknadsplatser", kalla: host };
  return { kanal: "Övrigt", kalla: host };
}

// ---------------------------------------------------------------------------
// Minnet och skrivningen
// ---------------------------------------------------------------------------

const sessioner = new Map<string, BesoksRad[]>();
let laddad: Promise<void> | null = null;
let kedja: Promise<unknown> = Promise.resolve();
const SESSIONSTAK = 50_000;

function skrivIn(rad: BesoksRad): void {
  let rader = sessioner.get(rad.sess);
  if (!rader) {
    if (sessioner.size >= SESSIONSTAK) {
      const aldst = sessioner.keys().next().value;
      if (aldst !== undefined) sessioner.delete(aldst);
    }
    rader = [];
    sessioner.set(rad.sess, rader);
  }
  // Sektionerna och scrollen gör en vanlig session några rader längre per sida än förr.
  if (rader.length < 600) rader.push(rad);
}

async function ladda(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(BESOK_FIL(), "utf-8");
  } catch {
    return;
  }
  for (const rad of raw.split("\n")) {
    if (!rad.trim()) continue;
    try {
      const r = JSON.parse(rad) as BesoksRad;
      if (r?.sess && r.event && r.at) skrivIn(r);
    } catch {
      continue;
    }
  }
}

export function redo(): Promise<void> {
  laddad ??= ladda();
  return laddad;
}

function stada(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const ut: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!TILLATNA_PROPS.has(k)) continue;
    if (typeof v === "boolean") ut[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) ut[k] = Math.round(v);
    else if (typeof v === "string" && v.trim() && v.length <= 120) ut[k] = v.trim();
  }
  return ut;
}

/** Skriver en besöksrad. Faller aldrig — en mätning får inte fälla det den mäter. */
export async function spara(
  sess: string,
  event: string,
  props: Record<string, unknown> = {},
  uid: string | null = null,
): Promise<void> {
  try {
    if (!BESOKSHANDELSER.has(event)) return;
    const nyckel = sess.trim().slice(0, 40);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(nyckel)) return;
    const rensade = stada(props);
    if ("sida" in rensade) {
      const sida = normaliseraSida(rensade.sida, rensade.vy);
      if (sida) rensade.sida = sida;
      else delete rensade.sida;
    }
    if ("fran" in rensade) {
      const fran = normaliseraSida(rensade.fran);
      if (fran) rensade.fran = fran;
      else delete rensade.fran;
    }
    delete rensade.vy;
    if (event === "sida" && !rensade.sida) return;
    // De nya händelserna bär ett namn ur sin egen lista, eller ingen rad alls — samma regel som
    // flödets mikrosteg. Ett tal som inte är ett av fyra scrolldjup är inget scrolldjup.
    if (event === "handling") {
      if (typeof rensade.namn !== "string" || !KLIENTHANDELSER.has(rensade.namn)) return;
    } else if (event === "sektion" || event === "klick") {
      if (typeof rensade.namn !== "string" || !SEKTION_SET.has(rensade.namn) || !rensade.sida) return;
    } else {
      delete rensade.namn;
    }
    if (event === "scroll") {
      if (typeof rensade.djup !== "number" || !SCROLLDJUP.has(rensade.djup) || !rensade.sida) return;
    } else {
      delete rensade.djup;
    }
    if (event === "handling" && typeof rensade.objekt === "string" && /^lp-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(rensade.objekt)) {
      rensade.objekt = rensade.objekt.toUpperCase();
    } else {
      delete rensade.objekt;
    }
    // Kampanjlänken: koden slås upp här, och källan skrivs av servern — se data/kampanjer.ts. En
    // okänd kod är en gammal eller påhittad länk; besöket räknas då efter sin referrer som vanligt.
    if (event === "landning" && "kampanjkod" in rensade) {
      const { kampanjFor, utmFor } = await import("./kampanjer.js");
      const k = await kampanjFor(String(rensade.kampanjkod));
      if (k) Object.assign(rensade, utmFor(k), { kampanjkod: k.kod });
      else delete rensade.kampanjkod;
    } else {
      delete rensade.kampanjkod;
    }
    if ("host" in rensade) {
      const host = rensaHost(String(rensade.host));
      if (host) rensade.host = host;
      else delete rensade.host;
    }
    await redo();
    const rad: BesoksRad = {
      at: new Date().toISOString(),
      sess: nyckel,
      uid: typeof uid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(uid.trim()) ? uid.trim() : null,
      event,
      props: rensade,
    };
    skrivIn(rad);
    const text = JSON.stringify(rad) + "\n";
    kedja = kedja
      .then(async () => {
        await mkdir(DATA_KATALOG(), { recursive: true });
        await appendFile(BESOK_FIL(), text, "utf-8");
      })
      .catch(() => undefined);
    await kedja;
  } catch {
    // Tyst. Se filens topp.
  }
}

// ---------------------------------------------------------------------------
// Ett besök, hopsatt
// ---------------------------------------------------------------------------

export interface Besok {
  sess: string;
  uid: string | null;
  start: string;
  slut: string;
  kanal: Kanal;
  kalla: string;
  kampanj: string | null;
  /** Kampanjlänkens kod, när besöket kom in genom en. Se data/kampanjer.ts. */
  kampanjkod: string | null;
  landning: string | null;
  enhet: string | null;
  /**
   * Sidorna i ordning, med tiden till nästa sida. Sista sidan har ingen tid — den lämnades.
   * `djup` är hur långt ned besökaren kom på just den visningen, null när det inte mättes.
   */
  sidor: Array<{ sida: string; at: string; ms: number | null; djup: number | null }>;
  /** Butikshändelserna i besöket: öppnade en möbel, sökte, gick till kassan, köpte. */
  handlingar: Array<{ at: string; namn: string; sida: string | null; objekt: string | null }>;
  /** Sektioner som syntes, en gång per sidvisning. */
  sektioner: Array<{ at: string; sida: string; namn: string }>;
  /** Tryck i namngivna sektioner. */
  klick: Array<{ at: string; sida: string; namn: string }>;
}

/** Längre än så på en sida är en flik som låg öppen, inte en läsning. */
const MAX_SIDTID_MS = 30 * 60 * 1000;

function byggBesok(sess: string, rader: BesoksRad[]): Besok {
  const sorterade = [...rader].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // Bara den första landningen räknas: en omladdning bär samma referrer, eller ingen alls, och ska
  // inte göra ett besök från Google till ett direktbesök halvvägs.
  const landning = sorterade.find((r) => r.event === "landning");
  const { kanal, kalla } = kanalFor(landning?.props ?? {});
  const sidor: Besok["sidor"] = [];
  for (const r of sorterade) {
    if (r.event !== "sida" || typeof r.props.sida !== "string") continue;
    // Samma sida två gånger i rad är en omladdning eller en dubbelrapport, inte ett steg.
    if (sidor.length && sidor[sidor.length - 1].sida === r.props.sida) continue;
    sidor.push({ sida: r.props.sida, at: r.at, ms: null, djup: null });
  }
  for (let i = 0; i < sidor.length - 1; i += 1) {
    const ms = new Date(sidor[i + 1].at).getTime() - new Date(sidor[i].at).getTime();
    sidor[i].ms = ms >= 0 && ms <= MAX_SIDTID_MS ? ms : null;
  }
  const handlingar: Besok["handlingar"] = [];
  const sektioner: Besok["sektioner"] = [];
  const klick: Besok["klick"] = [];
  for (const r of sorterade) {
    const sida = typeof r.props.sida === "string" ? r.props.sida : null;
    const namn = typeof r.props.namn === "string" ? r.props.namn : null;
    if (r.event === "handling" && namn) {
      handlingar.push({ at: r.at, namn, sida, objekt: typeof r.props.objekt === "string" ? r.props.objekt : null });
    } else if (r.event === "sektion" && namn && sida) {
      sektioner.push({ at: r.at, sida, namn });
    } else if (r.event === "klick" && namn && sida) {
      klick.push({ at: r.at, sida, namn });
    } else if (r.event === "scroll" && sida && typeof r.props.djup === "number") {
      // Scrollen skickas när sidan LÄMNAS och hör till den senaste visningen av samma sida före den.
      for (let i = sidor.length - 1; i >= 0; i -= 1) {
        if (sidor[i].sida === sida && sidor[i].at <= r.at) {
          sidor[i].djup = Math.max(sidor[i].djup ?? 0, r.props.djup);
          break;
        }
      }
    }
  }
  const lp = landning?.props ?? {};
  return {
    sess,
    uid: sorterade.find((r) => r.uid)?.uid ?? null,
    start: sorterade[0].at,
    slut: sorterade[sorterade.length - 1].at,
    kanal,
    kalla,
    kampanj: typeof lp.utm_campaign === "string" ? lp.utm_campaign.toLowerCase() : null,
    kampanjkod: typeof lp.kampanjkod === "string" ? lp.kampanjkod : null,
    landning: typeof lp.sida === "string" ? lp.sida : (sidor[0]?.sida ?? null),
    enhet: typeof lp.enhet === "string" ? lp.enhet : null,
    sidor,
    handlingar,
    sektioner,
    klick,
  };
}

export async function allaBesok(): Promise<Besok[]> {
  await redo();
  const ut: Besok[] = [];
  for (const [sess, rader] of sessioner) if (rader.length) ut.push(byggBesok(sess, rader));
  return ut.sort((a, b) => (a.start < b.start ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Läsningen: trafiken som panelen visar den
// ---------------------------------------------------------------------------

/** Ett konto som panelen kan sätta källa på. Formen `listAccounts` redan lämnar. */
export interface KontoIn {
  id: string;
  name: string | null;
  email: string | null;
  signedUpAt: string | null;
  signupApproximate: boolean;
  isAdmin: boolean;
}

export interface KanalRad {
  kanal: string;
  besok: number;
  /** Besök där ett konto loggade in. */
  medKonto: number;
  /** Nya konton vars FÖRSTA kända besök kom den här vägen. */
  nyaKonton: number;
  /** Besök som gick vidare från startsidan in i säljflödet (filmningen eller längre). */
  paborjade: number;
  /** Besök som nådde ett intygat kort. */
  intygade: number;
  /** Median antal sidor per besök. */
  sidorMedian: number;
  /** Andel besök med en enda sida, 0–1. */
  studs: number;
}

export interface SidRad {
  sida: string;
  visningar: number;
  besok: number;
  /** Gånger besöket BÖRJADE här. */
  ingang: number;
  /** Gånger besöket SLUTADE här. */
  utgang: number;
  /** Median i millisekunder till nästa sida. Null när ingen gick vidare. */
  tidMedianMs: number | null;
}

export interface Overgang {
  fran: string;
  till: string;
  antal: number;
}

export interface NyttKonto {
  id: string;
  namn: string | null;
  registrerad: string;
  ungefarligt: boolean;
  kanal: string | null;
  kalla: string | null;
  kampanj: string | null;
  landning: string | null;
  /** Sidorna under besöket där kontot först syntes, högst åtta. */
  vag: string[];
  /** Sant när kontot redan nått ett intygat kort. */
  intygat: boolean;
}

export interface Dag {
  dag: string;
  besok: number;
  nyaKonton: number;
  intygade: number;
}

export interface TrafikSvar {
  dagar: number;
  fran: string;
  summering: {
    besok: number;
    sidvisningar: number;
    nyaKonton: number;
    nyaKontonUtanKalla: number;
    paborjade: number;
    intygade: number;
    /** Besök som gick vidare från första sidan — motsatsen till att lämna direkt. */
    flerSidor: number;
    /** Besök där ett konto var inloggat. */
    medKonto: number;
    /** Konton som syntes i mer än ett besök, på olika dagar, inom perioden. */
    atervandande: number;
  };
  kanaler: KanalRad[];
  kallor: Array<KanalRad & { kanal: string; kalla: string }>;
  kampanjer: Array<{ kampanj: string; besok: number; nyaKonton: number; intygade: number }>;
  sidor: SidRad[];
  overgangar: Overgang[];
  /** De vanligaste vägarna från landning, tre sidor långa. */
  vagar: Array<{ vag: string[]; antal: number }>;
  perDag: Dag[];
  nyaKonton: NyttKonto[];
  /** Första besöket mätningen känner till. Allt före det är okänt, inte noll. */
  matningSedan: string | null;
}

const FORSTA_ARBETSSTEG = new Set<string>(STEG.slice(1));

function median(tal: number[]): number {
  if (!tal.length) return 0;
  const s = [...tal].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Trafiken för en period.
 *
 * REN FUNKTION, så att testerna kan mata den utan disk. Servervägen hämtar besöken, flödena och
 * kontona och lämnar dem hit.
 *
 * ADMINERNAS EGNA BESÖK RÄKNAS INTE. Den som sitter i panelen och klickar runt i butiken för att se
 * att något fungerar är inte trafik, och i en tidig produkt kan det vara en tredjedel av alla
 * sidvisningar.
 */
export function trafik(
  besokAlla: Besok[],
  flodenAlla: FlodesSession[],
  konton: KontoIn[],
  dagar: number,
  nu = new Date(),
): TrafikSvar {
  const fran = new Date(nu.getTime() - dagar * 24 * 60 * 60 * 1000).toISOString();
  const admins = new Set(konton.filter((k) => k.isAdmin).map((k) => k.id));
  const flodePerSess = new Map(flodenAlla.map((f) => [f.sess, f]));
  const intygadeUid = new Set(flodenAlla.filter((f) => f.intygat && f.uid).map((f) => f.uid!));

  const allaUtomAdmin = besokAlla.filter((b) => !(b.uid && admins.has(b.uid)));
  const besok = allaUtomAdmin.filter((b) => b.start >= fran);

  // Kontots FÖRSTA besök över hela loggen, inte bara perioden: det är där kontot kom ifrån.
  const forstaBesok = new Map<string, Besok>();
  for (const b of [...allaUtomAdmin].reverse()) if (b.uid && !forstaBesok.has(b.uid)) forstaBesok.set(b.uid, b);

  const nya = konton
    .filter((k) => !k.isAdmin && k.signedUpAt && k.signedUpAt >= fran)
    .sort((a, b) => (a.signedUpAt! < b.signedUpAt! ? 1 : -1));
  const nyaKonton: NyttKonto[] = nya.map((k) => {
    const b = forstaBesok.get(k.id);
    return {
      id: k.id,
      namn: k.name || k.email,
      registrerad: k.signedUpAt!,
      ungefarligt: k.signupApproximate,
      kanal: b?.kanal ?? null,
      kalla: b?.kalla ?? null,
      kampanj: b?.kampanj ?? null,
      landning: b?.landning ?? null,
      vag: b ? b.sidor.slice(0, 8).map((s) => s.sida) : [],
      intygat: intygadeUid.has(k.id),
    };
  });
  const nyttKontoPerSess = new Map<string, number>();
  for (const k of nya) {
    const b = forstaBesok.get(k.id);
    if (b) nyttKontoPerSess.set(b.sess, (nyttKontoPerSess.get(b.sess) ?? 0) + 1);
  }

  const paborjad = (b: Besok) => flodePerSess.get(b.sess)?.besokta.some((s) => FORSTA_ARBETSSTEG.has(s)) ?? false;
  const intygad = (b: Besok) => flodePerSess.get(b.sess)?.intygat ?? false;

  function rad(grupp: Besok[]): Omit<KanalRad, "kanal"> {
    return {
      besok: grupp.length,
      medKonto: grupp.filter((b) => b.uid).length,
      nyaKonton: grupp.reduce((n, b) => n + (nyttKontoPerSess.get(b.sess) ?? 0), 0),
      paborjade: grupp.filter(paborjad).length,
      intygade: grupp.filter(intygad).length,
      sidorMedian: median(grupp.map((b) => b.sidor.length)),
      studs: grupp.length ? grupp.filter((b) => b.sidor.length <= 1).length / grupp.length : 0,
    };
  }

  const grupperaPa = <K extends string>(nyckel: (b: Besok) => K | null) => {
    const m = new Map<K, Besok[]>();
    for (const b of besok) {
      const k = nyckel(b);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return m;
  };

  const kanaler = [...grupperaPa((b) => b.kanal)]
    .map(([kanal, g]) => ({ kanal, ...rad(g) }))
    .sort((a, b) => b.besok - a.besok);
  const kallor = [...grupperaPa((b) => `${b.kanal}\u0000${b.kalla}`)]
    .map(([k, g]) => {
      const [kanal, kalla] = k.split("\u0000");
      return { kanal, kalla, ...rad(g) };
    })
    .sort((a, b) => b.besok - a.besok)
    .slice(0, 30);
  const kampanjer = [...grupperaPa((b) => b.kampanj)]
    .map(([kampanj, g]) => {
      const r = rad(g);
      return { kampanj, besok: r.besok, nyaKonton: r.nyaKonton, intygade: r.intygade };
    })
    .sort((a, b) => b.besok - a.besok);

  // Sidorna och övergångarna.
  const sidMap = new Map<string, { visningar: number; besok: Set<string>; ingang: number; utgang: number; tider: number[] }>();
  const overgangMap = new Map<string, number>();
  const vagMap = new Map<string, number>();
  for (const b of besok) {
    b.sidor.forEach((s, i) => {
      let r = sidMap.get(s.sida);
      if (!r) {
        r = { visningar: 0, besok: new Set(), ingang: 0, utgang: 0, tider: [] };
        sidMap.set(s.sida, r);
      }
      r.visningar += 1;
      r.besok.add(b.sess);
      if (i === 0) r.ingang += 1;
      if (i === b.sidor.length - 1) r.utgang += 1;
      if (s.ms !== null) r.tider.push(s.ms);
      const nasta = b.sidor[i + 1];
      if (nasta) {
        const k = `${s.sida}\u0000${nasta.sida}`;
        overgangMap.set(k, (overgangMap.get(k) ?? 0) + 1);
      }
    });
    if (b.sidor.length >= 2) {
      const k = b.sidor.slice(0, 3).map((s) => s.sida).join("\u0000");
      vagMap.set(k, (vagMap.get(k) ?? 0) + 1);
    }
  }
  const sidor: SidRad[] = [...sidMap]
    .map(([sida, r]) => ({
      sida,
      visningar: r.visningar,
      besok: r.besok.size,
      ingang: r.ingang,
      utgang: r.utgang,
      tidMedianMs: r.tider.length ? median(r.tider) : null,
    }))
    .sort((a, b) => b.visningar - a.visningar)
    .slice(0, 40);
  const overgangar = [...overgangMap]
    .map(([k, antal]) => {
      const [f, t] = k.split("\u0000");
      return { fran: f, till: t, antal };
    })
    .sort((a, b) => b.antal - a.antal)
    .slice(0, 25);
  const vagar = [...vagMap]
    .map(([k, antal]) => ({ vag: k.split("\u0000"), antal }))
    .sort((a, b) => b.antal - a.antal)
    .slice(0, 15);

  // En rad per dag, också de tomma: en dag utan besök är ett svar, inte en lucka i diagrammet.
  const perDagMap = new Map<string, Dag>();
  for (let i = Math.min(dagar, 120) - 1; i >= 0; i -= 1) {
    const dag = new Date(nu.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    perDagMap.set(dag, { dag, besok: 0, nyaKonton: 0, intygade: 0 });
  }
  for (const b of besok) {
    const d = perDagMap.get(b.start.slice(0, 10));
    if (!d) continue;
    d.besok += 1;
    if (intygad(b)) d.intygade += 1;
  }
  for (const k of nya) {
    const d = perDagMap.get(k.signedUpAt!.slice(0, 10));
    if (d) d.nyaKonton += 1;
  }

  // Återvändande: samma konto i besök på minst två olika dagar.
  const dagarPerUid = new Map<string, Set<string>>();
  for (const b of besok) if (b.uid) dagarPerUid.set(b.uid, (dagarPerUid.get(b.uid) ?? new Set()).add(b.start.slice(0, 10)));

  return {
    dagar,
    fran,
    summering: {
      besok: besok.length,
      sidvisningar: besok.reduce((n, b) => n + b.sidor.length, 0),
      nyaKonton: nya.length,
      nyaKontonUtanKalla: nyaKonton.filter((k) => !k.kanal).length,
      paborjade: besok.filter(paborjad).length,
      intygade: besok.filter(intygad).length,
      flerSidor: besok.filter((b) => b.sidor.length > 1).length,
      medKonto: besok.filter((b) => b.uid).length,
      atervandande: [...dagarPerUid.values()].filter((d) => d.size > 1).length,
    },
    kanaler,
    kallor,
    kampanjer,
    sidor,
    overgangar,
    vagar,
    perDag: [...perDagMap.values()],
    nyaKonton,
    matningSedan: besokAlla.length ? besokAlla[besokAlla.length - 1].start : null,
  };
}

/** Bara för tester: glöm allt och läs om vid nästa fråga. */
export function nollstall(): void {
  sessioner.clear();
  laddad = null;
}

/**
 * Stryker kontots besök ur filen: varje session där kontot loggat in. Antalet sessioner.
 * Se raderaKonto.ts. Hela sessionen, av samma skäl som i flödet — sidorna före inloggningen är samma
 * besök av samma person.
 */
export async function glomKonto(userId: string): Promise<number> {
  const jobb = kedja.then(async () => {
    let raw: string;
    try {
      raw = await readFile(BESOK_FIL(), "utf-8");
    } catch {
      return 0;
    }
    const rader = raw.split("\n").filter((r) => r.trim());
    const tolkade = rader.map((r) => {
      try {
        return JSON.parse(r) as BesoksRad;
      } catch {
        return null;
      }
    });
    const deras = new Set(tolkade.filter((r) => r && r.uid === userId).map((r) => r!.sess));
    if (!deras.size) return 0;
    const kvar = rader.filter((_, i) => !(tolkade[i] && deras.has(tolkade[i]!.sess)));
    await writeFile(BESOK_FIL(), kvar.length ? kvar.join("\n") + "\n" : "", "utf-8");
    sessioner.clear();
    laddad = null;
    return deras.size;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}
