/**
 * Loopa-annonsen -> en riktig annons på Blocket Torget.
 *
 * Samma form som tradera/publish.ts — `plan…`, `mark…Publishing`, `run…` och samma fire-and-forget —
 * men vägen dit är en helt annan. Tradera har ett API som svarar vad som hände. Blocket har inget, så
 * det här är en robot som klickar i någon annans formulär, och varje antagande om den sidan är ett
 * antagande som kan sluta gälla utan förvarning.
 *
 * DÄRFÖR TVÅ REGLER SOM INTE FÅR TAS BORT:
 *
 *  1. TORRKÖRNING ÄR FÖRVALET. Utan `BLOCKET_PUBLICERA=1` fylls allt i men sista knappen trycks
 *     aldrig. En Blocket-annons går inte att ta ner automatiskt — det som inte går att ångra ska
 *     inte vara förvalt.
 *  2. VERIFIERA, ANTA INTE. Frakt, transaktionstyp och kategori läses tillbaka efter att de valts.
 *     Flera av de sju buggarna i railway-proxy v40 var tysta felval: rätt klick, fel resultat, och
 *     ingenting i loggen som sa det.
 *
 * FILEN ÄR DELAD I TVÅ. `driveBlocketForm` kan allt om Blockets formulär och tar en färdig plan;
 * `runBlocketPublish` kan allt om jobbet och statusen. Snittet finns för att det första ska gå att
 * PROVA: formulärkörningen är den del som gått sönder sju gånger, och den kan köras mot attrappen i
 * tests/blocketAttrapp.ts utan ett jobb på disk, utan en session och utan Blocket.
 */

import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { adImages, adTitle, composeAd, renderAdPlain, resolveAdPrice } from "../../adContent.js";
import { prisMedHemleverans, SHIPPING_INCLUDED_SEK } from "../../hemleverans.js";
import { medRattelser } from "../../butik/overrides.js";
import { jobToProduct } from "../../butik/normalize.js";
import { getJob, jobDir, persist } from "../../jobStore.js";
import { loopaIdFor } from "../../loopaId.js";
import { resolveCoverImageId } from "../../pipeline/cover.js";
import type { BlocketPublication, BlocketStep, ConditionJob } from "../../types.js";
import { blocketConfigured, blocketLivePublishing, blocketPostalCode, missingBlocketEnv, sessionFileExists } from "./blocket.js";
import { ensureSession, handleBankID, openTorgetForm, reopenTorgetForm, saveSessionIfReal, startBrowser, ON_FORM } from "./browser.js";
import { MAX_STEPS, nyttSteg, type Logga } from "./diag.js";
import {
  chooseRadio,
  clickFirstVisible,
  currentTitleValue,
  fillByLabel,
  fillBySelector,
  fillDescription,
  setSelectByOptionText,
} from "./form.js";
import {
  BLOCKET_CONDITION,
  blocketCategoryFor,
  capTitle,
  conditionOptions,
  MAX_BLOCKET_IMAGES,
  measurementsFrom,
  type BlocketCategory,
  type BlocketMeasurements,
} from "./mapping.js";
import { handlePackagePage, handleShippingPage } from "./shipping.js";

