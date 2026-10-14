/**
 * Redigering av en Blocket-annons som redan ligger uppe: beskrivningen och måtten.
 *
 * När säljaren (eller säljguiden) rättar annonsen ska Blocket-annonsen visa samma sak. Blocket har
 * inget API och ingen väg att ta ner en annons automatiskt, så annonsen ÄNDRAS PÅ PLATS — samma
 * formulär som prisroboten (pris.ts) redan går genom och som är uppmätt skarpt: /recommerce/create/<id>,
 * förifyllt, med Spara längst ner. Allt som går att återanvända därifrån återanvänds: vägen dit
 * (direkt eller via Mina annonser), kontrollen att annonsen är aktiv och RUBRIKVAKTEN — samma adress
 * med fel id ger ett tomt skapandeformulär, och ett Spara där hade skapat en ny annons.
 *
 * TORRKÖRNING ÄR FÖRVALET. Roboten fyller i beskrivningen och måtten, tar en skärmbild och stannar
 * före Spara — tills BLOCKET_REDIGERA=1 är satt. Egen brytare och inte prisrobotens: beskrivningsfältet
 * är inte uppmätt i redigeringsläge, och den första skarpa körningen ska vara ett eget beslut.
 *
 *     Provkörning: anropas av annonsUppdatering.ts när en annons som ligger ute ändras.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { blocketBaseUrl, blocketConfigured, blocketDataDir, lasHalsa, missingBlocketEnv, sessionFileExists, skrivHalsa } from "./blocket.js";
import { ensureSession, goAndSettle, handleBankID, isLoggedOut, saveSessionIfReal, startBrowser } from "./browser.js";
import { clickFirstVisible, dismissCookieBanner, dismissModal, fillByLabel, fillDescription } from "./form.js";
import { nyttSteg, type Logga } from "./diag.js";
import { arUpptagen, markeraUpptagen } from "./vakt.js";
import { capTitle } from "./mapping.js";
import { adIdFromUrl, annonsenArAktiv, BlocketAnnonsInteAktiv, felText, lasRubrik, redigeringsformularet, rubrikStammer, viaMinaAnnonser } from "./pris.js";
import { blocketInnehall, buildBlocketDescription, planBlocketPublish } from "./publish.js";
import { adTitle } from "../../adContent.js";
import { medRattelser } from "../../butik/overrides.js";
import { persist } from "../../jobStore.js";
import type { KanalUtfall, Visning } from "../annonsUppdatering.js";
import type { BlocketStep, ConditionJob } from "../../types.js";

const MAX_STEG = 40;

/** Får roboten SPARA en redigering? Annars torrkörning. Se filhuvudet. */
export function blocketRedigeringSkarp(): boolean {
  return process.env.BLOCKET_REDIGERA?.trim() === "1";
}

/**
 * `opts.skarp` sätter Spara för just det här anropet — adminens provkörning (provRedigering.ts), där
 * en människa uttryckligen bett om en skarp ändring av en enda annons. Utan det gäller brytaren.
 */
