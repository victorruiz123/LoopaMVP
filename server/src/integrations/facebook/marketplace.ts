/**
 * Loopa-annonsen -> en annons på Facebook Marketplace, genom Facebooks eget formulär.
 *
 * SAMMA TVÅ REGLER SOM BLOCKET-ROBOTEN:
 *
 *  1. TORRKÖRNING ÄR FÖRVALET. Allt fylls i, formuläret tas fram till Publicera, och där stannar det.
 *     En Marketplace-annons som ligger ute går inte att ångra tyst.
 *  2. VERIFIERA, ANTA INTE. Kategorin och skicket läses tillbaka efter valet; det som inte gick att
 *     fylla i står i stegloggen med sitt eget ord.
 *
 * FASERNA SKRIVS TILL DISK FÖRE SISTA KNAPPEN. `onPhase("publish_clicked")` anropas — och inväntas —
 * innan Publicera trycks. Dör processen därefter står det i lagret att knappen kan ha tryckts, och
 * kön gör då ALDRIG ett automatiskt omförsök (queue.ts). Det är hela skyddet mot två annonser.
 *
 * SELEKTORERNA ÄR ANTAGNA tills en torrkörning mot den riktiga ytan bekräftat dem. Föraren är skriven
 * för att FALLA BEGRIPLIGT när ytan ser annorlunda ut — varje fält har ett eget steg och ett eget fel —
 * inte för att ta sig igenom med gissningar.
 */

import { existsSync } from "node:fs";
import type { Page } from "playwright";
import { facebookBaseUrl } from "./config.js";
import { marketplaceCategoryCandidates, marketplaceConditionCandidates, marketplaceCopy, type FacebookListing } from "./mapping.js";
import { escapeRe, fillField, fillLocation, NON_SEK, pickCondition, priceShown, visibleFieldErrors } from "./forms.js";
import { FB } from "./selectors.js";
import { assertNoInterrupt, bodyText, goto, screenshot } from "./session.js";
import { felText, type Logga } from "./steps.js";
import type { ModerationState, PublicationPhase } from "./types.js";

export interface MarketplaceRunInput {
  listing: FacebookListing;
  dryRun: boolean;
  /** Anropas före och efter sista knappen. Kön skriver fasen till disk här. */
  onPhase: (phase: PublicationPhase) => Promise<void>;
}

export interface MarketplaceRunResult {
  /** RESTRICTED = Facebook säger att kontot inte får publicera på Marketplace just nu. Ingen skrivning gjordes. */
  status: "WOULD_PUBLISH" | "PUBLISHED" | "FAILED" | "RESTRICTED";
  url: string | null;
  listingId: string | null;
  screenshot: string | null;
  /** Vad vi såg om fälten: vilka Facebook krävde, hur adressen renderades. Rapportmaterial. */
  observations: string[];
  categoryPicked: string | null;
  conditionPicked: string | null;
  failureReason: string | null;
  /** "Säljinlägget granskas" efter Publicera (VERIFIERAT 2026-09-26) = Facebooks standardgranskning. */
  moderation: ModerationState | null;
}

/** Facebooks ord för att annonsen ligger i granskning innan andra ser den. */
export const FACEBOOK_REVIEW = /s[äa]ljinl[äa]gget granskas|inl[äa]gget granskas|standardgranskning|is being reviewed|under review|pending review/i;

/** Facebooks egna ord för att Marketplace är stängt för kontot just nu. */
const MARKETPLACE_RESTRICTED =
  /du kan inte skapa inlägg på marketplace[^.]*|dagliga gränsen för nya facebook-konton|you can'?t (create|post) (listings|on marketplace)[^.]*|daily limit for new (facebook )?accounts|marketplace[^.]{0,60}(begränsad|restricted|inte tillgänglig|unavailable)[^.]*/i;

