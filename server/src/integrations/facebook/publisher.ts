/**
 * Ett Loopa-inlägg i en Facebook-grupp — genom den skrivruta gruppen faktiskt erbjuder.
 *
 * TVÅ SORTERS GRUPPER. Diskussionsgrupper har textrutan "Skriv något …": där blir annonsen ett
 * textinlägg med bilder och Loopa-länken. Köp/sälj-grupper har i stället "Sälj något": Facebooks eget
 * annonsformulär i en dialog (VERIFIERAT 2026-09-26) — samma fält som Marketplace (foton, titel,
 * pris, skick, beskrivning, plats) och sist ett steg "Dela på fler platser" där gruppen är förvald,
 * Marketplace kan läggas till och upp till tjugo andra grupper kan bockas i. Föraren ser till att
 * BARA målgruppen är vald: Marketplace har sin egen kö, och en publicering i en grupp får aldrig tyst
 * bli tjugo.
 *
 * Samma regler som Marketplace-föraren: torrkörning som förval, fasen skriven till disk före
 * Publicera, verifiering efteråt, och valutavakten — ett pris i dollar publiceras aldrig.
 */

import { existsSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { fillField, fillLocation, NON_SEK, pickCondition, priceShown, readToggle, visibleFieldErrors } from "./forms.js";
import { groupListingCopy, groupPostCopy, marketplaceConditionCandidates, type FacebookListing } from "./mapping.js";
import { FB, TEXT } from "./selectors.js";
import { assertNoInterrupt, bodyText, goto, screenshot } from "./session.js";
import { felText, type Logga } from "./steps.js";
import { FACEBOOK_REVIEW } from "./marketplace.js";
import type { ComposerKind, FacebookGroup, ModerationState, PublicationPhase } from "./types.js";

export interface GroupPostInput {
  group: FacebookGroup;
  listing: FacebookListing;
  dryRun: boolean;
  onPhase: (phase: PublicationPhase) => Promise<void>;
}

export interface GroupPostResult {
  status: "WOULD_PUBLISH" | "PUBLISHED" | "PENDING_ADMIN_APPROVAL" | "FAILED";
  /** Vilken ruta som användes. Null när ingen hittades. */
  composer: ComposerKind | null;
  postUrl: string | null;
  /** Marketplace-annonsens id när säljinlägget fick ett (/marketplace/item/<id>/). */
  facebookListingId: string | null;
  screenshot: string | null;
  observations: string[];
  failureReason: string | null;
  /** Facebooks granskning eller gruppadministratörernas godkännande, när det gick att läsa efter Publicera. */
  moderation: ModerationState | null;
}

/** Väljer väg efter vad gruppsidan visar — lagrets composerKind är en förväntan, sidan är sanningen. */
export async function driveGroupPost(page: Page, input: GroupPostInput, logga: Logga): Promise<GroupPostResult> {
  const { group } = input;
  const observations: string[] = [];

  await goto(page, group.canonicalUrl, `grupp ${group.id}`);
  const header = await page.locator(FB.main).first().innerText().catch(() => "");
  if (!TEXT.member.test(header)) {
    logga("Kontot är inte medlem i gruppen", "error", {});
    return failed(null, "Kontot är inte (längre) medlem i gruppen — ingen skrivruta att använda.", observations, await screenshot(page, `gp_ej_medlem_${group.id}`));
  }

  if ((await page.locator(FB.composerPost).count()) > 0) return driveTextPost(page, input, logga, observations);
  if ((await page.locator(FB.composerListing).count()) > 0) return driveGroupListing(page, input, logga, observations);

  logga("Ingen skrivruta hittades", "error", {});
  return failed(null, "Ingen skrivruta hittades på gruppsidan — varken Skriv något eller Sälj något.", observations, await screenshot(page, `gp_ingen_ruta_${group.id}`));
}

// ---------------------------------------------------------------------------
// Textinlägget ("Skriv något …")
// ---------------------------------------------------------------------------

async function driveTextPost(page: Page, input: GroupPostInput, logga: Logga, observations: string[]): Promise<GroupPostResult> {
  const { group, listing, dryRun } = input;
  const text = groupPostCopy(listing);

  await page.locator(FB.composerPost).first().click();
  const editor = page.locator(FB.composerEditor).first();
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  await assertNoInterrupt(page, `skrivrutan ${group.id}`);
  logga("Skrivrutan öppen", "ok", {});

  await editor.click();
  await page.keyboard.insertText(text);
  logga("Texten ifylld", "ok", { tecken: text.length });

  // Hur renderar Facebook adressen? Skrivs ner, inte antas.
  await page.waitForTimeout(2500);
  const previewCount = await page.locator(FB.composerLinkPreview).count().catch(() => 0);
  observations.push(previewCount > 0 ? "Loopa-adressen blev en länkförhandsvisning i skrivrutan." : "Ingen länkförhandsvisning syntes i skrivrutan — adressen står som text (Facebook länkar den normalt i det publicerade inlägget).");

  const files = listing.imagePaths.filter((p) => existsSync(p));
  if (files.length) {
    try {
      const photoBtn = page.locator(FB.composerPhotoButton).first();
      if ((await photoBtn.count()) > 0 && (await page.locator(FB.composerFileInput).count()) === 0) await photoBtn.click();
      const fileInput = page.locator(FB.composerFileInput).first();
      await fileInput.waitFor({ state: "attached", timeout: 10_000 });
      await fileInput.setInputFiles(files.slice(0, 10));
      await page.locator(FB.mediaPreview).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
      logga(`${Math.min(files.length, 10)} bilder uppladdade`, "ok", {});
    } catch (err) {
      logga("Bilderna gick inte att ladda upp — inlägget hade gått ut utan bilder", "warning", { fel: felText(err) });
      observations.push(`Bilduppladdningen föll: ${felText(err)}`);
    }
  } else {
    logga("Inga bildfiler på disk", "warning", {});
  }

  const publish = page.locator(FB.composerPublish).first();
  await publish.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  const publishVisible = (await publish.count()) > 0;
  const shot = await screenshot(page, dryRun ? `gp_torrkorning_${group.id}` : `gp_fore_publicera_${group.id}`);
  observations.push(publishVisible ? "Publicera-knappen syns i skrivrutan." : "Ingen Publicera-knapp hittades i skrivrutan.");

  if (dryRun) {
    logga("TORRKÖRNING KLAR — Publicera trycktes inte", "ok", {});
    await closeComposer(page);
    const stillOpen = (await page.locator(FB.composerEditor).count()) > 0;
    if (stillOpen) observations.push("Skrivrutan kunde inte stängas helt efter torrkörningen (inget publicerades).");
    logga("Skrivrutan stängd, utkastet kastat", "ok", {});
    return { status: "WOULD_PUBLISH", composer: "post", postUrl: null, facebookListingId: null, screenshot: shot, observations, failureReason: null, moderation: null };
  }

  if (!publishVisible) return failed("post", "Ingen Publicera-knapp i skrivrutan.", observations, shot);
  for (let i = 0; i < 20 && (await publish.getAttribute("aria-disabled")) === "true"; i++) await page.waitForTimeout(500);

  await input.onPhase("publish_clicked");
  await publish.click();
  logga("Publicera tryckt", "running", {});
  await page.locator(FB.composerEditor).first().waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await assertNoInterrupt(page, `grupp ${group.id} (efter Publicera)`);

  const body = await bodyText(page);
  if (TEXT.postPendingApproval.test(body)) {
    await input.onPhase("verified");
    logga("Inlägget väntar på administratörens godkännande", "ok", {});
    return { status: "PENDING_ADMIN_APPROVAL", composer: "post", postUrl: null, facebookListingId: null, screenshot: await screenshot(page, `gp_vantar_${group.id}`), observations, failureReason: null, moderation: "ADMIN_APPROVAL" };
  }
  const probe = text.split("\n")[0]?.slice(0, 40) ?? "";
  const found = await findInFeed(page, probe);
  if (found.visible) {
    await input.onPhase("verified");
    logga("Inlägget syns i gruppflödet", "ok", { url: found.url });
    return { status: "PUBLISHED", composer: "post", postUrl: found.url, facebookListingId: null, screenshot: await screenshot(page, `gp_publicerad_${group.id}`), observations, failureReason: null, moderation: null };
  }
  logga("Publicera tryckt men inlägget syns inte i flödet", "warning", {});
  return { status: "PUBLISHED", composer: "post", postUrl: null, facebookListingId: null, screenshot: await screenshot(page, `gp_overifierad_${group.id}`), observations, failureReason: "Publicera trycktes men inlägget gick inte att verifiera i flödet — kontrollera gruppen för hand.", moderation: null };
}

// ---------------------------------------------------------------------------
// Säljinlägget ("Sälj något" -> "Vara till salu")
// ---------------------------------------------------------------------------

/**
 * Annonsformuläret i gruppen. Dialogen byts ut mellan stegen (typval -> formulär -> Dela på fler
 * platser), så `dialog` slås upp på nytt vid varje användning — locatorn är lat.
 */
async function driveGroupListing(page: Page, input: GroupPostInput, logga: Logga, observations: string[]): Promise<GroupPostResult> {
  const { group, listing, dryRun } = input;
  const copy = groupListingCopy(listing);
  const L = FB.groupListing;
  const dialog = () => page.locator(FB.dialog).last();

  await page.locator(FB.composerListing).first().click();
  const chooser = dialog().getByText(TEXT.listingTypeChooser).first();
  const titleField = () => dialog().getByLabel(/^Titel$|^Title$/).first();
  await Promise.race([chooser.waitFor({ state: "visible", timeout: 15_000 }), titleField().waitFor({ state: "visible", timeout: 15_000 })]).catch(() => undefined);
  await assertNoInterrupt(page, `Sälj något ${group.id}`);
  if (await chooser.isVisible().catch(() => false)) {
    const typeItem = dialog().locator(L.typeItem).first();
    if ((await typeItem.count()) === 0) {
      logga("Typvalet saknar Vara till salu", "error", {});
      return failed("listing", 'Sälj något-dialogen erbjöd inget "Vara till salu".', observations, await screenshot(page, `gl_typval_${group.id}`));
    }
    await typeItem.click();
    logga("Säljinlägg: Vara till salu valt", "ok", {});
  }
  await titleField().waitFor({ state: "visible", timeout: 20_000 });
  await assertNoInterrupt(page, `Vara till salu ${group.id}`);
  logga("Annonsformuläret öppet i gruppen", "ok", {});

  // ── Bilder ─────────────────────────────────────────────────────────────
  const files = listing.imagePaths.filter((p) => existsSync(p));
  if (files.length === 0) {
    logga("Inga bildfiler på disk", "error", {});
    return await abort(page, "listing", "Ingen av bilderna finns på disk. Säljinlägget kräver minst en bild.", observations, await screenshot(page, `gl_bilder_${group.id}`), logga);
  }
  try {
    const fileInput = dialog().locator(L.fileInput).first();
    await fileInput.waitFor({ state: "attached", timeout: 10_000 });
    await fileInput.setInputFiles(files.slice(0, 10), { timeout: 30_000 });
    const attached = dialog().getByText(TEXT.photoAttached).first();
    await Promise.race([attached.waitFor({ state: "visible", timeout: 25_000 }), dialog().locator(L.removePhoto).first().waitFor({ state: "visible", timeout: 25_000 })]).catch(() => undefined);
    const bekraftat = (await attached.count()) > 0 || (await dialog().locator(L.removePhoto).count()) > 0;
    logga(`${Math.min(files.length, 10)} bilder uppladdade${bekraftat ? "" : " (Facebook bekräftade inte bifogningen)"}`, bekraftat ? "ok" : "warning", {});
  } catch (err) {
    logga("Bilderna gick inte att ladda upp", "error", { fel: felText(err) });
    return await abort(page, "listing", `Bilderna gick inte att ladda upp: ${felText(err)}`, observations, await screenshot(page, `gl_bilder_${group.id}`), logga);
  }

  // ── Rubrik och pris, med valutavakten ──────────────────────────────────
  if (!(await fillField(dialog(), [/^Titel$/i, /^Title$/i], L.title, copy.title))) {
    logga("Rubrikfältet hittades inte", "error", {});
    return await abort(page, "listing", "Rubrikfältet hittades inte i säljinlägget.", observations, await screenshot(page, `gl_rubrik_${group.id}`), logga);
  }
  logga(`Rubrik: ${copy.title}`, "ok", {});
  if (!(await fillField(dialog(), [/^Pris$/i, /^Price$/i], L.price, String(listing.price)))) {
    logga("Prisfältet hittades inte", "error", {});
    return await abort(page, "listing", "Prisfältet hittades inte i säljinlägget.", observations, await screenshot(page, `gl_pris_${group.id}`), logga);
  }
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(500);
  const prisVisat = (await priceShown(dialog(), L.price)) ?? "";
  observations.push(`Prisfältet visar "${prisVisat}".`);
  if (NON_SEK.test(prisVisat)) {
    logga(`Prisfältet visar fel valuta: ${prisVisat}`, "error", {});
    return await abort(page, "listing", `Kontots valuta är inte svenska kronor — prisfältet visar "${prisVisat}". Säljinlägget hade fått fel pris.`, observations, await screenshot(page, `gl_valuta_${group.id}`), logga);
  }
  logga(`Pris: ${listing.price} kr (fältet visar ${prisVisat})`, "ok", {});

  // ── Skick ──────────────────────────────────────────────────────────────
  const conditions = marketplaceConditionCandidates(listing.grade);
  let conditionPicked: string | null = null;
  if (conditions.length) {
    conditionPicked = await pickCondition(page, dialog(), L.condition, L.conditionOption, conditions);
    if (conditionPicked) logga(`Skick: ${conditionPicked}`, "ok", { loopaBetyg: listing.grade });
    else logga("Skicket gick inte att sätta", "warning", { forsokte: conditions });
  } else {
    logga("Inget skickbetyg — fältet lämnas", "warning", {});
  }

  // ── Mer information: beskrivning och plats ─────────────────────────────
  const more = dialog().locator(L.moreInfo).first();
  if ((await more.count()) > 0) {
    await more.scrollIntoViewIfNeeded().catch(() => undefined);
    await more.click({ timeout: 5000 }).catch(() => undefined);
    await dialog().locator(L.description).first().waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
  }
  if (!(await fillField(dialog(), [/^Beskrivning$/i, /^Description$/i], L.description, copy.description))) {
    logga("Beskrivningsfältet hittades inte", "error", {});
    return await abort(page, "listing", "Beskrivningsfältet hittades inte i säljinlägget.", observations, await screenshot(page, `gl_beskrivning_${group.id}`), logga);
  }
  logga("Beskrivningen ifylld", "ok", { tecken: copy.description.length });
  await page.waitForTimeout(1200);
  const linkAnchors = await dialog().locator(`a[href*="${new URL(listing.canonicalUrl).hostname}"]`).count().catch(() => 0);
  observations.push(linkAnchors > 0 ? `Loopa-adressen renderas som länk i formuläret (${linkAnchors} ankare).` : "Loopa-adressen står som ren text i beskrivningsfältet.");

  const locationSet = await fillLocation(page, dialog(), L.location, L.locationOption, listing.location);
  logga(locationSet ? `Plats: ${locationSet}` : "Platsfältet hittades inte — kontots förvalda plats gäller", locationSet ? "ok" : "warning", {});

  const errorsBefore = await visibleFieldErrors(dialog(), FB.marketplace.fieldError);
  if (errorsBefore.length) observations.push(`Facebook markerar före Nästa: ${errorsBefore.join(" | ")}`);

  // ── Nästa: "Dela på fler platser" ──────────────────────────────────────
  const next = dialog().locator(L.next).first();
  if ((await next.count()) === 0) {
    return await abort(page, "listing", "Ingen Nästa-knapp i säljinlägget.", observations, await screenshot(page, `gl_nasta_${group.id}`), logga);
  }
  await next.click({ timeout: 5000 });
  const share = dialog().getByText(TEXT.shareMorePlaces).first();
  const reached = await share.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
  await assertNoInterrupt(page, `Sälj något ${group.id} (efter Nästa)`);
  if (!reached) {
    const errs = await visibleFieldErrors(dialog(), FB.marketplace.fieldError);
    if (errs.length) observations.push(`Facebook kräver: ${errs.join(" | ")}`);
    logga("Kom inte till Dela på fler platser", "error", { falt: errs });
    return await abort(page, "listing", `Formuläret släppte inte vidare efter Nästa. ${errs.join(" | ") || "Något obligatoriskt saknas."}`, observations, await screenshot(page, `gl_stopp_${group.id}`), logga);
  }
  logga("Dela på fler platser", "ok", {});

  const audience = await settleAudience(page, dialog(), group, logga);
  observations.push(...audience.observations);
  if (!audience.ok) {
    return await abort(page, "listing", audience.reason ?? "Målgruppen gick inte att begränsa till gruppen.", observations, await screenshot(page, `gl_malgrupp_${group.id}`), logga);
  }

  const publish = dialog().locator(L.publish).first();
  const publishVisible = (await publish.count()) > 0 && (await publish.isVisible().catch(() => false));
  const publishDisabled = publishVisible ? (await publish.getAttribute("aria-disabled")) === "true" : null;
  observations.push(publishVisible ? `Publicera-knappen syns${publishDisabled ? " men är avstängd" : " och är aktiv"}.` : "Ingen Publicera-knapp hittades.");
  const shot = await screenshot(page, dryRun ? `gl_torrkorning_${group.id}` : `gl_fore_publicera_${group.id}`);

  if (dryRun) {
    logga("TORRKÖRNING KLAR — Publicera trycktes inte", "ok", {});
    await closeListingDialog(page);
    logga("Dialogen stängd, utkastet kastat", "ok", {});
    return { status: "WOULD_PUBLISH", composer: "listing", postUrl: null, facebookListingId: null, screenshot: shot, observations, failureReason: null, moderation: null };
  }
  if (!publishVisible || publishDisabled) {
    return await abort(page, "listing", publishVisible ? "Publicera-knappen är avstängd — Facebook saknar något." : "Ingen Publicera-knapp i säljinlägget.", observations, shot, logga);
  }

  // ── Sista knappen — fasen först, klicket sedan ─────────────────────────
  await input.onPhase("publish_clicked");
  await publish.click({ timeout: 8000 });
  logga("Publicera tryckt", "running", {});
  await share.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  await assertNoInterrupt(page, `grupp ${group.id} (efter Publicera)`);

  const body = await bodyText(page);
  if (TEXT.postPendingApproval.test(body)) {
    await input.onPhase("verified");
    logga("Säljinlägget väntar på administratörens godkännande", "ok", {});
    return { status: "PENDING_ADMIN_APPROVAL", composer: "listing", postUrl: null, facebookListingId: null, screenshot: await screenshot(page, `gl_vantar_${group.id}`), observations, failureReason: null, moderation: "ADMIN_APPROVAL" };
  }
  // "Säljinlägget granskas" (VERIFIERAT 2026-09-26): Facebooks standardgranskning — inlägget finns, men andra ser det först när den släppt.
  const moderation: ModerationState | null = FACEBOOK_REVIEW.test(body) ? "FACEBOOK_REVIEW" : null;
  if (moderation) observations.push("Facebook: säljinlägget granskas innan andra i gruppen ser det (standardgranskning).");
  for (let i = 0; i < 3; i++) {
    const found = await findInFeed(page, copy.title.slice(0, 40));
    if (found.visible) {
      await input.onPhase("verified");
      logga("Säljinlägget syns i gruppen", "ok", { url: found.url });
      return { status: "PUBLISHED", composer: "listing", postUrl: found.url, facebookListingId: listingIdFromUrl(found.url), screenshot: await screenshot(page, `gl_publicerad_${group.id}`), observations, failureReason: null, moderation };
    }
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(3000);
  }
  logga("Publicera tryckt men säljinlägget syns inte i gruppen", "warning", {});
  return { status: "PUBLISHED", composer: "listing", postUrl: null, facebookListingId: null, screenshot: await screenshot(page, `gl_overifierad_${group.id}`), observations, failureReason: "Publicera trycktes men säljinlägget gick inte att verifiera i gruppen — kontrollera gruppen för hand.", moderation };
}

/**
 * Steget "Dela på fler platser": målgruppen ska vara ibockad, ingen annan grupp, och Marketplace av.
 * Rör bara det som avviker. Kan något inte ställas rätt publiceras ingenting.
 */
async function settleAudience(page: Page, dialog: Locator, group: FacebookGroup, logga: Logga): Promise<{ ok: boolean; reason: string | null; observations: string[] }> {
  const observations: string[] = [];
  const L = FB.groupListing;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zåäö0-9]+/g, " ").trim();
  const wanted = norm(group.name);

  const rows = dialog.locator(L.audienceGroupCheckbox).filter({ hasText: TEXT.memberCountRow });
  const n = await rows.count();
  let targetSeen = false;
  const extra: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const name = norm(text.replace(TEXT.memberCountRow, "").trim());
    const checked = (await row.getAttribute("aria-checked")) === "true";
    const isTarget = name === wanted || name.startsWith(wanted) || wanted.startsWith(name);
    if (isTarget && !targetSeen) {
      targetSeen = true;
      if (!checked) {
        await row.click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        if ((await row.getAttribute("aria-checked")) !== "true") return { ok: false, reason: `Målgruppen "${group.name}" gick inte att bocka i.`, observations };
        observations.push("Målgruppen bockades i för hand (den var inte förvald).");
      } else {
        observations.push("Målgruppen är förvald i Dela på fler platser.");
      }
    } else if (checked) {
      await row.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      if ((await row.getAttribute("aria-checked")) === "true") return { ok: false, reason: `En annan grupp ("${text.slice(0, 60)}") går inte att bocka ur — säljinlägget hade gått till fler grupper än den beställda.`, observations };
      extra.push(text.slice(0, 60));
    }
  }
  if (!targetSeen) return { ok: false, reason: `Målgruppen "${group.name}" syns inte i Dela på fler platser (${n} grupper listade).`, observations };
  if (extra.length) observations.push(`Bockade ur ${extra.length} förvalda grupper som inte var beställda: ${extra.join("; ")}.`);
  observations.push(`${n} grupper listade i Dela på fler platser; bara målgruppen är vald.`);

  // Marketplace-brytaren. Marketplace har sin egen kö och sitt eget skyddsräcke.
  const mp = dialog.locator(L.marketplaceRow).first();
  if ((await mp.count()) === 0) {
    observations.push("Ingen Marketplace-rad i Dela på fler platser.");
  } else {
    /**
     * VERIFIERAT 2026-09-26: Marketplace-raden är en knapp med en ikryssningsikon (SVG), utan
     * aria-checked. När Marketplace slås PÅ dyker en role=switch upp i dialogen (Marketplace-
     * alternativ); när det är av finns ingen switch. Det är den signalen som läses, med en riktig
     * brytare/kryssruta som förstahandsval om Facebook någon gång sätter en.
     */
    const marketplaceOn = async () => (await readToggle(mp)) ?? ((await dialog.locator(L.marketplaceSwitch).count()) > 0);
    if (await marketplaceOn()) {
      await mp.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      if (await marketplaceOn()) return { ok: false, reason: "Marketplace-brytaren i säljinlägget går inte att stänga av — annonsen hade också hamnat på Marketplace utanför Marketplace-kön.", observations };
      observations.push("Marketplace var påslaget i säljinlägget och stängdes av.");
    } else {
      observations.push("Marketplace är av i säljinlägget (ingen Marketplace-brytare aktiv i dialogen).");
    }
  }
  logga("Målgruppen begränsad till gruppen, Marketplace av", "ok", {});
  return { ok: true, reason: null, observations };
}

