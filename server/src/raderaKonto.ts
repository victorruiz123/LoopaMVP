/**
 * RADERA ANVÄNDARE & INNEHÅLL — adminens knapp för att ta bort en person ur Loopa.
 *
 * VARFÖR EN MODUL OCH INTE TIO HANDGREPP. En persons uppgifter ligger utspridda i ett dussin lager:
 * jobben med fotona från deras hem, butiken, Tradera, bevakningar, efterlysningar, notiser, ordrar,
 * affärer, inbjudningar, omdömen, chattloggar, flödesloggen, utskicksloggen, /outbox — och sist
 * inloggningen i Supabase. Att göra det för hand är att glömma ett av dem. Här står de i en lista,
 * i en ordning som håller.
 *
 * TVÅ STEG, UNDERLAGET OCH RADERINGEN. Panelen hämtar först `underlag` och visar vad som kommer att
 * försvinna och vad som stoppar. Raderingen räknar om underlaget själv i stället för att lita på det
 * panelen såg — det kan ha gått minuter mellan trycken, och en möbel kan ha hunnit bli reserverad.
 *
 * VAD SOM STOPPAR (`hinder`). Allt där någon annan part har pengar eller en möbel på väg:
 *   - en möbel reserverad i en kassa, eller såld men inte utbetald (vi är skyldiga säljaren pengar),
 *   - en order som köpare som är betald men inte levererad, eller som har en ånger/retur öppen,
 *   - en affär där pengar bytt händer men som inte är avslutad,
 *   - ett jobb som analyseras just nu (pipelinen hade skrivit tillbaka mappen efter raderingen),
 *   - adminkonton, och det egna kontot.
 * De löses i respektive flik först. Raderingen går sedan igenom.
 *
 * VAD SOM INTE RADERAS UTAN AVIDENTIFIERAS. Ordrar och affärer står kvar som bokföring — belopp,
 * datum, möbel — men utan konto, e-post, postnummer och tider. Bokföringslagen kräver sju år. De
 * hashade avtrycken i inbjudningsprofilen (e-post, adress, telefon) står också kvar: de är spärren
 * som gör att samma person inte kan registrera sig igen och få en gratis försäljning till, och de
 * går inte att läsa tillbaka till en adress.
 *
 * INLOGGNINGEN SIST. Kontot delas med Vips (samma Supabase-projekt), så det som raderas i Auth är
 * borta även där. Det tas sist för att allt ovan behöver id:t — och faller just det steget står
 * Loopa-datan ändå raderad, och knappen kan tryckas igen.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { kontoDetalj } from "./admin.js";
import { DATA_DIR, IN_FLIGHT, listJobs, listRemovedJobs, ownerIdOf, raderaJobb } from "./jobStore.js";
import { loopaIdFor } from "./loopaId.js";
import { supabaseUrl } from "./supabaseAuth.js";
import type { ConditionJob } from "./types.js";

export class RaderingsFel extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly hinder: string[] = [],
  ) {
    super(message);
  }
}

export interface RaderingsUnderlag {
  userId: string;
  email: string | null;
  namn: string | null;
  /** Jobb kontot äger, borttagna inräknade — mapparna med bilderna raderas för alla. */
  jobb: number;
  /** Av dem: de som blev annonser. */
  annonser: number;
  /** Annonser som ligger ute i butiken eller på Tradera just nu och tas ner. */
  uteNu: number;
  bevakningar: number;
  efterlysningar: number;
  /** Ordrar som köpare. Avidentifieras, raderas inte. */
  ordrar: number;
  /** Affärer som köpare eller säljare. Avidentifieras, och de som inte kommit till betalning avbryts. */
  affarer: number;
  omdomen: number;
  /** Det som stoppar raderingen. Tomt = knappen går att trycka. */
  hinder: string[];
  /** Det som måste tas ner för hand efteråt: Facebook och Blocket har ingen väg att avpublicera. */
  forHand: string[];
}

export interface RaderingsResultat {
  raderat: Record<string, number>;
  forHand: string[];
  /** Inloggningen i Supabase. `fel` satt = Loopa-datan är borta men kontot står kvar — tryck igen. */
  inloggning: { raderad: boolean; fel: string | null };
}

const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

/** Lägen där någon står i kassan eller har betalat, och ordern därför inte får tappa sin köpare. */
const AKTIVA_ORDRAR = new Set(["paid", "booking", "scheduled", "cancel_requested", "return_requested"]);

