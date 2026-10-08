/**
 * Affiliate-lagret: koderna, vem som värvade vem, och provisionerna.
 *
 * SAMMA TVÅ RYGGAR som inbjudningarna (referral/store.ts): Supabase när LOOPA_LAGRING=supabase, annars
 * filer under server/data/affiliate. Schemat står i server/sql/005_affiliate.sql och körs för hand.
 *
 * REGLERNA BOR INTE HÄR. Lagret kan bara det som måste vara ett villkorat skrivande för att hålla —
 * "sätt referred_by DÄR den är null", "skapa en provision om ingen finns för annonsen", "byt status
 * DÄR den är pending". Resten står i regler.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { supabaseUrl } from "../supabaseAuth.js";
import { supabaseLagring } from "../datalagring.js";

export interface AffiliateProfil {
  userId: string;
  /** "K7QM-2XRP". Unik inom affiliate — en egen kodrymd, skild från inbjudningskoderna. */
  kod: string;
  /** Den som värvade. Sätts EN gång, vid registreringen, och ändras aldrig. */
  referredBy: string | null;
  referredAt: string | null;
  /** Adressen admin betalar ut till. Null för den som bara blivit värvad och aldrig hämtat sin länk. */
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProvisionStatus = "pending" | "paid" | "cancelled";

