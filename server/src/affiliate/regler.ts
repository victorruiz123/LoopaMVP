/**
 * Affiliate-programmets regler.
 *
 * REGELN, i en mening: den som värvar en ny användare via sin affiliate-länk får 5 % av
 * försäljningspriset på varje annons den användaren säljer, när affären är slutförd.
 *
 * Fyra ögonblick:
 *
 *   1. ANSPRÅKET      (gorAnsprak)              den värvade loggar in första gången efter att ha
 *                                               öppnat länken → referred_by skrivs, en gång.
 *   2. UTBETALNINGEN  (provisionVidUtbetalning) admin markerar säljarens pengar utbetalda — det är
 *                                               "escrow frigjord" hos oss (butik/utbetalning.ts) →
 *                                               en provision, beloppet fryst i öre.
 *   3. RETUREN        (annulleraVidRetur)       möbeln returneras → en provision som inte betalats
 *                                               ut annulleras.
 *   4. AFFILIATE-UTBETALNINGEN (markeraUtbetalda) admin har betalat ut för hand → paid.
 *
 * SKILT FRÅN INBJUDNINGARNA (referral/). Där ger en inbjudan en gratis försäljning; här ger värvningen
 * pengar. Egen kod, egen referred_by, egen länk (/p/KOD i stället för /i/KOD). En användare kan ha
 * kommit via båda, och då gäller båda — programmen vet inte om varandra.
 *
 * VARFÖR PROVISIONEN SKAPAS VID UTBETALNINGEN och inte när möbeln säljs: först när säljarens pengar
 * gått ut är affären slutförd. En köpare som ångrar sig före det, en kassa som avbryts eller en order
 * som återbetalas når aldrig hit — och "ingen provision vid avbruten affär" följer av ordningen i
 * stället för av en regel någon måste minnas.
 */

import { randomUUID } from "node:crypto";
import { normaliseraKod, nyKod, inbjudningsbas } from "../referral/kod.js";
import { getJob, ownerIdOf } from "../jobStore.js";
import { store as butikStore, type ButikRecord } from "../butik/store.js";
import { affiliateStore, type AffiliateProfil, type AffiliateProvision } from "./store.js";

/** Andelen av försäljningspriset som går till den som värvade. */
export const AFFILIATE_ANDEL = 0.05;
/**
 * Hur gammalt ett konto får vara när anspråket görs. Anspråket görs vid första inloggningen efter
 * registreringen; ett konto äldre än så är inte nytt, utan ett befintligt konto som klickat på en länk.
 */
export const NYTT_KONTO_DAGAR = 30;

const DAG_MS = 24 * 60 * 60 * 1000;

/**
 * Länken som delas: loopa.nu/p/KOD.
 *
 * EN SÖKVÄG OCH INTE `/?ref=`, av samma skäl som inbjudningslänken (referral/kod.ts): Cloudflare
 * kan routa sökvägar till appen men inte query-strängar, och `loopa.nu/?ref=…` hamnar på
 * marknadssajten. `loopa.nu/p/*` är bunden i deploy/cloudflare/wrangler.toml.
 */
export function affiliateLank(kod: string): string {
  return `${inbjudningsbas() ?? "https://loopa.nu"}/p/${encodeURIComponent(kod)}`;
}

/** Kronor till öre, och provisionen i öre. Avrundad en gång, här. */
export function provisionOre(mobelprisSek: number, andel: number = AFFILIATE_ANDEL): { salePriceOre: number; amountOre: number } {
  const salePriceOre = Math.round(mobelprisSek * 100);
  return { salePriceOre, amountOre: Math.round(salePriceOre * andel) };
}

// ---------------------------------------------------------------------------
// Profilen och koden
// ---------------------------------------------------------------------------

/**
 * Kontots profil, skapad om den saknas. Koden skapas första gången den behövs.
 *
 * E-posten skrivs när den finns och ändrats: det är dit admin betalar ut, och den som bytt adress ska
 * inte få sin provision skickad till den gamla.
 */
export async function profilFor(userId: string, email: string | null, nu: Date = new Date()): Promise<AffiliateProfil> {
  const store = affiliateStore();
  const finns = await store.profil(userId);
  if (finns) {
    if (email && finns.email !== email) {
      await store.sattEmail(userId, email);
      return { ...finns, email };
    }
    return finns;
  }
  // En krock på koden är astronomiskt osannolik men inte omöjlig; en krock på användaren betyder att
  // en annan förfrågan hann före, och då är det den profilen som gäller.
  for (let forsok = 0; forsok < 5; forsok++) {
    const ny: AffiliateProfil = {
      userId,
      kod: nyKod(),
      referredBy: null,
      referredAt: null,
      email,
      createdAt: nu.toISOString(),
      updatedAt: nu.toISOString(),
    };
    const skapad = await store.skapaProfil(ny);
    if (skapad) return skapad;
    const hann = await store.profil(userId);
    if (hann) return hann;
  }
  throw new Error("Kunde inte skapa en affiliate-kod.");
}

