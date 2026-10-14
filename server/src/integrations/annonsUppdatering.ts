/**
 * En ändrad annons ut till marknadsplatserna.
 *
 * När en annons som redan ligger ute ändras — säljaren själv, säljguiden, adminen, eller priset — ska
 * varje marknadsplats visa samma sak som Loopa. Hur det går till skiljer sig per kanal, och det är hela
 * skälet att den här filen finns:
 *
 *   Tradera   — TEXTEN: TAS NER OCH PUBLICERAS IGEN. API:t har ingen väg att ändra texten på en annons
 *               som ligger ute (v4: bara pris, se tradera.ts), så annonsen tas ner och läggs upp med den
 *               aktuella texten. Inte om den har bud (det vore att dra undan en affär) eller redan gått
 *               ut (den läggs om för hand, se priceLadder.ts) — då blir det en uppgift för admin.
 *               PRISET går genom API:t utan omläggning, och sköts av prisstegen (priceLadder.ts).
 *   Blocket   — ÄNDRAS PÅ PLATS av roboten (blocket/redigera.ts): rubrik, beskrivning, mått, märke.
 *               Priset sköts av prisroboten (blocket/pris.ts) genom samma steg.
 *   Facebook  — ÄNDRAS PÅ PLATS av roboten (facebook/redigera.ts): rubrik, PRIS och text. Prisstegen
 *               når inte Facebook, så en prisändring skickas hit (`orsak: "pris"`).
 *
 * VARJE KANAL JÄMFÖR MOT DET SOM LIGGER UTE. Publiceringarna sparar vad som gick upp; står det redan så
 * rörs kanalen inte. Det är det som gör att Tradera bara läggs om när TEXTEN där faktiskt ändrats — en
 * omläggning kostar och tappar bevakarna.
 *
 * HUVUDBRYTAREN: utan ANNONS_UPPDATERING=1 schemaläggs ingenting. Blocket- och Facebook-robotarna kör
 * dessutom i TORRKÖRNING tills BLOCKET_REDIGERA=1 respektive FACEBOOK_REDIGERA=1 är satta.
 *
 * EN UPPDATERING PER OMGÅNG, INTE PER SPARAT FÄLT. Varje ändring skjuter fram körningen DROJ_MS, och
 * kanalerna samlas: tre rättade mått på en minut blir en omgång.
 *
 * KANALERNA ÄR OBEROENDE. En kanal som faller rör inte de andra. "Senare" (Blocket upptaget) och "fel"
 * försöks igen om en stund — felet högst MAX_FORSOK gånger, sedan står det kvar för admin.
 */

import { getJob, listJobs, persist } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import type { ConditionJob } from "../types.js";

export type AnnonsKanal = "tradera" | "blocket" | "facebook";
export const ALLA_KANALER: readonly AnnonsKanal[] = ["tradera", "blocket", "facebook"];

export interface KanalUtfall {
  /**
   * klar: ändrad. oforandrad: stod redan så, ingenting gjordes. torrkord: robot i torrkörning, ingenting
   * sparat. manuell: en människa måste göra det. senare: försök igen om en stund. fel: föll.
   * ej_uppe: annonsen ligger inte på kanalen.
   */
  status: "klar" | "oforandrad" | "torrkord" | "manuell" | "senare" | "fel" | "ej_uppe";
  detalj: string;
}

export interface AnnonsUppdatering {
  /** Senaste ändringen som ska ut. */
  begard: string;
  status: "vantar" | "pagar" | "klar";
  klar: string | null;
  kanaler: Partial<Record<AnnonsKanal, KanalUtfall & { at: string }>>;
  /** Kanalerna nästa körning ska gå igenom. Saknas = alla. */
  vantande?: AnnonsKanal[];
  /** Hur många gånger i rad en kanal fallit. Nollställs av en ny ändring. */
  forsok?: Partial<Record<AnnonsKanal, number>>;
}

/**
 * Visningsläget (scripts/visa-redigering.ts): en människa tittar på roboten i ett synligt fönster.
 * Då är det ALLTID torrkörning, oavsett BLOCKET_REDIGERA/FACEBOOK_REDIGERA, jobbet sparas inte, och
 * exempeländringen (`tillagg`, sist i beskrivningen) finns bara i minnet. `paus` väntar på åskådaren.
 */
export interface Visning {
  tillagg: string;
  paus: (vad: string, page: import("playwright").Page) => Promise<void>;
}

/**
 * Huvudbrytaren. Utan ANNONS_UPPDATERING=1 schemaläggs ingenting — inte ens Tradera, som är skarp
 * (tas ner och läggs upp igen). Funktionen slås på som ett eget beslut efter en visning.
 */
export function annonsUppdateringPa(): boolean {
  return process.env.ANNONS_UPPDATERING?.trim() === "1";
}

