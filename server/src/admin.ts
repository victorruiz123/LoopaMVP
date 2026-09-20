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
export function adminEmails(): string[] {
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
   * När kontot registrerades. Null när varken Supabase eller jobben kan säga det — kontot syns ändå,
   * men sist i listan: okänt är inte samma sak som gammalt. Se `jamforSenastRegistrerad`.
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
 * Ordningen i listan: nyast först, okänt datum sist.
 *
 * Panelen visade tidigare BARA konton från idag och igår. Fönstret gjorde vyn oanvändbar för allt
 * utom "vem registrerade sig nyss" — den som letade upp ett konto för att svara en kund fick veta
 * att det inte fanns, fast det låg kvar. Urvalet är därför borta, och sorteringen bär det som
 * fönstret var till för: den som är ny står överst ändå.
 *
 * ETT KONTO UTAN DATUM ÄR INTE GAMMALT, det är okänt — men det kan inte påstås vara nytt heller, och
 * det hör därför hemma sist och inte blandat in bland de daterade. Se `signupApproximate` för
 * skillnaden mellan ett känt och ett gissat datum.
 */
export function jamforSenastRegistrerad(a: Pick<AdminAccount, "signedUpAt">, b: Pick<AdminAccount, "signedUpAt">): number {
  if (!a.signedUpAt && !b.signedUpAt) return 0;
  if (!a.signedUpAt) return 1;
  if (!b.signedUpAt) return -1;
  return a.signedUpAt < b.signedUpAt ? 1 : a.signedUpAt > b.signedUpAt ? -1 : 0;
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
  /**
   * Fälten nedan läses BARA av `kontoDetalj`, för ett konto i taget. Listan rör dem aldrig — den
   * ritar hundra rader och har varken plats för dem eller rätt att sprida dem över en skärm ingen
   * bett om. De står ändå här, och inte i en egen typ, för att det är ETT svar från Auth.
   */
  phone?: string | null;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  app_metadata?: { providers?: unknown } | null;
  user_metadata?: {
    full_name?: string | null;
    name?: string | null;
    avatar_url?: string | null;
    telefon?: string | null;
    /** Adressen som registreringen skrev den. Formen står i AuthScreen — se adressUrMetadata. */
    adress?: Record<string, unknown> | null;
  } | null;
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

let epostCache: { at: number; karta: Map<string, string> } | null = null;

/**
 * Konto-id → e-postadress, för panelen som ska visa VEM som säljer och inte ett id.
 *
 * Jobben bär oftast adressen själva (`ownerEmail`), men de som skapades innan fältet fanns gör det
 * inte. Kartan fyller den luckan. En minut i minnet: listan öppnas och laddas om i ett svep, och
 * kontolistan ändras inte på den tiden. Utan servicenyckel blir kartan tom och id:t står kvar.
 */
export async function epostPerKonto(): Promise<Map<string, string>> {
  if (epostCache && Date.now() - epostCache.at < 60_000) return epostCache.karta;
  const serviceKey = serviceRoleKey();
  const users = serviceKey ? await fetchAuthUsers(serviceKey) : null;
  const karta = new Map<string, string>();
  for (const u of users ?? []) if (u.email) karta.set(u.id, u.email);
  if (users) epostCache = { at: Date.now(), karta };
  return karta;
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
): Promise<{ users: AdminAccount[]; directory: DirectorySource; total: number }> {
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

  /**
   * ALLA konton, inget urval.
   *
   * Listan är hela katalogen sammanslagen med jobben, sorterad så att den nyaste står överst. Det
   * enda som fortfarande kan göra den ofullständig är varifrån katalogen kom — se `directory`, och
   * notisen panelen skriver ut när servicenyckeln saknas.
   */
  const users = [...byId.values()].sort(jamforSenastRegistrerad);

  return { users, directory: dir.source, total: users.length };
}

/**
 * Säljarens adress, som registreringen skrev den (AuthScreen → user_metadata.adress).
 *
 * VARJE FÄLT FÅR VARA NULL var för sig. Adressen samlas in i ett svep vid registreringen, men konton
 * finns från före formuläret såg ut som det gör i dag, och portkod och våning är frivilliga även nu.
 * Ett tomt fält ska stå som tomt i panelen — inte få hela adressen att försvinna.
 */
export interface AdminKontoAdress {
  gatuadress: string | null;
  postnummer: string | null;
  ort: string | null;
  /** "hus" | "lagenhet" — avgör om våningen är en uppgift eller inte. */
  boende: string | null;
  portkod: string | null;
  vaning: string | null;
}

/**
 * ETT konto, allt vi vet om det.
 *
 * Skilt från raden i listan (`AdminAccount`) med flit: listan ritas för hundra konton och bär bara
 * det som får plats i en rad, medan det här slås upp för ETT konto som någon valt att titta på.
 * Adressen och inloggningstiderna hör till det andra fallet — de kostar ett eget anrop till Supabase
 * per konto, och de har ingen plats i en lista.
 */
export interface AdminKontoDetalj extends AdminAccount {
  adress: AdminKontoAdress | null;
  telefon: string | null;
  senastInloggad: string | null;
  /** När e-postadressen bekräftades. Null = obekräftad, vilket är en upplysning i sig. */
  epostBekraftad: string | null;
  /** Hur kontot loggar in: "email", "google". Tomt när Auth inte svarade. */
  inloggningssatt: string[];
  /**
   * Varifrån uppgifterna kom.
   *
   * "auth" = servicenyckeln svarade, och allt ovan är läst ur kontot. "jobb" = den vägen fanns inte,
   * och det som står är vad jobben själva kan berätta om ägaren. Panelen skriver ut skillnaden i
   * stället för att visa tomma fält som om de vore ett svar: en adress som saknas för att ingen
   * frågat, och en adress som saknas för att vi inte fick läsa den, är inte samma sak.
   */
  kalla: "auth" | "jobb";
}

/** Ett fält ur `user_metadata.adress`, städat. Tom sträng är inte en uppgift. */
function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function adressUrMetadata(metadata: unknown): AdminKontoAdress | null {
  const a = (metadata as { adress?: Record<string, unknown> | null } | null | undefined)?.adress;
  if (!a || typeof a !== "object") return null;
  const adress: AdminKontoAdress = {
    gatuadress: textOrNull(a.gatuadress),
    postnummer: textOrNull(a.postnummer),
    ort: textOrNull(a.ort),
    boende: textOrNull(a.boende),
    portkod: textOrNull(a.portkod),
    vaning: textOrNull(a.vaning),
  };
  // Ett objekt där varje fält är tomt är ingen adress. Då är "ingen adress angiven" det sanna svaret.
  return Object.values(adress).some(Boolean) ? adress : null;
}

/**
 * ETT konto ur Supabase Auth, med servicenyckeln.
 *
 * Eget anrop och inte ett uppslag i listan: listan sidas igenom med tak (fem sidor), och ett konto
 * bortom taket hade svarat "finns inte" på en sida som öppnats från en annons där kontot bevisligen
 * finns. Adressen går dessutom bara att läsa här — listans rader bär den inte.
 */
async function fetchAuthUser(serviceKey: string, id: string): Promise<AuthUserRow | null> {
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthUserRow;
  } catch {
    return null;
  }
}

/**
 * Allt om ett konto: uppgifterna ur Auth och siffrorna ur jobben.
 *
 * SIFFRORNA RÄKNAS HÄR och lånas inte från `listAccounts`. Den läser hela katalogen ur Supabase för
 * att kunna visa konton som aldrig filmat något — ett arbete som inte har något med ETT konto att
 * göra, och som hade gjort den här sidan långsammare än annonssidan den öppnas från.
 *
 * Null bara när kontot varken finns i Auth eller äger ett enda jobb. Ett konto som Auth inte vill
 * svara om men som äger annonser ska gå att öppna — det är då man som mest behöver se dem.
 */
export async function kontoDetalj(id: string): Promise<AdminKontoDetalj | null> {
  const serviceKey = serviceRoleKey();
  const [auth, jobs] = await Promise.all([serviceKey ? fetchAuthUser(serviceKey, id) : null, listJobs()]);

  const egna = jobs.filter((job) => ownerIdOf(job) === id);
  if (!auth && egna.length === 0) return null;

  const konto: AdminKontoDetalj = {
    ...blank({
      id,
      email: auth?.email ?? null,
      name: auth?.user_metadata?.full_name || auth?.user_metadata?.name || null,
      avatarUrl: auth?.user_metadata?.avatar_url ?? null,
      createdAt: auth?.created_at ?? null,
    }),
    adress: adressUrMetadata(auth?.user_metadata),
    telefon: textOrNull(auth?.phone) ?? textOrNull(auth?.user_metadata?.telefon),
    senastInloggad: auth?.last_sign_in_at ?? null,
    epostBekraftad: auth?.email_confirmed_at ?? auth?.confirmed_at ?? null,
    inloggningssatt: Array.isArray(auth?.app_metadata?.providers)
      ? (auth!.app_metadata!.providers as string[]).filter((p): p is string => typeof p === "string")
      : [],
    kalla: auth ? "auth" : "jobb",
  };

  for (const job of egna) {
    konto.jobCount += 1;
    const listing = listingOf(job);
    if (listing?.status === "ok" && listing.result) {
      konto.cardCount += 1;
      const price = job.result?.price;
      if (price?.status === "ok" && price.default !== null) konto.totalValue += price.default;
    }
    if (!konto.lastActivity || job.createdAt > konto.lastActivity) konto.lastActivity = job.createdAt;
    // Saknas registreringsdatumet är det första jobbet det närmaste vi kommer — och panelen skriver
    // ut att det är en uppskattning, precis som i listan.
    if (!konto.signedUpAt || job.createdAt < konto.signedUpAt) {
      if (!auth?.created_at) {
        konto.signedUpAt = job.createdAt;
        konto.signupApproximate = true;
      }
    }
  }

  return konto;
}
