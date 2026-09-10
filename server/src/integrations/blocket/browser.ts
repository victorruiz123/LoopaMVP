/**
 * Webbläsaren, sessionen och vägen fram till Torget-formuläret.
 *
 * Blocket har passwordless inloggning och stöder inte längre lösenord. Det går alltså INTE att logga
 * in i kod — sessionen skapas för hand en gång och återanvänds som Playwright-`storageState`. Servern
 * kan bara kontrollera att den fortfarande gäller, och säga till när den inte gör det.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { blocketBaseUrl, blocketHeadful, isRealBlocket, sessionFile } from "./blocket.js";
import { dismissCookieBanner, dismissModal, waitForForm } from "./form.js";
import type { Logga } from "./diag.js";

const ON_FORM = /recommerce\/create/i;

export interface BlocketSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Startar en FÄRSK webbläsare. Aldrig en återanvänd.
 *
 * Railway-proxyn lärde sig det den hårda vägen: en långlivad context bär med sig halvfyllda formulär,
 * cachade sidor och kvarglömda modaler från förra annonsen, och nästa publicering beter sig då
 * annorlunda utan att något i koden ändrats.
 */
export async function startBrowser(): Promise<BlocketSession> {
  const browser = await chromium.launch({
    headless: !blocketHeadful(),
    // Blocket kör bot-detektion. Flaggorna och skriptet nedan är samma uppsättning som railway-proxyn
    // använt i drift utan att bli blockerad.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const file = sessionFile();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "sv-SE",
    ...(file ? { storageState: file } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/** Går till en sida och låter den lugna sig. Blockets formulär renderas i flera omgångar. */
export async function goAndSettle(page: Page, url: string, timeout = 30_000): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => null);
  await page.waitForTimeout(2000);
}

/** Sant när sidan kastat oss till inloggningen. Blocket har tre adresser för samma sak. */
export function isLoggedOut(url: string): boolean {
  return /vend\.se\/authn|email-login|\/login|\/auth/i.test(url);
}

/**
 * Skriver tillbaka sessionen så att den hålls färsk — men BARA mot riktiga Blocket.
 *
 * Utan villkoret skriver en testkörning mot attrappen över sessionsfilen med attrappens kakor, och
 * nästa skarpa körning möts av en inloggningssida utan att någon rört sessionen. Felet är osynligt
 * tills det inträffar, och då ser det ut som att Blocket loggat ut dig.
 */
export async function saveSessionIfReal(context: BrowserContext): Promise<boolean> {
  const file = sessionFile();
  if (!file || !isRealBlocket()) return false;
  await context.storageState({ path: file }).catch(() => null);
  return true;
}

/**
 * Kontrollerar att sessionen gäller — INNAN något formulär öppnas.
 *
 * Ordningen är hela poängen. Upptäcks utloggningen först vid publiceringen har roboten redan hunnit
 * skapa ett halvfyllt utkast som någon får rensa för hand.
 */
export async function ensureSession(page: Page, logga: Logga): Promise<void> {
  await goAndSettle(page, `${blocketBaseUrl()}/mina-annonser`);
  await dismissCookieBanner(page);
  const url = page.url();
  if (isLoggedOut(url)) {
    logga("Sessionen har gått ut", "error", { url });
    throw new Error(
      "Blocket-sessionen har gått ut. Logga in för hand och exportera om sessionsfilen som BLOCKET_SESSION pekar på.",
    );
  }
  logga("Sessionen gäller", "ok", { url });
}

/**
 * FIX 5: BankID-väntan som slutar när legitimeringen faktiskt är klar.
 *
 * Den gamla koden räknade det som klart så fort texten "Bekräfta din identitet" försvann. Men den
 * försvinner REDAN när sidan navigerar vidare till Schibsteds eget flöde
 * (`login.vend.se/authn/...acr_values=eid`) — alltså precis när legitimeringen börjar. Körningen gick
 * då vidare mot ett formulär som inte fanns.
 *
 * Klart är i stället: webbläsaren är tillbaka på blocket.se och utanför inloggningsflödet. Med en
 * människa och en telefon tog det 170 sekunder. Schibsted ROTERAR sessionen när det sker, så den
 * sparas om direkt — annars är den tidigare exporterade storageState utloggad.
 */
export async function handleBankID(page: Page, context: BrowserContext, logga: Logga): Promise<void> {
  const inIdFlow = () => /login\.vend\.se|\/authn|identity\/(finish|verify)/i.test(page.url());
  const promptUp = async () =>
    await page
      .getByText(/Bekräfta din identitet/i)
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);

  if (!(await promptUp()) && !inIdFlow()) return;
  logga("BankID krävs", "running", { url: page.url() });

  if (await promptUp()) {
    // Knappen är <w-button>: texten ligger i light-DOM utanför den <button> som finns i skuggan.
    for (const sel of ['button:has-text("Verifiera med BankID")', 'w-button:has-text("Verifiera med BankID")']) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => null);
        break;
      }
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(3000);
  }

  // Vend frågar vilken BankID-enhet som ska användas. Öppna alternativet så att QR-koden syns — det
  // är den människan skannar. Ingen väg runt: legitimeringen sker i BankID-appen.
  for (const sel of [
    'button:has-text("Mobilt BankID på annan enhet")',
    'button:has-text("BankID på annan enhet")',
    'button:has-text("Mobilt BankID")',
    'button:has-text("BankID på den här enheten")',
  ]) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(2500);
      logga("Öppnade BankID-alternativet", "ok", { selector: sel, url: page.url() });
      break;
    }
  }

  if (!blocketHeadful()) {
    logga("BankID krävs men webbläsaren är osynlig", "error", { url: page.url() });
    throw new Error(
      "Blocket kräver BankID, och ingen kan legitimera sig i en osynlig webbläsare. " +
        "Starta om med BLOCKET_SYNLIG=1 och legitimera dig när fönstret kommer upp.",
    );
  }

  logga("Väntar på legitimering i BankID-appen (upp till 3 min)", "running", { url: page.url() });
  const deadline = Date.now() + 180_000;
  let laps = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    laps++;
    const url = page.url();
    if (/blocket\.se/i.test(url) && !/authn|login|identity/i.test(url)) {
      await saveSessionIfReal(context);
      logga("BankID klar — tillbaka på Blocket", "ok", { url, sekunder: laps * 5 });
      return;
    }
    if (laps % 6 === 0) logga(`Väntar fortfarande (${laps * 5} s)`, "running", { url });
  }
  throw new Error("BankID: legitimeringen slutfördes inte inom tre minuter.");
}

