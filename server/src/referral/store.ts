/**
 * Inbjudningarnas lager: vem som bjöd in vem, krediterna och huvudboken.
 *
 * SAMMA TVÅ RYGGAR som butiken (butik/store.ts): Supabase när SUPABASE_SERVICE_ROLE_KEY finns, annars
 * filer under server/data/referral. Schemat står i server/sql/003_referral.sql och körs för hand.
 *
 * REGLERNA BOR INTE HÄR. Lagret kan bara det som måste vara ett villkorat skrivande för att hålla —
 * "sätt referred_by DÄR den är null", "gör krediten used DÄR den är available", "skapa en kredit om
 * ingen redan finns för den inbjudna". Allt annat (vem som får en kredit, när den går ut, skydden)
 * står i regler.ts, där det kan testas utan att bry sig om vilken rygg som kör.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { supabaseUrl } from "../supabaseAuth.js";
import { supabaseLagring } from "../datalagring.js";

/**
 * Motsvarar `users.referral_code` och `users.referred_by` i uppdraget.
 *
 * EGEN TABELL och inte kolumner på en användartabell: Supabase-projektet delas med vips-buy-sell-hub,
 * och auth.users är Supabases egen. En tabell vi äger kan vi ändra i utan att röra något ett annat
 * system läser.
 */
export interface ReferralProfil {
  userId: string;
  /** "K7QM-2XRP". Unik. Se kod.ts. */
  kod: string;
  /** Den som bjöd in. Sätts EN gång, vid registreringen, och ändras aldrig — se sattReferredBy. */
  referredBy: string | null;
  referredAt: string | null;
  /**
   * När personen lade upp sin första annons efter inbjudan. Satt oavsett om inbjudaren fick en kredit
   * för den — en kredit kan nekas av skydden, men annonsen finns ändå. Driver inbjudarens lista.
   */
  forstaAnnonsAt: string | null;
  /**
   * AVTRYCKEN SKYDDEN JÄMFÖR. Normaliserade, aldrig råa: e-posten utan +tillägg och Gmail-punkter,
   * adressen som gata + postnummer i en form. Se avtryck.ts. Telefon och Stripe-konto är null tills
   * vi börjar spara dem — kontrollen står ändå skriven och slår till samma dag de fylls i.
   */
  emailNyckel: string | null;
  adressNyckel: string | null;
  telefonNyckel: string | null;
  stripeKonto: string | null;
  /** "an•••@gmail.com" — det inbjudaren får se om den de bjudit in. */
  emailMaskerad: string | null;
  /**
   * Förnamnet, som det står på landningssidan för den som öppnar personens länk: "Victor bjöd in
   * dig!". Ur kontots profil (full_name) eller, i brist på det, e-postadressens första del.
   */
  namn: string | null;
  createdAt: string;
  updatedAt: string;
}

export type KreditStatus = "available" | "used" | "expired";

export interface ReferralKredit {
  id: string;
  /** Mottagaren — den som bjöd in. */
  userId: string;
  /** Den inbjudna vars första försäljning gav krediten. UNIK: en kredit per inbjuden person, någonsin. */
  referredUserId: string;
  status: KreditStatus;
  /** Butikens produkt-id (Loopa-ID:t) för möbeln krediten användes på. */
  usedOnSaleId: string | null;
  usedAt: string | null;
  createdAt: string;
  expiresAt: string;
  /** När inbjudaren såg popupen om krediten. Null = inte visad än, och då visas den. */
  visadAt?: string | null;
}

export type ReferralHandelseNamn =
  | "invite_link_copied"
  | "referred_signup"
  | "referral_credit_created"
  | "referral_credit_used"
  /** Inte i uppdragets lista, men utan den går det inte att se i efterhand VARFÖR en kredit uteblev. */
  | "referral_credit_denied";

/**
 * En rad i huvudboken. Bär user_id och kod — till skillnad från analys/store.ts, som med flit är
 * identitetsfri och därför inte kan ta emot de här händelserna utan att bli något annat.
 */
export interface ReferralHandelse {
  id: string;
  at: string;
  event: ReferralHandelseNamn;
  userId: string;
  referralCode: string | null;
  props: Record<string, string | number | boolean | null>;
}

