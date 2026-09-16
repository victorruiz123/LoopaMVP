/**
 * Är Blocket-publiceringen påkopplad, och i vilket läge?
 *
 * Motsvarigheten till `tradera.ts` — fast utan API-nycklar, för Blocket har inget API att lägga upp
 * annonser i. Det som krävs här är en INLOGGAD SESSION, och den är sådant en människa måste ha ordnat.
 *
 * Postnumret är INTE en inställning här längre. Det är säljarens, olika för varje möbel — se saljare.ts.
 *
 * ALLT LÄSES VID ANROP, aldrig som konstanter på modulnivå. server.ts kallar `loadEnvFile` i sin
 * modulkropp, och ESM kör alla importerade moduler före den — en konstant här hade aldrig sett
 * server/.env. Samma fälla som publish.ts i tradera/ bär en varning om.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DATA_DIR } from "../../jobStore.js";

/** Sessionsfilen: Playwrights `storageState`, skapad genom en inloggning för hand. */
const SESSION_VAR = "BLOCKET_SESSION";

export function missingBlocketEnv(): string[] {
  return process.env[SESSION_VAR]?.trim() || sessionFranMiljo() ? [] : [SESSION_VAR];
}

export function blocketConfigured(): boolean {
  return missingBlocketEnv().length === 0;
}

/**
 * Sessionsfilens absoluta sökväg, eller null när ingen session är angiven.
 *
 * TVÅ VÄGAR IN. `BLOCKET_SESSION` pekar på en fil och vinner när den är satt. Annars tas sessionen ur
 * miljön, i SAMMA FORM SOM RAILWAY-PROXYN LÄSTE DEN — se `sessionFranMiljo` nedan.
 */
export function sessionFile(): string | null {
  const raw = process.env[SESSION_VAR]?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return sessionFranMiljo();
}

/**
 * Sessionen ur en miljövariabel, skriven till en fil som Playwright kan läsa.
 *
 * VARFÖR DEN FINNS. Benjamins BankID-session bodde i Railway, i variabeln BLOCKET_STORAGE_STATE_GZIP
 * (railway-proxy-company-blocket i vips-buy-sell-hub). Inte på någon dator och inte på Oracle. När
 * appen flyttade följde variabeln inte med, och publiceringen möttes av en inloggningssida. Samma
 * namn och samma format här betyder att värdet kan klistras över rakt av — utan att någon behöver
 * legitimera sig på nytt, så länge sessionen inte gått ut.
 *
 * FORMATEN, som proxyn skrev dem (export-storage-state.js):
 *   BLOCKET_STORAGE_STATE_GZIP  base64 av gzippad storageState-JSON
 *   BLOCKET_STORAGE_STATE       storageState-JSON som den är
 * Företagsvarianterna (BLOCKET_COMPANY_…) läses också. Värdet känns igen på innehållet och inte på
 * namnet, för proxyn läste BLOCKET_COMPANY_STORAGE_STATE som båda.
 *
 * FILEN SKRIVS INTE ÖVER VID VARJE START. Blocket roterar sessionen när BankID slutförs, och
 * `saveSessionIfReal` skriver då den nya till filen. Skrevs miljövärdet tillbaka vid nästa omstart vore
 * den roterade sessionen borta och den gamla — utloggade — tillbaka. Filen skrivs därför bara när den
 * saknas eller när MILJÖVÄRDET ändrats, alltså när någon faktiskt klistrat in en ny session.
 */
function sessionFranMiljo(): string | null {
  const kalla = [
    process.env.BLOCKET_STORAGE_STATE_GZIP,
    process.env.BLOCKET_COMPANY_STORAGE_STATE_GZIP,
    process.env.BLOCKET_STORAGE_STATE,
    process.env.BLOCKET_COMPANY_STORAGE_STATE,
  ]
    .map((v) => v?.trim())
    .find((v) => !!v);
  if (!kalla) return null;

  const json = avkodaStorageState(kalla);
  if (!json) {
    varnaEnGang("Blocket-sessionen i miljön gick inte att läsa som storageState (varken JSON eller base64+gzip).");
    return null;
  }

  const katalog = process.env.BLOCKET_DATA_DIR?.trim() || path.join(DATA_DIR, "blocket");
  const fil = path.join(katalog, "session.json");
  const markering = path.join(katalog, "session.kalla");
  const avtryck = createHash("sha256").update(kalla).digest("hex");
  const tidigare = existsSync(markering) ? readFileSync(markering, "utf8").trim() : null;

  if (!existsSync(fil) || tidigare !== avtryck) {
    mkdirSync(katalog, { recursive: true, mode: 0o700 });
    writeFileSync(fil, json, { encoding: "utf8", mode: 0o600 });
    writeFileSync(markering, avtryck, "utf8");
  }
  return fil;
}

/** storageState-JSON ur ett miljövärde i något av proxyns två format, eller null. */
function avkodaStorageState(varde: string): string | null {
  const kandidater: Array<() => string> = [
    () => varde,
    () => gunzipSync(Buffer.from(varde, "base64")).toString("utf8"),
  ];
  for (const kandidat of kandidater) {
    try {
      const text = kandidat();
      const state = JSON.parse(text) as { cookies?: unknown };
      if (Array.isArray(state.cookies)) return text;
    } catch {
      // Nästa format.
    }
  }
  return null;
}

let varnat = false;
function varnaEnGang(text: string): void {
  if (varnat) return;
  varnat = true;
  console.warn(`[blocket] ${text}`);
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
