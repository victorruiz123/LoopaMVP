import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isAdminEmail } from "./admin.js";
import { userFromRequest } from "./supabaseAuth.js";

/**
 * Vem ett anrop mot /api kommer ifrån.
 *
 * `id` är detsamma som ett jobbs `ownerId`. Det är hela poängen: ägarskapskontrollen blir en
 * jämförelse mellan två strängar, oavsett om anroparen är en inloggad säljare eller ett mätskript.
 */
export interface Identity {
  id: string;
  kind: "user" | "service";
  /** Adressen Supabase bekräftat. Null för maskinkontot och för anrop som kommer med bildkakan. */
  email: string | null;
  /** Får LÄSA andras annonser, aldrig skriva i dem. Se admin.ts för vem det är och varför. */
  isAdmin: boolean;
}

/**
 * Maskinkonto för mätning och regressionskörningar.
 *
 * Projektets viktigaste verktyg är mätharnessen, och de har inget Supabase-konto. Utan en väg in för
 * dem hade auth betytt att mätningen antingen slutade fungera eller fick en bakdörr utan ägare. Det
 * här är varken: nyckeln ger EN identitet, jobben den skapar ägs av den identiteten, och samma
 * ägarskapskontroll gäller för den som för alla andra.
 *
 * Utan nyckel i miljön finns kontot inte alls.
 */
const serviceKey = () => process.env.CONDITION_SERVICE_KEY ?? "";
const serviceOwner = () => process.env.CONDITION_SERVICE_OWNER ?? "service";

/**
 * Bildkakan.
 *
 * Bilderna sätts som `src` på `<img>`, och ett `<img>` kan inte bära ett Authorization-huvud. Innan
 * det här var därför bildvägarna öppna för vem som helst som kände till jobb-id:t — vilket gjorde
 * ägarskapskontrollen på själva jobbet till en halv åtgärd, eftersom det som faktiskt är känsligt är
 * fotografierna av någons hem.
 *
 * Kakan sätts av /api/session mot ett giltigt Supabase-token, är HttpOnly och signerad, och godtas
 * BARA för GET. En kaka som fick utföra skrivningar hade varit en CSRF-väg in i flödet.
 */
const COOKIE_NAME = "loopa_media";
const COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_PATH = "/api/jobs";

/**
 * Utan konfigurerad hemlighet slumpas en fram vid start. Då slutar utfärdade kakor gälla vid varje
 * omstart — hanterbart lokalt, fel i drift, och därför en varning värd att se.
 */
/**
 * Läses LAT, inte vid modulinläsning.
 *
 * server.ts kallar process.loadEnvFile i sin egen kropp, och ESM kör alla importer före den. En
 * konstant på toppnivå här hade därför alltid sett en tom miljö: nyckeln i server/.env fanns, men
 * lästes en tiondels sekund för tidigt. Det yttrade sig som att maskinkontot inte gick att logga in
 * på trots rätt nyckel.
 */
let secret: string | null = null;
let ephemeral = false;
function mediaSecret(): string {
  if (secret === null) {
    secret = process.env.MEDIA_COOKIE_SECRET ?? randomBytes(32).toString("hex");
    ephemeral = !process.env.MEDIA_COOKIE_SECRET;
  }
  return secret;
}

/** Anropa efter att miljön lästs in — värdet avgörs vid första användningen av hemligheten. */
export function mediaSecretIsEphemeral(): boolean {
  mediaSecret();
  return ephemeral;
}

const b64url = (b: Buffer) => b.toString("base64url");
const sign = (payload: string) => b64url(createHmac("sha256", mediaSecret()).update(payload).digest());

/** Konstant tid, och tål olika längd — `timingSafeEqual` kastar annars på längdskillnad. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf-8");
  const y = Buffer.from(b, "utf-8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Rollen följer MED i kakan, den slås inte upp igen.
 *
 * Adminpanelen visar andras kort, och miniatyrerna på dem hämtas av `<img>` — som bara har kakan att
 * legitimera sig med. Utan rollen i kakan hade panelen visat rader med trasiga bilder. Kakan är
 * signerad, så flaggan går inte att sätta själv; priset är att en ändrad adminlista slår igenom på
 * bilderna först vid nästa inloggning, inom ett dygn.
 */
export function issueMediaCookie(userId: string, secure: boolean, isAdmin = false): string {
  const expires = Date.now() + COOKIE_TTL_MS;
  const payload = `${userId}.${expires}.${isAdmin ? "a" : "u"}`;
  const value = `${payload}.${sign(payload)}`;
  return [
    `${COOKIE_NAME}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearMediaCookie(): string {
  return `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function readCookie(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

function userFromCookie(req: IncomingMessage): Identity | null {
  const value = readCookie(req);
  if (!value) return null;
  const cut = value.lastIndexOf(".");
  if (cut < 0) return null;
  const payload = value.slice(0, cut);
  if (!sameSecret(value.slice(cut + 1), sign(payload))) return null;

  // `userId.expires.roll`. Rollen saknas i kakor utfärdade före adminpanelen — de gäller dygnet ut
  // och ska fortsätta göra det, som vanliga användare. Läses bakifrån: id:t kan innehålla punkter.
  const parts = payload.split(".");
  const last = parts[parts.length - 1];
  const role = last === "a" || last === "u" ? (parts.pop() as string) : "u";
  const expires = Number(parts.pop());
  const userId = parts.join(".");
  if (!userId || !Number.isFinite(expires) || expires < Date.now()) return null;
  return { id: userId, kind: "user", email: null, isAdmin: role === "a" };
}

/**
 * Ordningen är avsiktlig: token först, sedan maskinnyckel, sedan kakan — och kakan bara för GET.
 *
 * Faller stängt. Är Supabase onåbart returnerar `userFromRequest` null och anropet avvisas; det är
 * skillnaden mot hur den används på andra ställen, där ett okänt anrop får fortsätta som utloggat.
 */
export async function identityFromRequest(req: IncomingMessage): Promise<Identity | null> {
  const user = await userFromRequest(req);
  if (user) return { id: user.id, kind: "user", email: user.email, isAdmin: isAdminEmail(user.email) };

  const header = req.headers["x-api-key"];
  const provided = Array.isArray(header) ? header[0] : header;
  const key = serviceKey();
  if (key && provided && sameSecret(provided, key)) {
    return { id: serviceOwner(), kind: "service", email: null, isAdmin: false };
  }

  if (req.method === "GET") return userFromCookie(req);
  return null;
}
