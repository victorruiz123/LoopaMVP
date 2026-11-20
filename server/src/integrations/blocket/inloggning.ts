/**
 * Inloggningen mot Blocket i ett synligt Chrome-fönster, som en funktion.
 *
 * Utbruten ur logga-in.ts så att två kommandon kan dela den:
 *   npm run blocket:logga-in     sparar sessionen till den lokala filen
 *   npm run blocket:byt-session  skickar den till servern (byt-session.ts)
 *
 * Funktionen sparar ingenting själv. Den returnerar sessionen OCH vilket konto den tillhör när
 * inloggningen är KLAR, och null om fönstret stängdes eller tiden gick ut.
 *
 * ALLTID EN TOM PROFIL. Fönstret får aldrig ärva någon inloggning — varken serverns nuvarande
 * session, din vanliga Chrome eller en tidigare körning. Annars kunde det se ut som en ny inloggning
 * fast det var det gamla kontot som kom tillbaka. Playwright startar Chrome med en tillfällig profil,
 * och funktionen kontrollerar dessutom att kakburken är tom innan Blocket öppnas.
 *
 * VILKET KONTO. Blocket väljer konto efter MEJLADRESSEN som skrivs in (inloggningen är e-post +
 * engångskod). BankID väljer inget konto — det bekräftar identiteten på det konto mejladressen
 * pekade ut, när Blocket ber om det. Därför läses kontot av från "Mitt konto" efteråt och visas,
 * så att den som loggat in ser att det blev rätt innan sessionen går vidare.
 *
 * SPARA INTE FÖR TIDIGT. Schibsted roterar sessionen när BankID slutförs, så ett storageState taget
 * mitt i flödet innehåller den utloggade sessionen. Därför går loopen till Mina annonser en gång till
 * och kräver att den sidan inte skickar tillbaka till inloggningen.
 */

import { chromium, type Browser, type Page } from "playwright";
import { blocketBaseUrl } from "./blocket.js";
import { isLoggedOut } from "./browser.js";

export interface InloggningsVal {
  /** Hur länge inloggningen får ta. Engångskod i mejlen plus BankID tar några minuter. */
  timeoutMs?: number;
  /** Vart lägesraderna skrivs. console.log som förval. */
  skriv?: (rad: string) => void;
}

export interface BlocketKonto {
  namn: string | null;
  mejl: string | null;
}

export interface Inloggning {
  /** Playwright-storageState som JSON. */
  session: string;
  konto: BlocketKonto;
}

const ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];
const MEJL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Riktiga Google Chrome om den finns installerad, annars Playwrights Chrome for Testing. */
async function startaChrome(): Promise<{ browser: Browser; vilken: string }> {
  try {
    return { browser: await chromium.launch({ channel: "chrome", headless: false, args: ARGS }), vilken: "Google Chrome" };
  } catch {
    return { browser: await chromium.launch({ headless: false, args: ARGS }), vilken: "Chrome for Testing (Playwright)" };
  }
}

/**
 * Konto ur sidan "Mitt konto": rubriken "Hej <namn>" och den första mejladressen i texten.
 * Ren funktion, så att tolkningen går att pröva utan webbläsare.
 */
export function tolkaKonto(rubriker: string[], text: string): BlocketKonto {
  const hej = rubriker.map((r) => r.trim()).find((r) => /^Hej\b/i.test(r));
  const namn = hej?.replace(/^Hej[,!]?\s*/i, "").replace(/[!.]+$/, "").trim() || null;
  const mejl = text.match(MEJL)?.[0] ?? null;
  return { namn, mejl };
}