/** Vad som kommer att publiceras, så säljaren kan se det INNAN de trycker. */
export interface BlocketPublishPlan {
  /** Kapad till Blockets 50 tecken, helst vid ett ordslut. */
  title: string;
  loopaId: string;
  category: BlocketCategory;
  /**
   * Priset som ska STÅ I ANNONSEN: möbeln plus hemleveransen, samma tal som Tradera-annonsen bär.
   *
   * Kanalerna bar olika pris så länge Blocket var en väg för säljaren att sälja själv. Den vägen är
   * borta: annonsen ligger på ett Loopa-konto, Loopa kör hem möbeln, och då ska priset vara
   * detsamma. En köpare som ser samma möbel på två ställen till två priser litar inte på någotdera.
   */
  price: number;
  /** Möbeln utan frakt. Prisstegen räknar i de här kronorna — se hemleverans.ts. */
  itemPrice: number;
  /** Fraktens andel av `price`, utskriven så att gränssnittet slipper känna till beloppet. */
  shippingSek: number;
  priceSource: "seller" | "condition" | "listing";
  /** Loopas skicksträng. Översätts till Blockets etiketter först i formuläret. */
  condition: string | null;
  /** Bara UPPMÄTTA mått. Schabloner skrivs inte ut — se measurementsFrom(). */
  measurements: BlocketMeasurements;
  brand: string | null;
  postalCode: string;
  imageCount: number;
  /** Sant = körningen stannar före sista knappen. Förval, tills BLOCKET_PUBLICERA=1 är satt. */
  dryRun: boolean;
}

export type BlocketReadiness = { ok: true; plan: BlocketPublishPlan } | { ok: false; reason: string };

// ---------- Planering ----------

/**
 * Kan jobbet publiceras på Blocket, och i så fall som vad?
 *
 * Samma tre grundkrav som Tradera-vägen — annonstext, pris och minst en bild — och med SAMMA ORD, för
 * att det inte ska gå att tro att den ena kanalen kan något den andra inte kan. Ovanpå det ett krav
 * till: postnumret, som Blocket kräver och Loopa inte känner.
 */
export async function planBlocketPublish(rajob: ConditionJob): Promise<BlocketReadiness> {
  const job = await medRattelser(rajob);
  const result = job.result;
  const card = result?.listing?.result ?? null;
  if (!result) return { ok: false, reason: "Analysen är inte klar än." };
  if (!card) return { ok: false, reason: "Annonsen kunde inte skapas, så det finns inget att publicera." };

  const title = adTitle(job);
  if (!title) return { ok: false, reason: "Annonsen saknar rubrik." };

  const price = resolveAdPrice(job);
  if (!price) return { ok: false, reason: "Det finns inget pris att sätta i annonsen." };

  const images = await listingImages(job);
  if (images.length === 0) return { ok: false, reason: "Jobbet har inga bilder kvar på disk." };

  const postalCode = blocketPostalCode();
  if (!postalCode) {
    return { ok: false, reason: "Postnumret saknas. Blocket kräver det — sätt BLOCKET_POSTNUMMER på servern." };
  }

  // Butiksprojektionen är den enda vägen från ett jobb till strukturerade fält (kategori, färg,
  // material, mått). Den returnerar null för affärsjobb och annonshärledda jobb — de är inte
  // butiksvaror, och de ska inte heller läggas ut på Blocket.
  const product = jobToProduct(job, "draft");
  if (!product) {
    return { ok: false, reason: "Det här jobbet är inte en annons — en affärsskanning läggs inte ut till försäljning." };
  }

  return {
    ok: true,
    plan: {
      title: capTitle(title),
      loopaId: loopaIdFor(job.id),
      category: blocketCategoryFor(product.categorySlug, title),
      // Möbeln PLUS hemleveransen, samma tal som Tradera-annonsen bär. Prisstegen räknar i
      // möbelkronor och frakten läggs på vid gränsen — se hemleverans.ts för varför de två aldrig
      // slås ihop tidigare än här.
      price: prisMedHemleverans(price.value),
      itemPrice: price.value,
      shippingSek: SHIPPING_INCLUDED_SEK,
      priceSource: price.source,
      condition: result.grade ? BLOCKET_CONDITION[result.grade.grade] : null,
      measurements: measurementsFrom(product.dimensions),
      brand: product.brand,
      postalCode,
      imageCount: images.length,
      dryRun: !blocketLivePublishing(),
    },
  };
}

/** Annonsens bilder, kapade till vad Blockets uppladdare tar. Urvalet och ordningen görs i adContent.ts. */
async function listingImages(job: ConditionJob) {
  return (await adImages(job)).slice(0, MAX_BLOCKET_IMAGES);
}