/** Fyller formuläret. Vet ingenting om jobb eller köer — bara om Facebooks sida. */
export async function driveMarketplaceForm(page: Page, input: MarketplaceRunInput, logga: Logga): Promise<MarketplaceRunResult> {
  const { listing, dryRun } = input;
  const copy = marketplaceCopy(listing);
  const observations: string[] = [];
  let categoryPicked: string | null = null;
  let conditionPicked: string | null = null;

  await goto(page, `${facebookBaseUrl()}${FB.marketplace.createPath}`, "Marketplace-formuläret");

  /**
   * SAMTYCKESVALET (VERIFIERAT 2026-09-25). Första besöket på Marketplace i EU skickar kontot till
   * /privacy/consent/?flow=fb_dma_marketplace — "Du måste göra ett val angående Marketplace" — ett val
   * om hur Facebook får använda kontots uppgifter. Det är kontoägarens beslut, inte robotens: körningen
   * stannar och säger vad som ska göras för hand (`npm run facebook -- open <adress>`). Ingen
   * kontrollpunkt, så sessionen står kvar som CONNECTED och grupp-inläggen påverkas inte.
   */
  if (/\/privacy\/consent\//i.test(page.url())) {
    const shot = await screenshot(page, "mp_samtycke");
    logga("Marketplace kräver ett samtyckesval av kontoägaren", "error", { url: page.url() });
    observations.push("Facebook visade samtyckesdialogen för Marketplace (flow=fb_dma_marketplace) i stället för formuläret.");
    return failed(
      `Marketplace kräver att kontoägaren gör ett val om dataanvändning innan formuläret visas. Öppna ${page.url()} för hand (npm run facebook -- open "${page.url()}"), gör valet, och köa om.`,
      observations,
      shot,
      categoryPicked,
      conditionPicked,
    );
  }
  logga("Formuläret öppnat", "ok", { url: page.url() });

  // ── Bilder ─────────────────────────────────────────────────────────────
  const files = listing.imagePaths.filter((p) => existsSync(p));
  if (files.length === 0) {
    logga("Inga bildfiler på disk", "error", {});
    return failed("Ingen av bilderna finns på disk. Marketplace kräver minst en bild.", observations, null, categoryPicked, conditionPicked);
  }
  try {
    let fileInput = page.locator(FB.marketplace.fileInput).first();
    if ((await fileInput.count()) === 0) {
      const add = page.locator(FB.marketplace.addPhotos).first();
      if ((await add.count()) > 0) await add.click({ timeout: 4000 }).catch(() => undefined);
      fileInput = page.locator(FB.marketplace.fileInput).first();
      await fileInput.waitFor({ state: "attached", timeout: 8000 }).catch(() => undefined);
    }
    if ((await fileInput.count()) === 0) throw new Error("Sidan har inget filfält");
    await fileInput.setInputFiles(files, { timeout: 30_000 });
    await page.locator('img[src^="blob:"]').first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    logga(`${files.length} bilder uppladdade`, "ok", {});
  } catch (err) {
    logga("Bilderna gick inte att ladda upp", "error", { fel: felText(err) });
    return failed(`Bilderna gick inte att ladda upp: ${felText(err)}`, observations, await screenshot(page, "mp_bilder"), categoryPicked, conditionPicked);
  }

  // ── Rubrik ─────────────────────────────────────────────────────────────
  if (!(await fillField(page, [/^Titel$/i, /^Title$/i], FB.marketplace.title, copy.title))) {
    logga("Rubrikfältet hittades inte", "error", {});
    return failed("Rubrikfältet hittades inte — Facebook har troligen byggt om formuläret.", observations, await screenshot(page, "mp_rubrik"), categoryPicked, conditionPicked);
  }
  logga(`Rubrik: ${copy.title}`, "ok", {});

  // ── Pris ───────────────────────────────────────────────────────────────
  if (!(await fillField(page, [/^Pris$/i, /^Price$/i], FB.marketplace.price, String(listing.price)))) {
    logga("Prisfältet hittades inte", "error", {});
    return failed("Prisfältet hittades inte.", observations, await screenshot(page, "mp_pris"), categoryPicked, conditionPicked);
  }
  /**
   * VALUTAN LÄSES TILLBAKA (VERIFIERAT 2026-09-25). Facebook formaterar prisfältet med kontots
   * Marketplace-valuta, och den styrs INTE av annonsens plats: med platsen Stockholm stod det ändå
   * "$1 000". En annons till 1 000 dollar för en soffa som kostar 1 000 kronor är ett falskt pris, så
   * körningen stannar här tills kontoägaren bytt valuta i Marketplace-inställningarna.
   */
  const prisVisat = (await priceShown(page, FB.marketplace.price)) ?? "";
  observations.push(`Prisfältet visar "${prisVisat}".`);
  if (NON_SEK.test(prisVisat)) {
    logga(`Prisfältet visar fel valuta: ${prisVisat}`, "error", {});
    return failed(
      `Marketplace-kontots valuta är inte svenska kronor — prisfältet visar "${prisVisat}". Annonsen hade fått fel pris. Byt valuta i kontots Marketplace-inställningar och köa om.`,
      observations,
      await screenshot(page, "mp_valuta"),
      categoryPicked,
      conditionPicked,
    );
  }
  logga(`Pris: ${listing.price} kr (fältet visar ${prisVisat})`, "ok", {});

  // ── Kategori (VERIFIERAT: en dialog med en knapp per kategori; "Möbler" är ett löv) ──
  categoryPicked = await pickCategory(page, marketplaceCategoryCandidates(listing.categorySlug));
  if (categoryPicked) logga(`Kategori: ${categoryPicked}`, "ok", { forsokte: marketplaceCategoryCandidates(listing.categorySlug) });
  else {
    logga("Kategorin gick inte att välja", "error", { forsokte: marketplaceCategoryCandidates(listing.categorySlug) });
    return failed("Kategorin gick inte att välja i Marketplace-dialogen.", observations, await screenshot(page, "mp_kategori"), categoryPicked, conditionPicked);
  }

  // ── Skick (VERIFIERAT: kombinationsruta med role=option) ─────────────────
  const conditions = marketplaceConditionCandidates(listing.grade);
  if (conditions.length) {
    conditionPicked = await pickCondition(page, page, FB.marketplace.condition, FB.marketplace.conditionOption, conditions);
    if (conditionPicked) logga(`Skick: ${conditionPicked}`, "ok", { loopaBetyg: listing.grade });
    else logga("Skicket gick inte att sätta", "warning", { forsokte: conditions });
  } else {
    logga("Inget skickbetyg — fältet lämnas", "warning", {});
  }

  // ── Mer information (VERIFIERAT: hopfälld sektion som bär beskrivning och plats) ──
  const more = page.getByRole("button", { name: FB.marketplace.moreInfo }).first();
  if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") {
    await more.scrollIntoViewIfNeeded().catch(() => undefined);
    await more.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    const expanded = (await more.getAttribute("aria-expanded")) === "true";
    logga(expanded ? "Mer information expanderad" : "Mer information gick inte att expandera", expanded ? "ok" : "warning", {});
  }

  // ── Beskrivning ────────────────────────────────────────────────────────
  if (!(await fillField(page, [/^Beskrivning$/i, /^Description$/i], FB.marketplace.description, copy.description))) {
    logga("Beskrivningsfältet hittades inte", "error", {});
    return failed("Beskrivningsfältet hittades inte.", observations, await screenshot(page, "mp_beskrivning"), categoryPicked, conditionPicked);
  }
  logga("Beskrivningen ifylld", "ok", { tecken: copy.description.length });

  // Hur renderar Facebook adressen? Läses av, aldrig antaget.
  await page.waitForTimeout(1500);
  const linkAnchors = await page.locator(`a[href*="${new URL(listing.canonicalUrl).hostname}"]`).count().catch(() => 0);
  observations.push(
    linkAnchors > 0
      ? `Loopa-adressen renderas som klickbar länk/förhandsvisning i formuläret (${linkAnchors} ankare).`
      : "Loopa-adressen står som ren text i beskrivningsfältet (ingen länk eller förhandsvisning i formuläret).",
  );

  // ── Plats (VERIFIERAT: kombinationsruta med förslag; första förslaget för "Stockholm" är "Stockholm Ort") ──
  const locationSet = await fillLocation(page, page, FB.marketplace.location, FB.marketplace.locationOption, listing.location);
  logga(locationSet ? `Plats: ${locationSet}` : "Platsfältet hittades inte — kontots förvalda plats gäller", locationSet ? "ok" : "warning", {});

  // ── Obligatoriska fält, som Facebook själv säger dem ───────────────────
  const errorsBefore = await visibleFieldErrors(page, FB.marketplace.fieldError);
  if (errorsBefore.length) observations.push(`Facebook markerar före Nästa: ${errorsBefore.join(" | ")}`);
  logga("Formuläret är ifyllt", "ok", { url: page.url() });

  // ── Fram till sista knappen ────────────────────────────────────────────
  // "Nästa" är ingen skrivning: den byter sida i samma formulär. Publicera är skrivningen — och den
  // finns bara på MÅLGRUPPSSIDAN (?step=audience, Nästa borta). Så länge Nästa syns är vi på sida 1,
  // vad som än råkar heta Publicera där (LÄRDOM 2026-09-26: klicket träffade förhandsgranskningen).
  const nextVisible = async () => {
    const next = page.locator(FB.marketplace.next).first();
    return (await next.count()) > 0 && (await next.isVisible().catch(() => false));
  };
  const atAudience = async () => /step=audience/.test(page.url()) || !(await nextVisible());
  for (let i = 0; i < 3; i++) {
    const publish = page.locator(FB.marketplace.publish).first();
    if ((await publish.count()) > 0 && (await publish.isVisible().catch(() => false)) && (await atAudience())) break;
    const next = page.locator(FB.marketplace.next).first();
    if ((await next.count()) === 0) break;
    await next.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    await assertNoInterrupt(page, "Marketplace (efter Nästa)");
    /**
     * MARKETPLACE-SPÄRREN (VERIFIERAT 2026-09-25). Sidan efter Nästa (?step=audience) kan säga
     * "Du kan inte skapa inlägg på Marketplace just nu eftersom du har nått den dagliga gränsen för nya
     * Facebook-konton" — Publicera-knappen finns ändå. Det är en Marketplace-begränsning: arbetaren
     * stannar, ingenting trycks, och kön markerar posten som en åtgärd för en människa.
     */
    const restriction = (await bodyText(page)).match(MARKETPLACE_RESTRICTED);
    if (restriction) {
      observations.push(`Facebook: "${restriction[0]}"`);
      logga("Marketplace är begränsat för kontot — Publicera trycks inte", "error", { text: restriction[0] });
      const shotR = await screenshot(page, "mp_begransad");
      await leaveWithoutPublishing(page, logga);
      return { status: "RESTRICTED", url: null, listingId: null, screenshot: shotR, observations, categoryPicked, conditionPicked, failureReason: `Facebook begränsar Marketplace för kontot: "${restriction[0]}"`, moderation: null };
    }
    const errs = await visibleFieldErrors(page, FB.marketplace.fieldError);
    if (errs.length) {
      observations.push(`Facebook kräver: ${errs.join(" | ")}`);
      logga("Facebook markerar fält som ofullständiga", "warning", { falt: errs });
    }
    logga("Vidare i formuläret (Nästa)", "ok", { url: page.url() });
  }

  const publish = page.locator(FB.marketplace.publish).first();
  const audience = await atAudience();
  const publishVisible = audience && (await publish.count()) > 0 && (await publish.isVisible().catch(() => false));
  const publishDisabled = publishVisible ? (await publish.getAttribute("aria-disabled")) === "true" : null;
  observations.push(audience ? `Målgruppssidan nådd (${page.url().includes("step=audience") ? "step=audience" : "Nästa borta"}).` : "Målgruppssidan nåddes ALDRIG — Nästa syns fortfarande.");
  observations.push(publishVisible ? `Publicera-knappen syns${publishDisabled ? " men är avstängd (något saknas)" : " och är aktiv"}.` : "Ingen Publicera-knapp (aria-label) på målgruppssidan.");
  const shot = await screenshot(page, dryRun ? "mp_torrkorning_fore_publicera" : "mp_fore_publicera");

  if (!publishVisible) {
    logga(audience ? "Publicera-knappen hittades inte" : "Målgruppssidan nåddes inte — Publicera trycks inte", "error", { url: page.url() });
    await leaveWithoutPublishing(page, logga);
    return failed(audience ? "Kom fram till målgruppssidan men hittade ingen Publicera-knapp." : "Formuläret släppte inte vidare till målgruppssidan (Nästa kvar) — ingenting trycktes.", observations, shot, categoryPicked, conditionPicked);
  }
  if (publishDisabled) {
    logga("Publicera är avstängd — Facebook saknar något", "error", { observationer: observations });
    return failed(`Publicera-knappen är avstängd. ${observations.filter((o) => /kräver|markerar/.test(o)).join(" ") || "Något obligatoriskt fält är inte ifyllt."}`, observations, shot, categoryPicked, conditionPicked);
  }

  if (dryRun) {
    logga("TORRKÖRNING KLAR — Publicera trycktes inte", "ok", { url: page.url() });
    await leaveWithoutPublishing(page, logga);
    return { status: "WOULD_PUBLISH", url: null, listingId: null, screenshot: shot, observations, categoryPicked, conditionPicked, failureReason: null, moderation: null };
  }

  // ── Sista knappen — fasen först, klicket sedan ─────────────────────────
  await input.onPhase("publish_clicked");
  await publish.click({ timeout: 8000 });
  logga("Publicera tryckt", "running", {});
  await page.waitForTimeout(4000);
  await assertNoInterrupt(page, "Marketplace (efter Publicera)");
  // Granskningsläget läses HÄR, på sidan Facebook visar direkt efter klicket — innan vi navigerar bort.
  const moderation: ModerationState | null = FACEBOOK_REVIEW.test(await bodyText(page)) ? "FACEBOOK_REVIEW" : null;
  if (moderation) observations.push("Facebook: annonsen granskas innan andra ser den (standardgranskning).");

  const url = await resolveListingUrl(page, copy.title);
  const after = await screenshot(page, "mp_efter_publicera");
  if (url) {
    await input.onPhase("verified");
    logga("Annonsen är publicerad", "ok", { url });
    return { status: "PUBLISHED", url, listingId: listingIdFromUrl(url), screenshot: after, observations, categoryPicked, conditionPicked, failureReason: null, moderation };
  }
  // Knappen är tryckt men adressen okänd: INTE ett fel som får göras om. Kön läser fasen.
  logga("Publicera tryckt men annonsadressen gick inte att läsa", "warning", { url: page.url() });
  return { status: "PUBLISHED", url: null, listingId: null, screenshot: after, observations, categoryPicked, conditionPicked, failureReason: "Publicera trycktes men adressen till annonsen gick inte att läsa — kontrollera Marketplace för hand.", moderation };
}

