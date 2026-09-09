/**
 * Kassan: reservation, Stripe och vägen tillbaka.
 *
 * ORDNINGEN ÄR HELA SÄKERHETEN. Möbeln reserveras FÖRE betalningen, aldrig efter. Reserveras den
 * efter kan två köpare betala för samma soffa och en av dem får pengarna tillbaka och en ursäkt;
 * reserveras den före kan bara en av dem ens nå betalfönstret. Reservationen är dessutom tidsbunden
 * (se RESERVATION_MINUTES) så en övergiven kassa inte låser möbeln för alltid.
 *
 * BELOPPET RÄKNAS HÄR. Priset läses ur butikslagrets `reservedPriceSek` — det som frystes när
 * möbeln reserverades — och frakten ur delivery.ts. Ingen summa kommer från klienten. Skickas ett
 * pris in i anropet ignoreras det; annars vore rabatten en fråga om att redigera ett fetch-anrop.
 *
 * WEBHOOKEN ÄR SANNINGEN. Att köparen skickas tillbaka till en tacksida betyder ingenting — den
 * adressen kan vem som helst öppna. Först `checkout.session.completed`, signaturverifierad mot
 * Stripes hemlighet, gör möbeln såld.
 */

import Stripe from "stripe";
import { claimForSale, release, reserve, store } from "./store.js";
import { notifyDelivered, notifyDeliveryBooked, notifyPurchase, notifySlotsRequested } from "./notiser.js";
import {
  createOrder,
  getOrder,
  orderByStripeSession,
  recordOrderEvent,
  updateOrder,
  type Order,
  type OrderSlot,
} from "./orders.js";
import { deliveryQuote, zoneFor } from "./delivery.js";
import { productById, invalidate } from "./inventory.js";
import { endTraderaItem } from "../integrations/tradera/tradera.js";
import { getJob } from "../jobStore.js";

const KEY = () => process.env.STRIPE_SECRET_KEY?.trim() || null;
const WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;

/**
 * Sant när kassan går att använda.
 *
 * Utan nycklar visas ingen köpknapp — samma mönster som `traderaConfigured()`. En knapp som leder
 * till ett fel är sämre än ingen knapp: den lovar ett köp vi inte kan ta emot.
 */
export function checkoutConfigured(): boolean {
  return KEY() !== null;
}

let client: Stripe | null = null;
function stripe(): Stripe {
  const key = KEY();
  if (!key) throw new Error("STRIPE_SECRET_KEY saknas");
  // API-versionen utelämnas med flit: SDK:n pinnar sin egen, och en hårdkodad sträng här går sönder
  // vid varje uppgradering av paketet — vilket är precis vad tsc nyss sade.
  client ??= new Stripe(key);
  return client;
}

function publicUrl(): string {
  return (process.env.LOOPA_PUBLIC_URL || "http://localhost:8799").replace(/\/+$/, "");
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    // Namnet sätts uttryckligen: adminpanelen känner igen felet över en dynamisk import, där
    // klassidentiteten inte nödvändigtvis är densamma som den anroparen importerade.
    this.name = "CheckoutError";
  }
}

/**
 * Steg 1: håll möbeln och skapa betalsessionen.
 *
 * Fraktzonen avgörs av postnumret HÄR, av samma skäl som priset: den är en post på beloppet.
 */
