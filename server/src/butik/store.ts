/**
 * Butikslagret: tillstånd, reservationer och huvudboken över varje övergång.
 *
 * TVÅ RYGGAR, ETT GRÄNSSNITT. Supabase när SUPABASE_SERVICE_ROLE_KEY finns, annars filer under
 * server/data/butik. Valet är inte en smaksak: PostgREST-vägen använder samma fetch-mot-PostgREST som
 * admin.ts redan gör (server/src/admin.ts:139) och drar därför inte in ett enda nytt beroende, medan
 * filvägen låter butiken köra på en maskin utan hemligheter — vilket är hur den byggs och testas.
 *
 * DUBBELFÖRSÄLJNINGEN LÖSES HÄR, och bara här. Möbeln är unik och ligger uppe i två kanaler
 * samtidigt, så någon gång kommer två köpare att vilja ha samma soffa inom samma sekund: en i vår
 * kassa, en som trycker Köp Nu på Tradera. Det som skiljer en butik som klarar det från en som inte
 * gör det är att övergången till `sold` är ETT villkorat skrivande — "sätt sold DÄR tillståndet
 * fortfarande är live eller reserved" — och att den som inte fick något rader tillbaka har förlorat.
 *
 * Det som INTE duger, och som är den självklara implementationen: läs tillståndet, kontrollera att
 * det är live, skriv sold. Mellan läsningen och skrivningen ryms hela den andra köparen.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../jobStore.js";
import { supabaseUrl } from "../supabaseAuth.js";
import { makeEvent, reservationDeadline } from "./state.js";
import type { ProductEvent, ProductSource, ProductState, TransitionActor } from "./types.js";

/**
 * Var butikens filer ligger. Överstyrbar med BUTIK_DATA_DIR.
 *
 * Överstyrningen finns för testerna: utan den skriver de i den RIKTIGA datamappen, och en
 * testkörning lämnar då kvar LP-TEST-poster bland skarpa varor. Den är också vägen in för en drift
 * som vill lägga butiken på en annan volym än jobben.
 */
const BUTIK_DIR = process.env.BUTIK_DATA_DIR?.trim() || path.join(DATA_DIR, "butik");
const PRODUCTS_FILE = path.join(BUTIK_DIR, "products.json");
const EVENTS_FILE = path.join(BUTIK_DIR, "events.jsonl");

/**
 * Butikens egen post om en möbel — tillståndet, inte innehållet.
 *
 * Titel, mått och skick står kvar i jobbet och normaliseras fram vid läsning (normalize.ts). Det som
 * bor här är sådant butiken äger och jobbet inte vet om: var i livscykeln möbeln är, vem som håller
 * den just nu, och vad den kostade när den såldes.
 */
