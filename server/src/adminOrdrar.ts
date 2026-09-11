/**
 * Orderpanelen: alla köp, och det som väntar på en människa.
 *
 * VARFÖR DEN FINNS. Annonspanelen (adminAnnonser.ts) svarar på "vad har vi fått in och vad ligger
 * ute". Den kunde inte svara på "vad är sålt och vad ska köras hem", och det var inte en lucka i
 * gränssnittet utan i produkten: en betald order fanns bara som en rad i en JSON-fil, och enda
 * vägen till den var att gissa vilken annons den hörde till och öppna just den.
 *
 * LISTAN ÄR EN ARBETSLISTA, inte ett arkiv. Överst ligger det som kräver något av oss — betalt utan
 * angivna tider, angivna tider utan bokad frakt, begärda returer — och de sorteras äldst först.
 * Resten går att bläddra till, men den som öppnar fliken gör det för att få talet högst upp till
 * noll.
 *
 * FRAKTEN ÄR TRE TRYCK OCH INTE ETT. "Vi bokar frakt" sätts av köparen när de lämnat sina tider;
 * panelen bekräftar EN tid, och markerar levererat när möbeln är inburen. Att slå ihop dem hade
 * gjort bokningen till ett ögonblick, och den är i verkligheten ett samtal med en budfirma.
 */

import { confirmDelivery, markOrderDelivered } from "./butik/checkout.js";
import { allOrders, getOrder, publikHistorik, recordOrderEvent, type Order, type OrderEvent, type OrderSlot } from "./butik/orders.js";
import { store as butikStore } from "./butik/store.js";
import { markDelivered } from "./butik/store.js";
import { getJob } from "./jobStore.js";
import { loopaIdFor } from "./loopaId.js";
import { invalidate } from "./butik/inventory.js";

export class OrderFel extends Error {}

/** En rad i listan. Bär allt panelen visar utan att något behöver slås upp per rad i klienten. */
export interface AdminOrderRad {
  id: string;
  reference: string;
  productId: string;
  /** Möbelns rubrik. Faller tillbaka på Loopa-id:t — en rad utan namn är fortfarande en rad. */
  titel: string;
  status: Order["status"];
  /** Vad panelen ska göra härnäst, skrivet som en uppmaning. Null när ingenting väntar på oss. */
  attGora: string | null;
  priceSek: number;
  deliveryFeeSek: number;
  postalCode: string | null;
  deliveryZone: string | null;
  /** Köparens tre önskade tider, i den ordning de angavs. */
  requestedSlots: OrderSlot[];
  deliveryDate: string | null;
  deliveryWindow: string | null;
  buyerEmail: string | null;
  /** Säljarens adress, så panelen kan se om säljaren gick att nå alls. */
  sellerEmail: string | null;
  createdAt: string;
  updatedAt: string;
  /** Hur länge ordern väntat på oss, i timmar. Null när den inte väntar. */
  vantatTimmar: number | null;
}

export interface AdminOrderDetalj extends AdminOrderRad {
  /** Hela historiken, inklusive de interna raderna. Köparen ser bara `publik`. */
  handelser: OrderEvent[];
  loopaId: string | null;
}

export interface OrderSummering {
  antal: number;
  /** Det tal fliken finns för att få ner. */
  attGora: number;
  betalda: number;
  bokade: number;
  levererade: number;
  /** Summa på det som sålts och inte gått åter. */
  omsattning: number;
}

/** Vad som väntar på oss i det här läget. Null betyder att bollen ligger hos köparen eller ingen. */
function attGoraFor(order: Order): string | null {
  switch (order.status) {
    case "paid":
      return order.requestedSlots.length
        ? "Boka frakt — köparen har lämnat tider."
        : "Väntar på köparens tider. Hör av dig om det dröjer.";
    case "booking":
      return "Boka frakt — köparen har lämnat tider.";
    case "scheduled":
      return "Kör ut och markera levererad.";
    case "cancel_requested":
      return "Köparen har ångrat sig — stoppa frakten och återbetala. Möbeln står kvar hos oss.";
    case "return_requested":
      return "Retur begärd — boka upphämtning och återbetala.";
    case "cancelled":
      return "Kontrollera om återbetalning krävs.";
    default:
      return null;
  }
}

async function titelFor(productId: string): Promise<{ titel: string; loopaId: string | null; sellerEmail: string | null }> {
  try {
    const record = await butikStore().get(productId);
    if (!record?.jobId) return { titel: productId, loopaId: null, sellerEmail: null };
    const job = await getJob(record.jobId);
    const listing = job?.result?.listing ?? job?.listing ?? null;
    return {
      titel: listing?.result?.listing.title ?? productId,
      loopaId: loopaIdFor(record.jobId),
      sellerEmail: job?.ownerEmail ?? null,
    };
  } catch {
    return { titel: productId, loopaId: null, sellerEmail: null };
  }
}

