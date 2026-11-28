/**
 * Leveransadressen på fraktsidan: köparen ändrar den själv, eller ber oss granska den.
 *
 * VI KÖR BARA INOM ZONERNA (Storstockholm med omnejd, se delivery.ts). Den som anger en adress
 * utanför får inte välja tider — sidan ber om en adress inom området. Den som inte hittar sin adress
 * (nybygge, ett postnummer i kanten av zonen, en adress Google inte känner) skriver den i klartext;
 * då mejlas Isac, ordern får en siffra i panelen, och en admin godkänner eller avvisar.
 */
import { sendLetter } from "../efterlysning/notify.js";
import { normalizePostal, zoneFor, type DeliveryZone } from "./delivery.js";
import { recordOrderEvent, type Order, type OrderPart } from "./orders.js";
import { fraktNotisMottagare } from "./notiser.js";
import { productById } from "./inventory.js";
import { fraktLank } from "../integrations/tradera/betald.js";
import { sendSms } from "../notify/sms.js";

function fornamn(order: Order): string {
  return order.kopare?.namn?.trim().split(/\s+/)[0] ?? "";
}

/** SMS till köparen om adressen. Utfallet skrivs i historiken, som för fraktlänken. */
async function smsaKoparen(order: Order, text: string, kind: string): Promise<void> {
  const to = order.kopare?.telefon;
  if (!to) return;
  const r = await sendSms({ to, text, kind });
  await recordOrderEvent(order.id, {
    status: null,
    note: r.sent ? `SMS skickat till köparen (${kind}).` : `SMS till köparen gick inte iväg (${kind}): ${r.error ?? "okänt fel"}`,
    actor: "system",
    publik: false,
  });
}

export class FraktAdressFel extends Error {
  constructor(message: string, readonly status: number, readonly kod: "ogiltig" | "utanfor" | "last") {
    super(message);
  }
}

/** Zonen för en adress som en admin godkänt för hand. Tiderna räknas inte på zonen (se slotsFor). */
export const MANUELL_ZON: DeliveryZone = { id: "manuell", name: "Manuellt godkänd adress", feeSek: 0, leadDays: 2 };

/** Zonen ordern levereras i, eller null om adressen ligger utanför och inte är godkänd. */
export function fraktZon(order: Pick<Order, "postalCode" | "adressGranskning">): DeliveryZone | null {
  if (order.postalCode) {
    const zon = zoneFor(order.postalCode);
    if (zon) return zon;
  }
  return order.adressGranskning?.status === "godkand" ? MANUELL_ZON : null;
}

export interface NyAdress {
  adress?: string | null;
  postnummer?: string | null;
  ort?: string | null;
}

function rensa(input: NyAdress): { adress: string; postnummer: string; ort: string } {
  const adress = (input.adress ?? "").trim().slice(0, 120);
  const postnummer = normalizePostal(input.postnummer ?? "");
  const ort = (input.ort ?? "").trim().slice(0, 60);
  if (!adress) throw new FraktAdressFel("Skriv gatuadressen.", 400, "ogiltig");
  if (postnummer.length !== 5) throw new FraktAdressFel("Postnumret ska vara fem siffror.", 400, "ogiltig");
  if (!ort) throw new FraktAdressFel("Skriv orten.", 400, "ogiltig");
  return { adress, postnummer, ort };
}

