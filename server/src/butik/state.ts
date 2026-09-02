/**
 * Tillståndsmaskinen för en unik möbel.
 *
 * Möbeln finns i ETT exemplar och ligger uppe på TVÅ ställen — Butiken och Tradera. Det är hela
 * problemet. En statusflagga per kanal går inte: två flaggor kan säga olika saker samtidigt, och den
 * dagen de gör det har vi sålt samma soffa två gånger. Här finns i stället ett tillstånd, och de två
 * kanalerna är två vägar in i samma övergång.
 *
 * Dubbelförsäljningen förhindras INTE här. Den förhindras i store.ts, av att övergången till `sold`
 * är ett villkorat skrivande som bara kan lyckas en gång. Den här filen säger vad som får hända;
 * lagret säger vem som hann först. Blanda inte ihop dem — en kontroll av typen "läs tillstånd, om
 * live så skriv sold" är exakt det tävlingsfönster som gör två köpare till ett problem.
 */

import { randomUUID } from "node:crypto";
import { canTransition, type Product, type ProductEvent, type ProductState, type TransitionActor } from "./types.js";

/**
 * Hur länge en möbel hålls medan någon står i kassan.
 *
 * Lång nog för att hinna igenom Stripe och ett leveransval, kort nog att en avbruten utcheckning
 * inte låser möbeln över natten. Reservationen släpps av sig själv — se `sweepExpiredReservations`.
 */
export const RESERVATION_MINUTES = Number(process.env.BUTIK_RESERVATION_MINUTES ?? 15);

export class TransitionError extends Error {
  constructor(
    public from: ProductState,
    public to: ProductState,
  ) {
    super(`Otillåten övergång: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}

/** Bygger händelsen. Kastar när övergången inte finns i tabellen — se types.ts. */
export function makeEvent(
  productId: string,
  from: ProductState,
  to: ProductState,
  actor: TransitionActor,
  note: string | null = null,
): ProductEvent {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
  return { id: randomUUID(), productId, from, to, at: new Date().toISOString(), actor, note };
}

/**
 * Vad som saknas innan möbeln får ligga i butiken.
 *
 * Mätt på lagret: 67 av 172 besiktigade jobb har ingen genererad annons alls — ingen titel, ingen
 * kategori, inget pris, ingen bild. De är riktiga besiktningar, men de är inte varor, och att låta
 * dem ligga i rutnätet som namnlösa rutor hade varit att låta lagrets storlek gå före dess innehåll.
 *
 * Listan är avsiktligt läsbar: den går tillbaka till säljverktyget som "det här fattas" i stället för
 * att möbeln tyst uteblir ur butiken.
 */
export function shopReadiness(product: Product): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!product.condition) missing.push("skickbetyg");
  if (product.priceSek === null) missing.push("pris");
  if (!product.brand && !product.model) missing.push("märke eller modell");
  if (product.categorySlug === "ovrigt") missing.push("kategori");
  // Bild ELLER mått: utan foto ritas möbeln ur måtten, samma stand-in som sanningskortet visar
  // (web/src/lib/furnitureModel.ts). Utan båda finns ingenting att visa i rutnätet.
  const renderable = product.dimensions.widthMm !== null || product.dimensions.heightMm !== null;
  if (!product.imageUrl && !renderable) missing.push("bild eller mått");
  return { ready: missing.length === 0, missing };
}

/** Reservationen som ett klockslag. Läses av kassan och av städningen. */
export function reservationDeadline(from: Date = new Date()): string {
  return new Date(from.getTime() + RESERVATION_MINUTES * 60_000).toISOString();
}

export function reservationHasExpired(reservedUntil: string | null): boolean {
  if (!reservedUntil) return false;
  return new Date(reservedUntil).getTime() <= Date.now();
}