export async function startCheckout(input: {
  productId: string;
  postalCode: string;
  userId: string | null;
  email: string | null;
}): Promise<{ order: Order; checkoutUrl: string }> {
  if (!checkoutConfigured()) throw new CheckoutError("Kassan är inte konfigurerad.", 503);

  const product = await productById(input.productId);
  if (!product) throw new CheckoutError("Varan finns inte.", 404);
  if (product.source !== "loopa") throw new CheckoutError("Den här annonsen köps hos Tradera.", 400);
  if (product.priceSek === null) throw new CheckoutError("Varan saknar pris.", 409);

  const quote = deliveryQuote(input.postalCode);
  const zone = quote.zone;
  // Utanför zonen går köpet ändå igenom, men utan leveransavgift: möbeln hämtas då, och det står i
  // bekräftelsen. Att vägra köpet hade varit att låta en gräns i vår logistik bli ett nej till pengar.
  const deliveryFee = zone?.feeSek ?? 0;

  const held = await reserve(product.id, product.priceSek, { kind: "buyer", userId: input.userId });
  if (!held) throw new CheckoutError("Möbeln är inte längre tillgänglig — någon annan hann före.", 409);

  let order: Order;
  try {
    order = await createOrder({
      productId: product.id,
      userId: input.userId,
      email: input.email,
      priceSek: held.record.reservedPriceSek ?? product.priceSek,
      reservationToken: held.token,
    });
    order = (await updateOrder(order.id, {
      deliveryFeeSek: deliveryFee,
      postalCode: input.postalCode,
      deliveryZone: zone?.id ?? null,
    }))!;

    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      // Kortet är obligatoriskt; Klarna och Swish aktiveras i Stripe-kontot och dyker upp av sig
      // själva när de är på. Att räkna upp dem här hade betytt ett fel för varje metod som inte är
      // aktiverad ännu.
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "sek",
            unit_amount: order.priceSek * 100,
            product_data: {
              name: product.title,
              description: product.condition ? `${product.condition.label} · Loopa-granskad` : undefined,
              images: product.imageUrl?.startsWith("http") ? [product.imageUrl] : undefined,
            },
          },
        },
        ...(deliveryFee > 0
          ? [
              {
                quantity: 1,
                price_data: {
                  currency: "sek" as const,
                  unit_amount: deliveryFee * 100,
                  product_data: { name: `Hemleverans – ${zone!.name}` },
                },
              },
            ]
          : []),
      ],
      ...(input.email ? { customer_email: input.email } : {}),
      // Referensen tas emot av webhooken. Den kommer tillbaka signerad från Stripe, till skillnad
      // från allt klienten skickar.
      client_reference_id: order.id,
      metadata: { orderId: order.id, productId: product.id, loopaId: product.id },
      success_url: `${publicUrl()}/butik/order/${order.id}?betald=1`,
      cancel_url: `${publicUrl()}/butik/objekt/${encodeURIComponent(product.id)}?avbruten=1`,
      // Stripes egen tidsgräns läggs strax innanför vår reservation, så fönstret aldrig står öppet
      // längre än möbeln faktiskt är hållen. Minsta tillåtna hos Stripe är 30 minuter.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    order = (await updateOrder(order.id, { stripeSessionId: session.id }))!;
    invalidate();
    if (!session.url) throw new CheckoutError("Stripe lämnade ingen betalningslänk.", 502);
    return { order, checkoutUrl: session.url };
  } catch (err) {
    // Faller något efter reservationen ska möbeln tillbaka i butiken direkt, inte om en kvart.
    await release(product.id, { kind: "system", job: "checkout-rollback" }, "Kassan kunde inte startas.");
    invalidate();
    throw err instanceof CheckoutError ? err : new CheckoutError(err instanceof Error ? err.message : "Kassan föll.", 502);
  }
}

/**
 * Steg 2: Stripe säger att betalningen gick igenom.
 *
 * `constructEvent` verifierar signaturen mot den RÅA kroppen — därför tas den som Buffer och inte
 * som ett tolkat objekt. Utan verifieringen kan vem som helst posta "betalt" till adressen och få en
 * soffa levererad.
 */
export function parseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = WEBHOOK_SECRET();
  if (!secret) throw new CheckoutError("STRIPE_WEBHOOK_SECRET saknas.", 503);
  try {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new CheckoutError(`Ogiltig Stripe-signatur: ${err instanceof Error ? err.message : "okänt fel"}`, 400);
  }
}

/**
 * Gör möbeln såld, och tar bort den från Tradera.
 *
 * AVPUBLICERINGEN LIGGER HÄR och inte i ett schemalagt jobb: möbeln är unik, den ligger uppe på två
 * ställen, och varje sekund den står kvar på Tradera efter att ha sålts hos oss är en sekund någon
 * kan lägga ett bud som vi inte kan infria. Att den kan misslyckas hanteras — köpet står kvar och
 * felet loggas — men den försöker omedelbart.
 */