/** Bildernas sökvägar på disk. `setInputFiles` vill ha filer, och de ligger redan här. */
async function imagePaths(job: ConditionJob): Promise<string[]> {
  const dir = path.join(jobDir(job.id), "originals");
  return (await listingImages(job)).map((image) => path.join(dir, image.path));
}

// ---------- Formulärkörningen ----------

export interface BlocketRunInput {
  plan: BlocketPublishPlan;
  /** Annonstexten som ren text. Byggd av adContent.ts, aldrig här — se ad.ts. */
  description: string;
  /** Bildernas sökvägar på disk, omslaget först. */
  files: string[];
}

export interface BlocketRunResult {
  status: "published" | "dry-run";
  url: string | null;
  receiptUrl: string;
}

/**
 * Fyller i Blockets formulär och tar sig igenom frakt- och paketsidan.
 *
 * Allt som vet något om Blockets sidor ligger här eller i form.ts/shipping.ts/browser.ts. Ingenting här
 * känner till ett jobb, en jobbfil eller en publiceringsstatus — det är just det som gör att funktionen
 * kan köras mot attrappen.
 */
export async function driveBlocketForm(
  page: Page,
  context: BrowserContext,
  input: BlocketRunInput,
  logga: Logga,
): Promise<BlocketRunResult> {
  const { plan, description, files } = input;

  await openTorgetForm(page, logga);
  await guardAgainstForeignDraft(page, plan.title, logga);

  // ── Transaktionstyp ──────────────────────────────────────────────────────
  // Läs och verifiera. Att anta att "Sälj" är förvalt är ingen bra idé när alternativet är
  // "Bortskänkes" — en annons som skänker bort möbeln ser likadan ut i formuläret.
  const sell = await chooseRadio(page, /^sälj$/i);
  if (sell.options.length === 0) {
    await clickFirstVisible(page, ['button:has-text("Sälj")', 'label:has-text("Sälj")', '[role="tab"]:has-text("Sälj")'], 4000).catch(
      () => null,
    );
    logga("Ingen transaktionstyp att verifiera", "warning", {});
  } else if (!sell.ok) {
    logga("Kunde inte välja Sälj", "error", { alternativ: sell.options });
    throw new Error(
      `Transaktionstypen gick inte att sätta till "Sälj"${sell.wrong.length ? ` — står på "${sell.wrong.join(", ")}"` : ""}.`,
    );
  } else {
    logga(sell.alreadySet ? "Sälj var redan valt (verifierat)" : "Valde Sälj (verifierat)", "ok", {});
  }

  // ── Bilder ───────────────────────────────────────────────────────────────
  await uploadImages(page, files, logga);

  // ── Kategori ─────────────────────────────────────────────────────────────
  // Huvudkategorin är den enda som får fälla körningen. Ett misslyckat löv ger en annons som ligger en
  // nivå för högt — den syns fortfarande. En annons utan huvudkategori går inte att publicera.
  try {
    const hit = await setSelectByOptionText(page, plan.category.main);
    logga(`Huvudkategori: ${hit.picked}`, "ok", { ...hit });
  } catch (err) {
    logga("Huvudkategorin gick inte att välja", "error", { forsokte: plan.category.main, fel: felText(err) });
    throw new Error(`Kunde inte välja huvudkategori "${plan.category.main}". Blocket har troligen byggt om formuläret.`);
  }
  for (const [level, value] of [
    ["Underkategori", plan.category.sub],
    ["Produktkategori", plan.category.product],
  ] as const) {
    if (!value) continue;
    try {
      const hit = await setSelectByOptionText(page, value);
      logga(`${level}: ${hit.picked}`, "ok", { ...hit });
    } catch (err) {
      logga(`${level} gick inte att välja`, "warning", { forsokte: value, fel: felText(err) });
    }
  }

  // ── Skick ────────────────────────────────────────────────────────────────
  await pickCondition(page, plan.condition, logga);

  // ── Mått ─────────────────────────────────────────────────────────────────
  // EXAKT etikettmatchning. "Höjd" är en delsträng av "Sitthöjd", och en luddig sökning fyller
  // sitthöjden med möbelns höjd — ett fel som ser rätt ut i formuläret och syns först i annonsen.
  for (const [label, value] of [
    ["Höjd", plan.measurements.height],
    ["Bredd", plan.measurements.width],
    ["Djup", plan.measurements.depth],
  ] as const) {
    if (!value) continue;
    try {
      await fillByLabel(page, label, value, { timeout: 6000, exact: true });
      logga(`${label}: ${value} cm`, "ok", {});
    } catch {
      logga(`${label} gick inte att fylla i`, "warning", { varde: value });
    }
  }

  // ── Varumärke ────────────────────────────────────────────────────────────
  if (plan.brand) {
    try {
      await fillByLabel(page, "Varumärke", plan.brand, { timeout: 6000 });
      logga(`Varumärke: ${plan.brand}`, "ok", {});
    } catch {
      try {
        await fillBySelector(page, ['input[name="brand"]', 'input[placeholder*="varumärke" i]'], plan.brand, 3000);
        logga(`Varumärke: ${plan.brand} (reservväg)`, "ok", {});
      } catch {
        // Märkesfältet heter olika i olika kategorier hos Blocket (furniture_brand,
        // sofas_armchairs_brand, …). Märket står redan i rubriken, så det här är en detalj.
        logga("Varumärkesfältet hittades inte", "warning", { marke: plan.brand });
      }
    }
  }

  // ── Rubrik ───────────────────────────────────────────────────────────────
  try {
    await fillByLabel(page, "Annonsrubrik", plan.title, { timeout: 8000 });
    logga(`Rubrik: ${plan.title}`, "ok", {});
  } catch {
    try {
      await fillBySelector(
        page,
        ['input[name="subject"]', 'input[name="title"]', 'input[placeholder*="rubrik" i]', "#subject"],
        plan.title,
        5000,
      );
      logga(`Rubrik: ${plan.title} (reservväg)`, "ok", {});
    } catch (err) {
      logga("Rubriken gick inte att fylla i", "error", { fel: felText(err) });
      throw new Error("Rubrikfältet hittades inte — utan rubrik finns ingen annons.");
    }
  }

  // ── Beskrivning ──────────────────────────────────────────────────────────
  try {
    const how = await fillDescription(page, description);
    logga(`Fyllde beskrivningen${how === "reserv" ? " (reservväg)" : ""}`, "ok", { tecken: description.length });
  } catch (err) {
    // Blocket vägrar gå vidare utan den: "Du måste rätta till Beskrivning innan du kan fortsätta".
    logga("Beskrivningen gick inte att fylla i", "error", { fel: felText(err) });
    throw new Error("Beskrivningsfältet gick inte att fylla i — Blocket släpper inte igenom annonsen utan text.");
  }

  // ── Pris ─────────────────────────────────────────────────────────────────
  try {
    await fillByLabel(page, "Pris", plan.price, { timeout: 8000 });
    logga(`Pris: ${plan.price} kr`, "ok", {});
  } catch {
    try {
      await fillBySelector(
        page,
        ['input[name="price"]', 'input[inputmode="numeric"]', 'input[type="number"]', 'input[placeholder*="pris" i]'],
        plan.price,
        5000,
      );
      logga(`Pris: ${plan.price} kr (reservväg)`, "ok", {});
    } catch (err) {
      logga("Priset gick inte att fylla i", "error", { fel: felText(err) });
      throw new Error("Prisfältet hittades inte — en annons utan pris publiceras inte.");
    }
  }

  // ── Postnummer ───────────────────────────────────────────────────────────
  try {
    await fillByLabel(page, "Postnummer", plan.postalCode, { timeout: 6000 });
    await page.waitForTimeout(1000);
    logga(`Postnummer: ${plan.postalCode}`, "ok", {});
  } catch {
    try {
      await fillBySelector(
        page,
        ['input[name="zipcode"]', 'input[name="postalCode"]', 'input[placeholder*="postnummer" i]'],
        plan.postalCode,
        5000,
      );
      await page.waitForTimeout(1000);
      logga(`Postnummer: ${plan.postalCode} (reservväg)`, "ok", {});
    } catch {
      logga("Postnumret gick inte att fylla i", "warning", { postnummer: plan.postalCode });
    }
  }

  logga("Formuläret är ifyllt", "ok", { url: page.url() });

  // ── Vidare från formuläret ───────────────────────────────────────────────
  // OBS: det här klicket skapar ett UTKAST hos Blocket, även i torrkörning. Det är priset för att
  // frakt- och paketsidan ska bli provade — två av de sju buggarna satt där. Utkastet är vårt eget och
  // känns igen av vakten ovan nästa gång.
  const submit = await clickFirstVisible(
    page,
    ['button:has-text("Fortsätt")', 'button:has-text("Skapa annons")', 'button[type="submit"]:not([disabled])'],
    12_000,
  );
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(2000);
  logga(`Vidare från formuläret (${submit})`, "ok", { url: page.url() });

  // Blocket kan begära BankID just här, för att skapa annonsen. Låg rutan över formuläret skickades det
  // aldrig iväg — då måste Fortsätt tryckas en gång till, men BARA på annonsformuläret. Ett blint klick
  // på Vends sida träffar fel knapp.
  await handleBankID(page, context, logga);
  if (ON_FORM.test(page.url())) {
    await clickFirstVisible(page, ['button:has-text("Fortsätt")', 'button[type="submit"]:not([disabled])'], 12_000).catch(() => null);
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(2000);
    logga("Tryckte Fortsätt igen efter BankID", "ok", { url: page.url() });
  }

  await handleShippingPage(page, logga);
  await handlePackagePage(page, logga);

  // ── Sista knappen ────────────────────────────────────────────────────────
  if (plan.dryRun) {
    logga("TORRKÖRNING KLAR — inget publicerades", "ok", { url: page.url() });
    return { status: "dry-run", url: null, receiptUrl: page.url() };
  }

  await clickFirstVisible(
    page,
    [
      'button:has-text("Gå till betalning")',
      'a:has-text("Gå till betalning")',
      'button:has-text("Publicera annonsen")',
      'a:has-text("Publicera annonsen")',
      'button:has-text("Publicera")',
    ],
    12_000,
  );
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(2500);

  const receiptUrl = page.url();
  const url = await resolveAdUrl(page, logga);
  logga("Klart — annonsen är publicerad", "ok", { url, kvitto: receiptUrl });
  return { status: "published", url, receiptUrl };
}

