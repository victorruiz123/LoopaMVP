/**
 * Affärslagret: affärerna, deras huvudbok och uppslaget på inbjudningslänken.
 *
 * SAMMA TVÅ RYGGAR som butiken (butik/store.ts): Supabase när SUPABASE_SERVICE_ROLE_KEY finns,
 * annars filer under server/data/affarer. Skälet är detsamma — PostgREST över fetch drar inte in ett
 * beroende, och filvägen låter allt köras och testas på en maskin utan hemligheter.
 *
 * ÖVERGÅNGARNA ÄR VILLKORADE SKRIVNINGAR, av samma skäl som i butiken: två parter tittar på samma
 * affär samtidigt, och den dagen båda trycker "acceptera" i samma sekund ska exakt en av dem vinna.
 * Ett läs-kontrollera-skriv hade haft hela motparten i glappet.
 */

import { mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../jobStore.js";
import { supabaseUrl } from "../supabaseAuth.js";
import { expiryFor, makeEvent, makeInviteToken } from "./state.js";
import type { Deal, DealActor, DealEvent, DealState } from "./types.js";

const AFFAR_DIR = () =>
  process.env.AFFAR_DATA_DIR?.trim() || path.join(DATA_DIR, "affarer");
const DEALS_FILE = () => path.join(AFFAR_DIR(), "deals.json");
const EVENTS_FILE = () => path.join(AFFAR_DIR(), "events.jsonl");

/** Köparens uppladdade annonsbilder. EGEN mapp, aldrig jobbmappen — se `submissionDir`. */
export function submissionDir(dealId: string): string {
  return path.join(AFFAR_DIR(), "underlag", dealId);
}

export interface Store {
  get(id: string): Promise<Deal | null>;
  byToken(token: string): Promise<Deal | null>;
  all(): Promise<Deal[]>;
  put(deal: Deal): Promise<void>;
  compareAndSet(id: string, expected: DealState[], next: DealState, patch: Partial<Deal>): Promise<Deal | null>;
  appendEvent(event: DealEvent): Promise<void>;
  events(dealId: string): Promise<DealEvent[]>;
}

// ---------------------------------------------------------------------------
// Filryggen
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

class FileStore implements Store {
  private cache: Map<string, Deal> | null = null;

  private async load(): Promise<Map<string, Deal>> {
    if (this.cache) return this.cache;
    try {
      const rows = JSON.parse(await readFile(DEALS_FILE(), "utf-8")) as Deal[];
      this.cache = new Map(rows.map((d) => [d.id, d]));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const rows = [...(await this.load()).values()];
    await mkdir(AFFAR_DIR(), { recursive: true });
    await writeFile(DEALS_FILE(), JSON.stringify(rows, null, 2), "utf-8");
  }

  async get(id: string): Promise<Deal | null> {
    return (await this.load()).get(id) ?? null;
  }

  async byToken(token: string): Promise<Deal | null> {
    for (const d of (await this.load()).values()) if (d.inviteToken === token) return d;
    return null;
  }

  async all(): Promise<Deal[]> {
    return [...(await this.load()).values()];
  }

  async put(deal: Deal): Promise<void> {
    await serialize(async () => {
      (await this.load()).set(deal.id, { ...deal, updatedAt: new Date().toISOString() });
      await this.flush();
    });
  }

  async compareAndSet(id: string, expected: DealState[], next: DealState, patch: Partial<Deal>): Promise<Deal | null> {
    return serialize(async () => {
      const map = await this.load();
      const current = map.get(id);
      if (!current || !expected.includes(current.state)) return null;
      const updated: Deal = { ...current, ...patch, id: current.id, state: next, updatedAt: new Date().toISOString() };
      map.set(id, updated);
      await this.flush();
      return updated;
    });
  }

  async appendEvent(event: DealEvent): Promise<void> {
    await mkdir(AFFAR_DIR(), { recursive: true });
    await appendFile(EVENTS_FILE(), JSON.stringify(event) + "\n", "utf-8");
  }

  async events(dealId: string): Promise<DealEvent[]> {
    try {
      const raw = await readFile(EVENTS_FILE(), "utf-8");
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as DealEvent).filter((e) => e.dealId === dealId);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase-ryggen
// ---------------------------------------------------------------------------

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
export function usingSupabase(): boolean {
  return serviceKey() !== null;
}

function toRow(d: Deal): Record<string, unknown> {
  return {
    id: d.id, invite_token: d.inviteToken, state: d.state,
    buyer_id: d.buyerId, buyer_email: d.buyerEmail,
    seller_id: d.sellerId, seller_email: d.sellerEmail,
    submission: d.submission, assessment: d.assessment,
    scan_job_id: d.scanJobId, proposals: d.proposals, awaiting: d.awaiting, accepted_by: d.acceptedBy,
    counter_rounds: d.counterRounds, agreed_price_sek: d.agreedPriceSek,
    buyer_postal_code: d.buyerPostalCode, seller_postal_code: d.sellerPostalCode,
    order_id: d.orderId, created_at: d.createdAt, updated_at: d.updatedAt,
    expires_at: d.expiresAt, reminder_sent: d.reminderSent,
  };
}

function fromRow(r: Record<string, any>): Deal {
  return {
    id: r.id, inviteToken: r.invite_token, state: r.state,
    buyerId: r.buyer_id, buyerEmail: r.buyer_email ?? null,
    sellerId: r.seller_id ?? null, sellerEmail: r.seller_email ?? null,
    submission: r.submission ?? null, assessment: r.assessment ?? null,
    scanJobId: r.scan_job_id ?? null, proposals: r.proposals ?? [], awaiting: r.awaiting ?? null,
    acceptedBy: r.accepted_by ?? [],
    counterRounds: r.counter_rounds ?? 0, agreedPriceSek: r.agreed_price_sek ?? null,
    buyerPostalCode: r.buyer_postal_code ?? null, sellerPostalCode: r.seller_postal_code ?? null,
    orderId: r.order_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    expiresAt: r.expires_at ?? null, reminderSent: r.reminder_sent ?? false,
  };
}

/** Fälten compareAndSet får skriva. Håller ett patch från att nollställa id eller inbjudan. */
const PATCHABLE = new Set([
  "seller_id", "seller_email", "submission", "assessment", "scan_job_id", "proposals",
  "awaiting", "accepted_by", "counter_rounds", "agreed_price_sek", "buyer_postal_code", "seller_postal_code",
  "order_id", "expires_at", "reminder_sent",
]);

class SupabaseStore implements Store {
  private async call<T>(method: string, q: string, body?: unknown, prefer?: string): Promise<T> {
    const key = serviceKey();
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY saknas");
    const res = await fetch(`${supabaseUrl()}/rest/v1/${q}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async get(id: string): Promise<Deal | null> {
    const rows = await this.call<any[]>("GET", `affar_deals?id=eq.${encodeURIComponent(id)}`);
    return rows?.[0] ? fromRow(rows[0]) : null;
  }

  async byToken(token: string): Promise<Deal | null> {
    const rows = await this.call<any[]>("GET", `affar_deals?invite_token=eq.${encodeURIComponent(token)}`);
    return rows?.[0] ? fromRow(rows[0]) : null;
  }

  async all(): Promise<Deal[]> {
    return ((await this.call<any[]>("GET", "affar_deals?select=*")) ?? []).map(fromRow);
  }

  async put(deal: Deal): Promise<void> {
    await this.call("POST", "affar_deals", toRow({ ...deal, updatedAt: new Date().toISOString() }), "resolution=merge-duplicates");
  }

  async compareAndSet(id: string, expected: DealState[], next: DealState, patch: Partial<Deal>): Promise<Deal | null> {
    const body: Record<string, unknown> = { state: next, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(toRow(patch as Deal))) {
      if (v !== undefined && PATCHABLE.has(k)) body[k] = v;
    }
    const rows = await this.call<any[]>(
      "PATCH",
      `affar_deals?id=eq.${encodeURIComponent(id)}&state=in.(${expected.join(",")})`,
      body,
      "return=representation",
    );
    return rows?.[0] ? fromRow(rows[0]) : null;
  }

  async appendEvent(e: DealEvent): Promise<void> {
    await this.call("POST", "affar_events", {
      id: e.id, deal_id: e.dealId, from_state: e.from, to_state: e.to, at: e.at, actor: e.actor, note: e.note,
    });
  }

  async events(dealId: string): Promise<DealEvent[]> {
    const rows = await this.call<any[]>("GET", `affar_events?deal_id=eq.${encodeURIComponent(dealId)}&order=at.asc`);
    return (rows ?? []).map((r) => ({
      id: r.id, dealId: r.deal_id, from: r.from_state, to: r.to_state, at: r.at, actor: r.actor, note: r.note ?? null,
    }));
  }
}

let instance: Store | null = null;
export function store(): Store {
  if (!instance) instance = usingSupabase() ? new SupabaseStore() : new FileStore();
  return instance;
}
export function resetStore(): void {
  instance = null;
}

// ---------------------------------------------------------------------------
// Övergångarna som affären faktiskt anropar dem
// ---------------------------------------------------------------------------

export async function createDeal(input: {
  buyerId: string;
  buyerEmail: string | null;
  buyerPostalCode: string | null;
}): Promise<Deal> {
  const now = new Date().toISOString();
  const deal: Deal = {
    id: randomUUID(),
    inviteToken: makeInviteToken(),
    state: "created",
    buyerId: input.buyerId,
    buyerEmail: input.buyerEmail,
    sellerId: null,
    sellerEmail: null,
    submission: null,
    assessment: null,
    scanJobId: null,
    proposals: [],
    awaiting: null,
    acceptedBy: [],
    counterRounds: 0,
    agreedPriceSek: null,
    buyerPostalCode: input.buyerPostalCode,
    sellerPostalCode: null,
    orderId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    reminderSent: false,
  };
  await store().put(deal);
  await store().appendEvent({
    id: randomUUID(), dealId: deal.id, from: null, to: "created", at: now,
    actor: { kind: "buyer", userId: input.buyerId }, note: "Affärsrummet skapades.",
  });
  return deal;
}

/**
 * Ett tillståndsbyte, villkorat och loggat.
 *
 * Klockan sätts om vid VARJE byte: ett läge med en tidsgräns får sin, ett utan får null. Utan det
 * hade en affär som gick från `invited` till `seller_joined` behållit inbjudans utgångsdatum och
 * dött mitt i en skanning.
 */
export async function move(
  id: string,
  expected: DealState[],
  next: DealState,
  actor: DealActor,
  note: string,
  patch: Partial<Deal> = {},
): Promise<Deal | null> {
  const before = await store().get(id);
  if (!before) return null;
  const updated = await store().compareAndSet(id, expected, next, { ...patch, expiresAt: expiryFor(next) });
  if (!updated) return null;
  await store().appendEvent(makeEvent(id, before.state, next, actor, note));
  return updated;
}

/**
 * Städar affärer vars klocka gått ut.
 *
 * Samma mönster som butikens reservationsstädning. Köparen får veta — och får skicka EN påminnelse,
 * vilket är varför `reminderSent` finns på affären och inte i ett utskicksregister: rätten att
 * påminna hör till affären, inte till ett mejl.
 */
export async function sweepExpired(): Promise<Deal[]> {
  const now = Date.now();
  const expired: Deal[] = [];
  for (const deal of await store().all()) {
    if (!deal.expiresAt || new Date(deal.expiresAt).getTime() > now) continue;
    const done = await move(
      deal.id,
      [deal.state],
      "expired",
      { kind: "system", job: "sweep" },
      `Ingen aktivitet i läget ${deal.state} innan tiden gick ut.`,
    );
    if (done) expired.push(done);
  }
  return expired;
}

/**
 * Tar bort köparens uppladdade annonsbilder.
 *
 * Briefen: annonsinnehållet ska inte bevaras utöver vad köparen behöver i sin egen vy. Vår SLUTSATS
 * (assessment) står kvar — den är vårt arbete och affärens underlag — medan bilderna, som är någon
 * annans annons och ofta någons hem, går. Anropas när affären når ett slutläge.
 */
export async function purgeSubmissionMedia(dealId: string): Promise<void> {
  await rm(submissionDir(dealId), { recursive: true, force: true });
  const deal = await store().get(dealId);
  if (deal?.submission) {
    await store().put({ ...deal, submission: { ...deal.submission, imagePaths: [] } });
  }
}
