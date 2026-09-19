/**
 * /api/salj/inbjudan — säljarens inbjudningar.
 *
 *   GET  /api/salj/inbjudan           koden, länken, krediterna och de inbjudna
 *   POST /api/salj/inbjudan/ansprak   { kod }  — den nyss registrerade kom via en länk
 *   POST /api/salj/inbjudan/handelse  { event: "invite_link_copied", kanal }
 *
 * UNDER /api/salj OCH INTE EGEN NAMNRYMD: Cloudflare-Workern binder API-vägarna en och en
 * (deploy/cloudflare/wrangler.toml), och en ny namnrymd hade svarats av marknadssajtens Pages
 * Functions tills någon kommit ihåg att lägga till en rutt och köra wrangler deploy. /api/salj/* är
 * redan bunden.
 *
 * Alla tre innanför inloggningsgrinden. Kontouppgifterna — skapelsetid, adress — hämtas med
 * användarens EGEN token hos Supabase; ingen servicenyckel behövs, och ingen kan fråga om någon annan.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerToken, supabaseAnonKey, supabaseUrl } from "../supabaseAuth.js";
import { inbjudningslank } from "./kod.js";
import { gorAnsprak, krediterFor, logga, profilFor, tillgangliga, type Konto } from "./regler.js";
import { referralStore } from "./store.js";

type Svara = (res: ServerResponse, status: number, body: unknown) => void;
type LasKropp = <T>(req: IncomingMessage) => Promise<T>;

/** Kontot bakom anropets token. Null när Supabase inte svarar — då görs ingenting alls. */
async function kontoFor(req: IncomingMessage): Promise<Konto | null> {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey() },
    });
    if (!res.ok) return null;
    const b = (await res.json()) as {
      id?: string;
      email?: string | null;
      created_at?: string | null;
      phone?: string | null;
      user_metadata?: { adress?: { gatuadress?: unknown; postnummer?: unknown } | null; telefon?: unknown } | null;
    };
    if (!b.id) return null;
    return {
      id: b.id,
      email: b.email ?? null,
      createdAt: b.created_at ?? null,
      adress: b.user_metadata?.adress ?? null,
      telefon: b.phone || b.user_metadata?.telefon || null,
    };
  } catch {
    return null;
  }
}

/** Det profilen visar. Inbjudnas e-post är maskerad — se avtryck.ts. */
export async function minInbjudan(konto: Konto) {
  const nu = new Date();
  const profil = await profilFor(konto, nu);
  const krediter = await krediterFor(konto.id, nu);
  const inbjudna = await referralStore().inbjudna(konto.id);
  return {
    kod: profil.kod,
    lank: inbjudningslank(profil.kod),
    tillgangliga: tillgangliga(krediter, nu).length,
    krediter: krediter.map((k) => ({ id: k.id, status: k.status, skapad: k.createdAt, gar_ut: k.expiresAt, anvand: k.usedAt })),
    inbjudna: inbjudna.map((p) => ({
      email: p.emailMaskerad,
      registrerad: p.referredAt,
      status: p.forstaUtbetalningAt ? "salt" : "registrerad",
    })),
  };
}

export async function handleInbjudan(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  svara: Svara,
  lasKropp: LasKropp,
): Promise<boolean> {
  if (segments[0] !== "inbjudan") return false;

  const konto = await kontoFor(req);
  if (!konto) {
    svara(res, 503, { error: "Vi når inte kontot just nu. Försök igen om en stund." });
    return true;
  }

  if (segments.length === 1 && req.method === "GET") {
    svara(res, 200, await minInbjudan(konto));
    return true;
  }

  if (segments.length === 2 && segments[1] === "ansprak" && req.method === "POST") {
    const body = await lasKropp<{ kod?: unknown }>(req).catch(() => ({}) as { kod?: unknown });
    svara(res, 200, { utfall: await gorAnsprak(konto, body.kod) });
    return true;
  }

  if (segments.length === 2 && segments[1] === "handelse" && req.method === "POST") {
    const body = await lasKropp<{ event?: unknown; kanal?: unknown }>(req).catch(() => ({}) as { event?: unknown; kanal?: unknown });
    // Bara den enda händelse klienten har att säga. Resten skriver servern själv, där de händer.
    if (body.event !== "invite_link_copied") {
      svara(res, 400, { error: "Okänd händelse." });
      return true;
    }
    const profil = await profilFor(konto);
    const kanal = body.kanal === "dela" ? "dela" : "kopiera";
    await logga("invite_link_copied", konto.id, profil.kod, { kanal });
    svara(res, 200, { ok: true });
    return true;
  }

  return false;
}