/**
 * FIX 7: klickar TORGET-KORTET, inte ett gammalt utkast.
 *
 * Tio körningar i rad öppnade samma utkast (id 20990506) i stället för att skapa en ny annons. På
 * `create-item/start` ligger "Dina senaste utkast" ÖVERST (y≈198) och korten under (y≈397), och den
 * gamla geometristrategin behöll bara kandidater OVANFÖR utkastlistan — precis fel ände.
 * `div:has-text("Torget") >> button` plockade på samma sätt ett utkast.
 *
 * Rätt element är den NEDERSTA lövnoden vars text är exakt "Torget". Därifrån går vi upp till kortet
 * och klickar mitt i det med musen: kortet är en vanlig `div` utan href och utan `role=button`
 * (Fordon och Bostad är `<a>`), så ett locator-klick har inget att ta i.
 *
 * Sökningen går genom shadow roots med en egen stack. Ingen namngiven hjälpfunktion inuti evaluate —
 * tsx/esbuild lindar sådana i `__name()`, som inte finns i webbläsaren, och hela evaluate faller med
 * "ReferenceError: __name is not defined".
 */
async function clickTorgetCard(page: Page, logga: Logga): Promise<boolean> {
  const geo = await page
    .evaluate(() => {
      const hits: Element[] = [];
      const stack: Array<Document | ShadowRoot | Element> = [document];
      while (stack.length) {
        const root = stack.pop()!;
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (el.children.length === 0 && (el.textContent || "").replace(/\s+/g, " ").trim() === "Torget") hits.push(el);
          if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
        }
      }
      if (!hits.length) return null;

      // Utkastlistan ligger överst, korten under. Nedersta träffen är kortets rubrik.
      hits.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      let card = hits[hits.length - 1] as HTMLElement;

      // Upp till själva kortet: första förfadern som är stor nog att vara ett kort.
      for (let i = 0; i < 6; i++) {
        const parent = card.parentElement ?? ((card.getRootNode() as ShadowRoot).host as HTMLElement | undefined);
        if (!parent) break;
        card = parent;
        const box = card.getBoundingClientRect();
        if (box.width >= 200 && box.height >= 80) break;
      }
      card.scrollIntoView({ block: "center" });
      const box = card.getBoundingClientRect();
      if (box.width < 40 || box.height < 20) return null;
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        width: Math.round(box.width),
        height: Math.round(box.height),
        text: (card.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      };
    })
    .catch(() => null);

  if (!geo) {
    logga("Hittade inget Torget-kort på sidan", "warning", { url: page.url() });
    return false;
  }
  // Kortet ska BÖRJA med "Torget". Gör det inte det har vi fått tag i något annat — ett utkast, en
  // sektionsrubrik — och då är ett klick värre än inget.
  if (!/^Torget/i.test(geo.text)) {
    logga("Kortet ser inte ut som Torget-kortet", "warning", { geo, url: page.url() });
    return false;
  }

  await page.mouse.click(geo.x, geo.y);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(3000);
  const arrived = ON_FORM.test(page.url());
  logga(arrived ? "Klickade Torget-kortet" : "Torget-klicket ledde inte till formuläret", arrived ? "ok" : "warning", {
    url: page.url(),
    geo,
  });
  return arrived;
}

