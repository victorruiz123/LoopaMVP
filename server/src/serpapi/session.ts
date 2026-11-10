/**
 * Sessioner och bildvärd för SerpApi-flödet (identifieringen av modellen, måtten och referensbilderna via Googles AI-läge).
 *
 * En SESSION motsvarar ett samtal med Googles AI-läge: omslagsbilden, token som fortsätter samtalet (`subsequent_request_token`), frågorna och svaren hittills, och de redan
 * pågående bildsökningarna. Hålls i minnet (ett samtal lever några minuter) och glöms efter två timmar.
 *
 * BILDVÄRDEN: SerpApi tar emot bilden som en ADRESS (`image_url`), inte som en fil. Omslagsbilden läggs därför ut på en slumpmässig, kortlivad adress (/api/serpapi/img/<nyckel>) som SerpApi
 * hämtar den från. Adressen går inte att gissa (24 slumpbyte), gäller en halvtimme och tas bort när flödet är slut. Kräver att servern nås utifrån, se `publicBase`.
 *
 * TAKEN skyddar kvoten och plånboken (varje sökning hos SerpApi kostar en kredit):
 *   - dygnstaket för hela servern, SERPAPI_DAILY_CAP (förval 200 sökningar). Är det nått går inget mer iväg förrän nästa dygn, och `serpApiEnabled` blir false så att webben låter den
 *     vanliga identifieringen ta över i stället för att visa ett fel;
 *   - taket per inloggad och dygn, SERPAPI_MAX_SESSIONS_PER_USER (förval 30 samtal), så att ett enda konto inte kan tömma dygnstaket;
 *   - taken per samtal nedan.
 */

import { randomBytes } from "node:crypto";
import { SerpApiError, serpApiKey } from "./client.js";

export interface Turn {
  label: string;
  question: string;
  answer: string;
  /** SerpApis id för sökningen och Googles egen adress, för att kunna granska den i efterhand. */
  searchId: string | null;
  googleUrl: string | null;
  ms: number;
  /** Fortsatte frågan ett tidigare samtal (subsequent_request_token), och följde bilden med? */
  continued: boolean;
  withImage: boolean;
  error?: string;
}

export interface ImageRowsGroup {
  model: string;
  rows: Array<{ src: string; alt: string; w: number; h: number; source?: string; page?: string }>;
}

export interface Session {
  id: string;
  owner: string;
  created: number;
  lastUsed: number;
  imageName: string | null;
  imageUrl: string | null;
  /** Token som fortsätter samtalet; null före första svaret. */
  token: string | null;
  turns: Turn[];
  /** Adresserna AI-läget stött sig på, ackumulerade över samtalet (som sidans länkar gör i skalet). */
  links: string[];
  /** Frågor till AI-läget och bildsökningar hittills, mot taken per session. */
  aiCalls: number;
  imageCalls: number;
  imgCache: Map<string, Promise<ImageRowsGroup>>;
  /** Frågorna i ett samtal ställs i tur och ordning: en uppföljning bygger på förra svarets token. */
  queue: Promise<unknown>;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const IMAGE_TTL_MS = 30 * 60 * 1000;
export const MAX_AI_CALLS_PER_SESSION = Number(process.env.SERPAPI_MAX_AI_PER_SESSION ?? 12);
export const MAX_IMAGE_CALLS_PER_SESSION = Number(process.env.SERPAPI_MAX_IMAGES_PER_SESSION ?? 30);

const sessions = new Map<string, Session>();
const images = new Map<string, { buf: Buffer; mime: string; exp: number }>();

const extFor = (mime: string): string => (/png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : "jpg");

export function sweep(now = Date.now()): void {
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS) endSession(id);
  for (const [name, im] of images) if (im.exp < now) images.delete(name);
}

export function createSession(owner: string): Session {
  sweep();
  const s: Session = {
    id: randomBytes(12).toString("hex"),
    owner,
    created: Date.now(),
    lastUsed: Date.now(),
    imageName: null,
    imageUrl: null,
    token: null,
    turns: [],
    links: [],
    aiCalls: 0,
    imageCalls: 0,
    imgCache: new Map(),
    queue: Promise.resolve(),
  };
  sessions.set(s.id, s);
  return s;
}

/** Sessionen, men bara för sin ägare: en annan inloggning får samma svar som för en session som inte finns. */
export function getSession(id: unknown, owner: string): Session | null {
  const s = typeof id === "string" ? sessions.get(id) : undefined;
  if (!s || s.owner !== owner) return null;
  s.lastUsed = Date.now();
  return s;
}

export function endSession(id: string): void {
  const s = sessions.get(id);
  if (s?.imageName) images.delete(s.imageName);
  // En rad per samtal till driftloggen: vad flödet kostade i sökningar (en kredit styck). Ger underlag till vad en identifiering faktiskt kostar i drift.
  if (s && (s.aiCalls > 0 || s.imageCalls > 0)) {
    console.info(`[serpapi] samtal ${s.id.slice(0, 8)} slut: ${s.aiCalls} frågor till AI-läget + ${s.imageCalls} bildsökningar = ${s.aiCalls + s.imageCalls} sökningar; dygnet hittills ${dayCount} av ${dailyCap()}`);
  }
  sessions.delete(id);
}