// ---------------------------------------------------------------------------
// 1. Anspråket
// ---------------------------------------------------------------------------

export type AnsprakUtfall = "ok" | "ogiltig_kod" | "egen_kod" | "inte_nytt_konto" | "har_annonser" | "redan_varvad";

export interface AnsprakKonto {
  id: string;
  email: string | null;
  /** Kontots skapelsetid hos Supabase. Saknas den kan vi inte veta att kontot är nytt. */
  createdAt: string | null;
}

/**
 * Den nyss registrerade kom via en affiliate-länk.
 *
 * "VID REGISTRERING" betyder här: kontot är högst NYTT_KONTO_DAGAR gammalt OCH har inga annonser
 * hos oss. Anspråket görs vid första inloggningen, inte i Supabases registrering (där har vi ingen
 * krok), och bekräftelsemejlet kan öppnas dagar senare. Utan villkoren kunde en befintlig säljare
 * klicka på en väns länk och ge vännen 5 % av allt den säljer framöver.
 *
 * FÖRSTA KODEN GÄLLER. Är referred_by redan satt ändras ingenting — villkorat i lagret, och i
 * Supabase dessutom av en trigger.
 */
export async function gorAnsprak(konto: AnsprakKonto, rawKod: unknown, harAnnonser: boolean, nu: Date = new Date()): Promise<AnsprakUtfall> {
  const utfall = await provaAnsprak(konto, rawKod, harAnnonser, nu);
  if (utfall !== "ok") console.info(`[affiliate] anspråk från ${konto.id} med "${String(rawKod).slice(0, 12)}" nekades: ${utfall}`);
  return utfall;
}

async function provaAnsprak(konto: AnsprakKonto, rawKod: unknown, harAnnonser: boolean, nu: Date): Promise<AnsprakUtfall> {
  const kod = normaliseraKod(rawKod);
  if (!kod) return "ogiltig_kod";
  const store = affiliateStore();
  const affiliate = await store.profilForKod(kod);
  if (!affiliate) return "ogiltig_kod";
  if (affiliate.userId === konto.id) return "egen_kod";

  const skapad = konto.createdAt ? new Date(konto.createdAt).getTime() : NaN;
  if (!Number.isFinite(skapad) || nu.getTime() - skapad > NYTT_KONTO_DAGAR * DAG_MS) return "inte_nytt_konto";
  if (harAnnonser) return "har_annonser";

  const profil = await profilFor(konto.id, konto.email, nu);
  if (profil.referredBy !== null) return "redan_varvad";
  if (!(await store.sattReferredBy(konto.id, affiliate.userId, nu.toISOString()))) return "redan_varvad";
  return "ok";
}

// ---------------------------------------------------------------------------
// 2. Utbetalningen till säljaren → provisionen
// ---------------------------------------------------------------------------

export type ProvisionUtfall = "provision" | "ingen_affiliate" | "samma_anvandare" | "redan_provision" | "inget_belopp";

/**
 * Säljarens pengar är utbetalda: affären är slutförd. Skapa provisionen åt den som värvade säljaren.
 *
 * Anropas från butik/utbetalning.ts, markeraUtbetald, EFTER att beloppen frysts. `mobelprisSek` är
 * samma belopp som Loopas andel räknades på — försäljningspriset utan frakt.
 */
export async function provisionVidUtbetalning(
  input: { productId: string; sellerUserId: string; mobelprisSek: number },
  nu: Date = new Date(),
): Promise<ProvisionUtfall> {
  const store = affiliateStore();
  const saljare = await store.profil(input.sellerUserId);
  if (!saljare?.referredBy) return "ingen_affiliate";
  // Schemat förbjuder det också, och referred_by kan inte peka på sig själv — men det här är regeln
  // uppdraget nämner, och den ska stå där den läses.
  if (saljare.referredBy === input.sellerUserId) return "samma_anvandare";
  if (await store.provisionForProdukt(input.productId)) return "redan_provision";

  const { salePriceOre, amountOre } = provisionOre(input.mobelprisSek);
  if (amountOre <= 0) return "inget_belopp";

  const provision: AffiliateProvision = {
    id: randomUUID(),
    affiliateUserId: saljare.referredBy,
    sellerUserId: input.sellerUserId,
    productId: input.productId,
    salePriceOre,
    rate: AFFILIATE_ANDEL,
    amountOre,
    status: "pending",
    createdAt: nu.toISOString(),
    paidAt: null,
    paidBy: null,
    cancelledAt: null,
    cancelReason: null,
  };
  // Falskt = en annan förfrågan hann skapa provisionen för samma annons. Den gäller.
  if (!(await store.skapaProvision(provision))) return "redan_provision";
  console.info(`[affiliate] provision ${amountOre / 100} kr till ${provision.affiliateUserId} för ${input.productId}.`);
  return "provision";
}

// ---------------------------------------------------------------------------
// 3. Returen
// ---------------------------------------------------------------------------

