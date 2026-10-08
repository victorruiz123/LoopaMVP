/**
 * Affiliate-koden på klientsidan: fånga den ur länken, håll den i en cookie i 30 dagar, lämna den till
 * servern efter registreringen.
 *
 * SKILD FRÅN INBJUDAN (lib/referral.ts). Två program, två koder, två länkar: /i/KOD är en inbjudan,
 * /p/KOD är affiliate. Båda kan fångas av samma besök utan att störa varandra.
 *
 * EN COOKIE, INTE localStorage, och satt på loopa.nu med punkt: länken öppnas på loopa.nu men
 * registreringen kan ske på app.loopa.nu, och localStorage delas inte mellan underdomäner.
 *
 * FÖRSTA KODEN GÄLLER. Ligger det redan en kod som inte gått ut skrivs den inte över av en ny länk —
 * samma regel som servern håller för referred_by (affiliate/regler.ts).
 *
 * KODEN ÄR BARA ETT PÅSTÅENDE HÄR. Servern avgör om den finns, om kontot är nytt och om referred_by
 * redan är satt.
 */

const COOKIE = "loopa_aff";
const GILTIG_S = 30 * 24 * 60 * 60;

/** Samma form som servern, så att en trasig kod aldrig ens sparas. Se server/src/referral/kod.ts. */
const KOD_FORM = /^[A-HJKMNP-Z2-9]{4}-?[A-HJKMNP-Z2-9]{4}$/;

/** `.loopa.nu` i drift, så att cookien följer med till app.loopa.nu. Lokalt: värden själv. */
function domanAttribut(): string {
  const host = window.location.hostname;
  return host === "loopa.nu" || host.endsWith(".loopa.nu") ? "; Domain=.loopa.nu" : "";
}

function skrivCookie(varde: string | null): void {
  try {
    const sakert = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      varde === null
        ? `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${domanAttribut()}${sakert}`
        : `${COOKIE}=${encodeURIComponent(varde)}; Max-Age=${GILTIG_S}; Path=/; SameSite=Lax${domanAttribut()}${sakert}`;
  } catch {
    // Cookies avstängda. Värvningen går förlorad, säljet eller köpet gör det inte.
  }
}

/** Koden, om cookien finns. Webbläsaren har redan kastat den efter 30 dagar (Max-Age). */
export function sparadAffiliate(): string | null {
  try {
    const rad = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
    const kod = rad ? decodeURIComponent(rad.slice(COOKIE.length + 1)) : "";
    return KOD_FORM.test(kod) ? kod : null;
  } catch {
    return null;
  }
}

/**
 * Läser affiliate-koden ur adressen och sparar den. Anropas en gång vid start.
 *
 *   /p/KOD     — den delade länken. En SÖKVÄG, för att Cloudflare kan routa sökvägar men inte
 *                query-strängar (se server/src/affiliate/regler.ts, affiliateLank).
 *   ?aff=KOD   — bekräftelsemejlets form (medAffiliate), där ingen Worker står emellan.
 *
 * Koden tas bort ur adressfältet så att den inte följer med när sidan delas vidare. Sökvägsformen
 * lämnar besökaren på roten: /p/KOD är en ingång, ingen sida att stanna på.
 */
export function fangaAffiliate(): void {
  try {
    const url = new URL(window.location.href);
    const urSokvag = /^\/p\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    const raw = urSokvag ? decodeURIComponent(urSokvag) : url.searchParams.get("aff");
    if (!raw) return;
    const kod = raw.trim().toUpperCase();
    if (KOD_FORM.test(kod) && !sparadAffiliate()) skrivCookie(kod);
    url.searchParams.delete("aff");
    const vag = urSokvag ? "/" : url.pathname;
    window.history.replaceState(window.history.state, "", vag + url.search + url.hash);
  } catch {
    // Ingen adress att läsa, eller ingen historik att skriva. Inget att fånga.
  }
}

/**
 * Adressen bekräftelsemejlet ska leda tillbaka till, med koden i.
 *
 * Mejlet öppnas ofta på en annan enhet än registreringen, och där finns ingen cookie. Med koden i
 * länken fångas den igen där (fangaAffiliate), och anspråket går därifrån.
 */
export function medAffiliate(url: string): string {
  const kod = sparadAffiliate();
  if (!kod) return url;
  const u = new URL(url);
  u.searchParams.set("aff", kod);
  return u.toString();
}

/** Anspråket är gjort, vad servern än svarade. Koden har gjort sitt. */
export function rensaAffiliate(): void {
  skrivCookie(null);
}
