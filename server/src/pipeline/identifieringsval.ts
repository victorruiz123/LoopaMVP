/**
 * Vad som händer med identifieringen när produktforskningen har svarat — eller inte kunnat.
 *
 * BAKGRUNDEN (första skarpa körningen, 2026-10-11): forskningens anrop föll efter 205 s, och den
 * gamla generatorn (gemini-3.5-flash-lite) fick då göra jobbet i stället. Den gav fyra kandidater, alla
 * ur märkets nuvarande sortiment, ingen av dem rätt — och säljaren såg fyra välvårdade produktbilder
 * på fel stolar som om de vore sökningens bästa gissningar. Det är sämre än ett ärligt "vi hittade
 * ingen": en säljare som väljer fel modell får fel mått, fel material och fel pris på hela annonsen.
 *
 * REGELN NU (sedan 2026-10-21; tidsgränsen på 60 s är borttagen 2026-10-24, men regeln om att inte gissa gäller):
 *   – forskningen svarade (även med noll kandidater): det är svaret. Noll kandidater är ett belagt
 *     "inget bilderna stöder", inte ett fel som något annat ska fylla igen;
 *   – forskningen gav inget svar — tiden tog slut, tjänsten var överbelastad, krediterna är slut: ett ÄRLIGT besked utan kandidater.
 *     Aldrig den gamla generatorn som reserv. Den svarar med en svagare modell och utan tidsgräns, och dess förslag såg lika
 *     säkra ut som forskningens egna; en reserv som lägger tid ovanpå tidsgränsen och gissar vore två fel på en gång.
 *
 * Utfallet (`IdentityResult`) följer med till skärmen, som skiljer på de tre tomma lägena: bilderna räckte inte
 * (`no_match`), tiden räckte inte (`timeout`) och tjänsten gick inte att nå (`unavailable`).
 */

import type { IdentityResult } from "../types.js";
import type { IdentifyOutcome } from "../research/types.js";

export type ForskningsBeslut =
  /** Forskningen har svarat. Använd dess kandidater, hur många de än är. */
  | { use: "research" }
  /** Forskningen gav inget svar: visa en tom väljare med ett ärligt besked. */
  | { use: "none"; why: string; result: Exclude<IdentityResult, "candidates" | "no_match">; note: string };

const NOTE_UNAVAILABLE =
  "AI-tjänsten är inte tillgänglig just nu. Försök igen om en stund, eller skriv modellnamnet själv om du vet det.";
const NOTE_TIMEOUT =
  "Modellsökningen tog för lång tid och avbröts — det är inget fel på dina bilder. Lägg till fler bilder (gärna en närbild på en etikett), försök igen eller skriv modellnamnet själv om du vet det.";
const NOTE_GENERIC = "Modellsökningen kom inte fram den här gången. Försök igen, eller skriv modellnamnet själv om du vet det.";

/** Fel där tiden eller omfånget tog slut — samma besked för säljaren: det räckte inte, och det beror inte på bilderna. */
const TOO_LONG = new Set(["timeout", "deadline", "tool_limit", "tool_budget"]);
/** Fel som säger något om tjänsten just nu, inte om uppgiften. */
const SERVICE = new Set(["billing", "quota", "overloaded", "network", "http"]);

export function beslutaEfterForskning(outcome: IdentifyOutcome): ForskningsBeslut {
  if (outcome.kind === "ok") return { use: "research" };
  const kind = outcome.failKind ?? "unknown";
  if (TOO_LONG.has(kind)) return { use: "none", why: kind, result: "timeout", note: NOTE_TIMEOUT };
  if (SERVICE.has(kind)) return { use: "none", why: kind, result: "unavailable", note: NOTE_UNAVAILABLE };
  return { use: "none", why: kind, result: "unavailable", note: NOTE_GENERIC };
}

/**
 * Raden under en tom väljare när forskningen FICK svar men inte kunde peka ut någon modell. Modellens
 * egen förklaring (på svenska, enligt schemat) är mer användbar än en generisk mening — den säger
 * vad som saknades — men bara om den ser ut som en förklaring och inte som skräp.
 */
export function noteForEmptyResearch(uncertaintyNote: string | null): string | null {
  const n = uncertaintyNote?.trim();
  if (!n || n.length < 12) return null;
  return n.length > 300 ? `${n.slice(0, 297)}…` : n;
}