/** Startsidan -> Ny annons -> Torget-kortet -> ett formulär med renderade fält. */
export async function openTorgetForm(page: Page, logga: Logga): Promise<void> {
  await goAndSettle(page, `${blocketBaseUrl()}/`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  logga("Startsidan laddad", "ok", { url: page.url() });

  for (const sel of ['a:has-text("Ny annons")', 'button:has-text("Ny annons")', 'a[href*="create-item/start"]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => null);
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);
      await dismissModal(page);
      logga("Klickade Ny annons", "ok", { url: page.url() });
      break;
    }
  }

  if (!ON_FORM.test(page.url())) {
    if (!/create-item\/start/i.test(page.url())) {
      await goAndSettle(page, `${blocketBaseUrl()}/create-item/start`);
      await dismissCookieBanner(page);
    }
    // Bara kortklicket. De gamla fallbackarna — `a:has-text("Torget")`, `div:has-text("Torget") >>
    // button` — är BORTA med flit: det var de som plockade utkasten. Hellre ett begripligt avbrott än
    // en körning som fyller i någon annans annons.
    await clickTorgetCard(page, logga);
  }

  if (!ON_FORM.test(page.url())) {
    logga("Kom aldrig fram till Torget-formuläret", "error", { url: page.url() });
    throw new Error(`Kunde inte öppna Torget-formuläret. Sidan står på ${page.url()}.`);
  }

  const form = await waitForForm(page);
  logga("Formuläret är redo", "ok", { url: page.url(), ...form });
}

/** Tillbaka till startsidan för annonsskapandet, för ett nytt försök med ett tomt formulär. */
export async function reopenTorgetForm(page: Page, logga: Logga): Promise<boolean> {
  await goAndSettle(page, `${blocketBaseUrl()}/create-item/start`);
  await dismissCookieBanner(page);
  const clicked = await clickTorgetCard(page, logga);
  if (!clicked) return false;
  await waitForForm(page).catch(() => null);
  return ON_FORM.test(page.url());
}

export { ON_FORM };
