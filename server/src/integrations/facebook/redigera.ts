/**
 * Redigering av det som redan ligger uppe på Facebook: Marketplace-annonsen och gruppinläggen.
 *
 * När annonsen ändras — säljarens rättelse, adminens, eller en prissänkning — ska Facebook visa samma
 * sak. Det finns ingen väg att ta ner en annons automatiskt, så den ÄNDRAS PÅ PLATS, med samma texter
 * som publiceringen bygger (mapping.ts).
 *
 * TRE SLAGS INLÄGG, TVÅ VÄGAR:
 *   Marketplace-annonsen       → redigeringssidan /marketplace/edit/?listing_id=<id>: Titel, Pris,
 *                                Beskrivning (under "Mer information"). Samma fält och etiketter som
 *                                publiceringsformuläret (selectors.ts, VERIFIERAT 2026-09-25).
 *   Säljinlägg i en grupp      → ÄR en Marketplace-annons ("Sälj något" skapar en), och redigeras på
 *                                samma sida. Id:t står på posten, eller i dess /commerce/listing/-länk.
 *                                Delar inlägget id med Marketplace-annonsen ändras den bara en gång.
 *   Textinlägg i en grupp      → inläggets meny → "Redigera inlägg" → hela texten byts.
 *
 * SAMMA REGLER SOM PUBLICERINGEN:
 *  1. TORRKÖRNING ÄR FÖRVALET. Allt fylls i, en skärmbild tas, och Spara trycks inte — tills
 *     FACEBOOK_REDIGERA=1 är satt.
 *  2. VERIFIERA, ANTA INTE. Ingenting skrivs förrän sidan bevisat att den visar VÅR annons: formulärets
 *     rubrik ska vara den som publicerades (contentSnapshot) eller den nya, och textinlägget ska
 *     innehålla annonsens Loopa-länk.
 *  3. ÄNDRA BARA DET SOM ÄNDRATS. Publiceringen sparade vad som gick ut (contentSnapshot). Står det
 *     redan så rörs inlägget inte — en prissänkning ska inte skriva om gruppinlägg som redan är rätt.
 *     Efter en lyckad redigering skrivs den nya ögonblicksbilden.
 *  4. EN WEBBLÄSARE I TAGET. Körningen går genom withFacebookBrowser, samma kö som publiceringen, så
 *     de aldrig slåss om profilen.
 *
 * ANTAGET tills en torrkörning mot den riktiga ytan bekräftat det: redigeringssidans adress och
 * knappen "Uppdatera", samt inläggsmenyn ("Åtgärder för det här inlägget" → "Redigera inlägg").
 * Fälten själva är publiceringsformulärets, som är uppmätta.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { FacebookInterrupt } from "./checkpoint.js";
import { facebookEnabled, facebookScreenshotDir } from "./config.js";
import { fillField, NON_SEK, priceShown } from "./forms.js";
import { FB } from "./selectors.js";
import { fbUrl, goto, recordInterrupt, withFacebookBrowser } from "./session.js";
import {
  facebookListingFor,
  groupListingCopy,
  groupListingSnapshot,
  groupPostCopy,
  groupSnapshot,
  marketplaceCopy,
  marketplaceSnapshot,
  type FacebookListing,
} from "./mapping.js";
import { allGroupPublications, allMarketplace, updateGroupPublication, updateMarketplace } from "./store.js";
import type { KanalUtfall, Visning } from "../annonsUppdatering.js";
import type { ConditionJob } from "../../types.js";

/** Får roboten SPARA en redigering? Annars torrkörning. */
export function facebookRedigeringSkarp(): boolean {
  return process.env.FACEBOOK_REDIGERA?.trim() === "1";
}

const MARKA_ALLT = process.platform === "darwin" ? "Meta+A" : "Control+A";
const UPPDATERA =
  '[role="button"][aria-label="Uppdatera"], [role="button"][aria-label="Spara"], [role="button"][aria-label="Update"], [role="button"][aria-label="Save"]';
const SPARA_TEXT = /^(Spara|Uppdatera|Save|Update)$/i;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Samma annons? Rubriken jämförs på början — Facebook kan kapa en lång rubrik. */
export function rubrikenArVar(iFormularet: string, kandidater: Array<string | null | undefined>): boolean {
  const f = norm(iFormularet);
  if (!f) return false;
  return kandidater.some((k) => {
    const v = norm(k ?? "");
    if (!v) return false;
    const n = Math.min(25, f.length, v.length);
    return n >= 8 && f.slice(0, n) === v.slice(0, n);
  });
}