export async function fulfilPaidOrder(orderId: string): Promise<Order | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  // Idempotent: Stripe skickar om webhooken vid minsta osäkerhet, och ett andra anrop får inte
  // försöka sälja möbeln igen.
  if (order.status !== "pending") return order;

  const sold = await claimForSale(order.productId, "butik", { kind: "buyer", userId: order.userId, orderId: order.id }, {
    requireToken: order.reservationToken,
  });

  if (!sold) {
    /**
     * Betalt men möbeln var borta. Det enda fall där dubbelförsäljningsskyddet syns utåt.
     *
     * Kan ske om möbeln såldes på Tradera i minuterna medan kortet drogs. Ordern markeras avbruten
     * och loggas skarpt — en människa måste återbetala och höra av sig. Vi låtsas inte att köpet
     * gick igenom.
     */
    console.error(`[butik] KRITISKT: order ${order.reference} betalades men ${order.productId} kunde inte säljas. Återbetalning krävs.`);
    const avbruten = await recordOrderEvent(order.id, {
      status: "cancelled",
      note: "Betalningen gick igenom men möbeln var redan såld i en annan kanal. Återbetalning krävs.",
      actor: "system",
      publik: true,
    });
    void notifyDoubleSale(avbruten ?? order);
    return avbruten;
  }

  const updated = await recordOrderEvent(order.id, {
    status: "paid",
    note: "Betalningen är genomförd. Nästa steg är att välja tider för leveransen.",
    actor: "system",
    publik: true,
  });
  invalidate();
  void delistFromTradera(order.productId);
  /**
   * Beskeden går EFTER att möbeln bytt ägare i lagret, och utan att invänta dem.
   *
   * Ordningen är inte godtycklig: ett kvitto på ett köp som sedan visade sig kollidera med en
   * Tradera-försäljning vore värre än ett sent kvitto. Och `void` för att en SMTP-server som hänger
   * aldrig får hålla kvar Stripes webhook — Stripe skickar om den då, och köpet hade fullföljts två
   * gånger.
   */
  if (updated) void notifyPurchase(updated, sold, await titleFor(updated.productId));
  return updated;
}

/**
 * Larmet när ett betalt köp inte kunde fullföljas.
 *
 * Det här är det enda stället i produkten där en människa MÅSTE agera manuellt och snabbt: pengar är
 * dragna för en möbel som inte finns. Tidigare stod det bara i journalen, där ingen läser det.
 */
async function notifyDoubleSale(order: Order): Promise<void> {
  const { notifyDoubleSaleLetter } = await import("./notiser.js");
  await notifyDoubleSaleLetter(order, await titleFor(order.productId));
}

/** Tar bort annonsen på Tradera. Loggar och går vidare om det inte går — köpet är redan giltigt. */
async function delistFromTradera(productId: string): Promise<void> {
  try {
    const record = await store().get(productId);
    if (!record?.jobId) return;
    const job = await getJob(record.jobId);
    const itemId = job?.tradera?.itemId;
    if (!itemId || job?.tradera?.status !== "published") return;
    await endTraderaItem(itemId);
    console.info(`[butik] ${productId} avpublicerad från Tradera (item ${itemId}) efter försäljning i Butik.`);
  } catch (err) {
    console.error(
      `[butik] Kunde INTE avpublicera ${productId} från Tradera: ${err instanceof Error ? err.message : err}. ` +
        "Annonsen kan ligga kvar och måste tas bort för hand.",
    );
  }
}

/**
 * Steg 3: köparen lämnar UPP TILL TRE tider som passar.
 *
 * TRE OCH INTE EN, och det är inte en bekvämlighet — det är skillnaden mellan ett löfte vi kan hålla
 * och ett vi hoppas på. Budfirman bokas av en människa hos oss, och en köpare som fått välja exakt
 * en tid har fått ett besked vi inte kunde ge: att just den tiden är ledig. Med tre alternativ är
 * sannolikheten hög att första försöket räcker, och köparen slipper en andra runda.
 *
 * ORDNINGEN BETYDER NÅGOT. Tiderna sparas i den ordning köparen angav dem, och panelen provar dem
 * uppifrån. Förstahandsvalet är det köparen faktiskt vill ha.
 *
 * Ordern går till `booking` — "vi bokar frakt" — och INTE till `scheduled`. Ingen tid är utlovad
 * förrän en människa bekräftat den, och att skriva in en önskad tid i `deliveryDate` hade betytt att
 * köparen läser "Frakt bokad" på något ingen bokat.
 */
