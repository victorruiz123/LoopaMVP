/**
 * Ger varje befintligt konto en gratisförsäljning.
 *
 *   npx tsx scripts/gratis-till-alla.ts            # TORRKÖRNING — räknar bara
 *   npx tsx scripts/gratis-till-alla.ts --kor      # ger krediterna på riktigt
 *
 * KAMPANJEN 2026-09-23: alla som redan var med hos Loopa fick sin nästa försäljning utan avgift.
 * Krediten är samma sak som en inbjudningskredit — tolv månader, valet vid publiceringen, andelen 0
 * på möbeln — men den kommer från oss och inte från någon som bjudit in någon. Se regler.ts, `gava`.
 *
 * EN GÅVA PER PERSON, någonsin. Lagret garanterar det (unikt index på user_id där source='gift', och
 * samma kontroll i filryggen), så skriptet kan köras om: konton som redan fått sin räknas som
 * "hade redan" och rörs inte. Det gör det också ofarligt att köra i omgångar om Auth skulle hicka.
 *
 * TORRKÖRNING ÄR STANDARD. Listan först, `--kor` sedan.
 *
 * INGET MEJL. Skriptet skriver krediter och ingenting annat — beskedet möter säljaren i appen
 * ("Vi vill ge dig en gratis försäljning!", GratisPopup.tsx) nästa gång de öppnar den.
 *
 * KRÄVER SUPABASE_SERVICE_ROLE_KEY: konton bor hos Supabase Auth, och det finns ingen annan väg till
 * listan över dem. Vart krediterna SKRIVS bestäms som vanligt av LOOPA_LAGRING (datalagring.ts) —
 * kör skriptet där servern kör, annars hamnar gåvorna i en filrygg ingen läser.
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

const { gava } = await import("../server/src/referral/regler.js");
const { supabaseUrl } = await import("../server/src/supabaseAuth.js");
const { supabaseLagring } = await import("../server/src/datalagring.js");

const argv = process.argv.slice(2);
const kor = argv.includes("--kor");
const arg = (k: string): string | null => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!serviceKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY saknas i server/.env — utan den går kontona inte att lista.");
  process.exit(1);
}

/**
 * Bara konton som fanns när körningen startade, om inget annat sägs.
 *
 * Kampanjen gäller dem som redan är med. Utan en gräns hade en omkörning i morgon gett gåvan till
 * dem som registrerat sig i natt — och den som kommer ny möts av inbjudan, inte av en gåva. Pinna
 * gränsen med --innan=2026-09-23T00:00:00Z när samma omgång ska köras om i flera steg.
 */
const innanRaw = arg("innan");
const innan = innanRaw ? new Date(innanRaw) : new Date();
if (Number.isNaN(innan.getTime())) {
  console.error(`--innan=${innanRaw} är inget datum.`);
  process.exit(1);
}

interface AuthUser {
  id?: string;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  user_metadata?: { full_name?: unknown; adress?: { gatuadress?: unknown; postnummer?: unknown } | null; telefon?: unknown } | null;
}

/** Alla konton, sida för sida. Ett avbrott mitt i är ett fel — hellre det än en tyst halv lista. */
async function allaKonton(): Promise<AuthUser[]> {
  const perPage = 200;
  const ut: AuthUser[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = `${supabaseUrl()}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, { headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` } });
    if (!res.ok) throw new Error(`Auth svarade ${res.status} på sida ${page}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { users?: AuthUser[] };
    const users = body.users ?? [];
    ut.push(...users);
    if (users.length < perPage) return ut;
  }
  throw new Error("Fler än 20 000 konton — höj taket i allaKonton().");
}

/**
 * Namnen ur profiles, i en fråga i stället för en per konto.
 *
 * Namnet används inte i gåvans besked, men profilFor skriver det ändå: den som öppnar sin egen
 * inbjudningslänk efteråt ska stå med sitt namn på landningssidan och inte med sin e-postadress.
 */
async function namnen(): Promise<Map<string, string>> {
  const karta = new Map<string, string>();
  const res = await fetch(`${supabaseUrl()}/rest/v1/profiles?select=user_id,full_name,username`, {
    headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) {
    console.warn(`[gava] profiles svarade ${res.status} — kör vidare utan namn.`);
    return karta;
  }
  for (const r of (await res.json()) as Array<{ user_id?: string; full_name?: string | null; username?: string | null }>) {
    const namn = r.full_name || r.username;
    if (r.user_id && namn) karta.set(r.user_id, namn);
  }
  return karta;
}

const konton = (await allaKonton()).filter((u) => {
  if (!u.id) return false;
  const skapad = u.created_at ? new Date(u.created_at) : null;
  return !skapad || skapad.getTime() <= innan.getTime();
});
const namn = await namnen();

console.log(`Lagring: ${supabaseLagring() ? "Supabase" : "filer under server/data/referral"}`);
console.log(`Konton skapade senast ${innan.toISOString()}: ${konton.length}`);
if (!kor) {
  console.log("TORRKÖRNING — ingenting skrivs. Lägg till --kor för att ge krediterna.");
  process.exit(0);
}

let gav = 0;
let hadeRedan = 0;
const fel: Array<{ id: string; orsak: string }> = [];

for (const u of konton) {
  const konto = {
    id: u.id!,
    email: u.email ?? null,
    createdAt: u.created_at ?? null,
    adress: u.user_metadata?.adress ?? null,
    telefon: u.phone || u.user_metadata?.telefon || null,
    fullName: namn.get(u.id!) ?? (typeof u.user_metadata?.full_name === "string" ? u.user_metadata.full_name : null),
  };
  try {
    const { utfall } = await gava(konto);
    if (utfall === "gava") gav += 1;
    else hadeRedan += 1;
  } catch (err) {
    // Ett konto som faller stoppar inte de andra. Listan skrivs ut till sist, och körningen kan
    // göras om: de som redan fått sin gåva hoppas då över.
    fel.push({ id: u.id!, orsak: err instanceof Error ? err.message : String(err) });
  }
  const gjorda = gav + hadeRedan + fel.length;
  if (gjorda % 25 === 0) console.log(`  ${gjorda}/${konton.length} …`);
}

console.log(`\nGav en gratisförsäljning: ${gav}`);
console.log(`Hade redan en gåva:       ${hadeRedan}`);
if (fel.length) {
  console.log(`Föll:                     ${fel.length}`);
  for (const f of fel) console.log(`  ${f.id}  ${f.orsak}`);
  process.exit(1);
}
