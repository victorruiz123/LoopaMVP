/**
 * Att ta ner en Blocket-annons — det första halvsteget i veckans omläggning (integrations/omlaggning.ts).
 * Det andra halvsteget är den vanliga publiceringen (publish.ts), som tar priset ur stegen
 * (adContent.ts `resolveAdPrice` → `ladder.currentPrice`) och därför lägger upp annonsen med det
 * SÄNKTA priset, i det gratis paketet "Bas" (shipping.ts).
 *
 * VAD SOM ÄR KÄNT OM FLÖDET, OCH VARIFRÅN:
 *
 *   - Uppmätt på riktiga Blocket 2026-10-02 (pris.ts): kortet på Mina annonser (/my-items) har en
 *     w-button "Markera som såld" och en w-button "Meny till genvägar för annonsen" med en DOLD meny
 *     ("Ändra annonsen", "Visa annonsen", "Se statistik" — fler val kan ha legat utanför det som
 *     lästes). Ägarsidan är /my-items/details/<id>.
 *   - Blockets hjälp ("Vad betyder de olika statusarna på min annons?"): en annons som avslutas flyttas
 *     till historiken och försvinner ur sökresultaten direkt; Avslutad = borttagen, såld eller utgången.
 *   - Blocket kör på samma plattform som FINN.no (/recommerce/…, w-button). FINN:s hjälp: "Mine
 *     annonser → de tre prickarna till høyre på annonsen → Slette". Kortets meny är de tre prickarna.
 *
 * UPPMÄTT PÅ RIKTIGA BLOCKET 2026-10-20 (barstolen 21946768): kortets meny har `<a role="button"
 * title="Ta bort">Ta bort</a>`; klicket öppnar en `<w-modal>`: i skuggan en `<dialog open>` med "Är du
 * säker?" och "Stäng", i light-DOM texten "Annonsen kommer att tas bort från Blocket …" och w-button
 * "Avbryt" / "Ta bort". Varje kort har en egen, stängd w-modal i sidan (se `oppenDialog`).
 *
 * I omläggningen körs den här först NÄR den nya annonsen redan är förberedd till sista knappen
 * (publish.ts `forberedBlocketPublicering`) — så att BankID eller ett annat stopp aldrig lämnar möbeln nere.
 *
 * Roboten går därför: Mina annonser → VÅRT kort (rubrikvakt) → kortets meny → "Ta bort" → bekräftelsen
 * (med ett skäl som INTE är "såld", om ett skäl begärs) → kontroll att annonsen inte längre står bland
 * de aktiva. Reservväg: samma val på ägarsidan. "Markera som såld" klickas ALDRIG — det vore att
 * påstå en försäljning som inte skett.
 *
 * TORRKÖRNINGEN hittar valet men klickar INTE på det: på Blocket kan "Ta bort" i menyn verkställa direkt
 * utan någon bekräftelse, och då finns ingen säker punkt efter klicket att stanna på. Provkörning:
 *
 *     npm run blocket:ta-bort -- <jobId>                         torrkörning: hittar kortet och valet, rör inget
 *     npm run blocket:ta-bort -- <jobId> --skarpt                tar bort
 *     npm run blocket:ta-bort -- --annons <url> [--rubrik <r>] [--skarpt]
 *
 * SPÄRREN: skarp publicering (BLOCKET_PUBLICERA=1) krävs alltid. BLOCKET_TA_BORT_ROBOT osatt följer den,
 * 0 stänger av omläggningen ensam (då ändras Blocket-priset på plats av prisroboten som förut). Flödet är
 * uppmätt och prövat skarpt 2026-10-20 (barstolen), och omläggningen förbereder den nya annonsen innan den
 * gamla tas ner — därför är den på som förval där publiceringen går skarpt.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { blocketBaseUrl, blocketConfigured, blocketDataDir, blocketLivePublishing, lasHalsa, missingBlocketEnv, sessionFileExists, skrivHalsa } from "./blocket.js";
import { ensureSession, goAndSettle, handleBankID, isLoggedOut, saveSessionIfReal, startBrowser } from "./browser.js";
import { dismissCookieBanner, dismissModal } from "./form.js";
import { nyttSteg, type Logga } from "./diag.js";
import { arUpptagen, markeraUpptagen } from "./vakt.js";
import { capTitle } from "./mapping.js";
import { adIdFromUrl, annonsenArAktiv, felText, rubrikStammer } from "./pris.js";
import { adTitle } from "../../adContent.js";
import type { BlocketStep, ConditionJob } from "../../types.js";

/**
 * Får roboten ta bort annonser? 1 = på, 0 = av, osatt = följer BLOCKET_PUBLICERA — samma regel som
 * prisroboten (pris.ts). Omläggningen ERSÄTTER prisändringen på plats så fort publiceringen går skarpt.
 */