export async function requestSlots(orderId: string, slots: OrderSlot[]): Promise<Order | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status !== "paid" && order.status !== "booking") {
    throw new CheckoutError("Ordern är inte betald, eller så är frakten redan bokad.", 409);
  }
  if (order.postalCode && !zoneFor(order.postalCode)) {
    throw new CheckoutError("Ordern har ingen leveranszon — vi hör av oss om upphämtning.", 409);
  }
  const rensade = slots
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && typeof s.window === "string" && s.window.length <= 12)
    .slice(0, 3);
  if (rensade.length === 0) throw new CheckoutError("Ange minst en tid som passar.", 400);

  const uppdaterad = await recordOrderEvent(
    order.id,
    {
      status: "booking",
      note: `Vi bokar frakt. Vi försöker med ${rensade.length === 1 ? "tiden" : "dessa tider"} du valde.`,
      actor: "buyer",
      publik: true,
    },
    { requestedSlots: rensade },
  );
  if (uppdaterad) void notifySlotsRequested(uppdaterad, await titleFor(uppdaterad.productId));
  return uppdaterad;
}

/**
 * Frakten är bokad. Sätts av en admin, aldrig av köparen.
 *
 * Tiden behöver INTE vara en av köparens tre. Budfirman kan svara "onsdag går inte, men torsdag
 * morgon" och då är det den tiden som gäller — panelen skriver in den, köparen får beskedet, och
 * historiken visar båda: vad som önskades och vad som blev.
 */
export async function confirmDelivery(orderId: string, date: string, window: string, note?: string): Promise<Order | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status !== "paid" && order.status !== "booking" && order.status !== "scheduled") {
    throw new CheckoutError(`Går inte att boka frakt från läget "${order.status}".`, 409);
  }
  const uppdaterad = await recordOrderEvent(
    order.id,
    {
      status: "scheduled",
      note: note?.trim() || `Frakt bokad: ${date} ${window}.`,
      actor: "admin",
      publik: true,
    },
    { deliveryDate: date, deliveryWindow: window },
  );
  if (uppdaterad) {
    const record = await store().get(uppdaterad.productId);
    void notifyDeliveryBooked(uppdaterad, record, await titleFor(uppdaterad.productId));
  }
  return uppdaterad;
}

/**
 * Levererad. Flyttar ORDERN och MÖBELN i samma anrop.
 *
 * De två har glidit isär förut: panelens "levererad" flyttade bara butiksposten, medan ordern stod
 * kvar på `scheduled` — och köparens stegrad tändes därför aldrig. Möbelns tillstånd och köpets
 * tillstånd är två svar på olika frågor, men "den är framme" är samma händelse för båda.
 */
export async function markOrderDelivered(orderId: string): Promise<Order | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status !== "scheduled" && order.status !== "booking" && order.status !== "paid") {
    throw new CheckoutError(`Går inte att leverera från läget "${order.status}".`, 409);
  }
  const uppdaterad = await recordOrderEvent(order.id, {
    status: "delivered",
    note: "Levererad och inburen.",
    actor: "admin",
    publik: true,
  });
  if (uppdaterad) {
    const record = await store().get(uppdaterad.productId);
    void notifyDelivered(uppdaterad, record, await titleFor(uppdaterad.productId));
  }
  return uppdaterad;
}

/**
 * Möbelns rubrik för ett brev. Faller tillbaka på id:t.
 *
 * Breven ska kunna nämna möbeln vid namn — "Din möbel är såld" utan att säga vilken är ett dåligt
 * besked för en säljare med tre annonser ute.
 */
async function titleFor(productId: string): Promise<string> {
  try {
    const record = await store().get(productId);
    if (!record?.jobId) return productId;
    const { getJob } = await import("../jobStore.js");
    const job = await getJob(record.jobId);
    const listing = job?.result?.listing ?? job?.listing ?? null;
    return listing?.result?.listing.title ?? productId;
  } catch {
    return productId;
  }
}

/** Avbruten kassa: köparen backade ur. Släpper möbeln direkt i stället för att vänta ut klockan. */
export async function abandonCheckout(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.status !== "pending") return;
  await updateOrder(order.id, { status: "cancelled" });
  await release(order.productId, { kind: "buyer", userId: order.userId }, "Kassan avbröts.");
  invalidate();
}