export interface ButikRecord {
  id: string;
  source: ProductSource;
  jobId: string | null;
  state: ProductState;
  /** Klockslaget reservationen går ut. Null när möbeln inte är reserverad. */
  reservedUntil: string | null;
  /** Vem som håller reservationen. Bara den som har token får fullfölja köpet. */
  reservationToken: string | null;
  /** Priset som gällde när reservationen togs — prisstegen får inte flytta priset mitt i en kassa. */
  reservedPriceSek: number | null;
  listedAt: string;
  soldAt: string | null;
  /** Vilken kanal som vann. Det är den här raden man läser dagen en köpare hör av sig. */
  soldChannel: "butik" | "tradera" | null;
  traderaItemId: number | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Gemensamt gränssnitt
// ---------------------------------------------------------------------------

export interface Store {
  get(id: string): Promise<ButikRecord | null>;
  all(): Promise<ButikRecord[]>;
  put(record: ButikRecord): Promise<void>;
  /**
   * Villkorat tillståndsbyte. Sant = vi vann, falskt = någon annan hann före.
   *
   * `expected` är de tillstånd bytet får ske FRÅN. Att skicka en lista och inte ett värde är vad som
   * gör Tradera-försäljningen möjlig att uttrycka: den vinner både över `live` och över `reserved`,
   * alltså även mitt i någons utcheckning.
   */
  compareAndSet(
    id: string,
    expected: ProductState[],
    next: ProductState,
    patch: Partial<ButikRecord>,
  ): Promise<ButikRecord | null>;
  appendEvent(event: ProductEvent): Promise<void>;
  events(productId: string): Promise<ProductEvent[]>;
}

// ---------------------------------------------------------------------------
// Filryggen
// ---------------------------------------------------------------------------

/**
 * En låskedja, inte ett lås.
 *
 * Node kör en tråd, men `await` mellan läsning och skrivning släpper ändå fram nästa anrop — och det
 * är precis mellan de två raderna dubbelförsäljningen bor. Varje skrivande operation ställer sig
 * därför sist i en löfteskedja, så att läs-ändra-skriv aldrig delas av två anrop.
 *
 * RÄCKER FÖR EN PROCESS, vilket är vad drift är i dag: en systemd-tjänst, en Node-process
 * (deploy/oracle/loopa-server.service). Skalas servern till två processer är den här ryggen inte
 * längre säker och Supabase-ryggen är det enda riktiga svaret. Det står här för att det är den
 * antagelsen som går sönder först.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

class FileStore implements Store {
  private cache: Map<string, ButikRecord> | null = null;

  private async load(): Promise<Map<string, ButikRecord>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(PRODUCTS_FILE, "utf-8");
      const rows = JSON.parse(raw) as ButikRecord[];
      this.cache = new Map(rows.map((r) => [r.id, r]));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const rows = [...(await this.load()).values()];
    await mkdir(BUTIK_DIR, { recursive: true });
    await writeFile(PRODUCTS_FILE, JSON.stringify(rows, null, 2), "utf-8");
  }

  async get(id: string): Promise<ButikRecord | null> {
    return (await this.load()).get(id) ?? null;
  }

  async all(): Promise<ButikRecord[]> {
    return [...(await this.load()).values()];
  }

  async put(record: ButikRecord): Promise<void> {
    await serialize(async () => {
      (await this.load()).set(record.id, { ...record, updatedAt: new Date().toISOString() });
      await this.flush();
    });
  }

  async compareAndSet(
    id: string,
    expected: ProductState[],
    next: ProductState,
    patch: Partial<ButikRecord>,
  ): Promise<ButikRecord | null> {
    return serialize(async () => {
      const map = await this.load();
      const current = map.get(id);
      if (!current || !expected.includes(current.state)) return null;
      const updated: ButikRecord = { ...current, ...patch, state: next, updatedAt: new Date().toISOString() };
      map.set(id, updated);
      await this.flush();
      return updated;
    });
  }

  async appendEvent(event: ProductEvent): Promise<void> {
    await mkdir(BUTIK_DIR, { recursive: true });
    await appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf-8");
  }

  async events(productId: string): Promise<ProductEvent[]> {
    try {
      const raw = await readFile(EVENTS_FILE, "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ProductEvent)
        .filter((e) => e.productId === productId);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase-ryggen (PostgREST över fetch — inget nytt beroende)
// ---------------------------------------------------------------------------

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

/** Sant när butiken har en riktig databas att ligga i. Annars körs filryggen. */
export function usingSupabase(): boolean {
  return serviceKey() !== null;
}

/** Kolumnnamnen är snake_case i Postgres och camelCase i TypeScript. Översättningen bor på ett ställe. */
function toRow(r: ButikRecord): Record<string, unknown> {
  return {
    id: r.id,
    source: r.source,
    job_id: r.jobId,
    state: r.state,
    reserved_until: r.reservedUntil,
    reservation_token: r.reservationToken,
    reserved_price_sek: r.reservedPriceSek,
    listed_at: r.listedAt,
    sold_at: r.soldAt,
    sold_channel: r.soldChannel,
    tradera_item_id: r.traderaItemId,
    updated_at: r.updatedAt,
  };
}

function fromRow(row: Record<string, any>): ButikRecord {
  return {
    id: row.id,
    source: row.source,
    jobId: row.job_id ?? null,
    state: row.state,
    reservedUntil: row.reserved_until ?? null,
    reservationToken: row.reservation_token ?? null,
    reservedPriceSek: row.reserved_price_sek ?? null,
    listedAt: row.listed_at,
    soldAt: row.sold_at ?? null,
    soldChannel: row.sold_channel ?? null,
    traderaItemId: row.tradera_item_id ?? null,
    updatedAt: row.updated_at,
  };
}

class SupabaseStore implements Store {
  private async call<T>(method: string, pathAndQuery: string, body?: unknown, prefer?: string): Promise<T> {
    const key = serviceKey();
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY saknas");
    const res = await fetch(`${supabaseUrl()}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async get(id: string): Promise<ButikRecord | null> {
    const rows = await this.call<Record<string, any>[]>("GET", `butik_products?id=eq.${encodeURIComponent(id)}`);
    return rows?.[0] ? fromRow(rows[0]) : null;
  }

  async all(): Promise<ButikRecord[]> {
    const rows = await this.call<Record<string, any>[]>("GET", "butik_products?select=*");
    return (rows ?? []).map(fromRow);
  }

  async put(record: ButikRecord): Promise<void> {
    await this.call("POST", "butik_products", toRow({ ...record, updatedAt: new Date().toISOString() }), "resolution=merge-duplicates");
  }

  /**
   * Villkoret ligger i WHERE-satsen, inte i en if-sats här.
   *
   * `state=in.(live,reserved)` gör Postgres till den som avgör vem som hann först: den andra
   * uppdateringen matchar noll rader och får en tom lista tillbaka. Det är hela låset.
   */
  async compareAndSet(
    id: string,
    expected: ProductState[],
    next: ProductState,
    patch: Partial<ButikRecord>,
  ): Promise<ButikRecord | null> {
    const body: Record<string, unknown> = { state: next, updated_at: new Date().toISOString() };
    const full = toRow({ ...(patch as ButikRecord) });
    for (const [k, v] of Object.entries(full)) {
      if (v !== undefined && k in patchable) body[k] = v;
    }
    const query = `butik_products?id=eq.${encodeURIComponent(id)}&state=in.(${expected.join(",")})`;
    const rows = await this.call<Record<string, any>[]>("PATCH", query, body, "return=representation");
    return rows?.[0] ? fromRow(rows[0]) : null;
  }

  async appendEvent(event: ProductEvent): Promise<void> {
    await this.call("POST", "butik_events", {
      id: event.id,
      product_id: event.productId,
      from_state: event.from,
      to_state: event.to,
      at: event.at,
      actor: event.actor,
      note: event.note,
    });
  }

  async events(productId: string): Promise<ProductEvent[]> {
    const rows = await this.call<Record<string, any>[]>(
      "GET",
      `butik_events?product_id=eq.${encodeURIComponent(productId)}&order=at.asc`,
    );
    return (rows ?? []).map((r) => ({
      id: r.id,
      productId: r.product_id,
      from: r.from_state,
      to: r.to_state,
      at: r.at,
      actor: r.actor,
      note: r.note ?? null,
    }));
  }
}

/** Fälten compareAndSet får skriva. Håller ett `patch` från att råka nollställa id eller listedAt. */
const patchable: Record<string, true> = {
  reserved_until: true,
  reservation_token: true,
  reserved_price_sek: true,
  sold_at: true,
  sold_channel: true,
  tradera_item_id: true,
};

let instance: Store | null = null;
export function store(): Store {
  if (!instance) instance = usingSupabase() ? new SupabaseStore() : new FileStore();
  return instance;
}

/** Bara för tester: tvinga fram en ny instans efter att miljön ändrats. */
export function resetStore(): void {
  instance = null;
}

// ---------------------------------------------------------------------------
// Övergångarna, som butiken faktiskt anropar dem
// ---------------------------------------------------------------------------

/** Lägger möbeln i butiken som utkast. Idempotent — en ompublicering skapar ingen andra post. */
export async function ensureRecord(
  id: string,
  jobId: string | null,
  source: ProductSource,
  listedAt: string,
): Promise<ButikRecord> {
  const existing = await store().get(id);
  if (existing) return existing;
  const record: ButikRecord = {
    id,
    source,
    jobId,
    state: "draft",
    reservedUntil: null,
    reservationToken: null,
    reservedPriceSek: null,
    listedAt,
    soldAt: null,
    soldChannel: null,
    traderaItemId: null,
    updatedAt: new Date().toISOString(),
  };
  await store().put(record);
  await store().appendEvent({
    id: randomUUID(),
    productId: id,
    from: null,
    to: "draft",
    at: record.updatedAt,
    actor: { kind: "system", job: "ensureRecord" },
    note: "Möbeln lades till i butiken.",
  });
  return record;
}

async function move(
  id: string,
  expected: ProductState[],
  next: ProductState,
  patch: Partial<ButikRecord>,
  actor: TransitionActor,
  note: string,
): Promise<ButikRecord | null> {
  const before = await store().get(id);
  if (!before) return null;
  const updated = await store().compareAndSet(id, expected, next, patch);
  if (!updated) return null;
  await store().appendEvent(makeEvent(id, before.state, next, actor, note));
  return updated;
}

export async function publish(id: string, actor: TransitionActor): Promise<ButikRecord | null> {
  return move(id, ["draft"], "live", {}, actor, "Publicerad i Butik.");
}

export async function unpublish(id: string, actor: TransitionActor): Promise<ButikRecord | null> {
  return move(id, ["live"], "draft", {}, actor, "Tagen ur Butik.");
}

/**
 * Håller möbeln medan någon står i kassan. Returnerar token som fullföljandet måste visa upp.
 *
 * Null betyder att möbeln inte var ledig — någon annan hann in i kassan, eller den är redan såld.
 */
export async function reserve(
  id: string,
  priceSek: number | null,
  actor: TransitionActor,
): Promise<{ record: ButikRecord; token: string } | null> {
  const token = randomUUID();
  const record = await move(
    id,
    ["live"],
    "reserved",
    { reservedUntil: reservationDeadline(), reservationToken: token, reservedPriceSek: priceSek },
    actor,
    "Reserverad i kassan.",
  );
  return record ? { record, token } : null;
}

/** Släpper en reservation — avbruten kassa eller utgången hållning. */
export async function release(id: string, actor: TransitionActor, note: string): Promise<ButikRecord | null> {
  return move(
    id,
    ["reserved"],
    "live",
    { reservedUntil: null, reservationToken: null, reservedPriceSek: null },
    actor,
    note,
  );
}

/**
 * Försäljningen. DEN HÄR ÄR DEN VIKTIGA.
 *
 * Går från både `live` och `reserved`: en Tradera-försäljning ska vinna även över en påbörjad kassa
 * hos oss, för möbeln är då faktiskt borta. Att den kan misslyckas är inte ett fel utan svaret — den
 * som får null tillbaka ska tala om för sin köpare att möbeln precis blev såld, och absolut inte
 * dra ett betalkort.
 */
export async function claimForSale(
  id: string,
  channel: "butik" | "tradera",
  actor: TransitionActor,
  opts: { requireToken?: string | null; traderaItemId?: number | null } = {},
): Promise<ButikRecord | null> {
  if (opts.requireToken) {
    const current = await store().get(id);
    // Reservationstoken kontrolleras FÖRE anspråket. Den skyddar inte mot dubbelförsäljning — det
    // gör compareAndSet — utan mot att någon annans reservation fullföljs av fel köpare.
    if (!current || current.reservationToken !== opts.requireToken) return null;
  }
  return move(
    id,
    ["live", "reserved"],
    "sold",
    {
      soldAt: new Date().toISOString(),
      soldChannel: channel,
      traderaItemId: opts.traderaItemId ?? null,
      reservedUntil: null,
      reservationToken: null,
    },
    actor,
    channel === "tradera" ? "Såld på Tradera." : "Såld i Butik.",
  );
}

export async function markDelivered(id: string, actor: TransitionActor): Promise<ButikRecord | null> {
  return move(id, ["sold"], "delivered", {}, actor, "Levererad.");
}

export async function markReturned(id: string, actor: TransitionActor): Promise<ButikRecord | null> {
  return move(id, ["delivered"], "returned", {}, actor, "Returnerad.");
}

/**
 * Släpper reservationer som gått ut.
 *
 * Utan den låser en avbruten utcheckning möbeln för alltid: köparen stängde fliken i Stripe, och
 * ingen kommer någonsin tillbaka för att släppa den.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const now = Date.now();
  let released = 0;
  for (const r of await store().all()) {
    if (r.state !== "reserved" || !r.reservedUntil) continue;
    if (new Date(r.reservedUntil).getTime() > now) continue;
    const done = await release(r.id, { kind: "system", job: "sweep" }, `Reservationen gick ut efter ${process.env.BUTIK_RESERVATION_MINUTES ?? 15} min.`);
    if (done) released += 1;
  }
  return released;
}
