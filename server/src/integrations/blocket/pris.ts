/**
 * Prisändring på en Blocket-annons som redan ligger uppe.
 *
 * Blocket har inget API, så här gör roboten det en människa gör — fast kortare. UPPMÄTT PÅ RIKTIGA
 * BLOCKET 2026-10-02 (inloggad session, bara läsning):
 *
 *   - Mina annonser ligger på /my-items (/mina-annonser skickar dit). Varje kort har en dold
 *     kontextmeny ("Meny till genvägar för annonsen", en w-button) med länkarna "Ändra annonsen" →
 *     /recommerce/create/<annons-id>, "Visa annonsen" → /<annons-id> och "Se statistik".
 *   - /recommerce/create/<annons-id> är SAMMA formulär som vid skapandet, förifyllt: Annonsrubrik
 *     (w-textfield name="title"), Beskrivning, Pris (etikett "Pris", getByLabel träffar <input>
 *     direkt), Postnummer, mått, Skick, kategorier — och längst ner `w-button[type=submit]` **Spara**
 *     plus Avbryt. Ingen frakt- eller paketsida: ändringen sparas från formuläret.
 *
 * Därför går roboten DIREKT till /recommerce/create/<id> — adressen är deterministisk och id:t står i
 * den annonsadress publiceringen sparade. Menyn på Mina annonser är reservvägen.
 *
 * RUBRIKVAKTEN är det viktigaste i filen. Samma adress utan känd annons (eller med fel id) ger ett
 * TOMT skapandeformulär, och ett Spara där hade skapat en ny annons. Priset fylls i först när
 * rubriken i formuläret är vår; annars avbryts körningen med ett fel som säger vad sidan visade.
 *
 * SPARANDET, UPPMÄTT SKARPT 2026-10-02 (två rundor 400 → 390 → 400 kr på en egen annons): formulärets
 * Spara SPARAR PRISET och går vidare till /recommerce/delivery/<id>?editMode=true — leveranssidan i
 * redigeringsläge, med egen Spara/Avbryt för leveransvalet. Den rörs inte: priset är redan sparat,
 * och leveransvalet är säljarens. Ingen BankID. Ingenting annat än priset ändras (23 fält, bilder
 * och leveransval jämförda före/efter). EFTER VARJE ÄNDRING svarar den publika annonssidan 404 i
 * 2–5 minuter — även efter en sänkning; en höjning märker dessutom annonsen "Granskas" på ägarsidan
 * en stund. Verifieringen läser därför ÄGARSIDAN /my-items/details/<id> ("Torget säljes 390,−"),
 * som visar det sparade priset direkt; den publika sidan är reserv. Provkörning för hand:
 *
 *     npm run blocket:pris -- <jobId>            torrkörning: öppnar, vaktar rubriken, fyller i priset, sparar INTE
 *     npm run blocket:pris -- <jobId> --skarpt   sparar
 *     npm run blocket:pris -- --annons <url> --pris <kr> [--skarpt]   vilken annons som helst på kontot
 *
 * SPÄRREN. Roboten ändrar priser när BLOCKET_PRIS_ROBOT=1, eller när den är osatt och publiceringen
 * går skarpt (BLOCKET_PUBLICERA=1). BLOCKET_PRIS_ROBOT=0 stänger av den ensam. Att den har en egen
 * brytare är avsiktligt: en prisändring går att ångra med en ny prisändring, en publicering går inte
 * att ta ner — prisroboten kan därför vara på i drift innan publiceringsroboten är det. Utanför
 * spärren svarar `flyttaBlocketPris` "manuell": stegen sänker möbeln ändå, panelen säger att Blocket
 * måste ändras för hand, och ett brev går till admin. Ingen veckovis torrkörning.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  blocketBaseUrl,
  blocketConfigured,
  blocketDataDir,
  blocketLivePublishing,
  lasHalsa,
  missingBlocketEnv,
  sessionFileExists,
  skrivHalsa,
} from "./blocket.js";
import { ensureSession, goAndSettle, handleBankID, isLoggedOut, saveSessionIfReal, startBrowser } from "./browser.js";
import { clickFirstVisible, dismissCookieBanner, dismissModal, fillByLabel, fillBySelector, pageHasText } from "./form.js";
import { nyttSteg, type Logga } from "./diag.js";
import { arUpptagen, markeraUpptagen } from "./vakt.js";
import { capTitle } from "./mapping.js";
import { adTitle } from "../../adContent.js";
import { persist } from "../../jobStore.js";
import type { FlyttUtfall } from "../../priceLadder.js";
import type { BlocketStep, ConditionJob } from "../../types.js";

/** Så många steg från senaste prisändringen sparas på jobbet. */
const MAX_PRISSTEG = 30;