/** Efter ett fel i dialogen: stäng och kasta, så nästa körning inte möter ett halvfyllt utkast. */
async function abort(page: Page, composer: ComposerKind, reason: string, observations: string[], shot: string | null, logga: Logga): Promise<GroupPostResult> {
  await closeListingDialog(page).catch(() => undefined);
  logga("Dialogen stängd utan att publicera", "ok", {});
  return failed(composer, reason, observations, shot);
}

/**
 * Stänger säljinläggets dialog och bekräftar "Kasta"/"Ta bort" om Facebook frågar (VERIFIERAT
 * 2026-09-26: Stäng stänger direkt utan fråga; Messenger-panelen räknas inte som en dialog här).
 */
export async function closeListingDialog(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const dialog = page.locator(FB.dialog).last();
    if ((await page.locator(FB.dialog).count()) === 0) return;
    const close = dialog.locator('[aria-label="Stäng"], [aria-label="Close"]').last();
    if ((await close.count()) > 0) await close.click({ timeout: 3000 }).catch(() => undefined);
    else await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(1000);
    const confirm = page.locator(FB.dialog).last().locator('[role="button"]').filter({ hasText: /^(Ta bort|Kasta|Lämna|Discard|Leave)/ }).first();
    if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

/**
 * Ett inlägg i flödet vars text börjar som vårt, och dess adress: permalänken för ett textinlägg,
 * annars säljinläggets kort (/commerce/listing/<id>/ — VERIFIERAT 2026-09-26; ett säljinlägg har
 * ingen /posts/-länk medan det granskas) eller en Marketplace-annons (/marketplace/item/<id>/).
 */
async function findInFeed(page: Page, probe: string): Promise<{ visible: boolean; url: string | null }> {
  if (!probe) return { visible: false, url: null };
  const own = page.locator(FB.feedArticle).filter({ hasText: probe }).first();
  const visible = await own.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
  if (!visible) return { visible: false, url: null };
  for (const selector of [FB.postLink, FB.groupListing.commerceLink, FB.groupListing.itemLink]) {
    const href = await own.locator(selector).first().getAttribute("href").catch(() => null);
    if (href) return { visible: true, url: new URL(href, page.url()).toString().split("?")[0] };
  }
  return { visible: true, url: null };
}

/** Facebooks id ur en annons- eller säljinläggsadress. */
export function listingIdFromUrl(url: string | null): string | null {
  return url?.match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/)?.[1] ?? null;
}

function failed(composer: ComposerKind | null, reason: string, observations: string[], shot: string | null): GroupPostResult {
  return { status: "FAILED", composer, postUrl: null, facebookListingId: null, screenshot: shot, observations, failureReason: reason, moderation: null };
}

/** Stänger textskrivrutan utan att publicera och bekräftar "Ta bort utkast" om Facebook frågar. */
export async function closeComposer(page: Page): Promise<void> {
  const close = page.locator(FB.composerClose).first();
  if ((await close.count()) > 0) await close.click().catch(() => undefined);
  else await page.keyboard.press("Escape").catch(() => undefined);
  const discard = page.locator(FB.discardConfirm).first();
  await discard.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
  if ((await discard.count()) > 0) await discard.click().catch(() => undefined);
  await page.locator(FB.composerEditor).first().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}
