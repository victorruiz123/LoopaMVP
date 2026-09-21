/**
 * Inbjudningskoden på klientsidan: fånga den ur länken, håll den i 30 dagar, lämna den till servern
 * efter registreringen.
 *
 * KODEN ÄR BARA ETT PÅSTÅENDE HÄR. Servern avgör om den gäller, om kontot är nytt nog och om
 * referred_by redan är satt (server/src/referral/regler.ts, gorAnsprak). Klienten kan inte skapa en
 * inbjudan, bara berätta vilken länk den kom från.
 *
 * VARFÖR TVÅ STEG. Länken öppnas ofta dagar innan någon registrerar sig, och registreringen sker hos
 * Supabase utan någon krok till oss — kontot finns, men vi vet inte om det förrän första inloggningen.
 * Koden sparas därför när länken öppnas, och AuthProvider skickar den när en session dyker upp.
 *
 * Klienten frågar inte om kontot är nytt. Det vet bara servern (Supabases skapelsetid), och den säger
 * nej till ett befintligt konto som råkat klicka på en väns länk. Koden töms efter ett svar, vilket
 * det än blev.
 */

const KOD_KEY = "loopa_ref";
const GILTIG_MS = 30 * 24 * 60 * 60 * 1000;

/** Samma form som servern, så att en trasig kod aldrig ens sparas. Se server/src/referral/kod.ts. */
const KOD_FORM = /^[A-HJKMNP-Z2-9]{4}-?[A-HJKMNP-Z2-9]{4}$/;

function las<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function skriv(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Privat läge. Inbjudan går förlorad, köpet eller säljet gör det inte.
  }
}

/**
 * Läser inbjudningskoden ur adressen och sparar den. Anropas en gång vid start.
 *
 * TVÅ FORMER, och båda måste läsas:
 *
 *   /i/KOD      — den delade länken. En SÖKVÄG, för att Cloudflare kan routa sökvägar men inte
 *                 query-strängar: `/?ref=KOD` nådde aldrig appen på loopa.nu utan fångades av
 *                 marknadssajten och skickades till /company. Se inbjudningslank på servern.
 *   ?ref=KOD    — den gamla formen. Läses kvar: länkar som redan delats ska inte dö, och
 *                 bekräftelsemejlet bär koden så här (medInbjudan) där ingen Worker står emellan.
 *
 * Den SENASTE länken vinner: har någon fått två inbjudningar är det den de faktiskt klickade sist som
 * fick dem att komma. Koden tas bort ur adressfältet så att den inte följer med när sidan delas
 * vidare — en delad länk ska bära delarens kod, inte den de själva kom via. För sökvägen betyder det
 * att adressen blir roten: `/i/KOD` är en inbjudan att gå in genom, ingen sida att stanna på.
 */
export function fangaInbjudan(): void {
  try {
    const url = new URL(window.location.href);
    const urSokvag = /^\/i\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    const ref = urSokvag ? decodeURIComponent(urSokvag) : url.searchParams.get("ref");
    if (!ref) return;
    const kod = ref.trim().toUpperCase();
    if (KOD_FORM.test(kod)) skriv(KOD_KEY, { kod, sparad: Date.now() });
    url.searchParams.delete("ref");
    // Sökvägsformen lämnar tillbaka besökaren till roten; query-formen behåller sidan de kom till.
    const vag = urSokvag ? "/" : url.pathname;
    window.history.replaceState(window.history.state, "", vag + url.search + url.hash);
  } catch {
    // Ingen adress att läsa, eller ingen historik att skriva. Inget att fånga.
  }
}

/** Koden, om den finns och inte är äldre än 30 dagar. */
export function sparadInbjudan(): string | null {
  const v = las<{ kod: string; sparad: number }>(KOD_KEY);
  if (!v) return null;
  if (Date.now() - v.sparad > GILTIG_MS) {
    skriv(KOD_KEY, null);
    return null;
  }
  return v.kod;
}

/**
 * Adressen bekräftelsemejlet ska leda tillbaka till, med koden i.
 *
 * Mejlet öppnas ofta på en annan enhet än registreringen — telefonens mejlapp — och där finns ingen
 * sparad kod. Med koden i länken fångas den igen där (fangaInbjudan), och anspråket går därifrån.
 */
export function medInbjudan(url: string): string {
  const kod = sparadInbjudan();
  if (!kod) return url;
  const u = new URL(url);
  u.searchParams.set("ref", kod);
  return u.toString();
}

/** Anspråket är gjort, vad servern än svarade. Koden har gjort sitt. */
export function rensaInbjudan(): void {
  skriv(KOD_KEY, null);
}
