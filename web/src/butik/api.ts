/**
 * Butikens anrop.
 *
 * Skilda från web/src/api.ts med flit: DE anropen bär säljarens Supabase-token, för de rör någons
 * jobb och någons profil. Butikens läsande vägar är publika och ska vara det — en sökmotor och en
 * besökare utan konto måste kunna hämta samma rutnät. Att skicka ett inloggningshuvud här hade gjort
 * butiken oåtkomlig för precis den trafik den byggs för.
 */

import type { BrandFacet, BrowseResult, Category, FurnitureType, Product, SortKey } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Anropet misslyckades (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface BrowseQuery {
  q?: string | null;
  kategori?: string | null;
  /** Möbeltyp, t.ex. "matbord". Se /api/butik/mobeltyper. */
  typ?: string | null;
  marke?: string[] | null;
  onlyLoopa?: boolean;
  minPris?: number | null;
  maxPris?: number | null;
  skick?: string[] | null;
  maxBredd?: number | null;
  maxDjup?: number | null;
  maxHojd?: number | null;
  farg?: string[] | null;
  material?: string[] | null;
  hemleverans?: boolean;
  sortering?: SortKey;
  antal?: number;
  fran?: number;
}

/**
 * Frågan som en söksträng.
 *
 * Samma parametrar som servern läser (se routes.ts) och samma svenska namn: adressen är en del av
 * gränssnittet, och `?kategori=stolar&maxbredd=80` går att läsa i en delad länk.
 */
export function browseParams(query: BrowseQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.kategori) p.set("kategori", query.kategori);
  if (query.typ) p.set("typ", query.typ);
  if (query.marke?.length) p.set("marke", query.marke.join(","));
  if (query.onlyLoopa) p.set("kalla", "loopa");
  if (query.minPris != null) p.set("minpris", String(query.minPris));
  if (query.maxPris != null) p.set("maxpris", String(query.maxPris));
  if (query.skick?.length) p.set("skick", query.skick.join(","));
  if (query.maxBredd != null) p.set("maxbredd", String(query.maxBredd));
  if (query.maxDjup != null) p.set("maxdjup", String(query.maxDjup));
  if (query.maxHojd != null) p.set("maxhojd", String(query.maxHojd));
  if (query.farg?.length) p.set("farg", query.farg.join(","));
  if (query.material?.length) p.set("material", query.material.join(","));
  if (query.hemleverans) p.set("leverans", "hem");
  if (query.sortering && query.sortering !== "relevans") p.set("sortering", query.sortering);
  if (query.antal != null) p.set("antal", String(query.antal));
  if (query.fran) p.set("fran", String(query.fran));
  return p;
}

export function browse(query: BrowseQuery): Promise<BrowseResult> {
  return getJson<BrowseResult>(`/api/butik/produkter?${browseParams(query).toString()}`);
}

export function fetchCategories(): Promise<{ categories: Category[] }> {
  return getJson("/api/butik/kategorier");
}

export function fetchBrands(): Promise<{ brands: BrandFacet[] }> {
  return getJson("/api/butik/marken");
}

/** Möbeltyperna med varor i lager. Driver typbrickorna på startsidan. */
export function fetchTypes(): Promise<{ types: FurnitureType[] }> {
  return getJson("/api/butik/mobeltyper");
}

/** En typsida: katalogposten, kategorin den hör till och dess syskon. Rutnätet hämtas för sig. */
export function fetchType(slug: string): Promise<{
  type: Omit<FurnitureType, "count" | "loopa" | "tradera">;
  category: Category | null;
  siblings: Array<Omit<FurnitureType, "count" | "loopa" | "tradera">>;
  total: number;
}> {
  return getJson(`/api/butik/mobeltyper/${encodeURIComponent(slug)}?antal=1`);
}

