/**
 * Ett betalt Tradera-köp blir en order hos oss — och köparen får länken där leveranstiden väljs.
 *
 * KEDJAN, när "Betalt objekt"-mejlet kommit och orderspecifikationen är läst (orderspec.ts):
 *
 *   1. En order skapas i `paid` med köparens namn, adress, e-post och telefon, och med Tradera-
 *      kontots säljaruppgifter och kopplingen till annonsen (jobbet) under `tradera`.
 *   2. Jobbet får en rad i `traderaOrdrar` som pekar tillbaka på ordern — annonsen vet vem som
 *      köpte den, och panelen kan gå från annonsen till köpet.
 *   3. Köparen får fraktlänken: ett SMS till numret i specifikationen, och samma länk med e-post.
 *      Det som INTE gick fram skrivs på ordern som en intern rad, så att panelen ser det.
 *
 * IDEMPOTENT. Samma ordernummer blir aldrig två ordrar och aldrig två SMS: kommer mejlet igen
 * returneras den befintliga ordern och ingenting skickas.
 */

import { getJob, persist } from "../../jobStore.js";
import { zoneFor } from "../../butik/delivery.js";
import { createTraderaOrder, recordOrderEvent, type Order, type OrderPart } from "../../butik/orders.js";
import { sender } from "../../notify/outbox.js";
import { sendSms, smsDelar, type SmsResult } from "../../notify/sms.js";
import { SHIPPING_INCLUDED_SEK } from "../../hemleverans.js";
import type { ConditionJob } from "../../types.js";
import type { BetaltMejl, OrderKontakt, Orderspecifikation } from "./orderspec.js";

/** Adressen länkarna byggs på. Samma förval som resten av produktens publika länkar. */
export function publicBase(): string {
  return (process.env.LOOPA_PUBLIC_URL?.trim() || "https://app.loopa.nu").replace(/\/+$/, "");
}

export function fraktLank(order: Pick<Order, "fraktToken">): string {
  return `${publicBase()}/butik/frakt/${order.fraktToken}`;
}

/** Förnamnet, för hälsningen. "Kim Köpare" → "Kim". Inget namn → ingen hälsning med namn. */
function fornamn(namn: string | null): string | null {
  const f = namn?.trim().split(/\s+/)[0];
  return f && f.length >= 2 ? f : null;
}

/**
 * Rubriken kortad till något som ryms i ett SMS. Klipps vid ett ord, inte mitt i det.
 *
 * Tre punkter och inte "…": ellipsen finns inte i GSM-alfabetet, och ETT sådant tecken gör hela
 * SMS:et till Unicode — 70 tecken per del i stället för 160, och tre SMS i stället för två.
 */
