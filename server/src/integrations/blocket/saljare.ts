/**
 * Säljarens postnummer — det Blocket-annonsen läggs på.
 *
 * VARFÖR INTE EN SERVERINSTÄLLNING. Postnumret satt förut i BLOCKET_POSTNUMMER, ett och samma för
 * varje annons. Men annonsen ligger på ett delat Blocket-konto och möblerna står hos säljarna, spridda
 * över stan: ett fast postnummer placerade varenda möbel på samma adress, och köparen som valde efter
 * avstånd valde efter en adress där möbeln aldrig stått.
 *
 * VAR DET FINNS. Registreringen samlar in adressen (AuthScreen) och lägger den i Supabase som
 * `user_metadata.adress`. Den läses på två sätt, i den ordningen:
 *
 *   1. PÅ JOBBET. När säljaren trycker "Sälj med Loopa" bär anropet deras egen token, och då skrivs
 *      postnumret in på jobbet (`sellerPostalCode`). Ingen hemlighet behövs — det är samma
 *      /auth/v1/user som inloggningen redan frågar.
 *   2. PÅ KONTOT, med servicenyckeln. För jobb som hamnade i kön innan fältet fanns, och för en säljare
 *      som lagt till adressen efteråt. Godkännandet sker i panelen, med ADMINENS token — säljarens
 *      finns inte att tillgå där, så utan nyckeln finns ingen annan väg.
 *
 * Saknas båda publiceras inget. En annons utan postnummer vägrar Blocket ändå, och ett gissat är
 * värre än inget: det står utåt, under möbeln, som om det vore sant.
 */

import { ownerIdOf } from "../../jobStore.js";
import { supabaseAnonKey, supabaseUrl } from "../../supabaseAuth.js";
import type { ConditionJob } from "../../types.js";

/** Fem siffror, eller null. "112 23", "11223" och "112-23" är samma postnummer. */
export function normaliseraPostnummer(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const siffror = String(raw).replace(/\D/g, "");
  return siffror.length === 5 ? siffror : null;
}

/** Postnumret ur ett kontos `user_metadata`, som registreringen skrev det. */
export function postnummerUrMetadata(metadata: unknown): string | null {
  const adress = (metadata as { adress?: { postnummer?: unknown } | null } | null | undefined)?.adress;
  return normaliseraPostnummer(adress?.postnummer);
}

/**
 * Postnumret på kontot som äger en token. Används när säljaren själv anropar.
 *
 * Tyst vid fel: ett uteblivet svar från Supabase får aldrig fälla säljarens tryck. Postnumret går att
 * hämta igen vid godkännandet (steg 2 ovan).
 */
export async function postnummerForToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey() },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user_metadata?: unknown };
    return postnummerUrMetadata(body.user_metadata);
  } catch {
    return null;
  }
}

/**
 * Postnumret på ett konto, slaget upp med servicenyckeln.
 *
 * Utan nyckeln görs inget anrop alls — den publika anon-nyckeln får inte läsa andras konton, och ska
 * inte kunna det.
 */
export async function postnummerForAnvandare(userId: string): Promise<string | null> {
  const nyckel = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!nyckel) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { apikey: nyckel, Authorization: `Bearer ${nyckel}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user_metadata?: unknown };
    return postnummerUrMetadata(body.user_metadata);
  } catch {
    return null;
  }
}

/** Postnumret annonsen ska ligga på: jobbets eget först, annars ägarens konto. */
export async function saljarensPostnummer(job: ConditionJob): Promise<string | null> {
  const paJobbet = normaliseraPostnummer(job.sellerPostalCode);
  if (paJobbet) return paJobbet;
  const agare = ownerIdOf(job);
  return agare ? postnummerForAnvandare(agare) : null;
}
