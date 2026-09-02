/**
 * Affärens tillståndsmaskin, och de två reglerna som håller den privat.
 *
 * Övergångarna står i types.ts; det här är vad som får ske och vad som händer på vägen. Precis som
 * butikens motsvarighet (butik/state.ts) säger den här filen VAD som är tillåtet, medan store.ts
 * avgör vem som hann först. Blanda inte ihop dem.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { canTransition, EXPIRY, MAX_COUNTER_ROUNDS, TERMINAL, type Deal, type DealActor, type DealEvent, type DealState } from "./types.js";

export class TransitionError extends Error {
  constructor(public from: DealState, public to: DealState) {
    super(`Otillåten övergång: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}

export function makeEvent(
  dealId: string,
  from: DealState,
  to: DealState,
  actor: DealActor,
  note: string | null = null,
): DealEvent {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
  return { id: randomUUID(), dealId, from, to, at: new Date().toISOString(), actor, note };
}

/**
 * Inbjudningslänkens hemlighet.
 *
 * 160 bitar ur en kryptografisk källa, skrivet i en teckenuppsättning utan 0/O och 1/l — länken
 * hamnar i en chatt där folk läser den högt och skriver av den för hand.
 *
 * Den ÄR åtkomstkontrollen: vem som helst med token får se affären, utan konto. Det är avsiktligt —
 * en säljare ska kunna titta innan de bestämmer sig — och det är precis därför den måste vara
 * ogissbar. Ett löpnummer här vore en publik katalog över alla pågående affärer.
 */
const TOKEN_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function makeInviteToken(): string {
  const bytes = randomBytes(28);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

/** När det här läget går ut, eller null om det inte gör det. */
export function expiryFor(state: DealState, from: Date = new Date()): string | null {
  const ms = EXPIRY[state];
  return ms ? new Date(from.getTime() + ms).toISOString() : null;
}

export function hasExpired(deal: Deal, now: Date = new Date()): boolean {
  if (TERMINAL.includes(deal.state)) return false;
  if (!deal.expiresAt) return false;
  return new Date(deal.expiresAt).getTime() <= now.getTime();
}

/**
 * Får den här parten lägga ett motbud?
 *
 * En runda, sagt i en siffra. Briefen tillåter accept, ETT motbud, eller avslag — och det andra
 * motbudet är det som gör en affär till en förhandling, vilket är precis vad Trygg affär inte är.
 */
export function mayCounter(deal: Deal): boolean {
  return deal.counterRounds < MAX_COUNTER_ROUNDS;
}

/** Sista ordet i prisdialogen, eller null innan någon sagt något. */
export function currentPrice(deal: Deal): number | null {
  return deal.agreedPriceSek ?? deal.proposals.at(-1)?.amountSek ?? null;
}

/**
 * Maskar personuppgifter ur annonstext FÖRE lagring.
 *
 * En Blocket-annons bär säljarens förnamn och ofta ett telefonnummer, och ibland en adress. Inget av
 * det behövs för att bedöma en soffa, och allt av det är sådant vi inte ska ha liggande. Maskningen
 * sker vid intaget och inte vid visningen: det som aldrig sparas kan inte läcka.
 *
 * Trubbig med flit. Den tar hellre bort ett årtal för mycket än lämnar ett telefonnummer kvar, och
 * texten den skyddar är ett underlag för en bedömning — inte något någon ska läsa som prosa.
 */
export function maskPersonalData(text: string | null): string | null {
  if (!text) return null;
  return text
    // Telefonnummer: svenska format med och utan landsnummer, mellanslag eller bindestreck.
    // Siffergrupperna får sluka efterföljande blanksteg, men markören sätter tillbaka ett — annars
    // klistras nästa ord ihop med etiketten ("[telefonnummer]eller").
    // `(?<!\d)`: nollan måste inleda ett tal, inte stå mitt i ett. Utan den läste den andra raden
    // "2026-09-05 20:26:14" som ett telefonnummer från och med sin egen nolla och lämnade
    // "2[telefonnummer] :26:14" i annonstexten — både för köparens ögon och för modellen.
    .replace(/(?<!\d)(?:\+46|0)\s?7[\d\s-]{8,12}\s*/g, "[telefonnummer] ")
    .replace(/(?<!\d)(?:\+46|0)\s?\d{1,3}[\s-]?\d{2,3}[\s-]?\d{2}[\s-]?\d{2}\s*/g, "[telefonnummer] ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+\s*/g, "[e-post] ")
    // Personnummer, med eller utan sekel och bindestreck.
    .replace(/\b(?:19|20)?\d{6}[-+]?\d{4}\b\s*/g, "[personnummer] ")
    // Maskningen kan lämna dubbla blanksteg och ett hängande före punkt.
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

/**
 * Vad säljaren får se innan de skapat konto.
 *
 * Bygger EN gång, ur affären, och lämnar allt om köparen utanför. Säljaren ska kunna bedöma
 * erbjudandet utan att vi lämnat ut vem som står bakom det.
 */
export function publicInviteOf(deal: Deal, what: string): import("./types.js").PublicInvite {
  const offered = deal.proposals.find((p) => p.by === "buyer")?.amountSek ?? null;
  return {
    token: deal.inviteToken,
    state: deal.state,
    what,
    askingPriceSek: deal.submission?.askingPriceSek ?? null,
    offeredPriceSek: offered,
    expiresAt: deal.expiresAt,
    closed: TERMINAL.includes(deal.state),
  };
}
