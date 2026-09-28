/**
 * Webbläsaren, den inloggade profilen och vakten mot Facebooks säkerhetssidor.
 *
 * EN PERSISTENT PROFIL, INGEN INLOGGNING I KOD. Operatören loggar in en gång för hand
 * (`npm run facebook:login`), och profilen på disk bär sessionen. Inget användarnamn och inget lösenord
 * finns någonstans i Loopa.
 *
 * VANLIG CHROMIUM. Ingen fingeravtrycksmaskering, inga proxyer, ingen "--disable-blink-features".
 * Facebook får se att det är en automatiserad webbläsare; det är inte vårt jobb att dölja det. Det
 * som däremot är vårt jobb är att STANNA när Facebook säger stopp — se `assertNoInterrupt`.
 *
 * EN WEBBLÄSARE I TAGET. Alla arbetare (upptäckt, medlemskap, Marketplace, grupp-poster) går genom
 * `withFacebookBrowser`, som köar dem. Två Chromium på en liten server är ett minnesproblem, och två
 * flikar som skriver samtidigt på samma konto gör felsökningen omöjlig.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { facebookAccountId, facebookBaseUrl, facebookHeadful, facebookProfileDir, facebookScreenshotDir, isRealFacebook } from "./config.js";
import { detectInterrupt, FacebookInterrupt, sessionStatusFor } from "./checkpoint.js";
import { logEvent, readSession, recordManualAction, writeSession } from "./store.js";
import type { FacebookSessionRecord, ManualAction } from "./types.js";

export interface FacebookBrowser {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** Selektorer som hör till sessionen. Verifierade mot den svenska Facebook-ytan 2026-09-23. */
export const SESSION_SEL = {
  navProfile:
    '[aria-label="Din profil"], [aria-label="Your profile"], [aria-label="Konto"], [aria-label="Account"], [aria-label="Ditt Facebook-konto"], [aria-label="Your Facebook account"]',
  loginForm: 'form[action*="login"], input[name="email"], input[name="pass"]',
  captchaFrame: 'iframe[src*="captcha"], iframe[title*="captcha" i], iframe[src*="recaptcha"]',
  main: '[role="main"]',
} as const;

/**
 * Öppnar den persistenta profilen. `headful` för inloggningen och för att titta på en torrkörning.
 * `allowLoggedOut` släpper igenom en profil där INGEN är inloggad — bara för login.ts, som finns till
 * för att fylla just en sådan profil. Ett annat konto i profilen stoppas fortfarande.
 */
export async function openFacebookBrowser(opts: { headful?: boolean; allowLoggedOut?: boolean } = {}): Promise<FacebookBrowser> {
  const dir = facebookProfileDir();
  mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    headless: !(opts.headful ?? facebookHeadful()),
    viewport: { width: 1280, height: 900 },
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    // --no-sandbox behövs på servern (Oracle kör som en användare utan userns). Ingenting annat.
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  // Kontoräcket: fel konto i profilen -> ingenting körs. Se facebookAccountId().
  const expected = facebookAccountId();
  if (expected && isRealFacebook()) {
    const actual = await loggedInAccountId(context);
    if (actual !== expected && !(opts.allowLoggedOut && actual === null)) {
      await context.close().catch(() => undefined);
      throw new Error(`Fel Facebook-konto i webbläsarprofilen: inloggad som ${actual ?? "ingen"}, FACEBOOK_ACCOUNT_ID är ${expected}. Ingenting körs.`);
    }
  }
  return {
    context,
    page,
    close: async () => {
      await context.close().catch(() => undefined);
    },
  };
}

/** Kontots id ur c_user-kakan, eller null när ingen är inloggad. Läser bara kakan, aldrig lösenord. */
export async function loggedInAccountId(context: BrowserContext): Promise<string | null> {
  try {
    const cookies = await context.cookies(facebookBaseUrl());
    return cookies.find((c) => c.name === "c_user")?.value ?? null;
  } catch {
    return null;
  }
}

/** Skärmbild till datakatalogen. Hjälp, inte krav — faller den står loggen kvar. */
export async function screenshot(page: Page, name: string): Promise<string | null> {
  try {
    const dir = facebookScreenshotDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 50)}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/** Sidans synliga text, kapad. Det checkpoint.ts letar i. */
export async function bodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
}

/** Kastar FacebookInterrupt när Facebook visar inloggning, CAPTCHA, kontrollpunkt eller spärr. */
export async function assertNoInterrupt(page: Page, step: string): Promise<void> {
  const url = page.url();
  const text = await bodyText(page);
  const hasCaptcha = (await page.locator(SESSION_SEL.captchaFrame).count().catch(() => 0)) > 0;
  const det = detectInterrupt(url, text, hasCaptcha);
  if (det) {
    const shot = await screenshot(page, `avbrott_${det.kind}`);
    throw new FacebookInterrupt(det.kind, `${det.reason} (under ${step})`, url, shot);
  }
}

