import { listJobs, ownerIdOf } from "./jobStore.js";
import { supabaseAnonKey, supabaseUrl } from "./supabaseAuth.js";
import type { ConditionJob } from "./types.js";

/**
 * Vem som får se andras annonser.
 *
 * Adminrollen sitter på ADRESSEN och inte på ett användar-id, av två skäl. Kontona ligger hos
 * Supabase och delas med vips-buy-sell-hub, så vi har ingen egen tabell att sätta en roll i — och en
 * UUID i koden hade varit omöjlig att läsa och lika omöjlig att kontrollera vid en genomgång.
 * Adressen verifieras av Supabase innan den når hit (se supabaseAuth.ts), så den går inte att påstå.
 *
 * ADMIN_EMAILS LÄGGER TILL, den ersätter inte. Listan här är den som gäller oavsett hur miljön ser
 * ut på maskinen som råkar köra servern — en admin som försvinner för att en env-variabel skrevs
 * över vore fel sorts överraskning.
 */
const BUILT_IN_ADMINS = ["victor@ruiz.se"];

/** Läses ur miljön vid varje anrop: modulen importeras innan server.ts hunnit läsa server/.env. */
function adminEmails(): string[] {
  const extra = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...BUILT_IN_ADMINS, ...extra];
}

export function isAdminEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return !!normalized && adminEmails().includes(normalized);
}

/**
 * Ett konto som det står i adminpanelen: vem det är, och vad de har lagt upp.
 *
 * Siffrorna räknas ur jobben på disk och inte ur något register — jobben ÄR registret, precis som för
 * uppslaget på ett Loopa-ID (se publicCard.ts).
 */
export interface AdminAccount {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Allt säljaren startat, inklusive det som föll. */
  jobCount: number;
  /** Så många av dem som blev annonser. Det är dem panelen kan öppna. */
  cardCount: number;
  /** Summan av kortens prisförslag, samma tal som säljarens egen profil visar. */
  totalValue: number;
  /** Senaste jobbet, som ISO-tid. Null för ett konto som aldrig filmat något. */
  lastActivity: string | null;
  /**
   * När kontot registrerades. Null när varken Supabase eller jobben kan säga det — och ett konto utan
   * datum kan inte påstås ha registrerats idag, så det faller ur panelens fönster.
   */
  signedUpAt: string | null;
  /**
   * true = datumet är kontots FÖRSTA jobb, inte registreringen.
   *
   * Bästa gissningen som finns när Supabase inte lämnar ut något datum: den som filmade sin första
   * möbel igår registrerade sig oftast igår. Panelen skriver ut skillnaden i stället för att låta en
   * gissning se ut som ett faktum.
   */
  signupApproximate: boolean;
}

/**
 * Panelens fönster: idag och igår, lokal tid på maskinen som kör servern.
 *
 * Dygnsgräns och inte "48 timmar bakåt". Frågan panelen svarar på är "vem är ny nu" och den ställs av
 * en människa som tänker i dagar — ett rullande timfönster hade tappat gårdagsmorgonens konton vid
 * lunch, mitt i den dag de fortfarande räknas som nya.
 */
export function signupWindowStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1);
  return start;
}

/** Registrerade sig kontot inom fönstret? Ett konto utan känt datum räknas aldrig som nytt. */
export function signedUpInWindow(account: Pick<AdminAccount, "signedUpAt">, now: Date = new Date()): boolean {
  if (!account.signedUpAt) return false;
  const at = new Date(account.signedUpAt).getTime();
  return Number.isFinite(at) && at >= signupWindowStart(now).getTime();
}

/**
 * Varifrån namnen och adresserna kom.
 *
 * - `service`  — SUPABASE_SERVICE_ROLE_KEY finns: hela användarlistan, även konton utan annonser.
 * - `profiles` — ingen servicenyckel, men `profiles` gick att läsa med adminens egen token.
 * - `jobs`     — ingendera: bara konton som syns i jobben, och bara med sitt id.
 *
 * Panelen visar skillnaden i stället för att tiga om den. "Alla användare" som i själva verket är
 * "alla som hunnit filma något" vore ett tyst fel i precis den vy som ska ge överblick.
 */
