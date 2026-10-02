import { createClient } from "@supabase/supabase-js";

/**
 * Samma Supabase-projekt som vips-buy-sell-hub.
 *
 * Avsiktligt samma URL och samma publika anon-nyckel: kontot en säljare redan har i Vips är kontot
 * de loggar in med här. Två projekt hade betytt två lösenord för samma person och en profil som
 * bara finns på ena hållet.
 *
 * Nyckeln är den publika anon-nyckeln — den är gjord för att ligga i klienten och skyddar ingenting
 * i sig. Det som skyddar data är RLS i databasen.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "https://tyxqxodnfyzxpwdgtypd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5eHF4b2RuZnl6eHB3ZGd0eXBkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyOTI1MzcsImV4cCI6MjA3Mzg2ODUzN30.Oql80KZxvtdXEYK_J_7xxGDJAfEvzEPQ7FK1_G7gJqY";

/**
 * Kom besökaren hit via länken i ett återställningsmejl?
 *
 * LÄSES FÖRE createClient. Klienten tolkar och tömmer adressen när den skapas, och det den hittar
 * meddelas i en setTimeout som AuthProvider inte alltid hinner lyssna på. Adressen ljuger inte.
 *
 * Tre former:
 *   - `#aterstall=<kod>`  vår egen länk, mejlad av servern (server/src/losenord.ts). Koden löses in
 *                         med verifyOtp i AuthProvider. Det är den länken som skickas i dag.
 *   - `#...&type=recovery` Supabases egen länk, om projektet någon gång skickar mejlet själv.
 *   - `#error_code=otp_expired` en Supabase-länk som redan använts eller blivit för gammal.
 */
export type AterstallningsLank = { typ: "kod"; kod: string } | { typ: "giltig" } | { typ: "utgangen" } | null;

function lasAterstallningsLank(): AterstallningsLank {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const kod = hash.get("aterstall");
  if (kod) return { typ: "kod", kod };
  if (hash.get("type") === "recovery" && hash.get("access_token")) return { typ: "giltig" };
  if (hash.get("error_code") === "otp_expired" || (hash.get("error") && /expired|invalid/i.test(hash.get("error_description") ?? ""))) {
    return { typ: "utgangen" };
  }
  return null;
}

export const aterstallningsLank: AterstallningsLank = lasAterstallningsLank();

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
