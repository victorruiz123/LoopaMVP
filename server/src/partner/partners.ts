/**
 * Partnerna: företag som rekommenderar Loopa till sina kunder, med en egen länk.
 *
 * REGELN, i en mening: en annons som läggs upp via en partners länk bär partnerns namn och säljs
 * utan Loopas provision.
 *
 * SKILT FRÅN BÅDA PROGRAMMEN. En inbjudan (referral/) ger EN gratisförsäljning till den som bjöd in,
 * affiliate (affiliate/) ger den som värvade 5 %. En partner ger ingen något — det är säljaren som
 * får 0 %, på varje annons, och partnern får en märkning och en siffra i panelen.
 *
 * SAMMA LÄNKFORM SOM AFFILIATE, loopa.nu/p/<slug>, för att den sökvägen redan är bunden till appen i
 * Cloudflare (deploy/cloudflare/wrangler.toml). De två krockar inte: en affiliate-kod är åtta tecken
 * ur kod-alfabetet med bindestreck, en partner är ett ord med gemener. Klienten provar partnern först
 * (web/src/lib/partner.ts).
 *
 * LISTAN STÅR I KODEN och inte i en tabell. Partner är ett avtal, inte något någon registrerar sig
 * till, och en ny partner är en rad här — samma rad i web/src/lib/partner.ts — och en logga i
 * web/public/partner/.
 */

import { inbjudningsbas } from "../referral/kod.js";

export interface Partner {
  /** Det som står i länken och på möbelns villkor. Byts aldrig — gamla annonser pekar på det. */
  slug: string;
  namn: string;
}

export const PARTNERS: Record<string, Partner> = {
  globalflytt: { slug: "globalflytt", namn: "Global Flytt" },
};

/** Partnern bakom en slug, eller null. Förlåtande mot versaler och mellanslag, inte mot något annat. */
export function partnerFor(raw: unknown): Partner | null {
  if (typeof raw !== "string") return null;
  return PARTNERS[raw.trim().toLowerCase()] ?? null;
}

/**
 * Länken partnern delar: loopa.nu/p/<slug>. Samma bas som inbjudnings- och affiliate-länkarna
 * (referral/kod.ts), så att den går att öppna på en telefon också lokalt.
 */
export function partnerLank(slug: string): string {
  return `${inbjudningsbas() ?? "https://loopa.nu"}/p/${encodeURIComponent(slug)}`;
}

/**
 * Mätningens händelsenamn för ett besök via länken: "partner_besok_globalflytt".
 *
 * Ett namn per partner och inte en egenskap på ett gemensamt namn: mätningen räknar händelser utan
 * annons per NAMN (analys/store.ts, globalStatistik), och då blir besöken en siffra utan att
 * mätningen behöver lära sig något nytt.
 */
export function besoksHandelse(slug: string): string {
  return `partner_besok_${slug}`;
}