/** Marketplace-annonsens id ur en Facebook-adress: /marketplace/item/<id>/ eller /commerce/listing/<id>/. */
export function annonsIdUrAdress(url: string | null | undefined): string | null {
  const m = (url ?? "").match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/);
  return m ? m[1] : null;
}

async function skarmbild(page: Page, namn: string): Promise<string | null> {
  try {
    const fil = path.join(facebookScreenshotDir(), `${namn}-${Date.now()}.png`);
    mkdirSync(path.dirname(fil), { recursive: true });
    await page.screenshot({ path: fil, fullPage: false });
    return fil;
  } catch {
    return null;
  }
}

interface AnnonsInnehall {
  title: string;
  price: number;
  description: string;
}

/**
 * En Marketplace-annons (eller ett säljinlägg, som är en sådan) på redigeringssidan.
 * Rubrikvakt, sedan Titel, Pris och Beskrivning. Kastar med ett eget fel per steg.
 */
async function redigeraAnnons(
  page: Page,
  fbId: string,
  nytt: AnnonsInnehall,
  publiceradRubrik: string | null,
  skarp: boolean,
  vad: string,
  visning?: Visning,
): Promise<string> {
  await goto(page, fbUrl(`/marketplace/edit/?listing_id=${encodeURIComponent(fbId)}`), `${vad}: redigeringen`);
  await page.waitForTimeout(2000);

  const rubrikfalt = page.getByLabel(/^(Titel|Title)$/i).or(page.locator(FB.marketplace.title)).first();
  if (!(await rubrikfalt.isVisible({ timeout: 10_000 }).catch(() => false))) {
    throw new Error(`${vad}: redigeringsformuläret visades inte (inget Titel-fält på ${page.url()}). Ingenting ändrades.`);
  }
  const iFormularet = (await rubrikfalt.inputValue().catch(() => "")) ?? "";
  if (!rubrikenArVar(iFormularet, [publiceradRubrik, nytt.title])) {
    throw new Error(`${vad}: formuläret visar en annan annons ("${iFormularet}") än vår ("${publiceradRubrik ?? nytt.title}"). Ingenting ändrades.`);
  }
  await visning?.paus(`${vad}: redigeringen för "${iFormularet}" är öppen och rubrikvakten godkände den. Nästa: rubrik, pris och beskrivning.`, page);

  if (norm(iFormularet) !== norm(nytt.title)) {
    if (!(await fillField(page, [/^Titel$/i, /^Title$/i], FB.marketplace.title, nytt.title))) {
      throw new Error(`${vad}: rubriken gick inte att fylla i. Ingenting sparades.`);
    }
  }
  if (!(await fillField(page, [/^Pris$/i, /^Price$/i], FB.marketplace.price, String(nytt.price)))) {
    throw new Error(`${vad}: prisfältet hittades inte. Ingenting sparades.`);
  }
  const prisVisat = (await priceShown(page, FB.marketplace.price)) ?? "";
  if (NON_SEK.test(prisVisat)) throw new Error(`${vad}: prisfältet visar fel valuta ("${prisVisat}"). Ingenting sparades.`);

  // Beskrivningen ligger under den hopfällda "Mer information" (VERIFIERAT i publiceringsformuläret).
  const mer = page.getByRole("button", { name: FB.marketplace.moreInfo }).first();
  if ((await mer.count()) > 0 && (await mer.getAttribute("aria-expanded")) === "false") {
    await mer.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  if (!(await fillField(page, [/^Beskrivning$/i, /^Description$/i], FB.marketplace.description, nytt.description))) {
    throw new Error(`${vad}: beskrivningsfältet hittades inte. Ingenting sparades.`);
  }

  await visning?.paus(`${vad}: rubrik, pris (${nytt.price} kr) och beskrivning är ifyllda. Här hade roboten tryckt Uppdatera — det gör den inte nu.`, page);
  const bild = await skarmbild(page, "redigera-annons");
  if (!skarp) return `${vad}: ifyllt men inte sparat (torrkörning)${bild ? `, skärmbild ${bild}` : ""}.`;

  const knapp = page.locator(UPPDATERA).or(page.getByRole("button", { name: SPARA_TEXT })).last();
  if (!(await knapp.isVisible({ timeout: 6000 }).catch(() => false))) throw new Error(`${vad}: Uppdatera-knappen hittades inte. Ingenting sparades.`);
  await knapp.click();
  await page.waitForTimeout(4000);
  // Kvar på formuläret med ett fältfel = inte sparat.
  const fel = await page.locator(FB.marketplace.fieldError).first().innerText({ timeout: 1000 }).catch(() => "");
  if (fel && /\/marketplace\/edit/.test(page.url())) throw new Error(`${vad}: Facebook sparade inte: "${fel.slice(0, 160)}".`);
  return `${vad}: uppdaterad.`;
}

/** Ett textinlägg i en grupp: menyn → Redigera inlägg, med kontroll att texten är vår. */
async function redigeraTextinlagg(
  page: Page,
  postUrl: string,
  loopaLank: string,
  text: string,
  skarp: boolean,
  vad: string,
  visning?: Visning,
): Promise<string> {
  await goto(page, postUrl, `${vad}: inlägget`);
  await page.waitForTimeout(2000);

  const meny = page.getByRole("button", { name: /^(Åtgärder för det här inlägget|Actions for this post)$/i }).first();
  if (!(await meny.isVisible({ timeout: 8000 }).catch(() => false))) throw new Error(`${vad}: inläggets meny hittades inte. Ingenting ändrades.`);
  await meny.click();
  const redigera = page.getByRole("menuitem", { name: /^(Redigera inlägg|Edit post)$/i }).first();
  if (!(await redigera.isVisible({ timeout: 5000 }).catch(() => false))) throw new Error(`${vad}: "Redigera inlägg" fanns inte i menyn. Ingenting ändrades.`);
  await redigera.click();

  const editor = page.locator(FB.composerEditor).first();
  if (!(await editor.isVisible({ timeout: 8000 }).catch(() => false))) throw new Error(`${vad}: redigeringsrutan öppnades inte. Ingenting ändrades.`);
  const nuvarande = (await editor.innerText().catch(() => "")) ?? "";
  if (!nuvarande.includes(loopaLank)) {
    throw new Error(`${vad}: inläggets text innehåller inte annonsens Loopa-länk — det är inte vårt inlägg. Ingenting ändrades.`);
  }
  await visning?.paus(`${vad}: inlägget är öppet för redigering och innehåller annonsens Loopa-länk. Nästa: byta texten.`, page);

  await editor.click();
  await page.keyboard.press(MARKA_ALLT);
  await page.keyboard.insertText(text);

  await visning?.paus(`${vad}: den nya texten står i rutan. Här hade roboten tryckt Spara — nu stängs rutan med Escape.`, page);
  const bild = await skarmbild(page, "redigera-grupp");
  if (!skarp) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return `${vad}: ifyllt men inte sparat (torrkörning)${bild ? `, skärmbild ${bild}` : ""}.`;
  }
  const knapp = page.locator(FB.dialog).getByRole("button", { name: SPARA_TEXT }).last();
  if (!(await knapp.isVisible({ timeout: 6000 }).catch(() => false))) throw new Error(`${vad}: Spara-knappen hittades inte. Ingenting sparades.`);
  await knapp.click();
  await page.waitForTimeout(3500);
  return `${vad}: uppdaterat.`;
}