/**
 * Får roboten ändra priser? Egen brytare, med publiceringens som förval. Se filhuvudet.
 */
export function blocketPrisRobotPa(): boolean {
  const egen = process.env.BLOCKET_PRIS_ROBOT?.trim();
  if (egen === "1") return true;
  if (egen === "0") return false;
  return blocketLivePublishing();
}

/** Annons-id:t ur en Blocket-adress: `blocket.se/26725957`, `/annons/.../26725957`, `?adId=…`. */
export function adIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/(?:adId=|\/)(\d{6,})(?:[/?#&]|$)/);
  return m ? m[1] : null;
}

/**
 * Mönstret för ett pris som det kan stå på sidan: "2040 kr", "2 040 kr", "2 040 kr" (hårt
 * mellanslag) — och ägarsidans "2 040,−" (utan kr). Tusentalsgruppen är valfri: Blocket skriver
 * med mellanslag, attrappen utan.
 */
export function prisMonster(pris: number): RegExp {
  const siffror = String(Math.round(pris));
  const grupper: string[] = [];
  for (let i = siffror.length; i > 0; i -= 3) grupper.unshift(siffror.slice(Math.max(0, i - 3), i));
  return new RegExp(`(^|[^\\d])${grupper.join("[\\s\\u00a0]?")}(?:[\\s\\u00a0]*kr|,[\\u2212\\-\\u2013])`, "i");
}

/**
 * Är rubriken i formuläret vår annons? Blocket kapar till 50 tecken och en admin kan ha putsat
 * texten för hand, så jämförelsen är tålig: lika efter normalisering, eller den ena börjar som den
 * andra. En TOM rubrik är aldrig vår — det är det tomma skapandeformuläret.
 */
export function rubrikStammer(iFormularet: string | null | undefined, var_: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const a = norm(iFormularet ?? "");
  const b = norm(var_);
  if (!a || !b) return false;
  if (a === b) return true;
  const stam = Math.min(30, a.length, b.length);
  return a.slice(0, stam) === b.slice(0, stam);
}

export interface BlocketPrisInput {
  /** Annonsens publika adress, som publiceringen sparade den. Id:t läses ur den. */
  adUrl: string;
  /** Rubriken som den står på Blocket — det formuläret vaktas mot. */
  title: string;
  /** ANNONSPRISET: möbeln plus hemleveransen. */
  price: number;
  /** Sant = fyll i, spara inte. */
  dryRun: boolean;
}

export interface BlocketPrisResultat {
  status: "andrad" | "torrkorning";
  /** Sågs det nya priset på ägarsidan (eller annonsen) efteråt? Null i torrkörning och när inget gick att läsa. */
  verifierad: boolean | null;
  /** Annonsens läge på ägarsidan efteråt: "Aktiv", "Granskas" … Null när det inte gick att läsa. */
  lage: string | null;
  url: string;
}

const SESSION_UTGANGEN =
  "Blocket-sessionen har gått ut. Logga in för hand och exportera om sessionsfilen som BLOCKET_SESSION pekar på.";

/**
 * Annonsen står inte bland de aktiva på Mina annonser: utgången, nekad eller borttagen.
 *
 * Egen feltyp därför att den INTE ska försökas igen som ett tillfälligt fel: `flyttaBlocketPris`
 * gör den till "för hand" med brev. Skälet att den finns alls är uppmätt: /recommerce/create/<id>
 * öppnar formuläret även för en annons som gått ut, med samma Spara — och ett Spara där hade
 * publicerat om annonsen (ny annonstid, ny granskning) på ett konto Blocket redan nekat en gång.
 * Roboten ska sänka priser, inte lägga ut annonser.
 */
export class BlocketAnnonsInteAktiv extends Error {
  constructor(id: string | null) {
    super(
      `Annonsen${id ? ` ${id}` : ""} finns inte bland de aktiva på Mina annonser (utgången, nekad eller borttagen) — priset rördes inte. ` +
        "Lägg om den eller ta bort den ur jobbet.",
    );
    this.name = "BlocketAnnonsInteAktiv";
  }
}

/**
 * Står annonsen bland de AKTIVA på Mina annonser? Listan visar bara aktiva som förval, så det räcker
 * att kortets länk finns. Flera sidor bläddras igenom (`?pageNumber=`); null id = går inte att veta,
 * och då släpps den igenom (rubrikvakten står kvar).
 */
async function annonsenArAktiv(page: Page, id: string | null, logga: Logga): Promise<boolean> {
  if (!id) return true;
  const bas = blocketBaseUrl();
  const sedda = new Set<string>();
  let url: string | null = `${bas}/my-items`;
  for (let sida = 0; url && sida < 10; sida++) {
    sedda.add(url);
    await goAndSettle(page, url);
    await dismissCookieBanner(page);
    await dismissModal(page);
    if (isLoggedOut(page.url())) throw new Error(SESSION_UTGANGEN);
    if ((await page.locator(`a[href="/my-items/details/${id}"]`).count().catch(() => 0)) > 0) {
      logga("Annonsen står bland de aktiva", "ok", { id, sida: sida + 1 });
      return true;
    }
    // Nästa sida, om listan har flera.
    const lankar: string[] = await page
      .locator('a[href*="pageNumber="]')
      .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href))
      .catch(() => []);
    url = lankar.find((l) => !sedda.has(l)) ?? null;
  }
  logga("Annonsen står inte bland de aktiva", "error", { id });
  return false;
}

