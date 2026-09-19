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
 * Länken som delas: loopa.nu/?ref=KOD.
 *
 * Roten, för att det är dit Workern skickar säljflödet (deploy/cloudflare/wrangler.toml, rutten
 * "loopa.nu/") och där klienten fångar koden. LOOPA_PUBLIC_URL är https://loopa.nu i drift; utan den
 * står den kanoniska domänen här, inte localhost — en länk i ett utbetalningsbrev ska fungera.
 */
export function inbjudningslank(kod: string): string {
  const bas = (process.env.LOOPA_PUBLIC_URL?.trim() || "https://loopa.nu").replace(/\/$/, "");
  return `${bas}/?ref=${encodeURIComponent(kod)}`;
}