// ---------- Jobbet och statusen ----------

/** Markerar jobbet som "publicerar" innan bakgrundsarbetet startar, så knappen kan låsas direkt. */
export async function markBlocketPublishing(job: ConditionJob): Promise<BlocketPublication> {
  const publication: BlocketPublication = {
    status: "publishing",
    url: null,
    receiptUrl: null,
    dryRun: !blocketLivePublishing(),
    error: null,
    startedAt: new Date().toISOString(),
    publishedAt: null,
    steps: [],
  };
  job.blocket = publication;
  await persist(job);
  return publication;
}

async function update(jobId: string, patch: (current: BlocketPublication) => BlocketPublication): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const current: BlocketPublication = job.blocket ?? {
    status: "publishing",
    url: null,
    receiptUrl: null,
    dryRun: !blocketLivePublishing(),
    error: null,
    startedAt: new Date().toISOString(),
    publishedAt: null,
    steps: [],
  };
  job.blocket = patch(current);
  await persist(job);
}

/**
 * Kör publiceringen och skriver hela tiden tillbaka var den står i jobbet.
 *
 * Anropas ALDRIG i ett HTTP-svar. En Blocket-körning tar minuter, inte sekunder — och kommer BankID upp
 * väntar den i upp till tre av dem på en människa med en telefon. Klienten pollar
 * `GET /api/jobs/:id/blocket/publicering` i stället, precis som den redan pollar Tradera.
 */