export interface ReferralStore {
  profil(userId: string): Promise<ReferralProfil | null>;
  profilForKod(kod: string): Promise<ReferralProfil | null>;
  /** Alla profiler med `referredBy = userId` — inbjudarens lista. */
  inbjudna(userId: string): Promise<ReferralProfil[]>;
  /** Null när användaren eller koden redan finns. Den som anropar slumpar en ny kod och försöker igen. */
  skapaProfil(p: ReferralProfil): Promise<ReferralProfil | null>;
  /** Avtrycken och första utbetalningen. Rör aldrig kod eller referredBy. */
  uppdateraProfil(
    userId: string,
    patch: Partial<Pick<ReferralProfil, "emailNyckel" | "adressNyckel" | "telefonNyckel" | "stripeKonto" | "emailMaskerad" | "namn" | "forstaAnnonsAt">>,
  ): Promise<void>;
  /** Sant om den sattes nu. Falskt om den redan var satt — då ändras ingenting. */
  sattReferredBy(userId: string, referrerId: string, at: string): Promise<boolean>;

  krediter(userId: string): Promise<ReferralKredit[]>;
  kreditForInbjuden(referredUserId: string): Promise<ReferralKredit | null>;
  /** Falskt om den inbjudna redan gett en kredit. Det är lagrets garanti, inte bara reglernas. */
  skapaKredit(k: ReferralKredit): Promise<boolean>;
  /** Popupen är visad. Villkorat på mottagaren — ingen kan kvittera någon annans kredit. */
  markeraVisad(id: string, userId: string, at: string): Promise<void>;
  /** Villkorat: bara från `from`. Sant om bytet skedde. */
  bytStatus(id: string, from: KreditStatus, to: KreditStatus, patch?: Partial<Pick<ReferralKredit, "usedOnSaleId" | "usedAt">>): Promise<boolean>;

  handelse(h: ReferralHandelse): Promise<void>;
  handelser(): Promise<ReferralHandelse[]>;
}

// ---------------------------------------------------------------------------
// Filryggen
// ---------------------------------------------------------------------------

const DIR = () => process.env.REFERRAL_DATA_DIR?.trim() || path.join(DATA_DIR, "referral");