async function kontotsJobb(userId: string): Promise<ConditionJob[]> {
  const [kvar, borttagna] = await Promise.all([listJobs(), listRemovedJobs()]);
  return [...kvar, ...borttagna].filter((j) => ownerIdOf(j) === userId);
}

/** Facebook- och Blocket-inläggen som ligger ute. De kan bara tas ner av en människa. */
async function manuellaNedtagningar(jobb: ConditionJob[]): Promise<string[]> {
  const ut: string[] = [];
  const fb = await import("./integrations/facebook/store.js").catch(() => null);
  for (const job of jobb) {
    const loopaId = loopaIdFor(job.id);
    if (job.blocket?.status === "published" && !job.blocket.dryRun) {
      ut.push(`Blocket ${loopaId}: ${job.blocket.url ?? "annons utan adress"}`);
    }
    if (!fb) continue;
    const mp = await fb.getMarketplace(loopaId).catch(() => null);
    if (mp?.status === "PUBLISHED") ut.push(`Facebook Marketplace ${loopaId}: ${mp.facebookUrl ?? "inlägg utan adress"}`);
    for (const g of await fb.groupPublicationsFor(loopaId).catch(() => [])) {
      if (g.status === "PUBLISHED") ut.push(`Facebook-grupp ${loopaId}: ${g.facebookPostUrl ?? "inlägg utan adress"}`);
    }
  }
  return ut;
}

export async function underlag(userId: string, adminId: string): Promise<RaderingsUnderlag | null> {
  const konto = await kontoDetalj(userId);
  if (!konto) return null;
  const email = konto.email?.trim() || null;
  const hinder: string[] = [];

  if (userId === adminId) hinder.push("Du kan inte radera ditt eget konto härifrån.");
  if (konto.isAdmin) hinder.push("Kontot är ett adminkonto. Ta bort adressen ur ADMIN_EMAILS först.");
  if (!serviceRoleKey()) {
    hinder.push("Servern saknar SUPABASE_SERVICE_ROLE_KEY, så inloggningen kan inte raderas.");
  }

  const jobb = await kontotsJobb(userId);
  const { store: butik } = await import("./butik/store.js");
  let uteNu = 0;
  for (const job of jobb) {
    const loopaId = loopaIdFor(job.id);
    if (IN_FLIGHT.has(job.progress?.stage)) hinder.push(`${loopaId} analyseras just nu. Vänta tills den är klar.`);
    const post = await butik().get(loopaId).catch(() => null);
    if (post?.state === "reserved") hinder.push(`${loopaId} är reserverad — någon står i kassan just nu.`);
    if ((post?.state === "sold" || post?.state === "delivered") && !post.utbetalning) {
      hinder.push(`${loopaId} är såld men inte utbetald. Betala ut till säljaren under Utbetalningar först.`);
    }
    const paTradera = job.tradera?.status === "published" || job.tradera?.status === "publishing";
    if (post?.state === "live" || paTradera) uteNu += 1;
  }

  const { ordersForUser, allOrders } = await import("./butik/orders.js");
  const epostLiten = email?.toLowerCase() ?? null;
  const ordrar = epostLiten
    ? (await allOrders()).filter((o) => o.userId === userId || o.email?.trim().toLowerCase() === epostLiten)
    : await ordersForUser(userId);
  for (const o of ordrar) {
    if (AKTIVA_ORDRAR.has(o.status)) hinder.push(`Order ${o.reference} pågår (${o.status}). Avsluta den under Ordrar först.`);
  }

  const affar = await import("./affar/store.js");
  const { CANCELLABLE, TERMINAL } = await import("./affar/types.js");
  const affarer = (await affar.store().all()).filter((d) => d.buyerId === userId || d.sellerId === userId);
  for (const d of affarer) {
    if (!TERMINAL.includes(d.state) && !CANCELLABLE.includes(d.state)) {
      hinder.push(`En affär (${d.id.slice(0, 8)}) har kommit till betalning och är inte avslutad (${d.state}).`);
    }
  }

  const [{ listBevakningar }, efterlysning, feedback] = await Promise.all([
    import("./butik/bevakningar.js"),
    import("./efterlysning/store.js"),
    import("./feedback.js"),
  ]);
  const jobIds = new Set(jobb.map((j) => j.id));
  const omdomen = (await feedback.listaFeedback()).poster.filter(
    (f) => f.userId === userId || (f.jobId && jobIds.has(f.jobId)),
  ).length;

  return {
    userId,
    email,
    namn: konto.name,
    jobb: jobb.length,
    annonser: jobb.filter((j) => !!(j.result?.listing ?? j.listing ?? j.pendingListing)).length,
    uteNu,
    bevakningar: (await listBevakningar(userId)).length,
    efterlysningar: (await efterlysning.forUser(userId)).length,
    ordrar: ordrar.length,
    affarer: affarer.length,
    omdomen,
    hinder,
    forHand: await manuellaNedtagningar(jobb),
  };
}