export type DirectorySource = "service" | "profiles" | "jobs";

interface DirectoryRow {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** Registreringstillfället, när katalogen kan säga det. */
  createdAt: string | null;
}

interface ProfileRow {
  user_id: string | null;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  email: string | null;
  created_at?: string | null;
}

interface AuthUserRow {
  id: string;
  email: string | null;
  created_at?: string | null;
  user_metadata?: { full_name?: string | null; name?: string | null; avatar_url?: string | null } | null;
}

const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

/**
 * `profiles` — samma tabell och kolumner som Vips fyller vid registreringen.
 *
 * `created_at` frågas efter först och utan garanti: kolumnen ägs av ett annat projekt, och PostgREST
 * svarar 400 på en kolumn som inte finns. Ett andra försök utan den är skillnaden mellan en panel som
 * tappar registreringsdatumet och en panel som tappar namnen också.
 */
async function fetchProfiles(apikey: string, bearer: string): Promise<DirectoryRow[] | null> {
  const columns = ["user_id,username,full_name,avatar_url,email,created_at", "user_id,username,full_name,avatar_url,email"];
  for (const select of columns) {
    try {
      const url = `${supabaseUrl()}/rest/v1/profiles?select=${select}`;
      const res = await fetch(url, { headers: { apikey, Authorization: `Bearer ${bearer}` } });
      if (!res.ok) continue;
      const rows = (await res.json()) as ProfileRow[];
      if (!Array.isArray(rows)) continue;
      return rows
        .filter((r) => !!r.user_id)
        .map((r) => ({
          id: r.user_id as string,
          email: r.email,
          name: r.full_name || r.username || null,
          avatarUrl: r.avatar_url,
          createdAt: r.created_at ?? null,
        }));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Hela användarlistan ur Supabase Auth. Kräver servicenyckeln — den publika anon-nyckeln får aldrig
 * läsa den vägen, och ska inte kunna det.
 *
 * Sidas igenom med tak: en panel som hämtar tiotusen konton för att rita en lista är inte en panel.
 */
async function fetchAuthUsers(serviceKey: string): Promise<DirectoryRow[] | null> {
  const perPage = 200;
  const maxPages = 5;
  const out: DirectoryRow[] = [];
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${supabaseUrl()}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
      const res = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!res.ok) return page === 1 ? null : out;
      const body = (await res.json()) as { users?: AuthUserRow[] };
      const users = body.users ?? [];
      for (const u of users) {
        if (!u.id) continue;
        out.push({
          id: u.id,
          email: u.email ?? null,
          name: u.user_metadata?.full_name || u.user_metadata?.name || null,
          avatarUrl: u.user_metadata?.avatar_url ?? null,
          // Auth vet exakt när kontot skapades. Det är det datum panelens fönster helst vilar på.
          createdAt: u.created_at ?? null,
        });
      }
      if (users.length < perPage) break;
    }
    return out;
  } catch {
    return out.length ? out : null;
  }
}

async function fetchDirectory(token: string | null): Promise<{ rows: DirectoryRow[]; source: DirectorySource }> {
  const serviceKey = serviceRoleKey();
  if (serviceKey) {
    const users = await fetchAuthUsers(serviceKey);
    if (users?.length) {
      // Namnen står i `profiles`, adresserna i Auth. Utan sammanslagningen blir listan en rad UUID:n
      // med e-post — läsbar, men inte den överblick panelen finns för.
      const profiles = (await fetchProfiles(serviceKey, serviceKey)) ?? [];
      const byId = new Map(profiles.map((p) => [p.id, p]));
      return {
        rows: users.map((u) => {
          const p = byId.get(u.id);
          return {
            id: u.id,
            email: u.email ?? p?.email ?? null,
            name: u.name ?? p?.name ?? null,
            avatarUrl: u.avatarUrl ?? p?.avatarUrl ?? null,
            createdAt: u.createdAt ?? p?.createdAt ?? null,
          };
        }),
        source: "service",
      };
    }
  }

  // Ingen servicenyckel: `profiles` med adminens egen token. Lyckas bara om radsäkerheten i databasen
  // släpper igenom andras profiler — gör den inte det får panelen falla tillbaka på jobben.
  if (token) {
    const profiles = await fetchProfiles(supabaseAnonKey(), token);
    if (profiles?.length) return { rows: profiles, source: "profiles" };
  }
  return { rows: [], source: "jobs" };
}

