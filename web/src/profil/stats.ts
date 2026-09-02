/**
 * Handelns siffror, räknade ur det som redan hämtats.
 *
 * INGEN EGEN SERVERVÄG. Profilen hämtar tre listor — annonser, ordrar, affärer — och varje tal här
 * går att räkna ur dem. En fjärde väg som räknade samma sak på servern hade blivit ett andra ställe
 * där "sålt" kan betyda något annat än i listan under, och det är den sortens glapp man upptäcker
 * först när talen inte stämmer.
 *
 * VAD SOM RÄKNAS OCH INTE:
 *
 * `sold` räknar möbler butiken vet är sålda. Tradera-försäljningar ingår — de gick ut genom en annan
 * kanal men det är samma möbel och samma säljare.
 *
 * `earned` summerar bara det vi har ett PRIS på. En möbel som såldes innan reservationspriset
 * skrevs har inget belopp, och den ska saknas i summan i stället för att räknas som noll kronor.
 *
 * `liveValue` är prisförslaget för det som ligger ute — inte en intäkt, utan vad lagret är värt.
 * Därför skilt från `earned`, som är pengar som faktiskt bytt ägare.
 */

import type { DealView } from "../affar/types";
import type { JobSummary } from "../types";
import type { Order } from "../butik/api";
import type { Product } from "../butik/types";

export interface SellStats {
  /** Färdiga annonskort. Ett jobb utan annons är en filmning, inte en möbel till salu. */
  cards: number;
  live: number;
  reserved: number;
  sold: number;
  /** Summan av det som sålts, där priset är känt. */
  earned: number;
  /** Vad som ligger ute, till prisförslaget. */
  liveValue: number;
  /** Affärer där jag är säljaren och något väntar på mig. */
  needsMe: number;
}

export interface BuyStats {
  orders: number;
  /** Betalda, levererade och bokade — allt som faktiskt blev ett köp. */
  completed: number;
  spent: number;
  /** Affärer där jag är köparen och som ännu inte är avslutade. */
  openDeals: number;
  needsMe: number;
  /** Vad de pågående affärerna landat på hittills — överenskommet pris, annars begärt. */
  committed: number;
}

const LIVE_STATES = ["live"] as const;
const SOLD_STATES = ["sold", "delivered"] as const;

/** Ordrar som faktiskt blev ett köp. `pending` är en påbörjad kassa; `cancelled` blev aldrig något. */
const REAL_ORDER = ["paid", "scheduled", "delivered", "return_requested", "returned"];

/** Affärslägen som är slut. Allt annat pågår, och det är det pågående profilen ska lyfta fram. */
export const CLOSED_DEAL_STATES = ["paid_out", "declined", "expired"];

export function sellStats(jobs: JobSummary[], deals: DealView[]): SellStats {
  const cards = jobs.filter((j) => j.hasListing);
  const live = cards.filter((j) => !!j.shop && (LIVE_STATES as readonly string[]).includes(j.shop.state));
  const reserved = cards.filter((j) => j.shop?.state === "reserved");
  const sold = cards.filter((j) => !!j.shop && (SOLD_STATES as readonly string[]).includes(j.shop.state));
  return {
    cards: cards.length,
    live: live.length,
    reserved: reserved.length,
    sold: sold.length,
    earned: sold.reduce((sum, j) => sum + (j.shop?.priceSek ?? 0), 0),
    liveValue: live.reduce((sum, j) => sum + (j.price?.status === "ok" ? (j.price.default ?? 0) : 0), 0),
    needsMe: deals.filter((d) => d.role === "seller" && d.awaiting === "seller").length,
  };
}

export function buyStats(orders: Array<{ order: Order }>, deals: DealView[]): BuyStats {
  const real = orders.filter((o) => REAL_ORDER.includes(o.order.status));
  const mine = deals.filter((d) => d.role === "buyer");
  const open = mine.filter((d) => !CLOSED_DEAL_STATES.includes(d.state));
  return {
    orders: orders.length,
    completed: real.length,
    spent: real.reduce((sum, o) => sum + o.order.priceSek + o.order.deliveryFeeSek, 0),
    openDeals: open.length,
    needsMe: mine.filter((d) => d.awaiting === "buyer").length,
    committed: open.reduce((sum, d) => sum + (d.agreedPriceSek ?? d.askingPriceSek ?? 0), 0),
  };
}

/** Möbeln på en orderrad, med butikens titel när den finns. */
export function orderTitle(product: Product | null, order: Order): string {
  return product?.title ?? `Order ${order.reference}`;
}

/**
 * "1 möbel", "2 möbler".
 *
 * Egen och pytteliten, för att alternativet är "1 möbler" i en ruta som ska inge förtroende om
 * pengar. i18n-lagret översätter hela strängar och har ingen böjning — den här hör hemma där texten
 * sätts ihop.
 */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
