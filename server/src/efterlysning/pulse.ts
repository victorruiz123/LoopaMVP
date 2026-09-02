/**
 * Pulsen och deadline-ventilen: de två breven som skickas när ingenting hänt.
 *
 * PULSEN DÖDAR DEN TYSTA DÖDEN. En bevakning som inte hör av sig är omöjlig att skilja från en
 * bevakning som glömts bort, och köparen som inte kan skilja dem åt slutar tro på båda. Brevet går
 * därför varje vecka ÄVEN NÄR DET INTE FINNS NÅGOT ATT BERÄTTA — och just då är det som viktigast:
 *
 *   "Vi har läst igenom 214 nya objekt och 2 tömningar åt dig. Inget höll måttet. Vi fortsätter."
 *
 * SIFFRORNA ÄR SANNA ELLER SÅ STÅR DE INTE DÄR. De kommer ur efterlysningens egna räknare, som
 * skrivs av svepet (se recordSweep). Har ingenting lästs sedan förra brevet säger brevet det i
 * stället för att upprepa en gammal summa — en påhittad siffra i ett brev som ska bygga förtroende
 * är värre än inget brev.
 *
 * DEADLINE-VENTILEN är pulsens motsats: den skickas när det BRÅDSKAR och det ändå inte finns någon
 * perfekt träff. Då är de tre närmaste kompromisserna mer värda än tystnad — köparen kan välja att
 * sänka ett krav i stället för att missa sin deadline utan att ha fått veta att de var nära.
 */

import { sweep } from "./sweep.js";
import * as store from "./store.js";
import { deepLink, lastOf, push, sendLetter } from "./notify.js";
import type { Efterlysning } from "./types.js";
import { emit } from "./analytics.js";

const WEEK_MS = 7 * 24 * 3600_000;
/** Så nära en deadline ventilen öppnar. Två veckor: nog för att hinna leta, kort nog att det bränner. */
const DEADLINE_WINDOW_DAYS = Number(process.env.EFTERLYSNING_DEADLINE_DAYS ?? 14);

const SEK = (n: number | null) => (n === null ? "okänt pris" : `${n.toLocaleString("sv-SE")} kr`);

/** Hur många objekt som lästs sedan förra pulsen. Noll = säg det, upprepa inte totalen. */
function scannedSince(e: Efterlysning, sincePulse: string | null): number {
  // Räknaren är kumulativ, så "sedan sist" kräver att vi minns var vi stod. Utan tidigare puls är
  // hela summan svaret.
  if (!sincePulse) return e.scannedCount;
  const marker = pulseMarkers.get(e.id);
  return marker === undefined ? e.scannedCount : Math.max(0, e.scannedCount - marker);
}

/**
 * Var räknaren stod när förra pulsen gick.
 *
 * I minnet och inte på disk med flit: tappas den vid omstart blir nästa puls generös (den räknar från
 * noll) i stället för fel. En felaktigt LÅG siffra hade sett ut som att vi slutat leta; en för hög
 * ser bara ut som att vi letat länge, vilket vi har.
 */
const pulseMarkers = new Map<string, number>();

export interface PulseResult {
  sent: number;
  skipped: number;
}

/**
 * Veckans livstecken till varje aktiv efterlysning.
 *
 * Hoppar över den som fått ett brev de senaste sju dagarna — en träffnotis räknas som livstecken, och
 * två brev samma vecka är ett för många.
 */
export async function runPulse(now = Date.now()): Promise<PulseResult> {
  const open = (await store.open()).filter((e) => e.userId);
  let sent = 0;
  let skipped = 0;

  for (const e of open) {
    const lastPulse = await lastOf(e.id, "puls");
    const lastMatch = await lastOf(e.id, "match");
    const lastAny = [lastPulse, lastMatch]
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;

    if (lastAny && now - new Date(lastAny.createdAt).getTime() < WEEK_MS) { skipped += 1; continue; }

    const lasta = scannedSince(e, lastPulse?.createdAt ?? null);
    const title = "Vi letar vidare åt dig";
    const body = [
      `Din efterlysning: ${e.summary}`,
      "",
      lasta > 0
        ? `Sedan sist har vi läst igenom ${lasta.toLocaleString("sv-SE")} objekt${e.scannedClearances > 0 ? ` och ${e.scannedClearances} ${e.scannedClearances === 1 ? "tömning" : "tömningar"}` : ""} åt dig. Inget höll måttet — vi fortsätter.`
        : "Vi har inte hunnit gå igenom något nytt sedan sist, men bevakningen är igång.",
      "",
      `Ändra eller pausa: ${deepLink(e)}`,
    ].join("\n");

    await push({
      userId: e.userId!, efterlysningId: e.id, kind: "puls",
      title, body, href: deepLink(e), productIds: [], source: null,
    });
    pulseMarkers.set(e.id, e.scannedCount);
    emit("pulse_sent", { efterlysning: e.id, lasta: lasta, tomningar: e.scannedClearances });
    if (e.email) await sendLetter({ to: e.email, subject: title, body, kind: "puls" });
    sent += 1;
  }
  return { sent, skipped };
}

/**
 * Deadline-ventilen: de tre närmaste kompromisserna när tiden håller på att ta slut.
 *
 * Öppnar en gång per efterlysning. Ett andra brev om samma sak hade varit gnat, och köparen som inte
 * agerade på det första kommer inte agera på det andra.
 */
