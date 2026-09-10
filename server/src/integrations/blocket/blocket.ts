/**
 * Är Blocket-publiceringen påkopplad, och i vilket läge?
 *
 * Motsvarigheten till `tradera.ts` — fast utan API-nycklar, för Blocket har inget API att lägga upp
 * annonser i. Det som krävs här är en INLOGGAD SESSION och ett postnummer, och båda är sådant en
 * människa måste ha ordnat en gång.
 *
 * ALLT LÄSES VID ANROP, aldrig som konstanter på modulnivå. server.ts kallar `loadEnvFile` i sin
 * modulkropp, och ESM kör alla importerade moduler före den — en konstant här hade aldrig sett
 * server/.env. Samma fälla som publish.ts i tradera/ bär en varning om.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Sessionsfilen: Playwrights `storageState`, skapad genom en inloggning för hand. */
const SESSION_VAR = "BLOCKET_SESSION";

/** Postnumret annonsen ska ligga på. Blocket kräver det; Loopa vet inte var möbeln står. */
const POSTAL_VAR = "BLOCKET_POSTNUMMER";

const REQUIRED = [SESSION_VAR, POSTAL_VAR] as const;

export function missingBlocketEnv(): string[] {
  return REQUIRED.filter((name) => !process.env[name]?.trim());
}

export function blocketConfigured(): boolean {
  return missingBlocketEnv().length === 0;
}

/** Sessionsfilens absoluta sökväg, eller null när variabeln inte är satt. */
export function sessionFile(): string | null {
  const raw = process.env[SESSION_VAR]?.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/**
 * Finns sessionsfilen på disk?
 *
 * Skild från `blocketConfigured()` med flit. En satt variabel som pekar på en fil som inte finns är
 * ett annat fel än en osatt variabel, och det går att laga på ett annat sätt — genom att logga in,
 * inte genom att redigera .env. Gränssnittet ska kunna säga vilket av de två det är.
 */
export function sessionFileExists(): boolean {
  const file = sessionFile();
  return Boolean(file && existsSync(file));
}

export function blocketPostalCode(): string {
  return (process.env[POSTAL_VAR] ?? "").replace(/\s+/g, "");
}

/**
 * SKARPT LÄGE. Utan den här är varje körning en torrkörning som stannar före sista knappen.
 *
 * Förvalet är omvänt mot Tradera-vägen, och det är avsiktligt. Tradera-annonsen läggs upp genom ett
 * API som svarar vad som hände och som går att ta ner igen med ett anrop. Blocket-annonsen läggs upp
 * genom att en robot klickar i någon annans formulär på ett riktigt privatkonto, och det finns ingen
 * automatisk väg att ta ner den. Det som inte går att ångra ska inte vara förvalt.
 */
export function blocketLivePublishing(): boolean {
  return process.env.BLOCKET_PUBLICERA === "1";
}

/**
 * Synlig webbläsare.
 *
 * Måste vara på när BankID kan komma upp: legitimeringen sker i en app i handen på en människa, och
 * en osynlig webbläsare ger dem inget att titta på. Servern kör annars headless.
 */
export function blocketHeadful(): boolean {
  return process.env.BLOCKET_SYNLIG === "1";
}

/**
 * Adressen till Blocket, som en funktion och inte en konstant.
 *
 * Sömmen finns för att flödet ska gå att prova. Publiceringen kan inte testas mot den riktiga sajten
 * — det kräver en inloggad session, och ett test som lägger upp annonser är inget test. Med
 * `BLOCKET_BAS_URL` går hela körningen i stället mot attrappen i tests/, och då prövas navigeringen,
 * kategorikaskaden, frakt- och paketsidorna och kvitto-URL:en på riktigt.
 *
 * Samma tanke som `TRADERA_SOURCE` och den injicerade `TraderaFetchers`: det som måste gå att prova
 * måste gå att peka om.
 */
export function blocketBaseUrl(): string {
  return (process.env.BLOCKET_BAS_URL || "https://www.blocket.se").replace(/\/+$/, "");
}

/** Sant bara mot riktiga blocket.se. Styr om sessionen får skrivas tillbaka efter en körning. */
export function isRealBlocket(): boolean {
  try {
    return /(^|\.)blocket\.se$/i.test(new URL(blocketBaseUrl()).hostname);
  } catch {
    return false;
  }
}