export function blocketTaBortRobotPa(): boolean {
  const egen = process.env.BLOCKET_TA_BORT_ROBOT?.trim();
  if (egen === "1") return true;
  if (egen === "0") return false;
  return blocketLivePublishing();
}

/**
 * Får Blocket-annonsen läggas om, i stället för att priset ändras på plats?
 *
 * Kräver SKARP PUBLICERING, och det är inget förval utan själva poängen: en nedtagen annons följd av en
 * torrkörd publicering är en möbel som försvunnit från Blocket.
 */
export function blocketOmlaggningKlar(): boolean {
  return blocketTaBortRobotPa() && blocketLivePublishing() && blocketConfigured() && sessionFileExists();
}

/** Valet i menyn eller på ägarsidan. Exakt text — "Markera som såld" får aldrig träffas. */
const TA_BORT_VAL = /^\s*(ta bort annonsen|ta bort|radera annonsen|radera|avsluta annonsen|avsluta)\s*$/i;
/** Bekräftelseknappen i dialogen. */
const BEKRAFTA = /^\s*(ta bort|ja, ta bort|ta bort annonsen|radera|ja, radera|avsluta|avsluta annonsen|bekräfta|ja)\s*$/i;
/** Skälen roboten får välja, om dialogen frågar. Aldrig ett skäl som säger att möbeln sålts. */
const SKAL_OK = /(vill inte sälja|ångrat|lägger upp (den )?(igen|på nytt)|annat|övrigt|annan anledning)/i;
const SKAL_SALD = /såld/i;

const KLICKBARA = 'a, button, w-button, [role="menuitem"], [role="button"], [role="option"]';

export interface BlocketBorttagningInput {
  adUrl: string;
  /** Rubriken som den står på Blocket — kortet vaktas mot den. Null bara i torrkörning från provskriptet. */
  title: string | null;
  dryRun: boolean;
}

export interface BlocketBorttagningResultat {
  /** borttagen: togs bort nu. redan-borta: stod inte bland de aktiva. torrkorning: valet hittades, inget klickat. */
  status: "borttagen" | "redan-borta" | "torrkorning";
  /** Vägen till valet, för loggen. */
  vag: string | null;
}

/**
 * Den öppna bekräftelsen, som den del av sidan knapparna faktiskt ligger i.
 *
 * UPPMÄTT 2026-10-20: Blockets bekräftelse är en `<w-modal>` (Warp). Den riktiga `<dialog open>` ligger i
 * komponentens SKUGGA, med rubriken "Är du säker?" och "Stäng" — men texten och knapparna "Avbryt" /
 * "Ta bort" ligger i värdelementets light-DOM (slot="content" / slot="footer"). Att leta inuti
 * `<dialog>` hittar alltså inga knappar, och `<w-modal>` själv har storleken 0×0. Varje kort har
 * dessutom en egen, stängd modal. Därför: den w-modal vars skugga har en öppen dialog; annars en vanlig
 * synlig dialog.
 */
async function oppenDialog(page: Page, timeoutMs: number): Promise<Locator | null> {
  const slut = Date.now() + timeoutMs;
  const modaler = page.locator("w-modal, w-dialog");
  do {
    const index = await modaler
      .evaluateAll((els) => els.findIndex((e) => !!e.shadowRoot?.querySelector("dialog[open]") || e.hasAttribute("open")))
      .catch(() => -1);
    if (index >= 0) return modaler.nth(index);
    const vanlig = await forstaSynliga(page.locator('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'), 0);
    if (vanlig) return vanlig;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < slut);
  return null;
}

/** Dialogens text, både värdelementets innehåll och skuggans rubrik. */
async function dialogText(dialog: Locator): Promise<string> {
  const text = await dialog
    .evaluate((el) => `${el.shadowRoot?.textContent ?? ""} ${el.textContent ?? ""}`)
    .catch(() => "");
  return text.replace(/\s+/g, " ").trim();
}