/** Lägger ut en bild och ger tillbaka namnet (nyckel.ändelse) som adressen byggs på. */
export function storeImage(buf: Buffer, mime: string): string {
  sweep();
  const name = `${randomBytes(24).toString("base64url")}.${extFor(mime)}`;
  images.set(name, { buf, mime, exp: Date.now() + IMAGE_TTL_MS });
  return name;
}

export function getImage(name: string): { buf: Buffer; mime: string } | null {
  const im = images.get(name);
  if (!im || im.exp < Date.now()) return null;
  return { buf: im.buf, mime: im.mime };
}

/**
 * Serverns adress utifrån, utan snedstreck sist — den SerpApi hämtar bilden från. Null när ingen går att få fram: SerpApi kan då inte hämta bilden.
 *
 * 1. SERPAPI_PUBLIC_URL, om den är satt (lokalt: adressen till en tunnel som bara släpper igenom /api/serpapi/img/; se docs/serpapi.md).
 * 2. LOOPA_PUBLIC_URL. MEN: i drift är den marknadsdomänen (https://loopa.nu), och den serveras av Cloudflare Pages — /api/serpapi/img/ är ingen av Workerns rutter
 *    (deploy/cloudflare/loopa-router.js), så en bild på loopa.nu/api/… ger 404. Servern bakom tunneln nås på app.loopa.nu, och det är dit SerpApi ska. Därför översätts loopa.nu till app.loopa.nu här.
 */
export function publicBase(): string | null {
  const explicit = (process.env.SERPAPI_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(explicit)) return explicit;
  const loopa = (process.env.LOOPA_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(loopa)) return null;
  try {
    const u = new URL(loopa);
    if (/^(www\.)?loopa\.nu$/i.test(u.hostname)) return "https://app.loopa.nu";
  } catch {
    return null;
  }
  return loopa;
}

// --- Taken ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

let dayKey = "";
let dayCount = 0;
const ownerDay = new Map<string, number>();

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};

export const dailyCap = (): number => num(process.env.SERPAPI_DAILY_CAP, 200);
export const ownerSessionCap = (): number => num(process.env.SERPAPI_MAX_SESSIONS_PER_USER, 30);

/** Nollar räknarna när dygnet byter (UTC). */
function rollDay(now: Date): void {
  const key = now.toISOString().slice(0, 10);
  if (key !== dayKey) {
    dayKey = key;
    dayCount = 0;
    ownerDay.clear();
  }
}

/** Räknar ETT anrop mot dygnstaket (kastar när det är nått). Anropas strax före varje sökning, så ett nekat anrop kostar ingenting. */
export function chargeSearch(now = new Date()): number {
  rollDay(now);
  if (dayCount >= dailyCap()) throw new SerpApiError(`Dygnstaket för SerpApi-sökningar (${dailyCap()}) är nått. Höj SERPAPI_DAILY_CAP i server/.env om det är meningen.`);
  dayCount += 1;
  return dayCount;
}

/** Räknar ETT nytt samtal mot den inloggades dygnstak (kastar när det är nått). Anropas innan samtalet skapas. */
export function chargeOwnerSession(owner: string, now = new Date()): number {
  rollDay(now);
  const n = (ownerDay.get(owner) ?? 0) + 1;
  if (n > ownerSessionCap()) throw new SerpApiError(`Kontot har nått dygnets tak för SerpApi-samtal (${ownerSessionCap()}).`);
  ownerDay.set(owner, n);
  return n;
}

export const searchesToday = (): number => {
  rollDay(new Date());
  return dayCount;
};

/**
 * Ska webben använda SerpApi-flödet just nu? Annars gör den som förut (servern identifierar själv). Svaret bygger på det servern själv kan avgöra utan att kosta en sökning:
 * avstängt med LOOPA_SERPAPI=0, nyckel saknas, ingen publik adress för bilden, eller dygnstaket nått. Webben frågar vid varje uppladdning, så ett nått tak eller en saknad nyckel ger den
 * vanliga identifieringen i stället för ett felmeddelande.
 */
export function serpApiEnabled(): { enabled: boolean; reason: string | null } {
  if (process.env.LOOPA_SERPAPI?.trim() === "0") return { enabled: false, reason: "avstängt (LOOPA_SERPAPI=0)" };
  if (!serpApiKey()) return { enabled: false, reason: "SERPAPI_API_KEY saknas" };
  if (!publicBase()) return { enabled: false, reason: "ingen publik adress för bilden (SERPAPI_PUBLIC_URL)" };
  if (searchesToday() >= dailyCap()) return { enabled: false, reason: `dygnstaket (${dailyCap()}) är nått` };
  return { enabled: true, reason: null };
}

/** Bara för test. */
export function resetForTests(): void {
  sessions.clear();
  images.clear();
  ownerDay.clear();
  dayKey = "";
  dayCount = 0;
}