export function kortTitel(titel: string | null, max = 60): string {
  const t = (titel ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "möbeln";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[,.;:–-]+$/, "")}...`;
}

/**
 * SMS:et. Kort, och med länken som enda uppmaning.
 *
 * Svarar på de tre frågor köparen har: vem är det här (Loopa, köpet på Tradera), vad ska jag göra
 * (välja tid), och hur (länken). Fraktpriset och adressen står på sidan bakom länken.
 */
export function smsText(input: { namn: string | null; titel: string | null; lank: string }): string {
  const hej = fornamn(input.namn) ? `Hej ${fornamn(input.namn)}!` : "Hej!";
  return `${hej} Tack för ditt köp av ${kortTitel(input.titel)} på Tradera. Välj när vi kör hem den till dig: ${input.lank} /Loopa`;
}

export function mejlText(input: { namn: string | null; titel: string | null; lank: string; ordernummer: string; adress: string | null }): {
  subject: string;
  body: string;
} {
  const hej = fornamn(input.namn) ? `Hej ${fornamn(input.namn)}!` : "Hej!";
  return {
    subject: `Välj leveranstid för ${kortTitel(input.titel, 60)}`,
    body: [
      hej,
      "",
      `Tack för ditt köp av ${input.titel ?? "möbeln"} på Tradera (order ${input.ordernummer}).`,
      "",
      "Vi kör hem möbeln och bär in den till din dörr. Välj upp till tre tider som passar — förmiddag eller eftermiddag de närmaste arbetsdagarna — så bokar vi budet:",
      "",
      input.lank,
      "",
      input.adress ? `Vi levererar till: ${input.adress}. Stämmer inte adressen? Svara på det här mejlet.` : "Svara på det här mejlet om du har frågor.",
      "",
      "Vänliga hälsningar,",
      "Loopa",
    ].join("\n"),
  };
}

function part(k: OrderKontakt): OrderPart {
  return { alias: k.alias, namn: k.namn, adress: k.adress, postnummer: k.postnummer, ort: k.ort, email: k.email, telefon: k.telefon };
}

function adressRad(k: OrderPart): string | null {
  const ort = [k.postnummer, k.ort].filter(Boolean).join(" ");
  const rad = [k.adress, ort].filter(Boolean).join(", ");
  return rad || null;
}

/**
 * Möbelpriset och frakten ur det köparen betalade.
 *
 * Två sorters annonser: frakten som egen rad hos Tradera (`fraktSeparat`) eller inbakad i priset.
 * Står en fraktrad över noll i specifikationen är det den. Annars dras annonsens inbakade frakt av,
 * så att ordern visar samma uppdelning som en butiksorder: möbeln plus hemleveransen.
 */
export function prisUppdelning(spec: Pick<Orderspecifikation, "totaltSek" | "fraktSek">, job: ConditionJob | null): {
  priceSek: number;
  deliveryFeeSek: number;
} {
  const totalt = spec.totaltSek ?? 0;
  if ((spec.fraktSek ?? 0) > 0) return { priceSek: Math.max(0, totalt - spec.fraktSek!), deliveryFeeSek: spec.fraktSek! };
  if (job?.tradera?.fraktSeparat) return { priceSek: totalt, deliveryFeeSek: 0 };
  const inbakad = job?.tradera?.shippingSek ?? SHIPPING_INCLUDED_SEK;
  if (totalt <= inbakad) return { priceSek: totalt, deliveryFeeSek: 0 };
  return { priceSek: totalt - inbakad, deliveryFeeSek: inbakad };
}

export interface BetaltUtfall {
  order: Order;
  created: boolean;
  sms: SmsResult | null;
  mejl: "skickat" | "misslyckat" | "ingen-adress" | null;
}

export async function hanteraBetaltKop(input: {
  meta: BetaltMejl;
  spec: Orderspecifikation;
  messageId: string;
  receivedAt: string;
  job: ConditionJob | null;
  loopaId: string;
  titel: string | null;
  categorySlug?: string | null;
}): Promise<BetaltUtfall> {
  const { meta, spec, job, loopaId } = input;
  const ordernummer = spec.ordernummer ?? meta.ordernummer ?? `okänd-${input.messageId}`;
  const kopare = part(spec.kopare);
  const { priceSek, deliveryFeeSek } = prisUppdelning(spec, job);
  const zon = kopare.postnummer ? zoneFor(kopare.postnummer, input.categorySlug ?? null) : null;

  const { order, created } = await createTraderaOrder({
    productId: loopaId,
    priceSek,
    deliveryFeeSek,
    kopare,
    zone: zon?.id ?? null,
    tradera: {
      ordernummer,
      itemId: meta.itemId ?? spec.objektnr[0] ?? null,
      purchaseOrderId: meta.purchaseOrderId,
      jobId: job?.id ?? meta.egenReferens,
      jobOwnerId: job?.ownerId ?? null,
      saljare: part(spec.saljare),
      totaltSek: spec.totaltSek,
      betalmetod: spec.betalmetod,
      betaldAt: input.receivedAt,
      messageId: input.messageId,
    },
  });
  if (!created) return { order, created, sms: null, mejl: null };

  // Annonsen får veta vem som köpte den.
  if (job) {
    try {
      const fresh = (await getJob(job.id)) ?? job;
      const rader = fresh.traderaOrdrar ?? [];
      if (!rader.some((r) => r.ordernummer === ordernummer)) {
        fresh.traderaOrdrar = [
          ...rader,
          {
            orderId: order.id,
            reference: order.reference,
            ordernummer,
            itemId: order.tradera?.itemId ?? null,
            betaldAt: input.receivedAt,
            kopare: { alias: kopare.alias, namn: kopare.namn, ort: kopare.ort },
            saljare: part(spec.saljare),
          },
        ];
        await persist(fresh);
      }
    } catch (err) {
      console.warn(`[tradera-betald] ${loopaId}: kunde inte skriva ordern på jobbet:`, err instanceof Error ? err.message : err);
    }
  }

  if (!zon) {
    await recordOrderEvent(order.id, {
      status: null,
      note: `Postnumret ${kopare.postnummer ?? "saknas"} ligger utanför leveranszonerna — kontakta köparen om leveransen.`,
      actor: "system",
      publik: false,
    });
  }

  const lank = fraktLank(order);

  // SMS:et.
  let sms: SmsResult | null = null;
  if (kopare.telefon) {
    const text = smsText({ namn: kopare.namn, titel: input.titel, lank });
    sms = await sendSms({ to: kopare.telefon, text, kind: "tradera-frakt" });
    await recordOrderEvent(order.id, {
      status: null,
      note: sms.sent
        ? `SMS med fraktlänken skickat till ${kopare.telefon} (${smsDelar(text)} del${smsDelar(text) === 1 ? "" : "ar"}).`
        : `SMS till ${kopare.telefon} gick INTE iväg: ${sms.error ?? "okänt fel"}.`,
      actor: "system",
      publik: false,
    });
  } else {
    await recordOrderEvent(order.id, {
      status: null,
      note: "Inget telefonnummer i Traderas orderspecifikation — inget SMS skickat.",
      actor: "system",
      publik: false,
    });
  }

  // Mejlet, alltid när adressen finns: det är kvittot på länken, och reserven om SMS:et inte kom fram.
  let mejl: BetaltUtfall["mejl"] = null;
  if (kopare.email) {
    const m = mejlText({ namn: kopare.namn, titel: input.titel, lank, ordernummer, adress: adressRad(kopare) });
    try {
      await sender().send({ to: kopare.email, subject: m.subject, body: m.body, kind: "tradera-frakt" });
      mejl = "skickat";
    } catch (err) {
      mejl = "misslyckat";
      await recordOrderEvent(order.id, {
        status: null,
        note: `Mejlet med fraktlänken till ${kopare.email} gick inte iväg: ${err instanceof Error ? err.message : String(err)}.`,
        actor: "system",
        publik: false,
      });
    }
  } else {
    mejl = "ingen-adress";
  }

  return { order, created, sms, mejl };
}
