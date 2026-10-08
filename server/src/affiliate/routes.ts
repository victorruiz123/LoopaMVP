/**
 * /api/salj/affiliate — användarens affiliate-länk och vad den gett.
 *
 *   GET  /api/salj/affiliate           länken, registreringar, annonser, sålda, intjänat
 *   POST /api/salj/affiliate/ansprak   { kod } — användaren kom via en affiliate-länk
 *
 * /api/admin/affiliate — provisionerna och den manuella utbetalningen.
 *
 *   GET  /api/admin/affiliate          en rad per affiliate, väntande först
 *   POST /api/admin/affiliate/utbetald { ids } — admin har betalat ut för hand
 *
 * UNDER /api/salj OCH /api/admin, inte en egen namnrymd: Cloudflare-Workern binder API-vägarna en och
 * en (deploy/cloudflare/wrangler.toml), och båda är redan bundna. Se referral/routes.ts för samma val.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken, supabaseAnonKey, supabaseUrl } from "../supabaseAuth.js";
import { adminOversikt, gorAnsprak, harAnnonser, markeraUtbetalda, oversikt, type AnsprakKonto } from "./regler.js";

type Svara = (res: ServerResponse, status: number, body: unknown) => void;
type LasKropp = <T>(req: IncomingMessage) => Promise<T>;

/**
 * Kontot bakom anropets token, med skapelsetiden — det anspråket behöver för att veta att kontot är
 * nytt. Läst med användarens EGEN token; ingen servicenyckel behövs. Null när Supabase inte svarar.
 */
async function kontoFor(req: IncomingMessage): Promise<AnsprakKonto | null> {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey() },
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { id?: string; email?: string | null; created_at?: string | null };
    return b.id ? { id: b.id, email: b.email ?? null, createdAt: b.created_at ?? null } : null;
  } catch {
    return null;
  }
}

/** Segmenten EFTER /api/salj. Innanför inloggningsgrinden. */
export async function handleAffiliate(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  svara: Svara,
  lasKropp: LasKropp,
): Promise<boolean> {
  if (segments[0] !== "affiliate") return false;

  const konto = await kontoFor(req);
  if (!konto) {
    svara(res, 503, { error: "Vi når inte kontot just nu. Försök igen om en stund." });
    return true;
  }

  if (segments.length === 1 && req.method === "GET") {
    svara(res, 200, await oversikt(konto.id, konto.email));
    return true;
  }

  if (segments.length === 2 && segments[1] === "ansprak" && req.method === "POST") {
    const body = await lasKropp<{ kod?: unknown }>(req).catch(() => ({}) as { kod?: unknown });
    svara(res, 200, { utfall: await gorAnsprak(konto, body.kod, await harAnnonser(konto.id)) });
    return true;
  }

  return false;
}

/** Segmenten EFTER /api/admin. Grinden ovanför har redan prövat att anroparen är admin. */
export async function handleAdminAffiliate(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  svara: Svara,
  lasKropp: LasKropp,
  adminId: string | null,
): Promise<boolean> {
  if (segments[0] !== "affiliate") return false;

  if (segments.length === 1 && req.method === "GET") {
    svara(res, 200, { rader: await adminOversikt() });
    return true;
  }

  if (segments.length === 2 && segments[1] === "utbetald" && req.method === "POST") {
    const body = await lasKropp<{ ids?: unknown }>(req).catch(() => ({}) as { ids?: unknown });
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
    if (ids.length === 0) {
      svara(res, 400, { error: "Inga provisioner valda." });
      return true;
    }
    svara(res, 200, { antal: await markeraUtbetalda(ids, adminId) });
    return true;
  }

  return false;
}