export function fetchProduct(id: string): Promise<{ product: Product }> {
  return getJson(`/api/butik/produkter/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Kassan och ordern — de enda butiksanropen som kräver inloggning
// ---------------------------------------------------------------------------

import { supabase } from "../lib/supabase";

export interface DeliveryZone { id: string; name: string; feeSek: number; leadDays: number }
export interface DeliverySlot { date: string; label: string; window: string }
export interface DeliveryQuote {
  deliverable: boolean;
  zone: DeliveryZone | null;
  slots: DeliverySlot[];
  message: string;
  checkoutConfigured: boolean;
}

/** Se server/src/butik/orders.ts — `booking` är "vi bokar frakt", `scheduled` är "frakt bokad". */
export type OrderStatus =
  | "pending"
  | "paid"
  | "booking"
  | "scheduled"
  | "delivered"
  | "return_requested"
  | "returned"
  | "cancelled";

/** En tid köparen kan ta emot möbeln. Samma form som serverns OrderSlot. */
export interface OrderSlot {
  date: string;
  window: string;
}

/**
 * En rad i orderns historik.
 *
 * Bara de publika raderna når hit — servern filtrerar (se butik/orders.ts `publikHistorik`), så
 * interna anteckningar från panelen kan aldrig råka renderas för en köpare.
 */
export interface OrderEvent {
  at: string;
  status: OrderStatus | null;
  note: string;
  actor: "buyer" | "admin" | "system";
}

export interface Order {
  id: string;
  productId: string;
  reference: string;
  priceSek: number;
  deliveryFeeSek: number;
  postalCode: string | null;
  deliveryZone: string | null;
  /** BOKAD tid. Null ända tills en människa bekräftat frakten. */
  deliveryDate: string | null;
  deliveryWindow: string | null;
  /** Tiderna köparen sagt passar, i den ordning de valdes. */
  requestedSlots: OrderSlot[];
  status: OrderStatus;
  /** Historiken, nyast sist. Tom på gamla ordrar från före tidslinjen. */
  events?: OrderEvent[];
  createdAt: string;
}

/** Leveransbeskedet är PUBLIKT — man ska kunna se pris och tid innan man loggar in. */
export function fetchDelivery(postal: string): Promise<DeliveryQuote> {
  return getJson(`/api/butik/leverans?postnummer=${encodeURIComponent(postal)}`);
}

/**
 * Anropen som rör en order bär säljarens/köparens token.
 *
 * Samma mekanik som web/src/api.ts, men lokal här: butikens läsande vägar ska INTE bära något
 * huvud (se filens topp), och en delad hjälpare hade gjort det lätt att råka lägga på ett.
 */
async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Logga in för att fortsätta.");
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}

async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Anropet misslyckades (${res.status})`);
  return body as T;
}

export function startCheckout(productId: string, postal: string): Promise<{ orderId: string; reference: string; checkoutUrl: string }> {
  return authJson("/api/butik/kassa", { method: "POST", body: JSON.stringify({ produkt: productId, postnummer: postal }) });
}

export function fetchOrder(id: string): Promise<{ order: Order; product: Product | null }> {
  return authJson(`/api/butik/order/${encodeURIComponent(id)}`);
}

/** Mina köp. Möbeln följer med per order — en rad utan bild är ett belopp och ett datum. */
export function fetchMyOrders(): Promise<{ orders: Array<{ order: Order; product: Product | null }> }> {
  return authJson("/api/butik/order");
}

/**
 * Köparen lämnar upp till tre tider som passar.
 *
 * Ordningen bevaras hela vägen: den första i listan är förstahandsvalet, och det är den panelen
 * försöker boka först.
 */
export function requestSlots(orderId: string, tider: OrderSlot[]): Promise<{ order: Order }> {
  return authJson(`/api/butik/order/${encodeURIComponent(orderId)}/leverans`, {
    method: "POST",
    body: JSON.stringify({ tider: tider.map((t) => ({ datum: t.date, tid: t.window })) }),
  });
}

export function requestReturn(orderId: string): Promise<{ order: Order }> {
  return authJson(`/api/butik/order/${encodeURIComponent(orderId)}/retur`, { method: "POST" });
}

export interface Interpretation {
  /** Serverns interna form — visas aldrig, finns för felsökning. Använd `query`. */
  filter: Record<string, unknown>;
  /** Filtret i rutnätets egna parameternamn, redan i centimeter. Det här är det som ska användas. */
  query: BrowseQuery;
  summary: string;
  /** Falskt = servern föll tillbaka på ren ordmatchning. Rutnätet säger det rakt ut. */
  aiUsed: boolean;
  available?: boolean;
  throttled?: boolean;
}

/** Fritext -> filter. Publik: att söka efter en soffa ska inte kräva ett konto. */
export async function interpret(fraga: string): Promise<Interpretation> {
  const res = await fetch("/api/butik/tolka", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fraga }),
  });
  if (!res.ok) throw new Error("Kunde inte tolka sökningen.");
  return (await res.json()) as Interpretation;
}