function sammaInnehall(a: AnnonsInnehall, b: { title?: string | null; price?: number | null; description?: string; text?: string } | null): boolean {
  if (!b) return false;
  return norm(a.title) === norm(b.title ?? "") && a.price === b.price && norm(a.description) === norm(b.description ?? b.text ?? "");
}

/** `opts.skarp`: se redigeraBlocketAnnons — adminens provkörning av en enda annons. */
export async function redigeraFacebook(job: ConditionJob, visning?: Visning, opts: { skarp?: boolean } = {}): Promise<KanalUtfall> {
  if (!facebookEnabled()) return { status: "ej_uppe", detalj: "Facebook är avstängt på servern." };
  const redo = await facebookListingFor(job);
  if (!redo.ok) return { status: "manuell", detalj: `Annonsen går inte att bygga för Facebook: ${redo.reason}` };
  const listing: FacebookListing = redo.listing;

  const mp = (await allMarketplace()).filter((p) => p.listingId === listing.loopaId && p.status === "PUBLISHED");
  const grupper = (await allGroupPublications()).filter((p) => p.listingId === listing.loopaId && p.status === "PUBLISHED");
  if (mp.length === 0 && grupper.length === 0) return { status: "ej_uppe", detalj: "Ligger inte uppe på Facebook." };

  const skarp = !visning && (opts.skarp ?? facebookRedigeringSkarp());
  const tillagg = visning?.tillagg ? `\n\n${visning.tillagg}` : "";
  const mpCopy = marketplaceCopy(listing);
  const mpNytt: AnnonsInnehall = { title: mpCopy.title, price: listing.price, description: mpCopy.description + tillagg };
  const glCopy = groupListingCopy(listing);
  const glNytt: AnnonsInnehall = { title: glCopy.title, price: listing.price, description: glCopy.description + tillagg };
  const textNytt = groupPostCopy(listing) + tillagg;

  // Vad som ska göras, och vad som redan stämmer. Inget öppnas i onödan.
  type Uppgift = { kor: (page: Page) => Promise<string>; klar: () => Promise<unknown> };
  const uppgifter: Uppgift[] = [];
  const rader: string[] = [];
  let manuella = 0;
  const redigeradeId = new Set<string>();

  for (const p of mp) {
    if (!visning && sammaInnehall(mpNytt, p.contentSnapshot)) {
      rader.push("Marketplace: redan aktuell.");
      continue;
    }
    const id = p.facebookListingId ?? annonsIdUrAdress(p.facebookUrl);
    if (!id) {
      manuella += 1;
      rader.push("Marketplace: annonsens Facebook-id saknas, så den går inte att hitta automatiskt — ändra för hand.");
      continue;
    }
    redigeradeId.add(id);
    uppgifter.push({
      kor: (page) => redigeraAnnons(page, id, mpNytt, p.contentSnapshot?.title ?? null, skarp, "Marketplace", visning),
      klar: () => updateMarketplace(p.listingId, (c) => ({ ...c, contentSnapshot: marketplaceSnapshot(listing, c.contentSnapshot?.category ?? "") })),
    });
  }

  for (const g of grupper) {
    const vad = `Grupp ${g.groupId}`;
    const arSaljinlagg = g.contentSnapshot?.kind === "listing" || g.composer === "listing";
    if (arSaljinlagg) {
      if (!visning && sammaInnehall(glNytt, g.contentSnapshot)) {
        rader.push(`${vad}: redan aktuellt.`);
        continue;
      }
      const id = g.facebookListingId ?? annonsIdUrAdress(g.facebookPostUrl);
      if (!id) {
        manuella += 1;
        rader.push(`${vad}: säljinläggets annons-id saknas — ändra för hand.`);
        continue;
      }
      const sparaBild = () => updateGroupPublication(g.listingId, g.groupId, (c) => ({ ...c, contentSnapshot: groupListingSnapshot(listing) }));
      if (redigeradeId.has(id)) {
        // Samma annons som en rad ovan: den ändringen gäller inlägget också.
        uppgifter.push({ kor: async () => `${vad}: samma annons som ovan, ändras där.`, klar: sparaBild });
        continue;
      }
      redigeradeId.add(id);
      uppgifter.push({ kor: (page) => redigeraAnnons(page, id, glNytt, g.contentSnapshot?.title ?? null, skarp, vad, visning), klar: sparaBild });
    } else {
      if (!visning && g.contentSnapshot && norm(g.contentSnapshot.text) === norm(textNytt)) {
        rader.push(`${vad}: redan aktuellt.`);
        continue;
      }
      if (!g.facebookPostUrl) {
        manuella += 1;
        rader.push(`${vad}: inläggets adress saknas — ändra för hand.`);
        continue;
      }
      const url = g.facebookPostUrl;
      uppgifter.push({
        kor: (page) => redigeraTextinlagg(page, url, listing.canonicalUrl, textNytt, skarp, vad, visning),
        klar: () => updateGroupPublication(g.listingId, g.groupId, (c) => ({ ...c, contentSnapshot: groupSnapshot(listing) })),
      });
    }
  }

  if (uppgifter.length === 0) {
    const detalj = rader.join(" ");
    return manuella > 0 ? { status: "manuell", detalj } : { status: "oforandrad", detalj: detalj || "Redan aktuell på Facebook." };
  }

  let fel = 0;
  try {
    await withFacebookBrowser(
      "redigera",
      async ({ page }) => {
        for (const u of uppgifter) {
          try {
            rader.push(await u.kor(page));
            if (skarp) await u.klar();
          } catch (err) {
            if (err instanceof FacebookInterrupt) throw err;
            fel += 1;
            rader.push(err instanceof Error ? err.message : String(err));
          }
        }
      },
      visning ? { headful: true } : {},
    );
  } catch (err) {
    if (err instanceof FacebookInterrupt) {
      // Utloggad, kontrollpunkt, spärr: syns i panelen som manuell åtgärd.
      await recordInterrupt(err, { worker: "redigera", listingId: listing.loopaId }, null).catch(() => undefined);
      return { status: "fel", detalj: `Facebook stoppade redigeringen: ${err.message}` };
    }
    // Fel konto, ingen webbläsare: ingenting kördes.
    return { status: "fel", detalj: err instanceof Error ? err.message : String(err) };
  }

  const detalj = rader.join(" ");
  if (fel > 0) return { status: "fel", detalj };
  if (!skarp) return { status: "torrkord", detalj };
  if (manuella > 0) return { status: "manuell", detalj };
  return { status: "klar", detalj };
}
