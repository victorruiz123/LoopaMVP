/**
 * Traderas meddelandefunktion, läst i en webbläsare med en sparad inloggning.
 *
 * VARFÖR WEBBLÄSAREN. Tradera-API:t har ingen läsning av meddelanden, och meddelandesidans egna anrop
 * (`/api/webclient/messaging/*`) kräver en token som bara sidan själv har — kakorna räcker inte (401).
 * Sessionen skapas för hand en gång (`npm run tradera:logga-in`, inloggningen har reCAPTCHA) och
 * återanvänds som Playwright-`storageState`, som Blocket-sessionen.
 *
 * UPPMÄTT 2026-10-22, inloggad som säljaren:
 *
 *   /messaging            Listan till vänster laddas efter sidan (Firestore). Varje konversation är en
 *                         länk /messaging/threads/<köpare>_<säljare>_l<annons-id>?show=ALL&limit=15,
 *                         med motpartens namn, datum, "Ang.: <rubrik>" och sista meddelandet.
 *   xcs_<säljare>_l<id>   Traderas kundtjänst och systemmeddelanden ("Du har godkänt leveransen") —
 *                         inte en köpare.
 *
 * Annons-id:t står alltså i länken, och det är det som räknas — aldrig rubriken, som en tidigare
 * annons för samma möbel delar.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

const BAS = "https://www.tradera.com";
const TRAD = 'a[href*="/messaging/threads/"]';

/** Sessionsfilen: TRADERA_SESSION, förval server/tradera-session.json (gitignorerad). */
export function traderaSessionFile(): string {
  const raw = process.env.TRADERA_SESSION?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return new URL("../../../tradera-session.json", import.meta.url).pathname;
}

export function traderaInkorgKonfigurerad(): boolean {
  return existsSync(traderaSessionFile());
}

/** Trådar från köpare om JUST den annonsen. Kundtjänstens trådar (xcs_) räknas inte. Ren funktion. */
export function tradarOmAnnonsen(hrefs: string[], itemId: number): number {
  const ids = new Set<string>();
  for (const href of hrefs) {
    const m = href.match(/\/messaging\/threads\/([^/?#]+)/);
    if (!m || m[1].startsWith("xcs_")) continue;
    if (m[1].endsWith(`_l${itemId}`)) ids.add(m[1]);
  }
  return ids.size;
}

/**
 * Länkarna till alla konversationer i inkorgen. Kastar när den inte gick att läsa: utloggad, eller
 * ingen lista inom tidsgränsen. En tom inkorg går inte att skilja från en som inte laddat, och räknas
 * därför också som oläslig — kontot har trådar sedan länge.
 */
export async function lasTraderaInkorg(): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "sv-SE",
      storageState: traderaSessionFile(),
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    await page.goto(`${BAS}/messaging`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await tradlankar(page);
  } finally {
    await browser.close().catch(() => null);
  }
}

async function tradlankar(page: Page): Promise<string[]> {
  const finns = await page.locator(TRAD).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (/login|logga-in/i.test(new URL(page.url()).pathname)) throw new Error("Tradera-sessionen har gått ut.");
  if (!finns) throw new Error("Inkorgen laddade ingen konversationslista.");
  return page.$$eval(TRAD, (as) => as.map((a) => a.getAttribute("href") ?? ""));
}