/** Första synliga elementet bland `kandidater`, inom `timeoutMs`; null när inget syns. */
async function forstaSynliga(kandidater: Locator, timeoutMs: number): Promise<Locator | null> {
  const slut = Date.now() + timeoutMs;
  do {
    const antal = await kandidater.count().catch(() => 0);
    for (let i = 0; i < antal; i++) {
      if (await kandidater.nth(i).isVisible().catch(() => false)) return kandidater.nth(i);
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < slut);
  return null;
}

/** Första synliga elementet bland `kandidater` vars text matchar `re`. */
async function synligMedText(kandidater: Locator, re: RegExp): Promise<Locator | null> {
  const antal = await kandidater.count().catch(() => 0);
  for (let i = 0; i < antal; i++) {
    const el = kandidater.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = (await el.innerText().catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "";
    if (re.test(text)) return el;
  }
  return null;
}

/**
 * Klickar på ett skäl som får väljas. Själva alternativet först (radio med det namnet), annars den
 * INNERSTA etiketten — aldrig en rad eller ett kort som rymmer flera skäl. Returnerar texten, eller null.
 */
async function valjSkal(dialog: Locator): Promise<string | null> {
  const radio = dialog.getByRole("radio", { name: SKAL_OK });
  for (let i = 0; i < (await radio.count().catch(() => 0)); i++) {
    const r = radio.nth(i);
    const namn = (await r.getAttribute("aria-label").catch(() => null)) ?? "";
    if (SKAL_SALD.test(namn) || !(await r.isVisible().catch(() => false))) continue;
    await r.click({ timeout: 3000 });
    return namn || "radio";
  }
  const etiketter = dialog.getByText(SKAL_OK);
  for (let i = 0; i < (await etiketter.count().catch(() => 0)); i++) {
    const e = etiketter.nth(i);
    const t = (await e.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    // Kort och utan något annat skäl i sig: en etikett, inte en rad som rymmer flera.
    if (!t || t.length > 60 || SKAL_SALD.test(t) || !(await e.isVisible().catch(() => false))) continue;
    if ((await e.locator("w-radio, input, [role=radio]").count().catch(() => 0)) > 0) continue;
    await e.click({ timeout: 3000 });
    return t;
  }
  return null;
}

/**
 * Etiketten till det alternativ som står VALT i dialogen just nu, eller null. Läser w-radio[checked],
 * [role=radio][aria-checked=true] och input:checked (även i skuggor), och etiketten via
 * aria-labelledby, aria-label, <label for> eller närmaste förälder.
 */
async function lasValtSkal(dialog: Locator): Promise<string | null> {
  // INGA NAMNGIVNA FUNKTIONER I KROPPEN: tsx/esbuild lindar dem i en `__name`-hjälpare som inte finns i
  // webbläsaren, och då kastar evaluate — vilket här hade lästs som "inget valt". Därför en kö i stället
  // för rekursion, och etiketten uträknad på plats.
  return dialog
    .evaluate((rot) => {
      const valda: Element[] = [];
      const ko: Array<Element | ShadowRoot> = [rot];
      while (ko.length) {
        const r = ko.pop()!;
        r.querySelectorAll('w-radio[checked], [role="radio"][aria-checked="true"], input[type="radio"]').forEach((el) => {
          if (el instanceof HTMLInputElement && !el.checked) return;
          valda.push(el);
        });
        r.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) ko.push(el.shadowRoot);
        });
      }
      if (valda.length !== 1) return null;
      // En input i en skugga får sin etikett från värdelementet.
      let el: Element = valda[0];
      const host = (el.getRootNode() as ShadowRoot).host;
      if (host) el = host;
      let text = "";
      const ids = el.getAttribute("aria-labelledby");
      const id = el.getAttribute("id");
      if (ids) text = ids.split(/\s+/).map((x) => document.getElementById(x)?.textContent ?? "").join(" ");
      else if (el.getAttribute("aria-label")) text = el.getAttribute("aria-label")!;
      else if (id && document.querySelector(`label[for="${id}"]`)) text = document.querySelector(`label[for="${id}"]`)!.textContent ?? "";
      else text = el.closest("label")?.textContent ?? el.parentElement?.textContent ?? "";
      return text.replace(/\s+/g, " ").trim() || null;
    })
    .catch(() => null);
}