export async function runBlocketPublish(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const steps: BlocketStep[] = [];
  let writing: Promise<void> = Promise.resolve();
  const logga: Logga = (name, status, details) => {
    steps.push(nyttSteg(name, status, details));
    if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
    console.info(`[blocket] ${jobId} ${status.toUpperCase()} ${name}`);
    // Stegen skrivs till jobbet medan körningen pågår, så att klientens pollning visar framsteg. Ett
    // misslyckat skrivförsök får aldrig fälla körningen — annonsen är viktigare än loggen.
    writing = writing.then(() => update(jobId, (current) => ({ ...current, steps: [...steps] }))).catch(() => undefined);
  };

  let session: Awaited<ReturnType<typeof startBrowser>> | null = null;

  try {
    // Äldre jobb saknar omslagsvalet helt och skulle annars lägga sin första bildruta överst — den som
    // ofta är svart. Räknas fram och sparas här, en gång, innan annonsen byggs.
    await resolveCoverImageId(job);

    const readiness = await planBlocketPublish(job);
    if (!readiness.ok) throw new Error(readiness.reason);
    const { plan } = readiness;

    if (!blocketConfigured()) throw new Error(`Blocket är inte konfigurerat på servern. Saknar ${missingBlocketEnv().join(", ")}.`);
    if (!sessionFileExists()) {
      throw new Error("Sessionsfilen som BLOCKET_SESSION pekar på finns inte. Logga in på Blocket för hand och exportera om den.");
    }

    // Samma rättelse en gång till, för texten: `job` ovan skriver publiceringsläget och måste vara det
    // riktiga jobbet, medan beskrivningen ska byggas ur den rättade kopian.
    const annons = await medRattelser(job);
    // SAMMA ANNONS SOM PÅ TRADERA, ord för ord. Loopa säljer möbeln och kör hem den på båda
    // kanalerna — annonsen ligger på ett Loopa-konto, och hemleveransen är redan inräknad i priset
    // (se `prisMedHemleverans`). Två olika löften om samma möbel vore det verkliga felet: en köpare
    // som jämför de två annonserna ska se samma pris och samma leverans.
    const description = buildBlocketDescription(annons);
    const files = await imagePaths(job);

    logga(plan.dryRun ? "Startar TORRKÖRNING — sista knappen trycks inte" : "Startar SKARP publicering", "running", {
      rubrik: plan.title,
      pris: plan.price,
      kategori: plan.category,
      bilder: files.length,
    });

    session = await startBrowser();
    await ensureSession(session.page, logga);
    await handleBankID(session.page, session.context, logga);

    const result = await driveBlocketForm(session.page, session.context, { plan, description, files }, logga);

    if (result.status === "published" && (await saveSessionIfReal(session.context).catch(() => false))) {
      logga("Sessionen sparades om", "ok", {});
    }

    await update(jobId, (current) => ({
      ...current,
      status: result.status,
      dryRun: result.status === "dry-run",
      url: result.url,
      receiptUrl: result.receiptUrl,
      error: null,
      publishedAt: result.status === "published" ? new Date().toISOString() : null,
      steps: [...steps],
    }));
    console.info(`[blocket] job ${jobId} ${result.status} — ${result.url ?? result.receiptUrl}`);
  } catch (err) {
    const message = felText(err);
    console.warn(`[blocket] job ${jobId} kunde inte publiceras — ${message}`);
    steps.push(nyttSteg("Körningen stoppades", "error", { fel: message }));
    await update(jobId, (current) => ({ ...current, status: "error", error: message, steps: [...steps] })).catch(() => undefined);
  } finally {
    await writing.catch(() => undefined);
    await session?.browser.close().catch(() => undefined);
  }
}