/** Vad som ändrades avgör vilka kanaler som behöver höra det. */
export type Orsak = "text" | "pris";
const KANALER_FOR: Record<Orsak, readonly AnnonsKanal[]> = {
  text: ALLA_KANALER,
  // Tradera och Blocket får priset genom prisstegen (priceLadder.ts synkaKanaler).
  pris: ["facebook"],
};

const DROJ_MS = Number(process.env.ANNONS_UPPDATERING_DROJ_MS ?? 60_000);
const OMFORSOK_MS = Number(process.env.ANNONS_UPPDATERING_OMFORSOK_MS ?? 10 * 60_000);
export const MAX_FORSOK = 3;

const timers = new Map<string, NodeJS.Timeout>();
const pagar = new Set<string>();

/** Ligger annonsen ute någonstans där den kan behöva uppdateras? */
async function liggerUte(job: ConditionJob): Promise<boolean> {
  if (job.tradera?.status === "published" || job.blocket?.status === "published") return true;
  try {
    const { allMarketplace, allGroupPublications } = await import("./facebook/store.js");
    const id = loopaIdFor(job.id);
    return (
      (await allMarketplace()).some((p) => p.listingId === id && p.status === "PUBLISHED") ||
      (await allGroupPublications()).some((p) => p.listingId === id && p.status === "PUBLISHED")
    );
  } catch {
    return false;
  }
}

function startaTimer(jobId: string, dröjMs: number): void {
  const tidigare = timers.get(jobId);
  if (tidigare) clearTimeout(tidigare);
  const t = setTimeout(() => {
    timers.delete(jobId);
    void korAnnonsUppdatering(jobId);
  }, dröjMs);
  // Håller inte processen vid liv: servern lever på sin lyssnare, och ett skript eller test som är
  // klart ska kunna avsluta trots en väntande omgång.
  t.unref();
  timers.set(jobId, t);
}

/**
 * Annonsen ändrades. Ligger den ute schemaläggs en uppdatering — och en som redan väntar skjuts fram
 * och får de nya kanalerna tillagda, så att en omgång ändringar blir en uppdatering. Kastar aldrig:
 * ändringen är redan sparad.
 */
export async function schemalaggAnnonsUppdatering(job: ConditionJob, dröjMs = DROJ_MS, orsak: Orsak = "text"): Promise<void> {
  try {
    if (!annonsUppdateringPa()) return;
    if (!(await liggerUte(job))) return;
    const fore = job.annonsUppdatering;
    const redanVantande = fore?.status === "vantar" || fore?.status === "pagar" ? (fore.vantande ?? ALLA_KANALER) : [];
    const vantande = ALLA_KANALER.filter((k) => redanVantande.includes(k) || KANALER_FOR[orsak].includes(k));
    job.annonsUppdatering = {
      begard: new Date().toISOString(),
      status: "vantar",
      klar: null,
      kanaler: fore?.kanaler ?? {},
      vantande,
      forsok: {},
    };
    await persist(job);
    startaTimer(job.id, dröjMs);
    console.info(`[annons-uppdatering] ${job.id.slice(0, 8)} schemalagd om ${Math.round(dröjMs / 1000)} s (${vantande.join(", ")})`);
  } catch (err) {
    console.warn(`[annons-uppdatering] ${job.id.slice(0, 8)} kunde inte schemaläggas:`, err instanceof Error ? err.message : err);
  }
}

/** Priset ändrades (en sänkning eller adminens nya pris): Facebook ska få det. */
export function schemalaggPrisUppdatering(job: ConditionJob): Promise<void> {
  return schemalaggAnnonsUppdatering(job, DROJ_MS, "pris");
}

/**
 * Tradera: ta ner och publicera igen — men bara när texten där faktiskt ändrats, och aldrig med bud
 * eller när annonsen redan gått ut.
 */
