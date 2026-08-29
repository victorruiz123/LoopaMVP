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

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