function failed(reason: string, observations: string[], shot: string | null, categoryPicked: string | null, conditionPicked: string | null): MarketplaceRunResult {
  return { status: "FAILED", url: null, listingId: null, screenshot: shot, observations, categoryPicked, conditionPicked, failureReason: reason, moderation: null };
}

/**
 * Kategorin: öppnar dialogen och klickar knappen vars text BÖRJAR med etiketten ("Möbler", inte
 * "MöblerLeverans är tillgängligt" för någon annan). Läser tillbaka kombinationsrutans text.
 */
async function pickCategory(page: Page, candidates: string[]): Promise<string | null> {
  const opener = page.locator(FB.marketplace.category).first();
  if ((await opener.count()) === 0) return null;
  for (const label of candidates) {
    try {
      await opener.click({ timeout: 4000 });
      await page.waitForTimeout(1200);
      const option = page.locator(FB.marketplace.categoryOption).filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}`, "i") }).first();
      if ((await option.count()) === 0 || !(await option.isVisible().catch(() => false))) {
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(400);
        continue;
      }
      await option.click({ timeout: 3000 });
      await page.waitForTimeout(800);
      const shown = (await opener.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (shown.toLowerCase().includes(label.toLowerCase())) return label;
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  return null;
}

/** Lämnar formuläret utan att publicera. Bekräftar "Lämna?"-dialogen om Facebook visar en. */
async function leaveWithoutPublishing(page: Page, logga: Logga): Promise<void> {
  await page.goto(`${facebookBaseUrl()}/marketplace/`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
  const leave = page.locator(FB.marketplace.leaveConfirm).first();
  if (await leave.isVisible({ timeout: 2500 }).catch(() => false)) {
    await leave.click().catch(() => undefined);
    logga("Lämnade formuläret utan att publicera (utkastet kastat)", "ok", {});
  } else {
    logga("Lämnade formuläret utan att publicera", "ok", {});
  }
}

/**
 * Adressen till den färdiga annonsen, om Facebook visar den.
 *
 * BÅDA MÖNSTREN SÖKS (LÄRDOM 2026-09-26, se listingIdFromUrl): en annons som Facebook granskar har
 * ingen /marketplace/item/<id>/-länk än — varken på sidan direkt efter Publicera eller i "Dina
 * inlägg" — utan länkas som /commerce/listing/<id>/ tills granskningen släpper. Samma fynd gjordes
 * samma dag för säljinlägget i grupper (publisher.ts, findInFeed) men portades aldrig hit.
 */
async function resolveListingUrl(page: Page, title: string): Promise<string | null> {
  const itemOrCommerce = `${FB.marketplace.itemLink}, ${FB.marketplace.commerceLink}`;
  const now = page.url();
  if (/\/(?:marketplace\/item|commerce\/listing)\/\d+/.test(now)) return now.split("?")[0];
  const link = page.locator(itemOrCommerce).first();
  if ((await link.count()) > 0) {
    const href = await link.getAttribute("href").catch(() => null);
    if (href) return new URL(href, facebookBaseUrl()).toString().split("?")[0];
  }
  // Dina annonser: den nyaste överst.
  await page.goto(`${facebookBaseUrl()}/marketplace/you/selling`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  const first = page.locator(itemOrCommerce).first();
  if ((await first.count()) > 0) {
    const href = await first.getAttribute("href").catch(() => null);
    if (href) return new URL(href, facebookBaseUrl()).toString().split("?")[0];
  }
  return await openOwnListingCard(page, title);
}

/**
 * Korten i "Dina inlägg" bär INGEN länk (läst 2026-10-05): de är klickbara rutor, och adressen syns
 * först i rutan som öppnas när rubriken klickas. Alla tre Marketplace-annonser servern publicerat
 * hamnade därför i "kontrollera för hand" fast de låg ute. Klicket är navigering, ingen skrivning.
 *
 * DET NYASTE KORTET med vår rubrik OCH "Publicerad på Marketplace": samma möbel har också kort per
 * grupp ("Publicerad i <grupp>"), och en äldre annons med samma rubrik ligger längre ner.
 */
async function openOwnListingCard(page: Page, title: string): Promise<string | null> {
  const index = await page
    .locator("div[role='main'] span[dir='auto']")
    // Ingen namngiven hjälpfunktion här inne: tsx lindar den i __name(), som inte finns i webbläsaren,
    // och då kastar hela funktionen — tyst, via catch nedan.
    .evaluateAll((spans: Element[], want: string) => {
      for (let i = 0; i < spans.length; i++) {
        if ((spans[i].textContent ?? "").replace(/\s+/g, " ").trim() !== want) continue;
        // Upp till kortet: närmaste förälder som också bär statusraden.
        let el: Element | null = spans[i];
        while (el && !/Publicerad/.test(el.textContent ?? "")) el = el.parentElement;
        if (el && /Publicerad på Marketplace/.test(el.textContent ?? "")) return i;
      }
      return -1;
    }, title.replace(/\s+/g, " ").trim())
    .catch(() => -1);
  if (index < 0) return null;
  await page.locator("div[role='main'] span[dir='auto']").nth(index).click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  const link = page.locator(`[role="dialog"] ${FB.marketplace.itemLink}, [role="dialog"] ${FB.marketplace.commerceLink}`).last();
  const href = (await link.count()) > 0 ? await link.getAttribute("href").catch(() => null) : null;
  await page.keyboard.press("Escape").catch(() => undefined);
  return href ? new URL(href, facebookBaseUrl()).toString().split("?")[0] : null;
}

/** Facebooks id ur en annons- eller säljinläggsadress. Delad med publisher.ts (grupp-säljinlägget). */
export function listingIdFromUrl(url: string | null): string | null {
  return url?.match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/)?.[1] ?? null;
}
