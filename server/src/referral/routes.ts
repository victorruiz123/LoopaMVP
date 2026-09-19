/**
 * /api/salj/inbjudan — säljarens inbjudningar.
 *
 *   GET  /api/salj/inbjudan           koden, länken, krediterna och de inbjudna
 *   POST /api/salj/inbjudan/ansprak   { kod }  — användaren kom via en länk
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
import { inbjudningsbas, inbjudningslank, normaliseraKod } from "./kod.js";
import { gorAnsprak, krediterFor, logga, profilFor, tillgangliga, type Konto } from "./regler.js";
import { referralStore } from "./store.js";
import { getJob, ownerIdOf } from "../jobStore.js";
import { store as butikStore } from "../butik/store.js";

/**
 * Har kontot sålt något genom oss? Ett konto som har det är inte en ny säljare och kan inte bli
 * inbjudet (regler.ts, gorAnsprak). Räknas på butikens sålda möbler, båda kanalerna.
 */
async function harSalt(userId: string): Promise<boolean> {
  for (const r of await butikStore().all()) {
    if (!r.jobId || (r.state !== "sold" && r.state !== "delivered" && !r.utbetalning)) continue;
    const job = await getJob(r.jobId);
    if (job && ownerIdOf(job) === userId) return true;
  }
  return false;
}

type Svara = (res: ServerResponse, status: number, body: unknown) => void;
type LasKropp = <T>(req: IncomingMessage) => Promise<T>;

/**
 * Namnet i kontots profil, läst med kontots EGEN token — samma rad klienten själv läser (RLS släpper
 * bara fram den egna). Null när det saknas eller inte går att läsa; namnet är en artighet, inte ett
 * krav.
 */
async function profilnamn(userId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl()}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=full_name,username`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey() },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ full_name?: string | null; username?: string | null }>;
    return rows[0]?.full_name || rows[0]?.username || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/salj/inbjudan/fran/:kod — vem som bjöd in, för landningssidan. UTAN inloggning.
 *
 * Den som öppnar länken har oftast inget konto än, och sidan ska kunna säga "Victor bjöd in dig!"
 * innan de skapat ett. Svaret är förnamnet och ingenting annat: inga id, ingen e-post. Koden är
 * redan något inbjudaren valt att dela, och åtta tecken ur 31 går inte att gissa sig fram i.
 */
export async function inbjudareFor(rawKod: string): Promise<{ namn: string | null } | null> {
  const kod = normaliseraKod(rawKod);
  if (!kod) return null;
  const profil = await referralStore().profilForKod(kod);
  return profil ? { namn: profil.namn ?? null } : null;
}

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
    const fullName =
      (await profilnamn(b.id, token)) ??
      (typeof (b.user_metadata as { full_name?: unknown } | null)?.full_name === "string"
        ? ((b.user_metadata as { full_name: string }).full_name)
        : null);
    return {
      id: b.id,
      fullName,
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
    // Null när ingen bas är satt: då bygger klienten länken på sidans egen adress i stället för att
    // få en produktionslänk till en sajt som kanske inte har koden.
    lank: inbjudningsbas() ? inbjudningslank(profil.kod) : null,
    tillgangliga: tillgangliga(krediter, nu).length,
    krediter: krediter.map((k) => ({ id: k.id, status: k.status, skapad: k.createdAt, gar_ut: k.expiresAt, anvand: k.usedAt })),
    inbjudna: inbjudna.map((p) => ({
      email: p.emailMaskerad,
      registrerad: p.referredAt,
      status: p.forstaAnnonsAt ? "annons" : "registrerad",
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
    svara(res, 200, { utfall: await gorAnsprak(konto, body.kod, await harSalt(konto.id)) });
    return true;
  }

  /**
   * GET /api/salj/inbjudan/nytt — en ny gratisförsäljning som inbjudaren inte sett än, med vännens
   * förnamn. Driver popupen "Din nästa försäljning är gratis!". Egen och liten, för att appen frågar
   * vid varje besök och när fliken kommer tillbaka i fokus — hela profilsvaret vore onödigt tungt.
   */
  if (segments.length === 2 && segments[1] === "nytt" && req.method === "GET") {
    const ny = tillgangliga(await krediterFor(konto.id)).find((k) => !k.visadAt) ?? null;
    const van = ny ? await referralStore().profil(ny.referredUserId) : null;
    svara(res, 200, { kredit: ny ? { id: ny.id, van: van?.namn ?? null, garUt: ny.expiresAt } : null });
    return true;
  }

  /** POST /api/salj/inbjudan/visad/:id — popupen är stängd. Visas inte igen. */
  if (segments.length === 3 && segments[1] === "visad" && req.method === "POST") {
    await referralStore().markeraVisad(decodeURIComponent(segments[2]), konto.id, new Date().toISOString());
    svara(res, 200, { ok: true });
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