// ---------- Delar av körningen ----------

/**
 * FIX 7, andra halvan: rör aldrig NÅGON ANNANS utkast.
 *
 * Blocket kan återuppta ett påbörjat utkast i stället för att skapa ett nytt. Är det vårt eget är det
 * ofarligt att skriva över — är det någon annans är det inte. Kontot hade ett eget utkast, "Bokhylla
 * Karamel från Hannah Home", som annars kunde ha fyllts med Loopa-innehåll och publicerats.
 */
async function guardAgainstForeignDraft(page: Page, title: string, logga: Logga): Promise<void> {
  const isOurs = (value: string) => value === title || value === title.slice(0, 50);

  const first = await currentTitleValue(page);
  if (!first) return;
  if (isOurs(first)) {
    logga("Återupptar vårt eget utkast med samma rubrik", "ok", { rubrik: first });
    return;
  }

  logga("Formuläret innehöll en ANNAN annons rubrik — rör den inte", "warning", { rubrik: first, url: page.url() });
  const reopened = await reopenTorgetForm(page, logga);
  // Ett tomt fält räcker inte som kvitto: står vi kvar på startsidan finns inget fält alls.
  const after = reopened ? await currentTitleValue(page) : "";
  if (!reopened || (after && !isOurs(after))) {
    logga("Kunde inte få ett tomt formulär", "error", { url: page.url(), rubrik: after });
    throw new Error("Öppnade ett befintligt utkast i stället för en ny annons — avbryter hellre än skriver över det.");
  }
}