/**
 * Raderar kontot. `bekraftelse` ska vara kontots e-postadress (eller id:t, när adressen saknas) —
 * det sista av panelens fyra tryck, och det enda som når servern. Ett anrop som inte kan namnge
 * kontot det raderar ska inte radera något.
 */
export async function raderaKonto(userId: string, bekraftelse: unknown, adminId: string): Promise<RaderingsResultat> {
  const u = await underlag(userId, adminId);
  if (!u) throw new RaderingsFel("Kontot finns inte.", 404);
  const forvantat = (u.email ?? u.userId).toLowerCase();
  if (typeof bekraftelse !== "string" || bekraftelse.trim().toLowerCase() !== forvantat) {
    throw new RaderingsFel(
      u.email ? "Bekräftelsen stämmer inte med kontots e-postadress." : "Bekräftelsen stämmer inte med kontots id.",
      400,
    );
  }
  if (u.hinder.length) throw new RaderingsFel("Kontot kan inte raderas än.", 409, u.hinder);

  const raderat: Record<string, number> = {};
  const jobb = await kontotsJobb(userId);
  const jobIds = new Set(jobb.map((j) => j.id));

  /**
   * 1. TRADERA FÖRST, och allt eller inget. En annons som inte gick att ta ner kan fortfarande köpas,
   *    och då ska ingenting ha raderats ännu — annars står en köpbar annons kvar utan jobb bakom sig.
   */
  const { taNerTraderaAnnons } = await import("./integrations/tradera/nedtagning.js");
  for (const job of jobb) {
    const loopaId = loopaIdFor(job.id);
    try {
      await taNerTraderaAnnons(job, loopaId, "kontot raderades av en admin");
    } catch (err) {
      console.error(`[radering] ${loopaId}: Tradera-annonsen kunde inte tas ner:`, err instanceof Error ? err.message : err);
      throw new RaderingsFel(
        `Tradera-annonsen för ${loopaId} kunde inte tas ner just nu. Ingenting har raderats — försök igen om en stund.`,
        502,
      );
    }
  }

  // 2. Butiken och jobben. Ur rutnätet medan jobbet finns kvar, sedan mappen med allt i.
  const butik = await import("./butik/store.js");
  const { tabort: taBortRattelse } = await import("./butik/overrides.js");
  for (const job of jobb) {
    const loopaId = loopaIdFor(job.id);
    const post = await butik.store().get(loopaId).catch(() => null);
    if (post?.state === "live") await butik.unpublish(loopaId, { kind: "admin", userId: adminId }).catch(() => null);
    await taBortRattelse(loopaId).catch(() => false);
    await raderaJobb(job.id);
  }
  raderat.jobb = jobb.length;
  const { invalidate } = await import("./butik/inventory.js");
  invalidate();

  // 3. Det kontot bad om att få veta: bevakningar, efterlysningar, förturer, notiser.
  const { listBevakningar, deleteBevakning } = await import("./butik/bevakningar.js");
  raderat.bevakningar = 0;
  for (const b of await listBevakningar(userId)) if (await deleteBevakning(b.id, userId)) raderat.bevakningar += 1;

  const efterlysning = await import("./efterlysning/store.js");
  raderat.efterlysningar = 0;
  for (const e of await efterlysning.forUser(userId)) if (await efterlysning.remove(e.id, userId)) raderat.efterlysningar += 1;
  raderat.forturer = await (await import("./efterlysning/fortur.js")).glomKonto(userId);
  raderat.notiser = await (await import("./efterlysning/notify.js")).glomKonto(userId);

  // 4. Bokföringen: ordrar och affärer står kvar, utan personen. Se filens topp.
  raderat.ordrarAvidentifierade = await (await import("./butik/orders.js")).avidentifieraKopare(userId, u.email);

  const affar = await import("./affar/store.js");
  const { CANCELLABLE } = await import("./affar/types.js");
  raderat.affarerAvidentifierade = 0;
  for (const d of (await affar.store().all()).filter((x) => x.buyerId === userId || x.sellerId === userId)) {
    if (CANCELLABLE.includes(d.state)) {
      await affar.move(d.id, [d.state], "declined", { kind: "ops", userId: adminId }, "Avbruten: kontot raderades.");
    }
    await affar.purgeSubmissionMedia(d.id);
    const fardig = await affar.store().get(d.id);
    if (!fardig) continue;
    const somKopare = fardig.buyerId === userId;
    const somSaljare = fardig.sellerId === userId;
    await affar.store().put({
      ...fardig,
      ...(somKopare ? { buyerEmail: null, buyerPostalCode: null } : {}),
      ...(somSaljare ? { sellerEmail: null, sellerPostalCode: null } : {}),
      updatedAt: new Date().toISOString(),
    });
    raderat.affarerAvidentifierade += 1;
  }

  // 5. Inbjudningarna: namnet, den maskade adressen och Stripe-kontot bort; avtrycken står kvar.
  const { referralStore } = await import("./referral/store.js");
  const referral = referralStore();
  if (await referral.profil(userId)) {
    await referral.uppdateraProfil(userId, { emailMaskerad: null, namn: null, stripeKonto: null });
    raderat.inbjudningsprofil = 1;
  }
  raderat.krediterAvslutade = 0;
  for (const k of await referral.krediter(userId)) {
    if (k.status === "available" && (await referral.bytStatus(k.id, "available", "expired"))) raderat.krediterAvslutade += 1;
  }

  // 6. Loggarna som bär personen: omdömen, chattar, flödet, utskicken, sparade brev.
  raderat.omdomen = await (await import("./feedback.js")).glomKonto(userId, jobIds);
  raderat.chattsamtal = await (await import("./data/samtal.js")).glomKonto(userId);
  raderat.flodessessioner = await (await import("./data/flode.js")).glomKonto(userId, jobIds);
  if (u.email) {
    raderat.utskicksrader = await (await import("./utskick.js")).glomMottagare(u.email);
    raderat.sparadeBrev = await (await import("./notify/outbox.js")).glomMottagare(u.email);
  }

  // 7. Inloggningen, sist. Profilraden före Auth: pekar den på kontot utan kaskad stoppar den annars
  //    raderingen i Auth med ett databasfel.
  const inloggning = await raderaInloggning(userId);

  await loggaRadering({ userId, adminId, raderat, inloggning: inloggning.raderad });
  console.log(`[radering] admin ${adminId} raderade konto ${userId}:`, JSON.stringify(raderat), inloggning);

  return { raderat, forHand: u.forHand, inloggning };
}