/** Går till en sida, väntar in huvudinnehållet och kontrollerar att inget avbrott visas. */
export async function goto(page: Page, url: string, step: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator(SESSION_SEL.main).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  await assertNoInterrupt(page, step);
}

/** Adressen till en sökväg på Facebook (eller attrappen). */
export function fbUrl(pathname: string): string {
  return `${facebookBaseUrl()}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

/**
 * Är sessionen inloggad? Skriver svaret till session.json så panelen kan visa det utan att starta
 * en webbläsare.
 */
export async function checkSession(page: Page): Promise<FacebookSessionRecord> {
  const checkedAt = new Date().toISOString();
  try {
    await page.goto(fbUrl("/"), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page
      .locator(`${SESSION_SEL.navProfile}, ${SESSION_SEL.loginForm}`)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch(() => undefined);
    const url = page.url();
    const accountId = await loggedInAccountId(page.context());
    const det = detectInterrupt(url, await bodyText(page), (await page.locator(SESSION_SEL.captchaFrame).count()) > 0);
    let record: FacebookSessionRecord;
    if (det && det.kind !== "LOGIN_REQUIRED") {
      record = { status: sessionStatusFor(det.kind), checkedAt, url, detail: det.reason, accountId };
    } else {
      const loggedIn = (await page.locator(SESSION_SEL.navProfile).count()) > 0 && (await page.locator(SESSION_SEL.loginForm).count()) === 0;
      record = loggedIn
        ? { status: "CONNECTED", checkedAt, url, detail: `Inloggad session i webbläsarprofilen${accountId ? ` (konto ${accountId})` : ""}.`, accountId }
        : { status: "DISCONNECTED", checkedAt, url, detail: "Inte inloggad. Kör `npm run facebook:login` och logga in för hand en gång.", accountId };
    }
    await writeSession(record);
    return record;
  } catch (err) {
    const record: FacebookSessionRecord = {
      status: "UNKNOWN",
      checkedAt,
      url: page.url(),
      detail: `Sessionskontrollen föll: ${err instanceof Error ? err.message : String(err)}`,
    };
    await writeSession(record);
    return record;
  }
}

/** Senast kända sessionsläge, utan webbläsare. */
export async function lastKnownSession(): Promise<FacebookSessionRecord | null> {
  return readSession();
}

// ---------------------------------------------------------------------------
// Ett spår i taget
// ---------------------------------------------------------------------------

let lane: Promise<unknown> = Promise.resolve();
let busyWith: string | null = null;

export function browserBusy(): string | null {
  return busyWith;
}

/**
 * Kör `fn` med en färsk webbläsare, EFTER att alla tidigare anrop är klara. Webbläsaren stängs alltid.
 *
 * Färsk per anrop och inte långlivad, av samma skäl som Blocket-roboten: en kvarglömd dialog eller ett
 * halvfyllt formulär från förra körningen ska inte påverka nästa. Profilen på disk bär sessionen ändå.
 */
export function withFacebookBrowser<T>(worker: string, fn: (browser: FacebookBrowser) => Promise<T>, opts: { headful?: boolean } = {}): Promise<T> {
  const run = async () => {
    busyWith = worker;
    const browser = await openFacebookBrowser(opts);
    try {
      return await fn(browser);
    } finally {
      busyWith = null;
      await browser.close();
    }
  };
  const next = lane.then(run, run);
  lane = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// När Facebook säger stopp
// ---------------------------------------------------------------------------

/**
 * Skriver NEEDS_MANUAL_ACTION för ett avbrott, uppdaterar sessionsläget och loggar. Anropas av varje
 * arbetare i sin catch. Returnerar posten så anroparen kan hänvisa till den.
 */
export async function recordInterrupt(
  err: FacebookInterrupt,
  context: ManualAction["context"],
  lastCompletedStep: string | null,
): Promise<ManualAction> {
  await writeSession({
    status: sessionStatusFor(err.kind),
    checkedAt: new Date().toISOString(),
    url: err.url,
    detail: err.message,
  });
  const action = await recordManualAction({
    kind: err.kind,
    reason: err.message,
    url: err.url,
    screenshot: err.screenshot,
    lastCompletedStep,
    context,
  });
  await logEvent({
    worker: context.worker,
    level: "error",
    action: "AVBROTT",
    target: context.listingId ?? context.groupId ?? null,
    detail: `${err.kind}: ${err.message}. Arbetaren stoppades; åtgärd ${action.id} väntar på en människa.`,
  });
  return action;
}

/** Sant för riktiga Facebook — det enda läget där en riktig skrivning kan bokföras. */
export { isRealFacebook };
