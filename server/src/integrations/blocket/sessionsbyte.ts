/**
 * Att ta en ny Blocket-session i bruk — på den maskin där den här koden kör.
 *
 * Kallas av installera-session.ts på servern, som i sin tur kallas av byt-session.ts på din dator.
 * Ingen omstart behövs: `sessionFile()` läses vid varje körning, och vaktens besked ligger i en fil.
 *
 * VART SESSIONEN SKRIVS. Till `sessionFile()`, alltså samma fil som roboten läser — oavsett om servern
 * får sin session via BLOCKET_SESSION (en fil) eller via BLOCKET_STORAGE_STATE_GZIP (miljön, packad
 * till data/blocket/session.json). I det andra fallet skrivs miljövärdet INTE tillbaka vid nästa
 * omstart: `sessionFranMiljo` skriver bara när miljövärdet ändrats, och det har det inte.
 *
 * ATOMISKT. En robot som läser filen i samma ögonblick ska se antingen den gamla eller den nya, aldrig
 * en halv. Därför en tillfällig fil bredvid och rename.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { glomHalsa, sessionFile } from "./blocket.js";

interface Kaka {
  name?: unknown;
  domain?: unknown;
}

/**
 * Är texten en storageState från en Blocket-inloggning? Null när den är det, annars varför inte.
 *
 * Fångar de troliga misstagen — fel fil, en tom profil, en session från attrappen i tests/ — men
 * kan inte avgöra om sessionen GÄLLER. Det gör bara en webbläsare mot Blocket (vakt.ts).
 */
export function felISession(text: string): string | null {
  let state: { cookies?: unknown; origins?: unknown };
  try {
    state = JSON.parse(text);
  } catch {
    return "Sessionen är inte JSON.";
  }
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies)) {
    return "Sessionen saknar kakor — det är ingen Playwright-storageState.";
  }
  const kakor = state.cookies as Kaka[];
  const blocket = kakor.filter((k) => typeof k?.domain === "string" && /(^|\.)blocket\.se$/i.test(k.domain.replace(/^\./, "")));
  const inloggning = kakor.filter((k) => typeof k?.domain === "string" && /(^|\.)vend\.se$/i.test(k.domain.replace(/^\./, "")));
  if (blocket.length === 0) return "Sessionen har inga kakor från blocket.se.";
  if (inloggning.length === 0) return "Sessionen har inga kakor från Blockets inloggning (vend.se) — inloggningen blev aldrig klar.";
  return null;
}

/** Skriver den nya sessionen och glömmer vaktens dom över den gamla. Returnerar filens sökväg. */
export function installeraSession(text: string): string {
  const fel = felISession(text);
  if (fel) throw new Error(fel);

  const fil = sessionFile();
  if (!fil) {
    throw new Error(
      "Servern har ingen Blocket-session konfigurerad. Sätt BLOCKET_SESSION=./blocket-session.json i server/.env (en gång) och försök igen.",
    );
  }

  mkdirSync(path.dirname(fil), { recursive: true, mode: 0o700 });
  const tillfallig = `${fil}.ny-${process.pid}`;
  writeFileSync(tillfallig, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tillfallig, fil);
  // Vaktens dom över den gamla sessionen gäller inte den nya. Utan raden står "sessionen har gått
  // ut" kvar i panelen tills nästa kontroll, fast inloggningen just lyckades.
  glomHalsa();
  return fil;
}
