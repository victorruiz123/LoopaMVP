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
 * Startar med TOM webbläsarprofil, inte med den sparade sessionen. En utgången session tar med sig
 * halvdöda kakor in i inloggningen, och Blocket svarar då ibland med en sida som varken är inloggad
 * eller utloggad.
 */

import { chromium } from "playwright";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { blocketBaseUrl, isRealBlocket, sessionFile } = await import("./blocket.js");
const { isLoggedOut } = await import("./browser.js");

const fil = sessionFile();
if (!fil) {
  console.error("\n  ✗ BLOCKET_SESSION är inte satt i server/.env — jag vet inte var sessionen ska sparas.\n");
  process.exit(1);
}
if (!isRealBlocket()) {
  console.error(`\n  ✗ BLOCKET_BAS_URL pekar på ${blocketBaseUrl()}, inte blocket.se. En session därifrån är värdelös.\n`);
  process.exit(1);
}

/** Hur länge inloggningen får ta. Engångskod i mejlen plus BankID tar några minuter. */
const TIMEOUT_MS = Number(process.env.BLOCKET_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

console.log("\nBlocket-inloggning\n");
console.log(`  Sparas till   ${fil}`);
console.log(`  Väntar upp till ${Math.round(TIMEOUT_MS / 60000)} minuter\n`);

const browser = await chromium.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "sv-SE",
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

const page = await context.newPage();
const minaAnnonser = `${blocketBaseUrl()}/mina-annonser`;
await page.goto(minaAnnonser, { waitUntil: "domcontentloaded" }).catch(() => null);
await page.waitForTimeout(2000);

// Cookiebannern täcker knapparna. Klickas bort en gång; kommer den tillbaka gör den det över en sida
// användaren själv styr, och då klickar de bort den.
for (const sel of ['button:has-text("Godkänn alla")', 'button:has-text("Acceptera alla")', 'button:has-text("Godkänn")']) {
  const el = page.locator(sel).first();
  if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
    await el.click({ timeout: 2000 }).catch(() => null);
    break;
  }
}

console.log("  1. Logga in i fönstret som öppnades (e-post + engångskod, ev. BankID).");
console.log("  2. Vänta tills du ser dina annonser.");
console.log("  3. Gör ingenting mer — sessionen sparas av sig själv.\n");

const slut = Date.now() + TIMEOUT_MS;
let sparad = false;
let varv = 0;

while (Date.now() < slut) {
  await page.waitForTimeout(3000);
  varv++;

  if (page.isClosed()) {
    console.error("\n  ✗ Fönstret stängdes innan inloggningen var klar. Ingenting sparades.\n");
    break;
  }

  const url = page.url();
  const påBlocket = /(^|\.)blocket\.se$/i.test(new URL(url).hostname);
  if (!påBlocket || isLoggedOut(url)) {
    if (varv % 10 === 0) console.log(`  … väntar (${url.slice(0, 70)})`);
    continue;
  }

  // Ser inloggat ut. Kontrollera det genom att gå till Mina annonser en gång till — en sida mitt i
  // inloggningsflödet kan ligga på blocket.se utan att sessionen är klar.
  await page.goto(minaAnnonser, { waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(2500);
  if (page.isClosed() || isLoggedOut(page.url())) {
    console.log("  … inte klar än, fortsätter vänta");
    continue;
  }

  await context.storageState({ path: fil });
  sparad = true;
  console.log(`\n  ✓ Inloggad. Sessionen sparad till ${fil}`);
  console.log("    Verifiera med: npm run blocket:prov -- <jobId> --session\n");
  break;
}

if (!sparad && !page.isClosed()) {
  console.error("\n  ✗ Tiden gick ut utan att inloggningen blev klar. Ingenting sparades.\n");
  process.exitCode = 1;
}

await browser.close().catch(() => null);
