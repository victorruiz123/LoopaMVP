import type { IncomingMessage } from "node:http";

/**
 * Vem som skickade anropet, enligt Supabase.
 *
 * Samma projekt som vips-buy-sell-hub, så samma konton. Token verifieras hos Supabase i stället för
 * att avkodas här: en JWT går att skriva ihop själv, och att lita på `sub` utan att fråga hade gjort
 * profilen till ett fält vem som helst kunde fylla i.
 *
 * Ingen hemlighet behövs — /auth/v1/user tar den publika anon-nyckeln och den token som ska prövas.
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://tyxqxodnfyzxpwdgtypd.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5eHF4b2RuZnl6eHB3ZGd0eXBkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyOTI1MzcsImV4cCI6MjA3Mzg2ODUzN30.Oql80KZxvtdXEYK_J_7xxGDJAfEvzEPQ7FK1_G7gJqY";

export interface SupabaseUser {
  id: string;
  email: string | null;
}

/**
 * Verifieringen kostar ett nätanrop, och skärmarna pollar var 1,2:e sekund med samma token. Utan
 * cache hade varje pollning blivit en rundtur till Supabase. Fem minuter är kortare än tokens
 * livstid, så en utloggning slår igenom snabbt ändå.
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { user: SupabaseUser; expires: number }>();

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function userFromRequest(req: IncomingMessage): Promise<SupabaseUser | null> {
  const token = bearer(req);
  if (!token) return null;

  const hit = cache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; email?: string | null };
    if (!body.id) return null;
    const user: SupabaseUser = { id: body.id, email: body.email ?? null };
    cache.set(token, { user, expires: Date.now() + TTL_MS });
    return user;
  } catch {
    // Supabase onåbart. Anropet får gå vidare som utloggat i stället för att fällas — besiktningen
    // är det som betyder något, och den ska inte stå still för att inloggningstjänsten hostar.
    return null;
  }
}