/** Annonsen kan sitta på tre ställen — samma regel som profillistan och det publika kortet följer. */
function listingOf(job: ConditionJob) {
  return job.result?.listing ?? job.listing ?? job.pendingListing ?? null;
}

function blank(row: DirectoryRow): AdminAccount {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isAdmin: isAdminEmail(row.email),
    jobCount: 0,
    cardCount: 0,
    totalValue: 0,
    lastActivity: null,
    signedUpAt: row.createdAt,
    signupApproximate: false,
  };
}

/**
 * Alla konton, med sina siffror.
 *
 * Katalogen och jobben slås ihop åt båda hållen med flit: ett konto som aldrig filmat något ska synas
 * (det är skillnaden mot att bara räkna ägare i jobben), och en ägare som saknas i katalogen ska ändå
 * synas med sina kort (det är skillnaden mot att bara lista katalogen).
 */
export async function listAccounts(
  token: string | null,
  now: Date = new Date(),
): Promise<{ users: AdminAccount[]; directory: DirectorySource; total: number; since: string }> {
  const [dir, jobs] = await Promise.all([fetchDirectory(token), listJobs()]);

  const byId = new Map<string, AdminAccount>();
  const firstJob = new Map<string, string>();
  for (const row of dir.rows) byId.set(row.id, blank(row));

  for (const job of jobs) {
    const owner = ownerIdOf(job);
    // Ägarlösa jobb hör inte till någon och syns inte för någon — inte heller här.
    if (!owner) continue;
    let account = byId.get(owner);
    if (!account) {
      account = blank({ id: owner, email: null, name: null, avatarUrl: null, createdAt: null });
      byId.set(owner, account);
    }
    account.jobCount += 1;
    const listing = listingOf(job);
    if (listing?.status === "ok" && listing.result) {
      account.cardCount += 1;
      const price = job.result?.price;
      if (price?.status === "ok" && price.default !== null) account.totalValue += price.default;
    }
    if (!account.lastActivity || job.createdAt > account.lastActivity) account.lastActivity = job.createdAt;
    // Första jobbet är reservdatumet när Supabase inte lämnar ut registreringen. Det sätts på varje
    // konto, men används bara nedan om det riktiga datumet saknas.
    if (!firstJob.has(owner) || job.createdAt < (firstJob.get(owner) as string)) firstJob.set(owner, job.createdAt);
  }

  for (const [id, at] of firstJob) {
    const account = byId.get(id);
    if (account && !account.signedUpAt) {
      account.signedUpAt = at;
      account.signupApproximate = true;
    }
  }

  const all = [...byId.values()];

  /**
   * Panelen visar de NYA kontona — de som registrerade sig idag eller igår — och inget annat.
   *
   * `total` följer med så vyn kan skriva ut hur många konton som finns bakom urvalet. Ett filter som
   * inte säger vad det döljer ser ut som en tom databas den dag ingen registrerat sig.
   */
  const users = all
    .filter((a) => signedUpInWindow(a, now))
    // Nyast först: det är den ordning frågan "vem är ny" ställs i.
    .sort((a, b) => ((a.signedUpAt as string) < (b.signedUpAt as string) ? 1 : -1));

  return { users, directory: dir.source, total: all.length, since: signupWindowStart(now).toISOString() };
}