/** Samma låskedja som butiken — se kommentaren i butik/store.ts för varför den räcker för en process. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

class FileStore implements ReferralStore {
  private profiler: Map<string, ReferralProfil> | null = null;
  private kreditMap: Map<string, ReferralKredit> | null = null;

  private async lasProfiler(): Promise<Map<string, ReferralProfil>> {
    if (this.profiler) return this.profiler;
    try {
      const rows = JSON.parse(await readFile(path.join(DIR(), "profiler.json"), "utf-8")) as ReferralProfil[];
      this.profiler = new Map(rows.map((r) => [r.userId, r]));
    } catch {
      this.profiler = new Map();
    }
    return this.profiler;
  }

  private async lasKrediter(): Promise<Map<string, ReferralKredit>> {
    if (this.kreditMap) return this.kreditMap;
    try {
      const rows = JSON.parse(await readFile(path.join(DIR(), "krediter.json"), "utf-8")) as ReferralKredit[];
      this.kreditMap = new Map(rows.map((r) => [r.id, r]));
    } catch {
      this.kreditMap = new Map();
    }
    return this.kreditMap;
  }

  private async sparaProfiler(): Promise<void> {
    await mkdir(DIR(), { recursive: true });
    await writeFile(path.join(DIR(), "profiler.json"), JSON.stringify([...(await this.lasProfiler()).values()], null, 2), "utf-8");
  }

  private async sparaKrediter(): Promise<void> {
    await mkdir(DIR(), { recursive: true });
    await writeFile(path.join(DIR(), "krediter.json"), JSON.stringify([...(await this.lasKrediter()).values()], null, 2), "utf-8");
  }

  async profil(userId: string) {
    return (await this.lasProfiler()).get(userId) ?? null;
  }

  async profilForKod(kod: string) {
    for (const p of (await this.lasProfiler()).values()) if (p.kod === kod) return p;
    return null;
  }

  async inbjudna(userId: string) {
    return [...(await this.lasProfiler()).values()].filter((p) => p.referredBy === userId);
  }

  skapaProfil(p: ReferralProfil) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      if (map.has(p.userId)) return null;
      for (const q of map.values()) if (q.kod === p.kod) return null;
      map.set(p.userId, p);
      await this.sparaProfiler();
      return p;
    });
  }

  uppdateraProfil(userId: string, patch: Parameters<ReferralStore["uppdateraProfil"]>[1]) {
    return serialize(async () => {
      const map = await this.lasProfiler();
      const p = map.get(userId);
      if (!p) return;
      map.set(userId, { ...p, ...patch, updatedAt: new Date().toISOString() });
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

  async krediter(userId: string) {
    return [...(await this.lasKrediter()).values()].filter((k) => k.userId === userId);
  }

  async kreditForInbjuden(referredUserId: string) {
    for (const k of (await this.lasKrediter()).values()) if (k.referredUserId === referredUserId) return k;
    return null;
  }

  skapaKredit(k: ReferralKredit) {
    return serialize(async () => {
      const map = await this.lasKrediter();
      for (const q of map.values()) if (q.referredUserId === k.referredUserId) return false;
      map.set(k.id, k);
      await this.sparaKrediter();
      return true;
    });
  }

  markeraVisad(id: string, userId: string, at: string) {
    return serialize(async () => {
      const map = await this.lasKrediter();
      const k = map.get(id);
      if (!k || k.userId !== userId || k.visadAt) return;
      map.set(id, { ...k, visadAt: at });
      await this.sparaKrediter();
    });
  }

  bytStatus(id: string, from: KreditStatus, to: KreditStatus, patch: Partial<Pick<ReferralKredit, "usedOnSaleId" | "usedAt">> = {}) {
    return serialize(async () => {
      const map = await this.lasKrediter();
      const k = map.get(id);
      if (!k || k.status !== from) return false;
      map.set(id, { ...k, ...patch, status: to });
      await this.sparaKrediter();
      return true;
    });
  }

  async handelse(h: ReferralHandelse) {
    await mkdir(DIR(), { recursive: true });
    await appendFile(path.join(DIR(), "handelser.jsonl"), JSON.stringify(h) + "\n", "utf-8");
  }

  async handelser() {
    try {
      const raw = await readFile(path.join(DIR(), "handelser.jsonl"), "utf-8");
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReferralHandelse);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase-ryggen (PostgREST över fetch, som butiken)
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
  // 409 = en unik rad fanns redan. Det är ett svar, inte ett fel: koden var tagen, eller den
  // inbjudna hade redan gett en kredit.
  if (res.status === 409) throw new KonfliktFel();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const q = encodeURIComponent;

function profilFranRad(r: Record<string, any>): ReferralProfil {
  return {
    userId: r.user_id,
    kod: r.referral_code,
    referredBy: r.referred_by ?? null,
    referredAt: r.referred_at ?? null,
    forstaAnnonsAt: r.first_listing_at ?? null,
    emailNyckel: r.email_key ?? null,
    adressNyckel: r.address_key ?? null,
    telefonNyckel: r.phone_key ?? null,
    stripeKonto: r.stripe_account_id ?? null,
    emailMaskerad: r.email_masked ?? null,
    namn: r.display_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PROFILKOLUMNER: Record<string, string> = {
  emailNyckel: "email_key",
  adressNyckel: "address_key",
  telefonNyckel: "phone_key",
  stripeKonto: "stripe_account_id",
  emailMaskerad: "email_masked",
  namn: "display_name",
  forstaAnnonsAt: "first_listing_at",
};

function kreditFranRad(r: Record<string, any>): ReferralKredit {
  return {
    id: r.id,
    userId: r.user_id,
    referredUserId: r.referred_user_id,
    status: r.status,
    usedOnSaleId: r.used_on_sale_id ?? null,
    usedAt: r.used_at ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    visadAt: r.shown_at ?? null,
  };
}

class SupabaseStore implements ReferralStore {
  async profil(userId: string) {
    const rows = await call<Record<string, any>[]>("GET", `referral_profiles?user_id=eq.${q(userId)}`);
    return rows?.[0] ? profilFranRad(rows[0]) : null;
  }

  async profilForKod(kod: string) {
    const rows = await call<Record<string, any>[]>("GET", `referral_profiles?referral_code=eq.${q(kod)}`);
    return rows?.[0] ? profilFranRad(rows[0]) : null;
  }

  async inbjudna(userId: string) {
    const rows = await call<Record<string, any>[]>("GET", `referral_profiles?referred_by=eq.${q(userId)}&order=referred_at.desc`);
    return (rows ?? []).map(profilFranRad);
  }

  async skapaProfil(p: ReferralProfil) {
    try {
      await call("POST", "referral_profiles", {
        user_id: p.userId,
        referral_code: p.kod,
        referred_by: p.referredBy,
        referred_at: p.referredAt,
        first_listing_at: p.forstaAnnonsAt,
        email_key: p.emailNyckel,
        address_key: p.adressNyckel,
        phone_key: p.telefonNyckel,
        stripe_account_id: p.stripeKonto,
        email_masked: p.emailMaskerad,
        display_name: p.namn,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      });
      return p;
    } catch (err) {
      if (err instanceof KonfliktFel) return null;
      throw err;
    }
  }

  async uppdateraProfil(userId: string, patch: Parameters<ReferralStore["uppdateraProfil"]>[1]) {
    const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && PROFILKOLUMNER[k]) body[PROFILKOLUMNER[k]] = v;
    await call("PATCH", `referral_profiles?user_id=eq.${q(userId)}`, body);
  }

  /** Villkoret i WHERE-satsen: `referred_by=is.null`. En andra skrivning matchar noll rader. */
  async sattReferredBy(userId: string, referrerId: string, at: string) {
    const rows = await call<unknown[]>(
      "PATCH",
      `referral_profiles?user_id=eq.${q(userId)}&referred_by=is.null`,
      { referred_by: referrerId, referred_at: at, updated_at: at },
      "return=representation",
    );
    return (rows?.length ?? 0) > 0;
  }

  async krediter(userId: string) {
    const rows = await call<Record<string, any>[]>("GET", `referral_credits?user_id=eq.${q(userId)}&order=expires_at.asc`);
    return (rows ?? []).map(kreditFranRad);
  }

  async kreditForInbjuden(referredUserId: string) {
    const rows = await call<Record<string, any>[]>("GET", `referral_credits?referred_user_id=eq.${q(referredUserId)}`);
    return rows?.[0] ? kreditFranRad(rows[0]) : null;
  }

  async skapaKredit(k: ReferralKredit) {
    try {
      await call("POST", "referral_credits", {
        id: k.id,
        user_id: k.userId,
        referred_user_id: k.referredUserId,
        status: k.status,
        used_on_sale_id: k.usedOnSaleId,
        used_at: k.usedAt,
        created_at: k.createdAt,
        expires_at: k.expiresAt,
      });
      return true;
    } catch (err) {
      if (err instanceof KonfliktFel) return false;
      throw err;
    }
  }

  async markeraVisad(id: string, userId: string, at: string) {
    await call("PATCH", `referral_credits?id=eq.${q(id)}&user_id=eq.${q(userId)}&shown_at=is.null`, { shown_at: at });
  }

  async bytStatus(id: string, from: KreditStatus, to: KreditStatus, patch: Partial<Pick<ReferralKredit, "usedOnSaleId" | "usedAt">> = {}) {
    const body: Record<string, unknown> = { status: to };
    if (patch.usedOnSaleId !== undefined) body.used_on_sale_id = patch.usedOnSaleId;
    if (patch.usedAt !== undefined) body.used_at = patch.usedAt;
    const rows = await call<unknown[]>("PATCH", `referral_credits?id=eq.${q(id)}&status=eq.${from}`, body, "return=representation");
    return (rows?.length ?? 0) > 0;
  }

  async handelse(h: ReferralHandelse) {
    await call("POST", "referral_events", {
      id: h.id,
      at: h.at,
      event: h.event,
      user_id: h.userId,
      referral_code: h.referralCode,
      props: h.props,
    });
  }

  async handelser() {
    const rows = await call<Record<string, any>[]>("GET", "referral_events?order=at.asc");
    return (rows ?? []).map((r) => ({
      id: r.id,
      at: r.at,
      event: r.event,
      userId: r.user_id,
      referralCode: r.referral_code ?? null,
      props: r.props ?? {},
    }));
  }
}

let instance: ReferralStore | null = null;
export function referralStore(): ReferralStore {
  // Samma beslut som butiken och affärerna gör, ur samma ställe: att nyckeln FINNS betyder inte att
  // inbjudningarna ska bo i Postgres. Se datalagring.ts.
  if (!instance) instance = supabaseLagring() ? new SupabaseStore() : new FileStore();
  return instance;
}

/** Bara för tester. */
export function resetReferralStore(): void {
  instance = null;
}
