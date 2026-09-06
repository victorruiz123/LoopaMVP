/**
 * Ordern: det som håller ihop betalningen, leveransen och möbelns tillstånd.
 *
 * Skild från ButikRecord med flit. Posten i butikslagret svarar på "var är möbeln i sitt liv" och
 * finns i exakt ett exemplar per möbel för alltid. Ordern svarar på "vad hände i det här köpet" och
 * kan bli fler än en om ett köp återgår och möbeln säljs igen. Att lägga köparens adress på
 * produkten hade gjort det omöjligt att sälja samma soffa två gånger utan att skriva över den
 * förstas historia.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

export type OrderStatus =
  | "pending"
  | "paid"
  | "scheduled"
  | "delivered"
  | "return_requested"
  | "returned"
  | "cancelled";

export interface Order {
  id: string;
  productId: string;
  /** Loopa-ID:t är läsbart; ordernumret är det köparen uppger. */
  reference: string;
  userId: string | null;
  email: string | null;
  /** Priset som gällde vid reservationen. Prisstegen får inte flytta det mitt i ett köp. */
  priceSek: number;
  deliveryFeeSek: number;
  postalCode: string | null;
  deliveryZone: string | null;
  /** Vald leveranstid, satt efter betalningen. */
  deliveryDate: string | null;
  deliveryWindow: string | null;
  status: OrderStatus;
  stripeSessionId: string | null;
  /** Reservationens token — knyter ordern till just den hållningen av möbeln. */
  reservationToken: string | null;
  createdAt: string;
  updatedAt: string;
}

const ORDERS_FILE = () =>
  path.join(process.env.BUTIK_DATA_DIR?.trim() || path.join(DATA_DIR, "butik"), "orders.json");

let cache: Map<string, Order> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Map<string, Order>> {
  if (cache) return cache;
  try {
    const rows = JSON.parse(await readFile(ORDERS_FILE(), "utf-8")) as Order[];
    cache = new Map(rows.map((o) => [o.id, o]));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function flush(): Promise<void> {
  const rows = [...(await load()).values()];
  await mkdir(path.dirname(ORDERS_FILE()), { recursive: true });
  await writeFile(ORDERS_FILE(), JSON.stringify(rows, null, 2), "utf-8");
}

/** Ordernumret köparen läser upp i telefon. Inga tecken som går att höra fel: 0/O, 1/I. */
function makeReference(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `LO-${out}`;
}

export async function createOrder(input: {
  productId: string;
  userId: string | null;
  email: string | null;
  priceSek: number;
  reservationToken: string;
}): Promise<Order> {
  return serialize(async () => {
    const now = new Date().toISOString();
    const order: Order = {
      id: randomUUID(),
      productId: input.productId,
      reference: makeReference(),
      userId: input.userId,
      email: input.email,
      priceSek: input.priceSek,
      deliveryFeeSek: 0,
      postalCode: null,
      deliveryZone: null,
      deliveryDate: null,
      deliveryWindow: null,
      status: "pending",
      stripeSessionId: null,
      reservationToken: input.reservationToken,
      createdAt: now,
      updatedAt: now,
    };
    (await load()).set(order.id, order);
    await flush();
    return order;
  });
}

export async function getOrder(id: string): Promise<Order | null> {
  return (await load()).get(id) ?? null;
}

export async function orderByReference(reference: string): Promise<Order | null> {
  const wanted = reference.trim().toUpperCase();
  for (const o of (await load()).values()) if (o.reference === wanted) return o;
  return null;
}

export async function orderByStripeSession(sessionId: string): Promise<Order | null> {
  for (const o of (await load()).values()) if (o.stripeSessionId === sessionId) return o;
  return null;
}

export async function ordersForProduct(productId: string): Promise<Order[]> {
  return [...(await load()).values()].filter((o) => o.productId === productId);
}

/**
 * Alla ordrar, i en läsning.
 *
 * Finns för adminpanelens annonslista, som vill veta antalet ordrar på 193 möbler samtidigt.
 * `ordersForProduct` i en slinga hade läst samma fil en gång per rad — samma fil, samma svar, 193
 * gånger. Ingen annan än panelen har anledning att läsa hela listan.
 */
export async function allOrders(): Promise<Order[]> {
  return [...(await load()).values()];
}

/**
 * Köparens egna ordrar, nyast först.
 *
 * `pending` följer med. En påbörjad kassa som aldrig blev betald är inte skräp för den som står i
 * den — det är den enda vägen tillbaka till möbeln de höll på att köpa, och reservationen lever
 * ändå i tjugo minuter. Att dölja den hade betytt att köparen som stängde Stripe-fliken inte kunde
 * hitta tillbaka.
 */
export async function ordersForUser(userId: string): Promise<Order[]> {
  return [...(await load()).values()]
    .filter((o) => o.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function updateOrder(id: string, patch: Partial<Order>): Promise<Order | null> {
  return serialize(async () => {
    const map = await load();
    const current = map.get(id);
    if (!current) return null;
    const next: Order = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    map.set(id, next);
    await flush();
    return next;
  });
}

/** Bara för tester. */
export function resetOrders(): void {
  cache = null;
}