/**
 * Ändrar priset på annonsen i den inloggade sessionen. Ingenting här känner till ett jobb.
 *
 * Kastar när priset INTE ändrades — anroparen bokför det på kanalen och försöker igen senare.
 */
export async function driveBlocketPriceChange(
  page: Page,
  context: BrowserContext,
  input: BlocketPrisInput,
  logga: Logga,
): Promise<BlocketPrisResultat> {
  const bas = blocketBaseUrl();
  const id = adIdFromUrl(input.adUrl);

  // ── Är annonsen aktiv? ───────────────────────────────────────────────────
  // FÖRE formuläret, med flit — se BlocketAnnonsInteAktiv.
  if (!(await annonsenArAktiv(page, id, logga))) throw new BlocketAnnonsInteAktiv(id);

  // ── Redigeringsformuläret ────────────────────────────────────────────────
  let vag: string | null = null;
  if (id) {
    await goAndSettle(page, `${bas}/recommerce/create/${id}`);
    await dismissCookieBanner(page);
    await dismissModal(page);
    if (isLoggedOut(page.url())) {
      logga("Sessionen har gått ut", "error", { url: page.url() });
      throw new Error(SESSION_UTGANGEN);
    }
    if (await redigeringsformularet(page)) vag = "direkt adress";
    else logga("Direktadressen gav inget redigeringsformulär — provar Mina annonser", "warning", { url: page.url() });
  }
  if (!vag) vag = await viaMinaAnnonser(page, id, input.title, input.adUrl, logga);
  if (!vag) {
    logga("Hittade ingen väg till redigeringen", "error", { url: page.url(), id, rubrik: input.title });
    throw new Error(`Hittade ingen redigering för annonsen${id ? ` ${id}` : ""}. Sidan står på ${page.url()}.`);
  }

  // ── Rubrikvakten ─────────────────────────────────────────────────────────
  const rubrik = await lasRubrik(page);
  if (!rubrikStammer(rubrik, input.title)) {
    logga("Formuläret visar inte vår annons", "error", { url: page.url(), iFormularet: rubrik, var: input.title });
    throw new Error(
      rubrik
        ? `Redigeringssidan visar en annan annons ("${rubrik}") än den vi ska ändra ("${input.title}") — priset rördes inte.`
        : `Redigeringssidan hade ingen rubrik — ett tomt skapandeformulär, inte vår annons. Priset rördes inte.`,
    );
  }
  logga(`Öppnade redigeringen (${vag})`, "ok", { url: page.url(), rubrik });

  // ── Pris ─────────────────────────────────────────────────────────────────
  try {
    await fillByLabel(page, "Pris", input.price, { timeout: 8000, exact: true });
    logga(`Pris: ${input.price} kr`, "ok", {});
  } catch {
    try {
      await fillBySelector(page, ['input[name="price"]', 'input[placeholder*="pris" i]'], input.price, 5000);
      logga(`Pris: ${input.price} kr (reservväg)`, "ok", {});
    } catch (err) {
      logga("Prisfältet gick inte att fylla i", "error", { fel: felText(err) });
      throw new Error("Prisfältet hittades inte på redigeringssidan — priset ändrades inte.");
    }
  }

  if (input.dryRun) {
    logga("TORRKÖRNING KLAR — priset sparades inte", "ok", { url: page.url() });
    return { status: "torrkorning", verifierad: null, lage: null, url: page.url() };
  }

  // ── Spara ────────────────────────────────────────────────────────────────
  // `w-button[type=submit]` med texten Spara, uppmätt. clickFirstVisible lägger själv till
  // w-button-varianten av varje button:has-text(). Sidan går vidare till leveranssidan i
  // redigeringsläge — priset är sparat i och med det, och leveransvalet lämnas som det är.
  const knapp = await clickFirstVisible(
    page,
    ['button:has-text("Spara")', 'button:has-text("Uppdatera annons")', 'button:has-text("Uppdatera")', 'button[type="submit"]:not([disabled])'],
    12_000,
  );
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(2500);
  logga(`Sparade (${knapp})`, "ok", { url: page.url() });
  // Blocket kan begära BankID för att spara, precis som för att skapa (sågs inte vid mätningen).
  await handleBankID(page, context, logga);

  // ── Verifiera ────────────────────────────────────────────────────────────
  // Ägarsidan först: den visar det sparade priset ("Torget säljes 390,−") och läget, även när
  // annonsen granskas och den publika sidan svarar 404. Den publika sidan är reserv.
  let verifierad: boolean | null = null;
  let lage: string | null = null;
  try {
    if (id) {
      await goAndSettle(page, `${bas}/my-items/details/${id}`);
      await dismissModal(page);
      const text = (await page.locator("main").first().innerText({ timeout: 4000 }).catch(() => "")).replace(/\s+/g, " ");
      // "Aktiv331 dagar kvar" — läget sitter ihop med siffrorna, så ingen ordgräns efteråt; men
      // inte "Aktiva" (filtret på listsidan).
      lage = text.match(/(Aktiv|Granskas|Nekad|Utkast|Utlöpt|Dold)(?![a-zåäö])/)?.[1] ?? null;
      if (text) verifierad = prisMonster(input.price).test(text);
    }
    if (verifierad !== true) {
      await goAndSettle(page, input.adUrl);
      if (await pageHasText(page, prisMonster(input.price), 4000)) verifierad = true;
    }
    logga(
      verifierad
        ? `Det nya priset står på ägarsidan${lage ? ` (annonsen är ${lage.toLowerCase()})` : ""}`
        : `Såg inte det nya priset efteråt${lage ? ` (annonsen är ${lage.toLowerCase()})` : ""}`,
      verifierad ? "ok" : "warning",
      { pris: input.price, lage },
    );
  } catch (err) {
    logga("Kunde inte läsa annonsen för verifiering", "warning", { fel: felText(err) });
  }
  return { status: "andrad", verifierad, lage, url: input.adUrl };
}

