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
import { createOrder, getOrder, orderByStripeSession, updateOrder, type Order } from "./orders.js";
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
    return updateOrder(order.id, { status: "cancelled" });
  }

  const updated = await updateOrder(order.id, { status: "paid" });
  invalidate();
  void delistFromTradera(order.productId);
  return updated;
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

/** Steg 3: köparen väljer leveranstid efter betalningen. */
export async function chooseSlot(orderId: string, date: string, window: string): Promise<Order | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (order.status !== "paid" && order.status !== "scheduled") {
    throw new CheckoutError("Ordern är inte betald.", 409);
  }
  if (order.postalCode && !zoneFor(order.postalCode)) {
    throw new CheckoutError("Ordern har ingen leveranszon — vi hör av oss om upphämtning.", 409);
  }
  return updateOrder(order.id, { deliveryDate: date, deliveryWindow: window, status: "scheduled" });
}

/** Avbruten kassa: köparen backade ur. Släpper möbeln direkt i stället för att vänta ut klockan. */
export async function abandonCheckout(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.status !== "pending") return;
  await updateOrder(order.id, { status: "cancelled" });
  await release(order.productId, { kind: "buyer", userId: order.userId }, "Kassan avbröts.");
  invalidate();
}