async function uppdateraTradera(job: ConditionJob): Promise<KanalUtfall> {
  const tr = job.tradera;
  if (!tr || tr.status !== "published" || !tr.itemId) return { status: "ej_uppe", detalj: "Ligger inte uppe på Tradera." };

  const { planTraderaPublish, traderaAdBlocks, markTraderaPublishing, runTraderaPublish } = await import("./tradera/publish.js");
  const plan = await planTraderaPublish(job);
  if (!plan.ok) return { status: "manuell", detalj: `Annonsen går inte att bygga för Tradera: ${plan.reason}` };
  const { medRattelser } = await import("../butik/overrides.js");
  const nyaBlock = traderaAdBlocks(await medRattelser(job), tr.shippingSek ?? plan.plan.shippingSek);
  if (tr.adBlocks && JSON.stringify(tr.adBlocks) === JSON.stringify(nyaBlock) && (tr.rubrik ?? plan.plan.title) === plan.plan.title) {
    return { status: "oforandrad", detalj: "Tradera-annonsen visar redan det här — den läggs inte om." };
  }

  const { getTraderaLage, traderaConfigured } = await import("./tradera/tradera.js");
  if (!traderaConfigured()) return { status: "manuell", detalj: "Tradera är inte konfigurerat på servern — uppdatera annonsen för hand." };
  const lage = await getTraderaLage(tr.itemId);
  if (lage?.ended) return { status: "manuell", detalj: "Tradera-annonsen har gått ut — lägg om den för hand." };
  if (lage && lage.totalBids > 0) {
    return { status: "manuell", detalj: `Tradera-annonsen har ${lage.totalBids} bud och tas inte ner — uppdatera beskrivningen för hand.` };
  }
  const { taNerTraderaAnnons } = await import("./tradera/nedtagning.js");
  const gammal = tr.itemId;
  await taNerTraderaAnnons(job, loopaIdFor(job.id), "annonsen uppdaterad");
  await markTraderaPublishing(job);
  await runTraderaPublish(job.id);
  const efter = (await getJob(job.id))?.tradera;
  if (efter?.status === "published" && efter.itemId && efter.itemId !== gammal) {
    return { status: "klar", detalj: `Tradera-annonsen är upplagd på nytt (${efter.url ?? efter.itemId}).` };
  }
  return { status: "fel", detalj: `Tradera-annonsen togs ner men kunde inte läggas upp igen: ${efter?.error ?? "okänt fel"}` };
}

const KOR: Record<AnnonsKanal, (job: ConditionJob) => Promise<KanalUtfall>> = {
  tradera: uppdateraTradera,
  blocket: async (job) => (await import("./blocket/redigera.js")).redigeraBlocketAnnons(job),
  facebook: async (job) => (await import("./facebook/redigera.js")).redigeraFacebook(job),
};

/** Kör uppdateringen nu: varje väntande kanal, en i taget. */
export async function korAnnonsUppdatering(jobId: string): Promise<void> {
  if (pagar.has(jobId)) return;
  pagar.add(jobId);
  try {
    const job = await getJob(jobId);
    if (!job?.annonsUppdatering) return;
    const omgang = job.annonsUppdatering;
    const vantande = omgang.vantande ?? [...ALLA_KANALER];
    omgang.status = "pagar";
    await persist(job);

    const kanaler: AnnonsUppdatering["kanaler"] = { ...omgang.kanaler };
    const forsok: NonNullable<AnnonsUppdatering["forsok"]> = { ...(omgang.forsok ?? {}) };
    const igen: AnnonsKanal[] = [];
    for (const kanal of vantande) {
      let utfall: KanalUtfall;
      try {
        utfall = await KOR[kanal](job);
      } catch (err) {
        utfall = { status: "fel", detalj: err instanceof Error ? err.message : String(err) };
      }
      if (utfall.status === "ej_uppe") {
        delete kanaler[kanal];
        continue;
      }
      if (utfall.status === "fel") {
        forsok[kanal] = (forsok[kanal] ?? 0) + 1;
        if (forsok[kanal]! < MAX_FORSOK) igen.push(kanal);
        else utfall = { ...utfall, detalj: `${utfall.detalj} (gav upp efter ${MAX_FORSOK} försök — åtgärda och ändra annonsen igen, eller gör det för hand)` };
      } else if (utfall.status === "senare") {
        igen.push(kanal);
      } else {
        delete forsok[kanal];
      }
      kanaler[kanal] = { ...utfall, at: new Date().toISOString() };
      console.info(`[annons-uppdatering] ${jobId.slice(0, 8)} ${kanal}: ${utfall.status} — ${utfall.detalj.slice(0, 160)}`);
    }

    const farsk = (await getJob(jobId)) ?? job;
    // En ny ändring kom in medan vi körde: den har redan sin egen omgång, med alla kanaler den behöver.
    if (farsk.annonsUppdatering && farsk.annonsUppdatering.begard !== omgang.begard) {
      farsk.annonsUppdatering.kanaler = { ...kanaler, ...farsk.annonsUppdatering.kanaler };
      await persist(farsk);
      return;
    }
    farsk.annonsUppdatering = {
      begard: omgang.begard,
      status: igen.length ? "vantar" : "klar",
      klar: igen.length ? null : new Date().toISOString(),
      kanaler,
      vantande: igen,
      forsok,
    };
    await persist(farsk);
    if (igen.length) startaTimer(jobId, OMFORSOK_MS);
  } finally {
    pagar.delete(jobId);
  }
}

/** Vid start: uppdateringar som väntade eller avbröts av en omstart körs igen. */
export async function aterupptaAnnonsUppdateringar(): Promise<void> {
  if (!annonsUppdateringPa()) return;
  try {
    for (const job of await listJobs()) {
      const s = job.annonsUppdatering?.status;
      if (s === "vantar" || s === "pagar") {
        job.annonsUppdatering!.status = "vantar";
        startaTimer(job.id, DROJ_MS);
      }
    }
  } catch (err) {
    console.warn("[annons-uppdatering] kunde inte återuppta:", err instanceof Error ? err.message : err);
  }
}