/** Visar sidan ett redigeringsformulär: ett prisfält och ett rubrikfält? Räknat med locators. */
async function redigeringsformularet(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pris = await page
      .getByLabel("Pris", { exact: true })
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (pris) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

/** Rubriken som den står i formuläret, eller null när inget rubrikfält finns. */
async function lasRubrik(page: Page): Promise<string | null> {
  const kandidater = [
    page.locator('w-textfield[name="title"] input, input[name="title"]').first(),
    page.getByLabel("Annonsrubrik", { exact: true }).first(),
    page.getByLabel("Rubrik", { exact: true }).first(),
  ];
  for (const falt of kandidater) {
    if (!(await falt.isVisible({ timeout: 800 }).catch(() => false))) continue;
    const varde = await falt
      .evaluate((node) => {
        const el = node as HTMLInputElement;
        if (!node.tagName.includes("-") && typeof el.value === "string") return el.value;
        const inre = node.shadowRoot?.querySelector("input, textarea") as HTMLInputElement | null;
        return inre?.value ?? node.getAttribute("value") ?? "";
      })
      .catch(() => null);
    if (varde !== null) return varde;
  }
  return null;
}

const ANDRA = ['a:has-text("Ändra annonsen")', 'a:has-text("Redigera")', 'button:has-text("Redigera")', 'a[href*="/recommerce/create/"]'];

/**
 * Reservvägen: Mina annonser → kortets meny → "Ändra annonsen". Länken ligger dold tills menyn
 * öppnats, så kortet letas upp först (på länkens href eller på rubriken) och menyknappen i det
 * klickas. Sista utvägen är annonssidan. Returnerar vilken väg som gick, eller null.
 */
async function viaMinaAnnonser(page: Page, id: string | null, title: string, adUrl: string, logga: Logga): Promise<string | null> {
  const bas = blocketBaseUrl();
  await goAndSettle(page, `${bas}/mina-annonser`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (isLoggedOut(page.url())) {
    logga("Sessionen har gått ut", "error", { url: page.url() });
    throw new Error(SESSION_UTGANGEN);
  }

  // Kortet: via den (dolda) ändra-länkens href, annars via rubriken.
  const ankare = id ? page.locator(`a[href*="/recommerce/create/${id}"]`).first() : page.getByText(title, { exact: false }).first();
  if ((await ankare.count().catch(() => 0)) > 0) {
    let kort = ankare;
    for (let niva = 0; niva < 6; niva++) {
      kort = kort.locator("xpath=..");
      const meny = kort.locator('w-button:has-text("Meny"), button:has-text("Meny"), button[aria-label*="eny" i]').first();
      if (await meny.isVisible({ timeout: 300 }).catch(() => false)) {
        await meny.click({ timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(600);
        break;
      }
    }
    const lank = id ? page.locator(`a[href*="/recommerce/create/${id}"]`).first() : kort.locator(ANDRA.join(", ")).first();
    if (await lank.isVisible({ timeout: 2000 }).catch(() => false)) {
      await lank.click({ timeout: 4000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
      await page.waitForTimeout(2000);
      await dismissModal(page);
      if (await redigeringsformularet(page)) return "Mina annonser → menyn → Ändra annonsen";
    }
  }

  // Annonssidan, där ägaren också ser "Ändra annonsen".
  await goAndSettle(page, adUrl);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (isLoggedOut(page.url())) return null;
  if (await clickFirstVisible(page, ANDRA, 4000).catch(() => null)) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(2000);
    if (await redigeringsformularet(page)) return "annonssidan → Ändra annonsen";
  }
  return null;
}

// ---------- Jobbet ----------

/**
 * Flyttar jobbets Blocket-annons till `annonspris`, om roboten får och kan. Det prisstegen anropar.
 *
 * Svarar "manuell" med ett skäl för varje läge där servern inte kan göra det själv — det är inget
 * fel, det är ett besked till panelen och ett brev till admin. Kastar bara när roboten faktiskt
 * försökte och misslyckades; då försöker stegen igen om sex timmar.
 */
export async function flyttaBlocketPris(job: ConditionJob, annonspris: number): Promise<FlyttUtfall> {
  const pub = job.blocket;
  const manuell = (skal: string): FlyttUtfall => ({ status: "manuell", skal });

  if (!pub || pub.status !== "published") return manuell("Annonsen ligger inte uppe på Blocket enligt jobbet.");
  if (!pub.url) return manuell("Blocket-annonsens adress saknas på jobbet, så roboten hittar den inte. Ändra för hand.");
  if (!blocketConfigured()) return manuell(`Blocket är inte konfigurerat på servern (saknar ${missingBlocketEnv().join(", ")}).`);
  if (!sessionFileExists()) return manuell("Sessionsfilen som BLOCKET_SESSION pekar på finns inte. Logga in på Blocket för hand och exportera om den.");
  if (!blocketPrisRobotPa()) {
    return manuell(
      "Prisroboten är av (sätt BLOCKET_PRIS_ROBOT=1 på servern, eller BLOCKET_PUBLICERA=1 för skarpt läge på allt). Ändra priset för hand så länge.",
    );
  }
  const halsa = lasHalsa();
  if (halsa && !halsa.ok) {
    return manuell(
      `Blocket-sessionen har gått ut (kontrollerad ${halsa.kontrolleradAt.slice(0, 16).replace("T", " ")}). Logga in på nytt — BLOCKET-PLAN.md, fas B.`,
    );
  }
  if (arUpptagen()) return { status: "senare", skal: "En annan Blocket-körning pågår." };

  const steps: BlocketStep[] = [];
  const logga: Logga = (name, status, details) => {
    steps.push(nyttSteg(name, status, details));
    if (steps.length > MAX_PRISSTEG) steps.splice(0, steps.length - MAX_PRISSTEG);
    console.info(`[blocket-pris] ${job.id} ${status.toUpperCase()} ${name}`);
  };

  let session: Awaited<ReturnType<typeof startBrowser>> | null = null;
  markeraUpptagen(true);
  try {
    logga("Startar prisändring", "running", { pris: annonspris, url: pub.url });
    session = await startBrowser();
    try {
      await ensureSession(session.page, logga);
      skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: true, url: session.page.url(), fel: null });
    } catch (err) {
      // Bara inloggningssidan räknas som utgången session — se runBlocketPublish.
      if (/gått ut/i.test(felText(err))) {
        skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: false, url: session.page.url(), fel: felText(err) });
      }
      throw err;
    }
    await handleBankID(session.page, session.context, logga);

    await driveBlocketPriceChange(
      session.page,
      session.context,
      { adUrl: pub.url, title: capTitle(adTitle(job)), price: annonspris, dryRun: false },
      logga,
    );
    if (await saveSessionIfReal(session.context).catch(() => false)) logga("Sessionen sparades om", "ok", {});
    return { status: "andrad" };
  } catch (err) {
    // En annons som inte längre är aktiv är inget att försöka igen om sex timmar — det är en människas
    // beslut att lägga om den eller ta bort den ur jobbet. Panelen och brevet säger vilket.
    if (err instanceof BlocketAnnonsInteAktiv) {
      steps.push(nyttSteg("Annonsen är inte aktiv — lämnas till en människa", "warning", { fel: err.message }));
      return manuell(err.message);
    }
    steps.push(nyttSteg("Prisändringen stoppades", "error", { fel: felText(err) }));
    if (session && !session.page.isClosed()) {
      const fil = path.join(blocketDataDir(), `pris-fel-${job.id}.png`);
      try {
        mkdirSync(path.dirname(fil), { recursive: true, mode: 0o700 });
        await session.page.screenshot({ path: fil, fullPage: true });
        steps.push(nyttSteg("Skärmbild sparad", "warning", { fil, url: session.page.url() }));
      } catch {
        // Sidan kan vara borta. Loggen ovan står kvar.
      }
    }
    throw err;
  } finally {
    markeraUpptagen(false);
    pub.prisSteg = [...steps];
    await persist(job).catch(() => undefined);
    await session?.browser.close().catch(() => undefined);
  }
}

function felText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
