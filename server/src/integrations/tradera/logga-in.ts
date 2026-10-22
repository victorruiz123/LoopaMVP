/**
 * Engångsinloggningen mot Tradera, för att kunna läsa meddelandefunktionen.
 *
 *   npm run tradera:logga-in
 *
 * VARFÖR EN WEBBLÄSARSESSION. Tradera-API:t har ingen läsning av meddelanden och inget sätt för en
 * säljare att svara. Meddelandena finns bara i meddelandefunktionen på tradera.com (inkorg.ts), så
 * vägen dit är densamma som för Blocket: en inloggning för hand, sparad som Playwright-`storageState`.
 * Omläggningen läser inkorgen med den innan en annons tas ner (fragor.ts).
 *
 * Inloggningen är e-post + lösenord bakom reCAPTCHA. Den görs därför av en människa i ett synligt
 * Chromium — skriptet fyller aldrig i något. Det upptäcker själv när inloggningen är klar och sparar då,
 * som blocket/logga-in.ts.
 *
 * Sessionen hamnar i TRADERA_SESSION, förval server/tradera-session.json (gitignorerad).
 */

import { chromium } from "playwright";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { traderaSessionFile } = await import("./inkorg.js");
const fil = traderaSessionFile();

/** Hur länge inloggningen får ta. */
const TIMEOUT_MS = Number(process.env.TRADERA_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

console.log("\nTradera-inloggning\n");
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
await page.goto("https://www.tradera.com/login", { waitUntil: "domcontentloaded" }).catch(() => null);
await page.waitForTimeout(2000);

for (const sel of ['button:has-text("Godkänn alla")', 'button:has-text("Acceptera alla")', 'button:has-text("Godkänn")']) {
  const el = page.locator(sel).first();
  if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
    await el.click({ timeout: 2000 }).catch(() => null);
    break;
  }
}

console.log("  1. Logga in i fönstret som öppnades (e-post + lösenord, ev. reCAPTCHA eller kod).");
console.log("  2. Vänta tills du är tillbaka på Tradera, inloggad.");
console.log("  3. Gör ingenting mer — sessionen sparas av sig själv.\n");

/** Inloggad = på tradera.com, inte på inloggningssidan, och inget lösenordsfält kvar. Två varv i rad. */
async function serInloggadUt(): Promise<boolean> {
  const url = new URL(page.url());
  if (!/(^|\.)tradera\.com$/i.test(url.hostname) || /login|logga-in|signin/i.test(url.pathname)) return false;
  return (await page.locator('input[type="password"]').count().catch(() => 1)) === 0;
}

const slut = Date.now() + TIMEOUT_MS;
let sparad = false;
let iRad = 0;
let varv = 0;

while (Date.now() < slut) {
  // Stängs fönstret mitt i väntan kastar waitForTimeout; det är samma utfall som isClosed nedan.
  await page.waitForTimeout(3000).catch(() => null);
  varv++;
  if (page.isClosed()) {
    console.error("\n  ✗ Fönstret stängdes innan inloggningen var klar. Ingenting sparades.\n");
    break;
  }
  iRad = (await serInloggadUt()) ? iRad + 1 : 0;
  if (iRad < 2) {
    if (varv % 10 === 0) console.log(`  … väntar (${page.url().slice(0, 70)})`);
    continue;
  }
  await context.storageState({ path: fil });
  sparad = true;
  console.log(`\n  ✓ Inloggad. Sessionen sparad till ${fil}\n`);
  break;
}

if (!sparad && !page.isClosed()) {
  console.error("\n  ✗ Tiden gick ut utan att inloggningen blev klar. Ingenting sparades.\n");
  process.exitCode = 1;
}

await browser.close().catch(() => null);
