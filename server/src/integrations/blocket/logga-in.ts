/**
 * Engångsinloggningen mot Blocket.
 *
 *   npm run blocket:logga-in
 *
 * Öppnar ett synligt Chromium. Du loggar in för hand — Blocket kör passwordless: e-post, engångskod
 * via mejl, ibland BankID. Det finns ingen väg runt det i kod, och det är precis därför sessionen
 * sparas i stället för lösenordet.
 *
 * SKILLNADEN MOT `blocket-publicerare/bin/logga-in.ts`: den väntar på att någon trycker ENTER i
 * terminalen. Den här upptäcker själv när du är inloggad och sparar då. Det spelar roll när skriptet
 * körs av något annat än en människa vid tangentbordet — och det tar bort den vanligaste
 * felkällan: att spara FÖR TIDIGT. Schibsted roterar sessionen när BankID slutförs, så en fil sparad
 * mitt i flödet innehåller den utloggade sessionen.
 *
 * Själva inloggningen bor i inloggning.ts, delad med byt-session.ts.
 *
 * Startar med TOM webbläsarprofil, inte med den sparade sessionen. En utgången session tar med sig
 * halvdöda kakor in i inloggningen, och Blocket svarar då ibland med en sida som varken är inloggad
 * eller utloggad.
 */

import { writeFileSync } from "node:fs";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { blocketBaseUrl, glomHalsa, isRealBlocket, sessionFile } = await import("./blocket.js");
const { kontoText, loggaInIWebblasare } = await import("./inloggning.js");

const fil = sessionFile();
if (!fil) {
  console.error("\n  ✗ BLOCKET_SESSION är inte satt i server/.env — jag vet inte var sessionen ska sparas.\n");
  process.exit(1);
}
if (!isRealBlocket()) {
  console.error(`\n  ✗ BLOCKET_BAS_URL pekar på ${blocketBaseUrl()}, inte blocket.se. En session därifrån är värdelös.\n`);
  process.exit(1);
}

console.log("\nBlocket-inloggning\n");
console.log(`  Sparas till   ${fil}`);
console.log("  (Ska sessionen till servern? Använd npm run blocket:byt-session i stället.)\n");

const inloggning = await loggaInIWebblasare();
if (!inloggning) {
  console.error("  Ingenting sparades.\n");
  process.exitCode = 1;
} else {
  writeFileSync(fil, inloggning.session, { encoding: "utf8", mode: 0o600 });
  // Vaktens dom över den gamla sessionen gäller inte den nya. Utan raden står "sessionen har gått
  // ut" kvar i panelen tills nästa kontroll, fast inloggningen just lyckades.
  glomHalsa();
  console.log(`\n  ✓ Inloggad som ${kontoText(inloggning.konto)}. Sessionen sparad till ${fil}`);
  console.log("    Verifiera med: npm run blocket:prov -- <jobId> --session\n");
}