export async function runDeadlineValve(now = Date.now()): Promise<PulseResult> {
  const open = (await store.open()).filter((e) => e.userId && e.deadline);
  let sent = 0;
  let skipped = 0;

  for (const e of open) {
    const days = (new Date(e.deadline!).getTime() - now) / 86_400_000;
    if (days < 0 || days > DEADLINE_WINDOW_DAYS) { skipped += 1; continue; }
    if (await lastOf(e.id, "deadline")) { skipped += 1; continue; }

    // GENERÖST svep med flit: hela poängen är att visa kompromisserna. Hade vi sökt strikt här hade
    // brevet inte haft något att innehålla — det är just för att inget är perfekt som vi skriver.
    const result = await sweep(e, { generous: true });
    const three = result.candidates.slice(0, 3);
    if (three.length === 0) { skipped += 1; continue; }

    /**
     * FINNS DET EXAKTA TRÄFFAR ÄR VENTILEN FEL BREV.
     *
     * Den skickas för att inget stämmer helt. Har köparen redan fått en träffnotis om just de här
     * möblerna är ventilen en upprepning — och skrev vi ändå "inget stämmer helt" ovanför en lista
     * med "uppfyller allt du bad om" hade brevet motsagt sig själv på tre rader. Mätt i skarp
     * körning, där matbordet fick båda breven med samma innehåll.
     */
    const exakta = three.filter((c) => c.kind === "exact");
    const redanSagt = exakta.every((c) => e.notifiedProductIds.includes(c.product.id));
    if (exakta.length > 0 && redanSagt) { skipped += 1; continue; }

    const baraNara = exakta.length === 0;
    const title = baraNara
      ? "Din deadline närmar sig — här är det närmaste vi har"
      : "Din deadline närmar sig — det här har vi";
    const body = [
      `Du efterlyste: ${e.summary}`,
      `Du behöver den senast ${e.deadline}.`,
      "",
      baraNara
        ? "Inget stämmer helt, men de här är närmast:"
        : "Så här ser det ut just nu:",
      "",
      ...three.map((c) => `• ${c.product.title} — ${SEK(c.product.priceSek)}\n  ${c.fitNote}`),
      "",
      `Se dem här: ${deepLink(e)}`,
      "",
      "Säg till om något duger, så tar vi det därifrån.",
    ].join("\n");

    await push({
      userId: e.userId!, efterlysningId: e.id, kind: "deadline",
      title, body, href: deepLink(e),
      productIds: three.map((c) => c.product.id), source: three[0].source,
    });
    emit("deadline_valve_sent", { efterlysning: e.id, kandidater: three.length, baraNara });
    if (e.email) await sendLetter({ to: e.email, subject: title, body, kind: "deadline" });
    sent += 1;
  }
  return { sent, skipped };
}

/**
 * Somnande efterlysningar får en påminnelse med ett klick i.
 *
 * Skickas två veckor innan, en gång. Alternativet — att låta dem somna tyst — hade betytt att en
 * köpare som fortfarande letar tappas för att nittio dagar gick.
 */
export async function runRenewalReminders(now = Date.now()): Promise<PulseResult> {
  const open = (await store.open()).filter((e) => e.userId);
  let sent = 0;
  let skipped = 0;

  for (const e of open) {
    const days = (new Date(e.expiresAt).getTime() - now) / 86_400_000;
    if (days < 0 || days > 14) { skipped += 1; continue; }
    if (await lastOf(e.id, "fornyelse")) { skipped += 1; continue; }

    const dagarBevakad = Math.floor((now - new Date(e.createdAt).getTime()) / 86_400_000);
    const title = "Din efterlysning somnar snart";
    const body = [
      `Din efterlysning: ${e.summary}`,
      "",
      // "0 dagar" är sant men läser som ett fel. Under ett dygn säger vi vad vi gjort i stället.
      dagarBevakad >= 1
        ? `Vi har bevakat den i ${dagarBevakad} ${dagarBevakad === 1 ? "dag" : "dagar"} och läst igenom ${e.scannedCount.toLocaleString("sv-SE")} objekt.`
        : `Vi har läst igenom ${e.scannedCount.toLocaleString("sv-SE")} objekt åt dig.`,
      `Om ${Math.max(0, Math.round(days))} dagar slutar vi automatiskt, om du inte säger till.`,
      "",
      `Förny med ett klick: ${deepLink(e)}`,
    ].join("\n");

    await push({
      userId: e.userId!, efterlysningId: e.id, kind: "fornyelse",
      title, body, href: deepLink(e), productIds: [], source: null,
    });
    if (e.email) await sendLetter({ to: e.email, subject: title, body, kind: "fornyelse" });
    sent += 1;
  }
  return { sent, skipped };
}

/** Somnar de som gått ut. Körs före påminnelserna, så en somnad inte får en påminnelse. */
export async function expireOverdue(now = Date.now()): Promise<number> {
  const open = await store.open();
  let n = 0;
  for (const e of open) {
    if (new Date(e.expiresAt).getTime() <= now) {
      await store.update(e.id, { state: "expired" });
      n += 1;
    }
  }
  return n;
}

/** Bara för tester. */
export function resetPulseMarkers(): void { pulseMarkers.clear(); }