async function raderaInloggning(userId: string): Promise<{ raderad: boolean; fel: string | null }> {
  const key = serviceRoleKey();
  if (!key) return { raderad: false, fel: "SUPABASE_SERVICE_ROLE_KEY saknas på servern." };
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const id = encodeURIComponent(userId);
  try {
    const profil = await fetch(`${supabaseUrl()}/rest/v1/profiles?user_id=eq.${id}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=minimal" },
    });
    if (!profil.ok) {
      const text = await profil.text().catch(() => "");
      return { raderad: false, fel: `Profilen kunde inte raderas (${profil.status}): ${text.slice(0, 200)}` };
    }
    const auth = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${id}`, { method: "DELETE", headers });
    // 404 = redan borta, vilket är det tillstånd vi bad om.
    if (!auth.ok && auth.status !== 404) {
      const text = await auth.text().catch(() => "");
      return { raderad: false, fel: `Inloggningen kunde inte raderas (${auth.status}): ${text.slice(0, 200)}` };
    }
    return { raderad: true, fel: null };
  } catch (err) {
    return { raderad: false, fel: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Kvittot: att en radering skett, när och av vem. Inga uppgifter om personen utöver id:t, som efter
 * raderingen inte pekar på någon. Det är det som går att visa upp om någon frågar om sin begäran
 * blev utförd.
 */
async function loggaRadering(post: Record<string, unknown>): Promise<void> {
  try {
    const dir = process.env.RADERING_DATA_DIR?.trim() || path.join(DATA_DIR, "raderingar");
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "logg.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...post }) + "\n", "utf-8");
  } catch (err) {
    console.error("[radering] kvittot kunde inte skrivas:", err);
  }
}