/**
 * En bild i taget med en paus emellan, aldrig alla på en gång.
 *
 * Blockets uppladdare tappar bilder som kommer för tätt — de försvinner tyst, och annonsen publiceras
 * med tre av sex bilder utan att något felmeddelande visas någonstans.
 *
 * Ordningen är laddad: första uppladdade bilden blir annonsens omslag, och adImages() har redan lagt
 * omslaget först.
 */
async function uploadImages(page: Page, files: string[], logga: Logga): Promise<void> {
  let uploaded = 0;
  for (const [i, file] of files.entries()) {
    try {
      const input = page.locator('input[type="file"]').first();
      if ((await input.count()) === 0) throw new Error("Sidan har inget filfält");
      await input.setInputFiles(file, { timeout: 20_000 });
      await page.waitForTimeout(1500);
      uploaded++;
    } catch (err) {
      logga(`Bild ${i + 1} misslyckades`, "warning", { fil: path.basename(file), fel: felText(err) });
    }
  }
  if (uploaded === 0) {
    logga("Ingen bild kom upp", "error", {});
    throw new Error("Ingen av bilderna gick att ladda upp. Blocket kräver minst en bild.");
  }
  logga(`${uploaded} av ${files.length} bilder uppe`, uploaded === files.length ? "ok" : "warning", {});
}

/** Skicket, provat i fallande träffsäkerhet. Blocket har skrivit om etiketterna minst en gång. */
async function pickCondition(page: Page, condition: string | null, logga: Logga): Promise<void> {
  if (!condition) {
    logga("Inget skickbetyg — fältet lämnas tomt", "warning", {});
    return;
  }
  const options = conditionOptions(condition);
  for (const option of options) {
    try {
      const hit = await setSelectByOptionText(page, option);
      logga(`Skick: ${hit.picked}`, "ok", { loopaBetyg: condition, ...hit });
      return;
    } catch {
      // Nästa etikett.
    }
  }
  logga("Skicket gick inte att sätta", "warning", { loopaBetyg: condition, provade: options });
}

// ---------- Kvittot och annonsadressen ----------

/**
 * Sant för en adress som pekar på en färdig annons.
 *
 * Prövas på SÖKVÄGEN och inte på värdnamnet, så att flödet går att köra mot attrappen. Blocket har tre
 * former: `/annons/...`, `/recommerce/forsale/item/<id>` och det korta `/<id>`.
 */