async function radAv(order: Order): Promise<AdminOrderRad> {
  const { titel, sellerEmail } = await titelFor(order.productId);
  const attGora = attGoraFor(order);
  return {
    id: order.id,
    reference: order.reference,
    productId: order.productId,
    titel,
    status: order.status,
    attGora,
    priceSek: order.priceSek,
    deliveryFeeSek: order.deliveryFeeSek,
    postalCode: order.postalCode,
    deliveryZone: order.deliveryZone,
    requestedSlots: order.requestedSlots ?? [],
    deliveryDate: order.deliveryDate,
    deliveryWindow: order.deliveryWindow,
    buyerEmail: order.email,
    sellerEmail,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    vantatTimmar: attGora ? Math.round((Date.now() - new Date(order.updatedAt).getTime()) / 3_600_000) : null,
  };
}

/**
 * Alla ordrar, arbetslistan först.
 *
 * `pending` utelämnas: en påbörjad kassa som aldrig betalades är inte en order någon ska agera på,
 * och de blir många — varje avbruten utcheckning lämnar en. Sveparen städar dem.
 */
export async function listaOrdrar(): Promise<{ rader: AdminOrderRad[]; summering: OrderSummering }> {
  const alla = (await allOrders()).filter((o) => o.status !== "pending");
  const rader = await Promise.all(alla.map(radAv));

  rader.sort((a, b) => {
    if (!!a.attGora !== !!b.attGora) return a.attGora ? -1 : 1;
    // Inom arbetslistan: äldst först, den som väntat längst har mest rätt att bli otålig.
    // Bland de färdiga: nyast först, det är den senaste affären man vill se.
    return a.attGora ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt);
  });

  const summering: OrderSummering = {
    antal: rader.length,
    attGora: rader.filter((r) => r.attGora).length,
    betalda: rader.filter((r) => r.status === "paid" || r.status === "booking").length,
    bokade: rader.filter((r) => r.status === "scheduled").length,
    levererade: rader.filter((r) => r.status === "delivered").length,
    omsattning: rader
      // Ett ångrat köp är inte omsättning: pengarna går tillbaka, precis som vid en retur.
      .filter((r) => r.status !== "cancelled" && r.status !== "returned" && r.status !== "cancel_requested")
      .reduce((sum, r) => sum + r.priceSek + r.deliveryFeeSek, 0),
  };
  return { rader, summering };
}

export async function orderDetalj(id: string): Promise<AdminOrderDetalj | null> {
  const order = await getOrder(id);
  if (!order) return null;
  const rad = await radAv(order);
  const { loopaId } = await titelFor(order.productId);
  return { ...rad, loopaId, handelser: [...(order.events ?? [])].reverse() };
}

/** Vad panelen kan göra med en order. Varje åtgärd skriver en rad i historiken. */
export interface OrderAtgard {
  gor: "boka" | "levererad" | "anteckna";
  /** För `boka`: tiden som faktiskt bokades. Behöver inte vara en av köparens tre. */
  datum?: string;
  tid?: string;
  /** Fritext. För `anteckna` är den hela handlingen; för `boka` ersätter den standardtexten. */
  text?: string;
  /** För `anteckna`: ska köparen och säljaren se raden? Förval är nej — anteckningar är interna. */
  publik?: boolean;
}

/**
 * Utför en åtgärd och returnerar ordern som den blev.
 *
 * ALLA VÄGAR GÅR GENOM CHECKOUT-MODULEN där tillståndsreglerna och notiserna bor. Panelen får inte
 * ha en egen uppfattning om vad som är en tillåten övergång — den skulle med tiden bli en annan än
 * köparens, och då står de två sidorna av samma affär och säger olika saker.
 */
export async function andraOrder(id: string, atgard: OrderAtgard, adminId: string | null): Promise<AdminOrderDetalj | null> {
  const order = await getOrder(id);
  if (!order) return null;

  if (atgard.gor === "boka") {
    if (!atgard.datum || !atgard.tid) throw new OrderFel("Ange datum och tid för bokningen.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(atgard.datum)) throw new OrderFel("Datumet ska skrivas som ÅÅÅÅ-MM-DD.");
    await confirmDelivery(order.id, atgard.datum, atgard.tid, atgard.text);
  } else if (atgard.gor === "levererad") {
    await markOrderDelivered(order.id);
    /**
     * Möbeln följer med ordern.
     *
     * Det här är felet som fanns förut, fast åt andra hållet: panelens "levererad" flyttade bara
     * butiksposten och lämnade ordern kvar på `scheduled`. Nu flyttas båda, och att butiksposten
     * inte kan gå dit (den är kanske redan `delivered`) är inte ett fel som ska stoppa ordern.
     */
    try {
      await markDelivered(order.productId, { kind: "admin", userId: adminId });
      invalidate();
    } catch {
      // Butiksposten stod i ett läge som inte tillåter övergången. Ordern är ändå levererad.
    }
  } else if (atgard.gor === "anteckna") {
    const text = atgard.text?.trim();
    if (!text) throw new OrderFel("Anteckningen är tom.");
    await recordOrderEvent(order.id, { status: null, note: text, actor: "admin", publik: atgard.publik === true });
  } else {
    throw new OrderFel("Okänd åtgärd.");
  }
  return orderDetalj(id);
}

/** Köparens egen vy av historiken. Exporterad här så att butiksrutten inte behöver känna reglerna. */
export { publikHistorik };