export interface AffiliateProvision {
  id: string;
  affiliateUserId: string;
  sellerUserId: string;
  /** Butikens produkt-id. Unik: max en provision per såld annons. */
  productId: string;
  /** Försäljningspriset (möbeln, utan frakt) i öre, som det frystes vid utbetalningen. */
  salePriceOre: number;
  rate: number;
  /** Provisionen i öre. Räknad en gång, vid skapandet, och aldrig om. */
  amountOre: number;
  status: ProvisionStatus;
  createdAt: string;
  paidAt: string | null;
  paidBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface AffiliateStore {
  profil(userId: string): Promise<AffiliateProfil | null>;
  profilForKod(kod: string): Promise<AffiliateProfil | null>;
  /** Alla profiler med `referredBy = userId`. */
  varvade(userId: string): Promise<AffiliateProfil[]>;
  /** Null när användaren eller koden redan finns. Den som anropar slumpar en ny kod och försöker igen. */
  skapaProfil(p: AffiliateProfil): Promise<AffiliateProfil | null>;
  sattEmail(userId: string, email: string): Promise<void>;
  /** Kontot raderas: adressen bort. Koden, referred_by och provisionerna står kvar för bokföringen. */
  rensaEmail(userId: string): Promise<void>;
  /** Sant om den sattes nu. Falskt om den redan var satt — då ändras ingenting. */
  sattReferredBy(userId: string, referrerId: string, at: string): Promise<boolean>;

  provisioner(filter?: { affiliateUserId?: string; status?: ProvisionStatus }): Promise<AffiliateProvision[]>;
  provisionForProdukt(productId: string): Promise<AffiliateProvision | null>;
  /** Falskt om annonsen redan har en provision. Lagrets garanti, inte bara reglernas. */
  skapaProvision(p: AffiliateProvision): Promise<boolean>;
  /** Villkorat: bara från `from`. Sant om bytet skedde. */
  bytStatus(
    id: string,
    from: ProvisionStatus,
    to: ProvisionStatus,
    patch?: Partial<Pick<AffiliateProvision, "paidAt" | "paidBy" | "cancelledAt" | "cancelReason">>,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Filryggen
// ---------------------------------------------------------------------------

const DIR = () => process.env.AFFILIATE_DATA_DIR?.trim() || path.join(DATA_DIR, "affiliate");

/** Samma låskedja som inbjudningarna — en process, en skrivare i taget. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

class FileStore implements AffiliateStore {
  private profilMap: Map<string, AffiliateProfil> | null = null;
  private provisionMap: Map<string, AffiliateProvision> | null = null;

  private async lasProfiler(): Promise<Map<string, AffiliateProfil>> {
    if (this.profilMap) return this.profilMap;
    try {
      const rows = JSON.parse(await readFile(path.join(DIR(), "profiler.json"), "utf-8")) as AffiliateProfil[];
      this.profilMap = new Map(rows.map((r) => [r.userId, r]));
    } catch {
      this.profilMap = new Map();
    }
    return this.profilMap;
  }

  private async lasProvisioner(): Promise<Map<string, AffiliateProvision>> {
    if (this.provisionMap) return this.provisionMap;
    try {
      const rows = JSON.parse(await readFile(path.join(DIR(), "provisioner.json"), "utf-8")) as AffiliateProvision[];
      this.provisionMap = new Map(rows.map((r) => [r.id, r]));
    } catch {
      this.provisionMap = new Map();
    }
    return this.provisionMap;
  }

  private async sparaProfiler(): Promise<void> {
    await mkdir(DIR(), { recursive: true });
    await writeFile(path.join(DIR(), "profiler.json"), JSON.stringify([...(await this.lasProfiler()).values()], null, 2), "utf-8");
  }

  private async sparaProvisioner(): Promise<void> {
    await mkdir(DIR(), { recursive: true });
    await writeFile(path.join(DIR(), "provisioner.json"), JSON.stringify([...(await this.lasProvisioner()).values()], null, 2), "utf-8");
  }

  async profil(userId: string) {
    return (await this.lasProfiler()).get(userId) ?? null;
  }

  async profilForKod(kod: string) {
    for (const p of (await this.lasProfiler()).values()) if (p.kod === kod) return p;
    return null;
  }

  async varvade(userId: string) {
    return [...(await this.lasProfiler()).values()].filter((p) => p.referredBy === userId);
  }

  skapaProfil(p: AffiliateProfil) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      if (map.has(p.userId)) return null;
      for (const q of map.values()) if (q.kod === p.kod) return null;
      map.set(p.userId, p);
      await this.sparaProfiler();
      return p;
    });
  }

  sattEmail(userId: string, email: string) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      const p = map.get(userId);
      if (!p || p.email === email) return;
      map.set(userId, { ...p, email, updatedAt: new Date().toISOString() });
      await this.sparaProfiler();
    });
  }

  rensaEmail(userId: string) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      const p = map.get(userId);
      if (!p || p.email === null) return;
      map.set(userId, { ...p, email: null, updatedAt: new Date().toISOString() });
      await this.sparaProfiler();
    });
  }

  sattReferredBy(userId: string, referrerId: string, at: string) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      const p = map.get(userId);
      if (!p || p.referredBy !== null) return false;
      map.set(userId, { ...p, referredBy: referrerId, referredAt: at, updatedAt: at });
      await this.sparaProfiler();
      return true;
    });
  }

  async provisioner(filter: { affiliateUserId?: string; status?: ProvisionStatus } = {}) {
    return [...(await this.lasProvisioner()).values()].filter(
      (p) =>
        (!filter.affiliateUserId || p.affiliateUserId === filter.affiliateUserId) && (!filter.status || p.status === filter.status),
    );
  }

  async provisionForProdukt(productId: string) {
    for (const p of (await this.lasProvisioner()).values()) if (p.productId === productId) return p;
    return null;
  }

  /** Motsvarar Supabase-ryggens unika index på product_id. */
  skapaProvision(p: AffiliateProvision) {
    return serialize(async () => {
      const map = await this.lasProvisioner();
      for (const q of map.values()) if (q.productId === p.productId) return false;
      map.set(p.id, p);
      await this.sparaProvisioner();
      return true;
    });
  }

  bytStatus(id: string, from: ProvisionStatus, to: ProvisionStatus, patch: Parameters<AffiliateStore["bytStatus"]>[3] = {}) {
    return serialize(async () => {
      const map = await this.lasProvisioner();
      const p = map.get(id);
      if (!p || p.status !== from) return false;
      map.set(id, { ...p, ...patch, status: to });
      await this.sparaProvisioner();
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Supabase-ryggen (PostgREST över fetch, som inbjudningarna)
// ---------------------------------------------------------------------------

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

class KonfliktFel extends Error {}

async function call<T>(method: string, pathAndQuery: string, body?: unknown, prefer?: string): Promise<T> {
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
  // 409 = en unik rad fanns redan: koden var tagen, eller annonsen hade redan en provision.
  if (res.status === 409) throw new KonfliktFel();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const q = encodeURIComponent;

function profilFranRad(r: Record<string, any>): AffiliateProfil {
  return {
    userId: r.user_id,
    kod: r.affiliate_code,
    referredBy: r.referred_by ?? null,
    referredAt: r.referred_at ?? null,
    email: r.email ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function provisionFranRad(r: Record<string, any>): AffiliateProvision {
  return {
    id: r.id,
    affiliateUserId: r.affiliate_user_id,
    sellerUserId: r.seller_user_id,
    productId: r.product_id,
    salePriceOre: r.sale_price_ore,
    rate: Number(r.rate),
    amountOre: r.amount_ore,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at ?? null,
    paidBy: r.paid_by ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelReason: r.cancel_reason ?? null,
  };
}

class SupabaseStore implements AffiliateStore {
  async profil(userId: string) {
    const rows = await call<Record<string, any>[]>("GET", `affiliate_profiles?user_id=eq.${q(userId)}`);
    return rows?.[0] ? profilFranRad(rows[0]) : null;
  }

  async profilForKod(kod: string) {
    const rows = await call<Record<string, any>[]>("GET", `affiliate_profiles?affiliate_code=eq.${q(kod)}`);
    return rows?.[0] ? profilFranRad(rows[0]) : null;
  }

  async varvade(userId: string) {
    const rows = await call<Record<string, any>[]>("GET", `affiliate_profiles?referred_by=eq.${q(userId)}&order=referred_at.desc`);
    return (rows ?? []).map(profilFranRad);
  }

  async skapaProfil(p: AffiliateProfil) {
    try {
      await call("POST", "affiliate_profiles", {
        user_id: p.userId,
        affiliate_code: p.kod,
        referred_by: p.referredBy,
        referred_at: p.referredAt,
        email: p.email,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      });
      return p;
    } catch (err) {
      if (err instanceof KonfliktFel) return null;
      throw err;
    }
  }

  async sattEmail(userId: string, email: string) {
    await call("PATCH", `affiliate_profiles?user_id=eq.${q(userId)}`, { email, updated_at: new Date().toISOString() });
  }

  async rensaEmail(userId: string) {
    await call("PATCH", `affiliate_profiles?user_id=eq.${q(userId)}`, { email: null, updated_at: new Date().toISOString() });
  }

  /** Villkoret i WHERE-satsen: `referred_by=is.null`. En andra skrivning matchar noll rader. */
  async sattReferredBy(userId: string, referrerId: string, at: string) {
    const rows = await call<unknown[]>(
      "PATCH",
      `affiliate_profiles?user_id=eq.${q(userId)}&referred_by=is.null`,
      { referred_by: referrerId, referred_at: at, updated_at: at },
      "return=representation",
    );
    return (rows?.length ?? 0) > 0;
  }

  async provisioner(filter: { affiliateUserId?: string; status?: ProvisionStatus } = {}) {
    const villkor = [
      filter.affiliateUserId ? `affiliate_user_id=eq.${q(filter.affiliateUserId)}` : null,
      filter.status ? `status=eq.${filter.status}` : null,
      "order=created_at.asc",
    ].filter(Boolean);
    const rows = await call<Record<string, any>[]>("GET", `affiliate_commissions?${villkor.join("&")}`);
    return (rows ?? []).map(provisionFranRad);
  }

  async provisionForProdukt(productId: string) {
    const rows = await call<Record<string, any>[]>("GET", `affiliate_commissions?product_id=eq.${q(productId)}`);
    return rows?.[0] ? provisionFranRad(rows[0]) : null;
  }

  async skapaProvision(p: AffiliateProvision) {
    try {
      await call("POST", "affiliate_commissions", {
        id: p.id,
        affiliate_user_id: p.affiliateUserId,
        seller_user_id: p.sellerUserId,
        product_id: p.productId,
        sale_price_ore: p.salePriceOre,
        rate: p.rate,
        amount_ore: p.amountOre,
        status: p.status,
        created_at: p.createdAt,
      });
      return true;
    } catch (err) {
      if (err instanceof KonfliktFel) return false;
      throw err;
    }
  }

  async bytStatus(id: string, from: ProvisionStatus, to: ProvisionStatus, patch: Parameters<AffiliateStore["bytStatus"]>[3] = {}) {
    const body: Record<string, unknown> = { status: to };
    if (patch.paidAt !== undefined) body.paid_at = patch.paidAt;
    if (patch.paidBy !== undefined) body.paid_by = patch.paidBy;
    if (patch.cancelledAt !== undefined) body.cancelled_at = patch.cancelledAt;
    if (patch.cancelReason !== undefined) body.cancel_reason = patch.cancelReason;
    const rows = await call<unknown[]>("PATCH", `affiliate_commissions?id=eq.${q(id)}&status=eq.${from}`, body, "return=representation");
    return (rows?.length ?? 0) > 0;
  }
}

let instance: AffiliateStore | null = null;
export function affiliateStore(): AffiliateStore {
  // Samma beslut som butiken och inbjudningarna, ur samma ställe. Se datalagring.ts.
  if (!instance) instance = supabaseLagring() ? new SupabaseStore() : new FileStore();
  return instance;
}

/** Bara för tester. */
export function resetAffiliateStore(): void {
  instance = null;
}