/**
 * Vårt kort på Mina annonser, och dess menyknapp. Klättrar från detaljlänken tills en menyknapp finns
 * — men aldrig så högt att flera kort ingår, för då vore menyknappen någon annans.
 */
async function kortetOchMenyn(page: Page, id: string): Promise<{ kort: Locator; meny: Locator; rubrik: string } | null> {
  const lank = page.locator(`a[href="/my-items/details/${id}"]`).first();
  if ((await lank.count().catch(() => 0)) === 0) return null;
  const rubrik = (await lank.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  let kort = lank;
  for (let niva = 0; niva < 6; niva++) {
    kort = kort.locator("xpath=..");
    if ((await kort.locator('a[href^="/my-items/details/"]').count().catch(() => 0)) > 1) return null;
    const meny = kort.locator('w-button:has-text("Meny"), button:has-text("Meny"), button[aria-label*="eny" i], w-button[aria-label*="eny" i]').first();
    if (await meny.isVisible({ timeout: 300 }).catch(() => false)) return { kort, meny, rubrik };
  }
  return null;
}

/**
 * Tar bort annonsen i den inloggade sessionen. Ingenting här känner till ett jobb.
 *
 * Kastar när annonsen INTE togs bort (och står kvar). `redan-borta` är inget fel: en annons som gått ut
 * eller tagits bort för hand har inget att ta ner, och omläggningen kan gå vidare till publiceringen.
 */
export async function driveBlocketBorttagning(page: Page, input: BlocketBorttagningInput, logga: Logga): Promise<BlocketBorttagningResultat> {
  const bas = blocketBaseUrl();
  const id = adIdFromUrl(input.adUrl);
  if (!id) throw new Error(`Annonsens id gick inte att läsa ur adressen ${input.adUrl} — ingenting rördes.`);
  if (!input.title && !input.dryRun) throw new Error("Rubriken saknas — en skarp borttagning kräver rubrikvakten.");

  // ── Är annonsen aktiv? Lämnar sidan på den sida av Mina annonser där kortet står. ─────────────
  if (!(await annonsenArAktiv(page, id, logga))) {
    logga("Annonsen står inte bland de aktiva — inget att ta ner", "ok", { id });
    return { status: "redan-borta", vag: null };
  }

  // ── Kortet och rubrikvakten ──────────────────────────────────────────────
  const hittat = await kortetOchMenyn(page, id);
  if (input.title && hittat && !rubrikStammer(hittat.rubrik, input.title)) {
    logga("Kortet visar inte vår annons", "error", { id, iKortet: hittat.rubrik, var: input.title });
    throw new Error(`Kortet för ${id} har rubriken "${hittat.rubrik}", inte "${input.title}" — ingenting togs bort.`);
  }

  // ── Valet: kortets meny först, ägarsidan som reserv ─────────────────────
  let val: Locator | null = null;
  let vag: string | null = null;
  if (hittat) {
    // Menyer läggs ofta utanför kortet i DOM:en. Ett val på sidan räknas därför bara om det inte
    // syntes redan innan VÅR meny öppnades — annars kan det höra till något annat på sidan.
    const fore = await synligMedText(page.locator(KLICKBARA), TA_BORT_VAL);
    await hittat.meny.click({ timeout: 4000 }).catch(() => null);
    await page.waitForTimeout(700);
    val = (await synligMedText(hittat.kort.locator(KLICKBARA), TA_BORT_VAL)) ?? (fore ? null : await synligMedText(page.locator(KLICKBARA), TA_BORT_VAL));
    if (val) vag = "Mina annonser → kortets meny";
    else {
      logga("Kortets meny hade inget val att ta bort", "warning", { id });
      await page.keyboard.press("Escape").catch(() => null);
    }
  } else {
    logga("Hittade inte kortets meny — provar ägarsidan", "warning", { id });
  }
  if (!val) {
    await goAndSettle(page, `${bas}/my-items/details/${id}`);
    await dismissCookieBanner(page);
    await dismissModal(page);
    if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
    const sidtext = (await page.locator("main").first().innerText({ timeout: 4000 }).catch(() => "")).replace(/\s+/g, " ");
    // Ägarsidan har ingen egen rubrik att läsa ett fält ur ("Hantera annons … <rubrik>"), så vakten
    // är att rubrikens början står på sidan.
    if (input.title && !sidtext.toLowerCase().includes(input.title.toLowerCase().replace(/\s+/g, " ").slice(0, 30))) {
      logga("Ägarsidan visar inte vår annons", "error", { id, url: page.url() });
      throw new Error(`Ägarsidan för ${id} visar inte "${input.title}" — ingenting togs bort.`);
    }
    // En meny även här ("tre prickar")? Öppna den, men bara om valet inte redan syns.
    val = await synligMedText(page.locator(KLICKBARA), TA_BORT_VAL);
    if (!val) {
      const meny = await synligMedText(page.locator("w-button, button"), /meny|fler val|mer/i);
      if (meny) {
        await meny.click({ timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(700);
        val = await synligMedText(page.locator(KLICKBARA), TA_BORT_VAL);
      }
    }
    if (val) vag = "ägarsidan";
  }
  if (!val) {
    logga("Hittade inget val att ta bort annonsen", "error", { id, url: page.url() });
    throw new Error(`Hittade inget "Ta bort" för annonsen ${id}, varken i kortets meny eller på ägarsidan. Sidan står på ${page.url()}.`);
  }
  const valText = (await val.innerText().catch(() => "")).trim();
  logga(`Hittade "${valText}" (${vag})`, "ok", { id });

  if (input.dryRun) {
    logga("TORRKÖRNING KLAR — ingenting klickat, annonsen ligger kvar", "ok", { id, val: valText, vag });
    return { status: "torrkorning", vag };
  }

  // ── Ta bort, och bekräfta ────────────────────────────────────────────────
  await val.click({ timeout: 4000 });
  await page.waitForTimeout(1200);

  const dialog = await oppenDialog(page, 3000);
  if (dialog) {
    const text = await dialogText(dialog);
    logga("Bekräftelsen visas", "ok", { text: text.slice(0, 200) });

    // Frågar den efter ett skäl? Välj ett som INTE säger att möbeln sålts — eller avbryt.
    const skalen = dialog.locator('w-radio, input[type="radio"], [role="radio"], label');
    const fragarSkal = (await skalen.count().catch(() => 0)) > 0 && /anledning|varför|skäl/i.test(text);
    if (fragarSkal) {
      const valt = await valjSkal(dialog);
      // VAD SOM FAKTISKT ÄR VALT, inte vad som klickades. Ett klick på raden runt ett alternativ kan
      // välja ett annat (attrappen visade det: klicket på "Vill inte sälja längre"-raden valde
      // "Såld på Blocket"). Ett "såld" här är ett påstående om en försäljning som inte skett.
      const ivalt = await lasValtSkal(dialog);
      if (!valt || !ivalt || SKAL_SALD.test(ivalt) || !SKAL_OK.test(ivalt)) {
        await page.keyboard.press("Escape").catch(() => null);
        logga("Kunde inte välja ett skäl som inte säger 'såld'", "error", { klickat: valt, valt: ivalt, text: text.slice(0, 300) });
        throw new Error(
          `Blocket frågar varför annonsen tas bort, och roboten fick inte ett skäl valt som inte säger "såld" ` +
            `(valt: ${ivalt ? `"${ivalt}"` : "inget"}) — avbröt, ingenting togs bort.`,
        );
      }
      logga(`Skäl: ${ivalt}`, "ok", {});
    }

    const knapp = await synligMedText(dialog.locator("button, w-button, a"), BEKRAFTA);
    if (!knapp) {
      await page.keyboard.press("Escape").catch(() => null);
      logga("Bekräftelseknappen hittades inte", "error", { text: text.slice(0, 300) });
      throw new Error(`Hittade ingen bekräftelseknapp i dialogen ("${text.slice(0, 160)}") — avbröt.`);
    }
    // En gång till, precis före klicket: ingenting mellan valet och bekräftelsen får ha bytt skälet.
    if (fragarSkal) {
      const nu = await lasValtSkal(dialog);
      if (!nu || SKAL_SALD.test(nu) || !SKAL_OK.test(nu)) {
        await page.keyboard.press("Escape").catch(() => null);
        throw new Error(`Skälet i dialogen är inte längre ett som får väljas (${nu ? `"${nu}"` : "inget"}) — avbröt, ingenting togs bort.`);
      }
    }
    await knapp.click({ timeout: 4000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(2000);
    logga("Bekräftade", "ok", {});
  } else {
    logga("Ingen bekräftelsedialog — valet verkställde direkt", "ok", { url: page.url() });
  }

  // ── Verifiera: inte längre bland de aktiva ───────────────────────────────
  for (let forsok = 0; forsok < 3; forsok++) {
    if (!(await annonsenArAktiv(page, id, () => undefined))) {
      logga("Annonsen står inte längre bland de aktiva", "ok", { id });
      return { status: "borttagen", vag };
    }
    await page.waitForTimeout(3000);
  }
  logga("Annonsen står kvar bland de aktiva efter borttagningen", "error", { id });
  throw new Error(`Annonsen ${id} står kvar bland de aktiva på Mina annonser efter borttagningen — ingen ny läggs upp.`);
}

// ---------- Jobbet ----------

export type TaNerUtfall = { status: "nere" } | { status: "senare"; skal: string };

/**
 * Tar ner jobbets Blocket-annons. Kastar när den INTE togs ner — anroparen lägger då inte upp någon ny,
 * och den gamla ligger kvar på det gamla priset. "senare" = roboten var upptagen.
 */
export async function taNerBlocketAnnons(job: ConditionJob): Promise<TaNerUtfall> {
  const pub = job.blocket;
  if (!pub || pub.status !== "published") throw new Error("Annonsen ligger inte uppe på Blocket enligt jobbet.");
  if (!pub.url) throw new Error("Blocket-annonsens adress saknas på jobbet, så roboten hittar den inte.");
  if (!blocketConfigured()) throw new Error(`Blocket är inte konfigurerat på servern (saknar ${missingBlocketEnv().join(", ")}).`);
  if (!sessionFileExists()) throw new Error("Sessionsfilen som BLOCKET_SESSION pekar på finns inte.");
  if (!blocketOmlaggningKlar()) throw new Error("Borttagningsroboten är av (BLOCKET_TA_BORT_ROBOT=1 och BLOCKET_PUBLICERA=1 krävs).");
  const halsa = lasHalsa();
  if (halsa && !halsa.ok) throw new Error(`Blocket-sessionen har gått ut (kontrollerad ${halsa.kontrolleradAt.slice(0, 16).replace("T", " ")}).`);
  if (arUpptagen()) return { status: "senare", skal: "En annan Blocket-körning pågår." };

  const steps: BlocketStep[] = [];
  const logga: Logga = (name, status, details) => {
    steps.push(nyttSteg(name, status, details));
    console.info(`[blocket-ta-bort] ${job.id} ${status.toUpperCase()} ${name}`);
  };

  let session: Awaited<ReturnType<typeof startBrowser>> | null = null;
  markeraUpptagen(true);
  try {
    logga("Startar borttagning för omläggning", "running", { url: pub.url });
    session = await startBrowser();
    try {
      await ensureSession(session.page, logga);
      skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: true, url: session.page.url(), fel: null });
    } catch (err) {
      if (/gått ut/i.test(felText(err))) {
        skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: false, url: session.page.url(), fel: felText(err) });
      }
      throw err;
    }
    await handleBankID(session.page, session.context, logga);
    await driveBlocketBorttagning(session.page, { adUrl: pub.url, title: capTitle(adTitle(job)), dryRun: false }, logga);
    if (await saveSessionIfReal(session.context).catch(() => false)) logga("Sessionen sparades om", "ok", {});
    return { status: "nere" };
  } catch (err) {
    if (session && !session.page.isClosed()) {
      const fil = path.join(blocketDataDir(), `ta-bort-fel-${job.id}.png`);
      try {
        mkdirSync(path.dirname(fil), { recursive: true, mode: 0o700 });
        await session.page.screenshot({ path: fil, fullPage: true });
        logga("Skärmbild sparad", "warning", { fil, url: session.page.url() });
      } catch {
        // Sidan kan vara borta.
      }
    }
    throw err;
  } finally {
    markeraUpptagen(false);
    // Stegen hamnar på publiceringen som den ser ut nu; publiceringen efteråt skriver sina egna.
    pub.prisSteg = [...(pub.prisSteg ?? []), ...steps].slice(-30);
    await session?.browser.close().catch(() => undefined);
  }
}
