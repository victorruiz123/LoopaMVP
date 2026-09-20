/**
 * Inbjudningskoden: fyra plus fyra tecken, "K7QM-2XRP".
 *
 * ALFABETET SAKNAR DET SOM GÅR ATT FÖRVÄXLA. Koden läses upp i telefon, skrivs av från en skärm och
 * står i en länk någon klistrat in i ett sms. 0/O, 1/I/L är de par som faktiskt blandas ihop, och
 * ett tecken som inte finns kan inte skrivas fel. 31 tecken i åtta positioner är ~8,5 × 10¹¹ koder —
 * långt från att gå att gissa sig fram till en giltig.
 */

import { randomInt } from "node:crypto";

export const KOD_ALFABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** En ny kod, slumpad ur kryptografisk källa. Unikheten avgörs av lagret — se regler.ts. */
export function nyKod(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += KOD_ALFABET[randomInt(KOD_ALFABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Koden i sin enda form, eller null.
 *
 * Förlåtande mot det människor gör med en kod — gemener, mellanslag, bindestreck på fel ställe — men
 * inte mot tecken som inte finns i alfabetet. "K7QM2XRP", "k7qm-2xrp" och "K7QM 2XRP" är samma kod;
 * "K7QM-2XR0" är ingen kod alls, och ska inte rättas till en som råkar finnas.
 */
export function normaliseraKod(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8) return null;
  for (const c of s) if (!KOD_ALFABET.includes(c)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Var inbjudningslänkarna pekar, när det är bestämt. Null = inte satt.
 *
 * REFERRAL_LINK_BASE går först, och finns för lokal utveckling: där är LOOPA_PUBLIC_URL osatt (den
 * styr också truth-cardets länk i Tradera-annonser, och en localhost-adress där vore skarp och fel),
 * men en inbjudan måste gå att öppna på en telefon. Sätt den till datorns nätverksadress,
 * t.ex. https://192.168.1.140:5190, så fungerar samma länk på datorn och telefonen. I drift räcker
 * LOOPA_PUBLIC_URL (https://loopa.nu).
 */
export function inbjudningsbas(): string | null {
  const bas = process.env.REFERRAL_LINK_BASE?.trim() || process.env.LOOPA_PUBLIC_URL?.trim() || "";
  return bas ? bas.replace(/\/$/, "") : null;
}

/**
 * Länken som delas: loopa.nu/?ref=KOD.
 *
 * Roten, för att det är dit Workern skickar säljflödet och där klienten fångar koden. Utan en satt
 * bas står den kanoniska domänen här — utbetalningsbrevet har ingen sida att fråga, och en länk i
 * ett brev ska fungera.
 */
export function inbjudningslank(kod: string): string {
  return `${inbjudningsbas() ?? "https://loopa.nu"}/?ref=${encodeURIComponent(kod)}`;
}