/**
 * Annonstexten för Blocket. Motsvarigheten till `buildDescription` i tradera/publish.ts.
 *
 * SAMMA FLAGGOR SOM TRADERA, och det är själva poängen: Loopa säljer möbeln och kör hem den på båda
 * kanalerna, hemleveransen är inräknad i priset på båda, och en köpare som jämför de två annonserna
 * ska hitta samma löften. Skillnaden är renderingsformen — Tradera tar HTML, Blockets
 * beskrivningsfält är en textarea.
 *
 * Egen funktion och inte en rad inuti körningen, så att pariteten går att PRÖVA utan att starta en
 * webbläsare (tests/traderaListing.test.ts).
 */
export function buildBlocketDescription(job: ConditionJob): string {
  return renderAdPlain(composeAd(job, { delivery: true, loopaSells: true }));
}

export function isAdUrl(url: string): boolean {
  try {
    return /^\/(annons|recommerce\/forsale\/item|\d{6,})(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Plockar annons-id ur en kvittoadress och bygger den publika adressen.
 *
 * Kvittosidan är inte annonsen. Blocket landar på `/order-and-payment/ad-receipt?adId=<id>`, och den
 * adressen fungerar bara för den inloggade — klistrar man in den någon annanstans får mottagaren en
 * inloggningssida.
 */
export function publicUrlFromReceipt(url: string, base = "https://www.blocket.se"): string | null {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("adId") ?? parsed.pathname.match(/(?:^|\/)(\d{6,})(?:$|\/)/)?.[1];
    return id ? `${base.replace(/\/+$/, "")}/${id}` : null;
  } catch {
    const id = String(url || "").match(/(?:adId=|\/)(\d{6,})(?:[&#/?]|$)/)?.[1];
    return id ? `${base.replace(/\/+$/, "")}/${id}` : null;
  }
}

/**
 * Letar upp adressen till den färdiga annonsen.
 *
 * OVERIFIERAT OMRÅDE. Publiceringsklicket har aldrig körts skarpt mot Blocket, och allt härifrån är
 * därför skrivet efter samma regel som resten men aldrig prövat mot sajten. Den gamla koden använde
 * `page.evaluate(document.querySelectorAll('a'))` och `page.click('a:has-text(...)')` — exakt de mönster
 * som fallerade överallt annars. Här går sökningen genom locators, och när ingenting hittas normaliseras
 * kvittoadressen i stället för att gissas.
 */
async function resolveAdUrl(page: Page, logga: Logga): Promise<string | null> {
  const receipt = page.url();
  const linkText = /fortsätt till annonsen|till annonsen|visa annons/i;

  const link = page.locator("a, w-button, w-link").filter({ hasText: linkText }).first();
  if (await link.isVisible({ timeout: 5000 }).catch(() => false)) {
    const href = await link.getAttribute("href").catch(() => null);
    if (href) {
      const absolute = new URL(href, receipt).toString();
      if (isAdUrl(absolute)) {
        logga("Läste annonsadressen ur kvittot", "ok", { url: absolute });
        return absolute;
      }
    }
    // Ingen href (w-button är ingen länk) — klicka och läs adressen vi hamnar på.
    await Promise.all([page.waitForNavigation({ timeout: 10_000 }).catch(() => null), link.click({ timeout: 5000 }).catch(() => null)]);
    await page.waitForTimeout(1500);
    if (isAdUrl(page.url())) {
      logga("Hämtade annonsadressen genom att klicka", "ok", { url: page.url() });
      return page.url();
    }
  }

  const normalized = publicUrlFromReceipt(receipt, new URL(receipt).origin);
  if (normalized) {
    logga("Normaliserade kvittoadressen till den publika", "ok", { url: normalized, kvitto: receipt });
    return normalized;
  }

  logga("Kunde inte härleda annonsadressen", "warning", { kvitto: receipt });
  return null;
}

function felText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { blocketConfigured, missingBlocketEnv };