export async function redigeraBlocketAnnons(job: ConditionJob, visning?: Visning, opts: { skarp?: boolean } = {}): Promise<KanalUtfall> {
  const pub = job.blocket;
  const manuell = (detalj: string): KanalUtfall => ({ status: "manuell", detalj });
  if (!pub || pub.status !== "published") return { status: "ej_uppe", detalj: "Ligger inte uppe på Blocket." };
  if (!pub.url) return manuell("Blocket-annonsens adress saknas på jobbet, så roboten hittar den inte. Ändra för hand.");
  if (!blocketConfigured()) return manuell(`Blocket är inte konfigurerat på servern (saknar ${missingBlocketEnv().join(", ")}).`);
  if (!sessionFileExists()) return manuell("Blocket-sessionen saknas på servern. Logga in på nytt och ändra för hand så länge.");
  const halsa = lasHalsa();
  if (halsa && !halsa.ok) return manuell("Blocket-sessionen har gått ut. Logga in på nytt; ändra annonsen för hand så länge.");

  const plan = await planBlocketPublish(job);
  if (!plan.ok) return manuell(`Annonsen går inte att bygga för Blocket: ${plan.reason}`);
  const annons = await medRattelser(job);
  // Frakten annonsen GICK UT med, inte dagens taxa: den är inbakad i priset som står på Blocket.
  const frakt = pub.shippingSek ?? plan.plan.shippingSek;
  const beskrivning = buildBlocketDescription(annons, frakt) + (visning?.tillagg ? `\n\n${visning.tillagg}` : "");
  const nytt = blocketInnehall(plan.plan, beskrivning);
  const fore = pub.innehall ?? null;
  // Står det redan så på Blocket öppnas ingen webbläsare. Utan ögonblicksbild (äldre annonser) vet vi
  // inte vad som står där, och då redigeras den.
  if (!visning && fore && JSON.stringify(fore) === JSON.stringify(nytt)) {
    return { status: "oforandrad", detalj: "Blocket-annonsen visar redan det här." };
  }
  if (arUpptagen()) return { status: "senare", detalj: "En annan Blocket-körning pågår." };
  const matt = plan.plan.measurements;
  const skarp = !visning && (opts.skarp ?? blocketRedigeringSkarp());

  const steg: BlocketStep[] = [];
  const logga: Logga = (name, status, details) => {
    steg.push(nyttSteg(name, status, details));
    if (steg.length > MAX_STEG) steg.splice(0, steg.length - MAX_STEG);
    console.info(`[blocket-redigera] ${job.id} ${status.toUpperCase()} ${name}`);
  };

  let session: Awaited<ReturnType<typeof startBrowser>> | null = null;
  markeraUpptagen(true);
  try {
    logga(skarp ? "Startar redigering (SKARP)" : "Startar redigering (TORRKÖRNING — Spara trycks inte)", "running", { url: pub.url });
    session = await startBrowser();
    try {
      await ensureSession(session.page, logga);
      skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: true, url: session.page.url(), fel: null });
    } catch (err) {
      if (/gått ut/i.test(felText(err))) skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: false, url: session.page.url(), fel: felText(err) });
      throw err;
    }
    await handleBankID(session.page, session.context, logga);
    const page = session.page;
    const id = adIdFromUrl(pub.url);
    if (!(await annonsenArAktiv(page, id, logga))) throw new BlocketAnnonsInteAktiv(id);

    // Vägen till redigeringen — samma två som prisroboten.
    let vag: string | null = null;
    if (id) {
      await goAndSettle(page, `${blocketBaseUrl()}/recommerce/create/${id}`);
      await dismissCookieBanner(page);
      await dismissModal(page);
      if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
      if (await redigeringsformularet(page)) vag = "direkt adress";
    }
    // Rubriken annonsen BÄR på Blocket: den som gick upp, inte nödvändigtvis den som gäller nu — det
    // är ju rubriken som kan vara det som ändrats.
    const rubrikPaBlocket = fore?.rubrik ?? capTitle(adTitle(job));
    const kandidater = [...new Set([rubrikPaBlocket, plan.plan.title, capTitle(adTitle(job))])];
    if (!vag) vag = await viaMinaAnnonser(page, id, rubrikPaBlocket, pub.url, logga);
    if (!vag) throw new Error(`Hittade ingen redigering för annonsen${id ? ` ${id}` : ""}.`);

    // RUBRIKVAKTEN: fyll i ingenting förrän formuläret visar VÅR annons.
    const rubrik = await lasRubrik(page);
    if (!kandidater.some((k) => rubrikStammer(rubrik, k))) {
      throw new Error(
        rubrik
          ? `Redigeringssidan visar en annan annons ("${rubrik}") än vår ("${rubrikPaBlocket}") — ingenting ändrades.`
          : "Redigeringssidan hade ingen rubrik — ett tomt skapandeformulär, inte vår annons. Ingenting ändrades.",
      );
    }
    logga(`Öppnade redigeringen (${vag})`, "ok", { rubrik });
    await visning?.paus(`Blocket: redigeringen för "${rubrik}" är öppen och rubrikvakten godkände den. Nästa: fylla i beskrivningen och måtten.`, page);

    if (rubrik !== nytt.rubrik) {
      await fillByLabel(page, "Annonsrubrik", nytt.rubrik, { timeout: 8000 });
      logga(`Rubrik: ${nytt.rubrik}`, "ok", { var: rubrik });
    }
    if (nytt.marke && nytt.marke !== fore?.marke) {
      try {
        await fillByLabel(page, "Varumärke", nytt.marke, { timeout: 6000 });
        logga(`Varumärke: ${nytt.marke}`, "ok", {});
      } catch {
        logga("Varumärket gick inte att fylla i", "warning", { varde: nytt.marke });
      }
    }

    if (nytt.postnummer !== fore?.postnummer) {
      try {
        await fillByLabel(page, "Postnummer", nytt.postnummer, { timeout: 6000 });
        logga(`Postnummer: ${nytt.postnummer}`, "ok", {});
      } catch {
        logga("Postnumret gick inte att fylla i", "warning", { varde: nytt.postnummer });
      }
    }

    const hur = await fillDescription(page, beskrivning);
    logga(`Fyllde beskrivningen${hur === "reserv" ? " (reservväg)" : ""}`, "ok", { tecken: beskrivning.length });

    // Måtten med EXAKT etikett — "Höjd" är en delsträng av "Sitthöjd" (se publish.ts).
    for (const [etikett, varde] of [
      ["Höjd", matt.height],
      ["Bredd", matt.width],
      ["Djup", matt.depth],
    ] as const) {
      if (!varde) continue;
      try {
        await fillByLabel(page, etikett, varde, { timeout: 6000, exact: true });
        logga(`${etikett}: ${varde} cm`, "ok", {});
      } catch {
        logga(`${etikett} gick inte att fylla i`, "warning", { varde });
      }
    }

    const bild = path.join(blocketDataDir(), `redigera-${job.id}.png`);
    mkdirSync(path.dirname(bild), { recursive: true, mode: 0o700 });
    await page.screenshot({ path: bild, fullPage: true }).catch(() => undefined);

    await visning?.paus("Blocket: allt är ifyllt. Här hade roboten tryckt Spara — det gör den inte nu. Fönstret stängs utan att spara.", page);
    if (!skarp) {
      logga("TORRKÖRNING KLAR — ingenting sparades", "ok", { skarmbild: bild });
      return { status: "torrkord", detalj: `Fyllde i redigeringen men sparade inte (BLOCKET_REDIGERA är av). Skärmbild: ${bild}` };
    }

    const knapp = await clickFirstVisible(
      page,
      ['button:has-text("Spara")', 'button:has-text("Uppdatera annons")', 'button:has-text("Uppdatera")', 'button[type="submit"]:not([disabled])'],
      12_000,
    );
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(2500);
    logga(`Sparade (${knapp})`, "ok", { url: page.url() });
    pub.innehall = nytt;
    await handleBankID(page, session.context, logga);
    if (await saveSessionIfReal(session.context).catch(() => false)) logga("Sessionen sparades om", "ok", {});
    return { status: "klar", detalj: "Rubriken, beskrivningen och måtten är uppdaterade på Blocket." };
  } catch (err) {
    if (err instanceof BlocketAnnonsInteAktiv) return manuell(err.message);
    logga("Redigeringen stoppades", "error", { fel: felText(err) });
    if (session && !session.page.isClosed()) {
      const fil = path.join(blocketDataDir(), `redigera-fel-${job.id}.png`);
      await session.page.screenshot({ path: fil, fullPage: true }).catch(() => undefined);
    }
    return { status: "fel", detalj: felText(err) };
  } finally {
    markeraUpptagen(false);
    pub.redigeringSteg = [...steg];
    if (!visning) await persist(job).catch(() => undefined);
    await session?.browser.close().catch(() => undefined);
  }
}
