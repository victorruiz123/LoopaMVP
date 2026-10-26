/**
 * Partnern på klientsidan: fånga den ur länken, håll den i en cookie i 30 dagar, skicka den med när
 * säljaren trycker "Sälj med Loopa".
 *
 * En partner är ett företag som rekommenderar Loopa till sina kunder — se server/src/partner/partners.ts
 * för regeln. Länken är loopa.nu/p/<slug>, samma sökväg som affiliate-länken (lib/affiliate.ts). De
 * krockar inte: affiliate är en kod ur kod-alfabetet, en partner är ett ord ur listan nedan. Den här
 * körs FÖRE fangaAffiliate, och lämnar adressen orörd när slugen inte är en partner.
 *
 * EN COOKIE OCH INTE localStorage, av samma skäl som affiliate: länken öppnas på loopa.nu, men
 * säljaren kan logga in och sälja på app.loopa.nu.
 *
 * SENASTE LÄNKEN GÄLLER, till skillnad från inbjudan och affiliate. Ingen får något för att ha varit
 * först här; det som räknas är vem som skickade säljaren nu.
 *
 * SLUGEN ÄR BARA ETT PÅSTÅENDE HÄR. Servern slår upp den och sätter villkoren — se server.ts,
 * handlePublishTradera.
 */

import globalflyttLogga from "../assets/partner/globalflytt.png";

export interface Partner {
  slug: string;
  namn: string;
  logga: string;
}

/** Samma lista som servern (server/src/partner/partners.ts), med loggan som servern inte behöver. */
const PARTNERS: Record<string, Partner> = {
  globalflytt: { slug: "globalflytt", namn: "Global Flytt", logga: globalflyttLogga },
};

const COOKIE = "loopa_partner";
const GILTIG_S = 30 * 24 * 60 * 60;

/** `.loopa.nu` i drift, så att cookien följer med till app.loopa.nu. Lokalt: värden själv. */
function domanAttribut(): string {
  const host = window.location.hostname;
  return host === "loopa.nu" || host.endsWith(".loopa.nu") ? "; Domain=.loopa.nu" : "";
}

function skrivCookie(varde: string): void {
  try {
    const sakert = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${COOKIE}=${encodeURIComponent(varde)}; Max-Age=${GILTIG_S}; Path=/; SameSite=Lax${domanAttribut()}${sakert}`;
  } catch {
    // Cookies avstängda. Partnern går förlorad för den här säljaren; säljet gör det inte.
  }
}

/** Partnern säljaren kom via, om cookien finns och slugen fortfarande är en partner. */
export function sparadPartner(): Partner | null {
  try {
    const rad = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
    const slug = rad ? decodeURIComponent(rad.slice(COOKIE.length + 1)) : "";
    return PARTNERS[slug] ?? null;
  } catch {
    return null;
  }
}

/**
 * Samma anrop som `track` i butik/components/Bits.tsx, utan att dra in butikens kod i startsidans
 * paket för en enda rad. Ingen identitet, ingen kaka — se server/src/analys/store.ts.
 */
function raknaBesok(slug: string): void {
  try {
    const kropp = JSON.stringify({ event: `partner_besok_${slug}`, props: {} });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/analys", new Blob([kropp], { type: "application/json" }));
    else void fetch("/api/analys", { method: "POST", body: kropp, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
  } catch {
    // Mätningen får aldrig märkas av den som mäts.
  }
}

/**
 * Läser partnern ur /p/<slug> och sparar den. Anropas en gång vid start, före fangaAffiliate.
 *
 * Besöket räknas här (partner_besok_<slug>, se server/src/analys/store.ts) — det är panelens siffra
 * för hur många som öppnat länken. Adressen blir roten: /p/<slug> är en ingång, ingen sida.
 */
export function fangaPartner(): void {
  try {
    const url = new URL(window.location.href);
    const slug = /^\/p\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    const partner = slug ? PARTNERS[decodeURIComponent(slug).trim().toLowerCase()] : undefined;
    if (!partner) return;
    skrivCookie(partner.slug);
    raknaBesok(partner.slug);
    window.history.replaceState(window.history.state, "", "/" + url.search + url.hash);
  } catch {
    // Ingen adress att läsa, eller ingen historik att skriva. Inget att fånga.
  }
}
