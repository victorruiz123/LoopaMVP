/**
 * Engångsinloggningen mot Facebook.
 *
 *   npm run facebook:login
 *
 * Öppnar ett SYNLIGT Chromium på den persistenta profilen (FACEBOOK_PROFILE_DIR, förval
 * server/data/facebook/profile). Du loggar in för hand — användarnamn, lösenord, eventuell
 * tvåstegskod eller kontrollpunkt löser du själv i fönstret. Ingenting av det sparas av Loopa;
 * webbläsarprofilen bär sessionen.
 *
 * Skriptet upptäcker självt när du är inloggad (profilmenyn syns, inget inloggningsformulär), skriver
 * session.json = CONNECTED och stänger fönstret. Samma profil används sedan av arbetarna, osynligt.
 *
 * Startar ALDRIG mot attrappen: en session därifrån är värdelös.
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { facebookBaseUrl, facebookProfileDir, isRealFacebook } = await import("./config.js");
const { openFacebookBrowser, SESSION_SEL, bodyText } = await import("./session.js");
const { detectInterrupt } = await import("./checkpoint.js");
const { writeSession } = await import("./store.js");

if (!isRealFacebook()) {
  console.error(`\n  ✗ FACEBOOK_BASE_URL pekar på ${facebookBaseUrl()}, inte facebook.com. En session därifrån är värdelös.\n`);
  process.exit(1);
}

const TIMEOUT_MS = Number(process.env.FACEBOOK_LOGIN_TIMEOUT_MS ?? 20 * 60 * 1000);

console.log("\nFacebook-inloggning\n");
console.log(`  Profil        ${facebookProfileDir()}`);
console.log(`  Väntar upp till ${Math.round(TIMEOUT_MS / 60000)} minuter\n`);

/**
 * Fönstret kan dö inom några sekunder utan att någon rört det: en tidigare Chromium på samma profil
 * som fortfarande håller på att stänga tar emot starten, och den nya instansen avslutar sig. En
 * människa hinner inte logga in och stänga på under femton sekunder, så en så snabb stängning är ett
 * kollisionsfall — då öppnas fönstret igen, upp till tre gånger.
 */
const SNABB_STANGNING_MS = 15_000;
let browser = await openFacebookBrowser({ headful: true });
let page = browser.page;
let oppnat = Date.now();
let omstarter = 0;
await page.goto(`${facebookBaseUrl()}/login/`, { waitUntil: "domcontentloaded" }).catch(() => null);

console.log("  1. Logga in i fönstret som öppnades. Lös eventuell tvåstegskod eller kontrollpunkt själv.");
console.log("  2. Vänta tills startsidan (flödet) syns.");
console.log("  3. Gör ingenting mer — sessionen upptäcks och sparas av sig själv.\n");

const slut = Date.now() + TIMEOUT_MS;
let sparad = false;
let varv = 0;

while (Date.now() < slut) {
  await page.waitForTimeout(3000).catch(() => undefined);
  varv++;
  if (page.isClosed()) {
    if (Date.now() - oppnat < SNABB_STANGNING_MS && omstarter < 3) {
      omstarter++;
      console.log(`  … fönstret stängdes direkt (troligen en tidigare Chromium på samma profil) — öppnar igen (${omstarter}/3)`);
      await browser.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 4000));
      browser = await openFacebookBrowser({ headful: true });
      page = browser.page;
      oppnat = Date.now();
      await page.goto(`${facebookBaseUrl()}/login/`, { waitUntil: "domcontentloaded" }).catch(() => null);
      continue;
    }
    console.error("\n  ✗ Fönstret stängdes innan inloggningen var klar. Ingenting sparades.\n");
    break;
  }
  const url = page.url();
  const det = detectInterrupt(url, await bodyText(page), (await page.locator(SESSION_SEL.captchaFrame).count().catch(() => 0)) > 0);
  if (det) {
    if (varv % 10 === 0) console.log(`  … väntar på dig (${det.kind.toLowerCase()} — ${url.slice(0, 70)})`);
    continue;
  }
  const inloggad =
    (await page.locator(SESSION_SEL.navProfile).count().catch(() => 0)) > 0 &&
    (await page.locator(SESSION_SEL.loginForm).count().catch(() => 0)) === 0;
  if (!inloggad) {
    if (varv % 10 === 0) console.log(`  … väntar (${url.slice(0, 70)})`);
    continue;
  }

  await writeSession({ status: "CONNECTED", checkedAt: new Date().toISOString(), url, detail: "Inloggad för hand via npm run facebook:login." });
  sparad = true;
  console.log(`\n  ✓ Inloggad. Sessionen ligger i profilen ${facebookProfileDir()}`);
  console.log("    Arbetarna använder den när FACEBOOK_ENABLED=1 är satt i server/.env.\n");
  break;
}

if (!sparad && !page.isClosed()) {
  console.error("\n  ✗ Tiden gick ut utan att inloggningen blev klar. Ingenting sparades.\n");
  process.exitCode = 1;
}

await browser.close();