/**
 * Möbeln returnerades och köparen fick pengarna tillbaka. En provision som inte betalats ut än
 * annulleras. En som redan betalats ut lämnas och loggas — den går inte att ta tillbaka automatiskt,
 * och admin behöver veta om den.
 */
export async function annulleraVidRetur(productId: string, nu: Date = new Date()): Promise<"annullerad" | "ingen" | "redan_utbetald"> {
  const store = affiliateStore();
  const p = await store.provisionForProdukt(productId);
  if (!p || p.status === "cancelled") return "ingen";
  if (p.status === "paid") {
    console.warn(`[affiliate] ${productId} returnerades, men provisionen ${p.id} (${p.amountOre / 100} kr) är redan utbetald.`);
    return "redan_utbetald";
  }
  const ok = await store.bytStatus(p.id, "pending", "cancelled", { cancelledAt: nu.toISOString(), cancelReason: "returnerad" });
  return ok ? "annullerad" : "ingen";
}

// ---------------------------------------------------------------------------
// 4. Utbetalningen till affiliate — för hand
// ---------------------------------------------------------------------------

/** Admin har betalat ut. Bara väntande provisioner byter; svaret är hur många som gjorde det. */
export async function markeraUtbetalda(ids: string[], adminId: string | null, nu: Date = new Date()): Promise<number> {
  const store = affiliateStore();
  let antal = 0;
  for (const id of new Set(ids)) {
    if (await store.bytStatus(id, "pending", "paid", { paidAt: nu.toISOString(), paidBy: adminId })) antal += 1;
  }
  return antal;
}

// ---------------------------------------------------------------------------
// Översikterna
// ---------------------------------------------------------------------------

/** Butikens annonser som tillhör någon av användarna. En annons = en post i butiken, oavsett läge. */
async function annonserFor(userIds: Set<string>): Promise<ButikRecord[]> {
  if (userIds.size === 0) return [];
  const ut: ButikRecord[] = [];
  for (const r of await butikStore().all()) {
    if (!r.jobId) continue;
    const job = await getJob(r.jobId);
    const agare = job ? ownerIdOf(job) : null;
    if (agare && userIds.has(agare)) ut.push(r);
  }
  return ut;
}

/** Har kontot redan annonser hos oss? Ett sådant konto är inte nytt och kan inte bli värvat. */
export async function harAnnonser(userId: string): Promise<boolean> {
  return (await annonserFor(new Set([userId]))).length > 0;
}

export interface AffiliateOversikt {
  kod: string;
  lank: string;
  registreringar: number;
  annonser: number;
  salda: number;
  vantandeOre: number;
  utbetaltOre: number;
}

/** Det affiliate-användaren ser: länken, de värvade och vad det gett. */
export async function oversikt(userId: string, email: string | null, nu: Date = new Date()): Promise<AffiliateOversikt> {
  const store = affiliateStore();
  const profil = await profilFor(userId, email, nu);
  const varvade = await store.varvade(userId);
  const annonser = await annonserFor(new Set(varvade.map((p) => p.userId)));
  const provisioner = await store.provisioner({ affiliateUserId: userId });
  const summa = (status: AffiliateProvision["status"]) =>
    provisioner.filter((p) => p.status === status).reduce((s, p) => s + p.amountOre, 0);
  return {
    kod: profil.kod,
    lank: affiliateLank(profil.kod),
    registreringar: varvade.length,
    annonser: annonser.length,
    salda: annonser.filter((r) => r.state === "sold" || r.state === "delivered").length,
    vantandeOre: summa("pending"),
    utbetaltOre: summa("paid"),
  };
}

export interface AdminAffiliateRad {
  userId: string;
  email: string | null;
  kod: string | null;
  vantandeOre: number;
  utbetaltOre: number;
  provisioner: AffiliateProvision[];
}

/** Panelens lista: en rad per affiliate med provisioner, de med väntande belopp först. */
export async function adminOversikt(): Promise<AdminAffiliateRad[]> {
  const store = affiliateStore();
  const perAnvandare = new Map<string, AffiliateProvision[]>();
  for (const p of await store.provisioner()) {
    const lista = perAnvandare.get(p.affiliateUserId) ?? [];
    lista.push(p);
    perAnvandare.set(p.affiliateUserId, lista);
  }
  const rader: AdminAffiliateRad[] = [];
  for (const [userId, provisioner] of perAnvandare) {
    const profil = await store.profil(userId);
    const summa = (status: AffiliateProvision["status"]) =>
      provisioner.filter((p) => p.status === status).reduce((s, p) => s + p.amountOre, 0);
    rader.push({
      userId,
      email: profil?.email ?? null,
      kod: profil?.kod ?? null,
      vantandeOre: summa("pending"),
      utbetaltOre: summa("paid"),
      provisioner: provisioner.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }
  return rader.sort((a, b) => b.vantandeOre - a.vantandeOre || b.utbetaltOre - a.utbetaltOre);
}