/** Läser vilket konto sidan är inloggad på. Lämnar sidan på "Mitt konto". */
export async function lasKonto(page: Page): Promise<BlocketKonto> {
  await page.goto(`${blocketBaseUrl()}/my-page/my-account`, { waitUntil: "domcontentloaded" }).catch(() => null);
  await page
    .locator("h1, h2, h3")
    .filter({ hasText: /^\s*Hej\b/ })
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => null);
  const rubriker = await page.locator("h1, h2, h3").allInnerTexts().catch(() => [] as string[]);
  const text = await page.locator("body").innerText().catch(() => "");
  return tolkaKonto(rubriker, text);
}

/** "Namn <mejl>", eller så mycket av det som gick att läsa. */
export function kontoText(konto: BlocketKonto | null): string {
  if (!konto || (!konto.namn && !konto.mejl)) return "okänt konto (kunde inte läsas från Mitt konto)";
  if (konto.namn && konto.mejl) return `${konto.namn} <${konto.mejl}>`;
  return konto.namn ?? konto.mejl!;
}

export async function loggaInIWebblasare(val: InloggningsVal = {}): Promise<Inloggning | null> {
  const timeoutMs = val.timeoutMs ?? Number(process.env.BLOCKET_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);
  const skriv = val.skriv ?? ((rad: string) => console.log(rad));

  const { browser, vilken } = await startaChrome();
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "sv-SE",
    });
    if ((await context.cookies()).length > 0) {
      throw new Error("Webbläsarprofilen var inte tom — avbryter hellre än att riskera det gamla kontot.");
    }
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();
    await page.bringToFront().catch(() => null);
    skriv(`  Öppnar ${vilken} med en tom profil — ingen tidigare inloggning följer med.`);

    const minaAnnonser = `${blocketBaseUrl()}/mina-annonser`;
    await page.goto(minaAnnonser, { waitUntil: "domcontentloaded" }).catch(() => null);
    await page.waitForTimeout(2000).catch(() => null);

    // Cookiebannern täcker knapparna. Klickas bort en gång; kommer den tillbaka gör den det över en sida
    // användaren själv styr, och då klickar de bort den.
    for (const sel of ['button:has-text("Godkänn alla")', 'button:has-text("Acceptera alla")', 'button:has-text("Godkänn")']) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => null);
        break;
      }
    }

    skriv(`  Väntar upp till ${Math.round(timeoutMs / 60000)} minuter.\n`);
    skriv("  1. Skriv in mejladressen till det Blocket-konto som ska användas — det är den som väljer konto.");
    skriv("  2. Ange koden från mejlet, och legitimera dig med BankID när Blocket ber om det.");
    skriv("  3. Gör ingenting mer — kontot läses av och fönstret stängs av sig självt.\n");

    const slut = Date.now() + timeoutMs;
    let varv = 0;
    while (Date.now() < slut) {
      await page.waitForTimeout(3000).catch(() => null);
      varv++;

      if (page.isClosed()) {
        skriv("\n  ✗ Fönstret stängdes innan inloggningen var klar.\n");
        return null;
      }

      const url = page.url();
      const påBlocket = /(^|\.)blocket\.se$/i.test(new URL(url).hostname);
      if (!påBlocket || isLoggedOut(url)) {
        if (varv % 10 === 0) skriv(`  … väntar (${url.slice(0, 70)})`);
        continue;
      }

      // Ser inloggat ut. Kontrollera det genom att gå till Mina annonser en gång till — en sida mitt i
      // inloggningsflödet kan ligga på blocket.se utan att sessionen är klar.
      await page.goto(minaAnnonser, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(2500).catch(() => null);
      if (page.isClosed() || isLoggedOut(page.url())) {
        skriv("  … inte klar än, fortsätter vänta");
        continue;
      }

      const konto = await lasKonto(page);
      // Sessionen tas SIST, efter alla sidbyten, så att den innehåller de färskaste kakorna.
      const session = JSON.stringify(await context.storageState(), null, 2);
      return { session, konto };
    }

    skriv("\n  ✗ Tiden gick ut utan att inloggningen blev klar.\n");
    return null;
  } finally {
    await browser.close().catch(() => null);
  }
}