function adressRad(p: Pick<OrderPart, "adress" | "postnummer" | "ort"> | null | undefined): string {
  if (!p) return "—";
  return [p.adress, [p.postnummer, p.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—";
}

function kanAndras(order: Order): void {
  if (order.status !== "paid") throw new FraktAdressFel("Tiderna är redan skickade — hör av dig till oss för att ändra adressen.", 409, "last");
}

/** Köparen byter leveransadress. Inom zonen: sparas direkt. Utanför: 422 och ingenting ändras. */
export async function andraFraktAdress(order: Order, input: NyAdress): Promise<Order> {
  kanAndras(order);
  const ny = rensa(input);
  const product = await productById(order.productId).catch(() => null);
  const zon = zoneFor(ny.postnummer, product?.categorySlug);
  if (!zon) {
    throw new FraktAdressFel(
      "Vi levererar bara inom Storstockholm med omnejd. Ange en adress inom området — eller skicka adressen till oss för granskning.",
      422,
      "utanfor",
    );
  }
  const forut = adressRad(order.kopare);
  const kopare: OrderPart = { ...(order.kopare ?? { alias: null, namn: null, email: order.email, telefon: null, adress: null, postnummer: null, ort: null }), ...ny };
  const updated = await recordOrderEvent(
    order.id,
    { status: null, note: `Köparen ändrade leveransadressen till ${adressRad(kopare)} (var ${forut}).`, actor: "buyer", publik: false },
    { kopare, postalCode: ny.postnummer, deliveryZone: zon.id, adressGranskning: null },
  );
  if (!updated) throw new FraktAdressFel("Ordern finns inte.", 404, "last");
  return updated;
}

/** "Hittar du inte din adress?" — fritext till oss, mejl till Isac, siffra i panelen. */
export async function begarAdressGranskning(order: Order, text: string, titel: string): Promise<Order> {
  kanAndras(order);
  const rent = text.trim().slice(0, 500);
  if (rent.length < 5) throw new FraktAdressFel("Skriv adressen, gärna med postnummer och ort.", 400, "ogiltig");
  const updated = await recordOrderEvent(
    order.id,
    { status: null, note: `Köparen bad oss granska adressen: "${rent}"`, actor: "buyer", publik: false },
    { adressGranskning: { text: rent, status: "vantar", at: new Date().toISOString(), hanteradAt: null } },
  );
  if (!updated) throw new FraktAdressFel("Ordern finns inte.", 404, "last");

  const panel = `${(process.env.LOOPA_PUBLIC_URL?.trim() || "https://app.loopa.nu").replace(/\/+$/, "")}/?admin=1`;
  for (const to of fraktNotisMottagare()) {
    await sendLetter({
      to,
      subject: `Adress att granska: ${titel} (${order.reference})`,
      kind: "ops-adress-granskning",
      body: [
        "En köpare hittade inte sin adress på fraktsidan och bad oss granska den.",
        "",
        `Angiven adress: ${rent}`,
        "",
        `Möbel: ${titel}`,
        `Order: ${order.reference}`,
        `Namn: ${order.kopare?.namn ?? "—"}`,
        `Telefon: ${order.kopare?.telefon ?? "saknas"}`,
        `E-post: ${order.kopare?.email ?? order.email ?? "saknas"}`,
        `Adress från Tradera: ${adressRad(order.kopare)}`,
        order.tradera ? `Tradera-order: ${order.tradera.ordernummer}` : null,
        "",
        "Godkänn eller avvisa under Ordrar i panelen. Godkänner du får köparen ett SMS och kan välja tider.",
        panel,
      ].filter((l) => l !== null).join("\n"),
    });
  }
  return updated;
}

/** Admin godkänner: adressen sätts (som admin skrev den) och köparen kan välja tider. */
export async function godkannAdress(order: Order, input: NyAdress): Promise<Order> {
  if (order.status !== "paid") throw new FraktAdressFel("Ordern väntar inte på en adress.", 409, "last");
  const ny = rensa(input);
  const kopare: OrderPart = { ...(order.kopare ?? { alias: null, namn: null, email: order.email, telefon: null, adress: null, postnummer: null, ort: null }), ...ny };
  const zon = zoneFor(ny.postnummer);
  const updated = await recordOrderEvent(
    order.id,
    { status: null, note: `Adressen godkänd för leverans: ${adressRad(kopare)}.`, actor: "admin", publik: false },
    {
      kopare,
      postalCode: ny.postnummer,
      deliveryZone: zon?.id ?? MANUELL_ZON.id,
      adressGranskning: { text: order.adressGranskning?.text ?? adressRad(kopare), status: "godkand", at: order.adressGranskning?.at ?? new Date().toISOString(), hanteradAt: new Date().toISOString() },
    },
  );
  if (!updated) throw new FraktAdressFel("Ordern finns inte.", 404, "last");
  const hej = fornamn(updated) ? `Hej ${fornamn(updated)}! ` : "Hej! ";
  await smsaKoparen(updated, `${hej}Vi kan leverera till ${ny.adress}, ${ny.ort}. Välj när vi får komma: ${fraktLank(updated)} /Loopa`, "frakt-adress-godkand");
  return updated;
}

/** Admin avvisar: köparen ser att vi inte kan leverera dit och kan ange en annan adress. */
export async function avvisaAdress(order: Order, skal?: string): Promise<Order> {
  if (!order.adressGranskning) throw new FraktAdressFel("Det finns ingen adress att avvisa.", 409, "last");
  const updated = await recordOrderEvent(
    order.id,
    { status: null, note: `Adressen avvisad${skal?.trim() ? `: ${skal.trim()}` : "."}`, actor: "admin", publik: false },
    { adressGranskning: { ...order.adressGranskning, status: "avvisad", hanteradAt: new Date().toISOString() } },
  );
  if (!updated) throw new FraktAdressFel("Ordern finns inte.", 404, "last");
  const hej = fornamn(updated) ? `Hej ${fornamn(updated)}! ` : "Hej! ";
  await smsaKoparen(updated, `${hej}Vi kan tyvärr inte leverera till adressen du angav. Ange en annan adress inom Storstockholm här: ${fraktLank(updated)} /Loopa`, "frakt-adress-avvisad");
  return updated;
}
