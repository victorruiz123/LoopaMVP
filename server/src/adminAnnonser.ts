/**
 * Adminpanelens annonsvy: allt vi fått in, vad det är värt, och vad som hänt med det.
 *
 * EN RAD PER JOBB, inte per butiksvara. Skillnaden är hela poängen med vyn: 67 av 172 besiktigade
 * jobb har ingen annons alls, och de syns ingenstans i produkten i dag — inte i butiken (de faller
 * på `shopReadiness`), inte i profilen (den visar bara kort). Panelen som ska svara på "vad får vi
 * in" måste visa dem, med det som fattas utskrivet, annars mäter den bara det som redan lyckats.
 *
 * SEX KÄLLOR SLÅS IHOP HÄR, och alla sex ägs av någon annan:
 *
 *   jobStore          besiktningen, annonstexten, prisstegen, Tradera-publiceringen
 *   butik/store       tillståndet och huvudboken över varje övergång
 *   butik/normalize   projektionen till en butiksvara — titel, kategori, mått, bild
 *   butik/overrides   adminens egna rättelser, pålagda sist
 *   butik/orders      ordrarna på möbeln
 *   analys/store      visningar och klick
 *
 * Ingenting räknas om här som någon annan redan räknar. Panelen får INTE bli ett andra svar på
 * "vad kostar den" eller "är den såld" — den ska visa samma tal som butiken och profilen visar, och
 * ett tal som räknas på två ställen börjar avvika samma dag det ena stället ändras.
 */

import { getJob, listJobs, ownerIdOf, persist } from "./jobStore.js";
import { loopaIdFor } from "./loopaId.js";
import { jobToProduct } from "./butik/normalize.js";
import { shopReadiness } from "./butik/state.js";
import {
  claimForSale,
  ensureRecord,
  markDelivered,
  markReturned,
  publish,
  release,
  store as butikStore,
  unpublish,
  type ButikRecord,
} from "./butik/store.js";
import { invalidate } from "./butik/inventory.js";
import { allOrders, ordersForProduct, type Order } from "./butik/orders.js";
import * as overrides from "./butik/overrides.js";
import { allStatistik, handelserFor, statistikFor, tomStatistik, type AnalysHandelse, type AnnonsStatistik } from "./analys/store.js";
import { makePriceLadder, nextRung } from "./priceLadder.js";
import type { ConditionJob, PriceLadder, TraderaPublication } from "./types.js";
import { markTraderaPublishing, planTraderaPublish, runTraderaPublish } from "./integrations/tradera/publish.js";
import { traderaConfigured, missingTraderaEnv } from "./integrations/tradera/tradera.js";
import type { Product, ProductEvent, ProductState } from "./butik/types.js";

/** Var i pipelinen jobbet står, i klartext för en människa som läser en lista. */
export type AnnonsLage = "misslyckad" | "pagaende" | "utan-annons" | "utkast" | "vantar" | "live" | "reserverad" | "sald" | "levererad" | "returnerad";

export interface AdminAnnonsRad {
  /** Loopa-ID:t. Adressen möbeln har utåt, och nyckeln allt annat slås upp på. */
  id: string;
  jobId: string;
  ownerId: string | null;
  createdAt: string;
  lage: AnnonsLage;
  /** Butikens tillstånd, när möbeln finns där. Null = aldrig inlagd. */
  state: ProductState | null;
  titel: string;
  brand: string | null;
  model: string | null;
  categorySlug: string | null;
  imageUrl: string | null;
  grade: string | null;
  /** Vad som fattas innan möbeln får ligga i butiken. Tom lista = ingenting. */
  saknas: string[];
  /** Sant när en admin rättat något på annonsen. */
  overstyrd: boolean;

  // --- pris ---
  /** Priset som ligger nu: prisstegen om den finns, annars prismotorns förslag. */
  prisNu: number | null;
  /** Priset annonsen LADES UPP med. Skilt från prisNu — det är hela frågan stegen finns för. */
  prisStart: number | null;
  prisGolv: number | null;
  /** Prismotorns eget förslag, som jämförelse mot vad säljaren valde. */
  prisForslag: number | null;
  /** Nypris, när det är känt. Besparingen räknas ur det. */
  prisNy: number | null;
  /** Hur många sänkningar stegen redan gjort. */
  sankningar: number;
  nextDropAt: string | null;

  // --- tid ---
  /** När möbeln lades i butiken. Null = aldrig. */
  listedAt: string | null;
  soldAt: string | null;
  soldChannel: "butik" | "tradera" | null;
  /** Dygn uppe: från listedAt till försäljningen, eller till nu för det som fortfarande ligger. */
  dagarUppe: number | null;

  // --- kanaler ---
  traderaStatus: TraderaPublication["status"] | null;
  traderaItemId: number | null;
  /** När säljaren tryckte "Sälj med Loopa". Null = aldrig. Kön sorteras på den. */
  begardAt: string | null;

  // --- mätning ---
  statistik: AnnonsStatistik;
  /** Klick delat med visningar. Null när ingen sett annonsen — noll vore en påstådd nolla. */
  ctr: number | null;
  ordrar: number;
}

export interface AdminAnnonsDetalj extends AdminAnnonsRad {
  /** Varan som butiken visar den, med rättelserna pålagda. Null när jobbet inte projicerar. */
  produkt: Product | null;
  /** Vad besiktningen och generatorn HÄRLEDDE, före rättelserna. Det man jämför mot. */
  harlett: Product | null;
  overstyrning: overrides.Overstyrning | null;
  annonstext: { title: string; description: string; conditionText: string } | null;
  ladder: PriceLadder | null;
  /** Publiceringen mot Tradera i sin helhet — länken, felet, vem som godkände. */
  tradera: TraderaPublication | null;
  /** Butikens huvudbok för möbeln: varje övergång, med vem och varför. */
  handelser: ProductEvent[];
  /** Mätningens råa rader, nyast först. */
  matningar: AnalysHandelse[];
  ordrarRader: Order[];
  progress: { stage: string; pct?: number } | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Läsningen
// ---------------------------------------------------------------------------

/** Annonsen kan sitta på tre ställen — samma regel som profilen och det publika kortet följer. */
function listingOf(job: ConditionJob) {
  return job.result?.listing ?? job.listing ?? job.pendingListing ?? null;
}

/**
 * Ett läge som går att sortera på och läsa i en lista.
 *
 * Butikens tillstånd vinner när det finns — det är den enda källan till om möbeln är såld. Saknas
 * det säger jobbet var i pipelinen det står, och de tre lägena före butiken är just de som annars är
 * osynliga: föll, kör fortfarande, eller blev aldrig en annons.
 */
export function lageAv(job: ConditionJob, record: ButikRecord | undefined): AnnonsLage {
  if (record) {
    if (record.state === "live") return "live";
    if (record.state === "reserved") return "reserverad";
    if (record.state === "sold") return "sald";
    if (record.state === "delivered") return "levererad";
    if (record.state === "returned") return "returnerad";
  }
  // Säljaren har tryckt "Sälj med Loopa" och ingen har svarat än. Går före utkastet: en möbel som
  // redan finns som utkast i lagret men står i kön är i första hand något som väntar på oss.
  if (job.tradera?.status === "pending") return "vantar";
  if (record) return "utkast";
  if (job.error) return "misslyckad";
  if (!job.result) return "pagaende";
  return "utan-annons";
}

function dygnMellan(fran: string | null, till: string | null): number | null {
  if (!fran) return null;
  const start = Date.parse(fran);
  const slut = till ? Date.parse(till) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(slut)) return null;
  return Math.max(0, Math.round((slut - start) / 86_400_000));
}

/**
 * Klickfrekvensen.
 *
 * Nämnaren är sidvisningar OCH listvisningar tillsammans: en möbel som visats tusen gånger i ett
 * rutnät och klickats tio gånger har en frekvens, och att räkna bara på dem som redan öppnat
 * produktsidan hade svarat på en annan fråga än den panelen ställer.
 */
function ctrAv(s: AnnonsStatistik): number | null {
  const namnare = s.visningar + s.listvisningar;
  return namnare > 0 ? s.klick / namnare : null;
}

function radAv(
  job: ConditionJob,
  record: ButikRecord | undefined,
  overstyrning: overrides.Overstyrning | undefined,
  produkt: Product | null,
  statistik: AnnonsStatistik,
  ordrar: number,
): AdminAnnonsRad {
  const id = loopaIdFor(job.id);
  const listing = listingOf(job);
  const ladder = job.priceLadder ?? null;
  const pris = job.result?.price;
  const listedAt = record?.listedAt ?? null;

  return {
    id,
    jobId: job.id,
    ownerId: ownerIdOf(job),
    createdAt: job.createdAt,
    lage: lageAv(job, record),
    state: record?.state ?? null,
    /**
     * Titeln i tre steg ner: butikens projicerade titel, annonsgeneratorns rubrik, och till sist
     * märke + modell. Sista utvägen är Loopa-ID:t — en rad utan namn är fortfarande en rad som ska gå
     * att klicka på, och ett jobb som föll före generatorn har inget annat namn.
     */
    titel:
      produkt?.title ??
      listing?.result?.listing.title ??
      [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ") ??
      id,
    brand: produkt?.brand ?? job.identity?.brand ?? null,
    model: produkt?.model ?? job.identity?.model ?? null,
    categorySlug: produkt?.categorySlug ?? null,
    imageUrl: produkt?.imageUrl ?? null,
    grade: job.result?.grade?.grade ?? null,
    saknas: produkt ? shopReadiness(produkt).missing : ["besiktning"],
    overstyrd: !!overstyrning,

    prisNu: produkt?.priceSek ?? (ladder ? Math.round(ladder.currentPrice) : null),
    prisStart: ladder ? Math.round(ladder.startPrice) : null,
    prisGolv: ladder ? Math.round(ladder.floorPrice) : null,
    prisForslag: pris?.status === "ok" && pris.default !== null ? Math.round(pris.default) : null,
    prisNy: produkt?.retailPriceSek ?? null,
    sankningar: ladder?.drops.length ?? 0,
    nextDropAt: ladder?.nextDropAt ?? null,

    listedAt,
    soldAt: record?.soldAt ?? null,
    soldChannel: record?.soldChannel ?? null,
    dagarUppe: dygnMellan(listedAt, record?.soldAt ?? null),

    traderaStatus: job.tradera?.status ?? null,
    traderaItemId: job.tradera?.itemId ?? null,
    begardAt: job.tradera?.startedAt ?? null,

    statistik,
    ctr: ctrAv(statistik),
    ordrar,
  };
}

/**
 * Alla annonser, nyast först.
 *
 * Läser hela lagret en gång per anrop — samma val som `listAccounts` gör, och av samma skäl: det är
 * 193 filer i dag, panelen öppnas av en handfull människor, och ett index som kan bli inaktuellt är
 * en sämre affär än en läsning som tar en halv sekund.
 */
export async function listaAnnonser(): Promise<{ rader: AdminAnnonsRad[]; summering: Summering }> {
  const [jobs, records, overstyrningar, statistik] = await Promise.all([
    listJobs(),
    butikStore().all(),
    overrides.alla(),
    allStatistik(),
  ]);
  const byId = new Map(records.map((r) => [r.id, r]));

  /**
   * Ordrarna slås upp en gång för HELA listan och inte per rad.
   *
   * `ordersForProduct` läser orderfilen; anropad i en slinga över 193 rader läser den samma fil 193
   * gånger. Skillnaden syns direkt i en panel som ska öppnas medan man pratar med en kund.
   */
  const ordrarPerId = new Map<string, number>();
  for (const order of await allOrders()) {
    ordrarPerId.set(order.productId, (ordrarPerId.get(order.productId) ?? 0) + 1);
  }

  const rader: AdminAnnonsRad[] = [];
  for (const job of jobs) {
    const id = loopaIdFor(job.id);
    const record = byId.get(id);
    const overstyrning = overstyrningar.get(id);
    const harlett = jobToProduct(job, record?.state ?? "draft");
    const produkt = harlett ? overrides.tillampaPaProdukt(harlett, overstyrning) : null;
    rader.push(
      radAv(job, record, overstyrning, produkt, statistik.get(id) ?? tomStatistik(), ordrarPerId.get(id) ?? 0),
    );
  }

  return { rader, summering: summera(rader) };
}

export interface Summering {
  antal: number;
  /** Väntar på godkännande. Det tal panelen finns för att få ner till noll. */
  vantar: number;
  live: number;
  salda: number;
  utanAnnons: number;
  /** Samlat pris på det som ligger uppe just nu. */
  varde: number;
  visningar: number;
  klick: number;
  /** Median dygn uppe för det som sålts. Median och inte medel: en enda liggare drar medelvärdet. */
  medianDagarTillSald: number | null;
}

function summera(rader: AdminAnnonsRad[]): Summering {
  const salda = rader.filter((r) => r.soldAt);
  const dagar = salda.map((r) => r.dagarUppe).filter((d): d is number => d !== null).sort((a, b) => a - b);
  return {
    antal: rader.length,
    vantar: rader.filter((r) => r.lage === "vantar").length,
    live: rader.filter((r) => r.lage === "live").length,
    salda: salda.length,
    utanAnnons: rader.filter((r) => r.lage === "utan-annons" || r.lage === "misslyckad").length,
    varde: rader.filter((r) => r.lage === "live").reduce((s, r) => s + (r.prisNu ?? 0), 0),
    visningar: rader.reduce((s, r) => s + r.statistik.visningar, 0),
    klick: rader.reduce((s, r) => s + r.statistik.klick, 0),
    medianDagarTillSald: dagar.length ? dagar[Math.floor(dagar.length / 2)] : null,
  };
}

/** Jobbet bakom ett Loopa-ID. Slås upp genom att räkna om id:t — samma väg som publicCard tar. */
async function jobbFor(loopaId: string): Promise<ConditionJob | undefined> {
  const { jobByLoopaId } = await import("./publicCard.js");
  return jobByLoopaId(loopaId);
}

export async function annonsDetalj(loopaId: string): Promise<AdminAnnonsDetalj | null> {
  const job = await jobbFor(loopaId);
  if (!job) return null;
  const id = loopaIdFor(job.id);
  const record = (await butikStore().get(id)) ?? undefined;
  const overstyrning = (await overrides.hamta(id)) ?? undefined;
  const harlett = jobToProduct(job, record?.state ?? "draft");
  const produkt = harlett ? overrides.tillampaPaProdukt(harlett, overstyrning) : null;
  const ordrarRader = await ordersForProduct(id);
  const statistik = await statistikFor(id);

  return {
    ...radAv(job, record, overstyrning, produkt, statistik, ordrarRader.length),
    produkt,
    harlett,
    overstyrning: overstyrning ?? null,
    annonstext: overrides.annonstext(job, overstyrning),
    ladder: job.priceLadder ?? null,
    tradera: job.tradera ?? null,
    handelser: await butikStore().events(id),
    matningar: await handelserFor(id),
    ordrarRader,
    progress: job.progress ? { stage: job.progress.stage, pct: (job.progress as { pct?: number }).pct } : null,
    error: job.error,
  };
}

// ---------------------------------------------------------------------------
// Ändringarna
// ---------------------------------------------------------------------------

export interface AndringsPatch {
  /** Rättelser av innehållet. Se butik/overrides.ts. */
  falt?: Partial<Record<overrides.OverstyrbartFalt, string | number | null>>;
  /**
   * Fält som ska sluta vara rättade och följa besiktningen igen — ETT I TAGET, till skillnad från
   * `aterstall` som kastar allt. Skickas före `falt`, så att sätta och återställa i samma anrop
   * betyder "sätt": det är den ordning en människa menar när de gör båda på samma spara.
   */
  aterstallFalt?: overrides.OverstyrbartFalt[];
  /** Nytt pris nu. Flyttar prisstegens `currentPrice` och skrivs vidare till Tradera om den ligger uppe. */
  prisNu?: number;
  /** Nytt spann för prisstegen. Startpris och golv måste följas åt — se makePriceLadder. */
  ladder?: { startPrice: number; floorPrice: number; weeklyDropPct?: number };
  /**
   * Tillståndsbyte: godkänn, publicera, ta ner, markera såld, levererad, returnerad, släpp reservation.
   *
   * `godkann` är kö-knappen: möbeln går ut i Butiken OCH på Tradera i samma tryck. `publicera` är
   * bara butiken, för möbler som aldrig beställts till Tradera.
   */
  lage?: "godkann" | "publicera" | "ta-ner" | "sald" | "levererad" | "returnerad" | "slapp";
  /** Kanalen försäljningen skedde i. Bara meningsfull tillsammans med lage: "sald". */
  kanal?: "butik" | "tradera";
  /**
   * Kastar alla rättelser och låter annonsen falla tillbaka på besiktningen igen.
   *
   * Egen flagga och inte "sätt varje fält till null": null betyder UTTRYCKLIGEN TOMT och är ett
   * beslut i sig — "den här möbeln har ingen känd färg". Att återställa är det motsatta beslutet,
   * att inte ha någon åsikt, och de två går inte att uttrycka med samma värde.
   */
  aterstall?: boolean;
}

export class AndringsFel extends Error {}

/**
 * Verkställer en ändring och lämnar tillbaka annonsen som den blev.
 *
 * ALLT GÅR GENOM DE BEFINTLIGA VÄGARNA. Tillståndsbytena anropar butik/store.ts, som skriver
 * huvudboken och håller det villkorade skrivandet som hindrar dubbelförsäljning; prisstegen byggs av
 * makePriceLadder, som validerar spannet på samma sätt som säljarens eget reglage. En panel som
 * skrev tillstånd rakt in i posten hade tagit sig förbi precis det skyddet — och den dagen två
 * köpare vill ha samma soffa är panelen den som förlorar.
 */
export async function andraAnnons(
  loopaId: string,
  patch: AndringsPatch,
  adminId: string | null,
): Promise<AdminAnnonsDetalj> {
  const job = await jobbFor(loopaId);
  if (!job) throw new AndringsFel("Annonsen finns inte.");
  const id = loopaIdFor(job.id);

  if (patch.aterstall) await overrides.tabort(id);

  /**
   * Bara kända fältnamn släpps igenom, precis som `satt` gör med sin patch. Kroppen kommer utifrån,
   * och en lista med godtyckliga nycklar hade betytt att panelen kan radera vad som helst ur posten.
   */
  const attAterstalla = (patch.aterstallFalt ?? []).filter((f): f is overrides.OverstyrbartFalt =>
    (overrides.OVERSTYRBARA as readonly string[]).includes(f),
  );
  if (attAterstalla.length > 0) await overrides.taBortFalt(id, attAterstalla, adminId);

  if (patch.falt && Object.keys(patch.falt).length > 0) {
    await overrides.satt(id, patch.falt, adminId);
  }

  if (patch.ladder) {
    const byggd = makePriceLadder(patch.ladder);
    if ("error" in byggd) throw new AndringsFel(byggd.error);
    /**
     * Ett nytt spann behåller det pris som redan ligger uppe.
     *
     * `makePriceLadder` sätter `currentPrice` till startpriset, vilket är rätt för en NY steg men fel
     * här: annonsen ligger på ett pris köpare redan sett, och att höja tillbaka den till startpriset
     * för att golvet justerades hade varit en prishöjning ingen bett om.
     */
    const nuvarande = job.priceLadder?.currentPrice;
    if (typeof nuvarande === "number" && nuvarande <= byggd.startPrice && nuvarande >= byggd.floorPrice) {
      byggd.currentPrice = Math.round(nuvarande);
      byggd.nextDropAt = job.priceLadder?.nextDropAt ?? null;
      byggd.drops = job.priceLadder?.drops ?? [];
    }
    job.priceLadder = byggd;
    await persist(job);
  }

  if (typeof patch.prisNu === "number") {
    await sattPris(job, patch.prisNu);
  }

  if (patch.lage) {
    await bytLage(id, patch.lage, patch.kanal ?? "butik", adminId, job);
  }

  // Butikens index är härlett och hålls i minnet i 30 sekunder. En admin som rättar en titel ska se
  // den i butiken direkt, inte efter en halv minut.
  invalidate();

  const detalj = await annonsDetalj(loopaId);
  if (!detalj) throw new AndringsFel("Annonsen försvann under ändringen.");
  return detalj;
}

/**
 * Sätter priset som ligger nu.
 *
 * Kräver en prissteg. Utan den finns inget fält att skriva i: priset kommer då ur prismotorns
 * förslag, som är en uträkning och inte ett val — att skriva över den hade betytt att panelen
 * påstår något om motorn i stället för om annonsen. Den som vill sätta ett pris på en annons utan
 * steg får skapa en steg, vilket är exakt vad `ladder` i patchen gör.
 */
async function sattPris(job: ConditionJob, pris: number): Promise<void> {
  const belopp = Math.round(pris);
  if (!Number.isFinite(belopp) || belopp < 1) throw new AndringsFel("Priset måste vara ett belopp i kronor.");
  const ladder = job.priceLadder;
  if (!ladder) throw new AndringsFel("Annonsen har ingen prissteg. Sätt ett spann först.");
  if (belopp < ladder.floorPrice) throw new AndringsFel("Priset ligger under golvet. Sänk golvet först.");

  ladder.currentPrice = belopp;
  ladder.floorReachedAt = belopp <= ladder.floorPrice ? new Date().toISOString() : null;
  ladder.lastError = null;
  await persist(job);

  /**
   * Ligger annonsen uppe på Tradera ska priset dit också.
   *
   * Ett pris som bara ändras hos oss är två priser på samma möbel, och det är köparen som upptäcker
   * det. Faller anropet skrivs felet på stegen — samma fält som den veckovisa sänkningen använder,
   * och det panelen läser för att kunna säga varför priset står stilla.
   */
  const itemId = job.tradera?.itemId;
  if (job.tradera?.status === "published" && typeof itemId === "number") {
    try {
      const { traderaConfigured, updateTraderaPrice } = await import("./integrations/tradera/tradera.js");
      if (traderaConfigured()) await updateTraderaPrice(itemId, belopp, ladder.listingMode ?? "fixed");
    } catch (err) {
      ladder.lastError = err instanceof Error ? err.message : String(err);
      await persist(job);
    }
  }
}

async function bytLage(
  id: string,
  lage: NonNullable<AndringsPatch["lage"]>,
  kanal: "butik" | "tradera",
  adminId: string | null,
  job: ConditionJob,
): Promise<void> {
  const actor = { kind: "admin" as const, userId: adminId };

  /**
   * En möbel som aldrig varit i butiken får en post först.
   *
   * Utan det kan panelen inte publicera det som `syncFromJobs` hoppat över — och det är just de
   * annonserna man öppnar panelen för att göra något åt.
   */
  if (lage === "godkann") return godkann(id, job, adminId);

  if (lage === "publicera") {
    const produkt = jobToProduct(job, "draft");
    const rattat = produkt ? overrides.tillampaPaProdukt(produkt, await overrides.hamta(id)) : null;
    if (!rattat) throw new AndringsFel("Jobbet går inte att visa som en vara — det saknar besiktning eller betyg.");
    const brist = shopReadiness(rattat);
    if (!brist.ready) throw new AndringsFel(`Annonsen saknar ${brist.missing.join(", ")}.`);
    await ensureRecord(id, job.id, "loopa", rattat.listedAt);
  }

  const utfall =
    lage === "publicera" ? await publish(id, actor)
    : lage === "ta-ner" ? await unpublish(id, actor)
    : lage === "sald" ? await claimForSale(id, kanal, actor)
    : lage === "levererad" ? await markDelivered(id, actor)
    : lage === "returnerad" ? await markReturned(id, actor)
    : await release(id, actor, "Reservationen släppt av admin.");

  /**
   * Null betyder att övergången inte var tillåten FRÅN det tillstånd möbeln stod i — inte att något
   * gick sönder. Felet skrivs som det, med tillståndet i, för annars läser det som en bugg.
   */
  if (!utfall) {
    const nu = await butikStore().get(id);
    throw new AndringsFel(
      nu ? `Går inte att göra det från läget "${nu.state}".` : "Möbeln finns inte i butikslagret.",
    );
  }
}

/**
 * Godkännandet: det säljaren beställde med "Sälj med Loopa", verkställt av en admin.
 *
 * Två kanaler i samma tryck, i den här ordningen:
 *
 *   1. Butiken. Posten skapas om den saknas och går till `live` genom tillståndsmaskinen — samma väg
 *      som `publicera`. Det sker synkront; när svaret kommer ligger möbeln i rutnätet. Bara en förtur
 *      (efterlysning/fortur.ts) håller den kvar som utkast, och då publicerar `syncFromJobs` den när
 *      förturen gått ut — den läser `godkand()`, inte Traderas svar.
 *   2. Tradera. Köas i bakgrunden precis som förut; panelen läser `tradera.status` för utfallet. Ett
 *      avslag från Tradera tar INTE ner möbeln ur butiken: godkännandet är Loopas beslut, och det
 *      står. Admin ser felet på annonsen och kan trycka igen.
 *
 * Ett andra tryck medan Tradera arbetar avvisas; ett tryck efter ett Tradera-fel är just det
 * omförsöket som behövs.
 */
async function godkann(id: string, job: ConditionJob, adminId: string | null): Promise<void> {
  const status = job.tradera?.status;
  if (status === "publishing") throw new AndringsFel("Annonsen är redan på väg upp på Tradera.");
  if (status === "published") throw new AndringsFel("Annonsen ligger redan uppe på Tradera.");
  if (status !== "pending" && status !== "error") {
    throw new AndringsFel("Säljaren har inte tryckt \"Sälj med Loopa\" på den här annonsen.");
  }
  if (!traderaConfigured()) {
    throw new AndringsFel(`Tradera är inte konfigurerat på servern. Saknar ${missingTraderaEnv().join(", ")}.`);
  }

  // Samma krav som säljarens knapp ställde — underlaget kan ha ändrats sedan dess.
  const readiness = await planTraderaPublish(job);
  if (!readiness.ok) throw new AndringsFel(readiness.reason);

  const produkt = jobToProduct(job, "draft");
  const rattat = produkt ? overrides.tillampaPaProdukt(produkt, await overrides.hamta(id)) : null;
  if (!rattat) throw new AndringsFel("Jobbet går inte att visa som en vara — det saknar besiktning eller betyg.");
  const brist = shopReadiness(rattat);
  if (!brist.ready) throw new AndringsFel(`Annonsen saknar ${brist.missing.join(", ")}.`);

  // Stämpeln först. Skulle Tradera-steget falla är möbeln ändå godkänd, och butiken vet det.
  await markTraderaPublishing(job, adminId);

  await ensureRecord(id, job.id, "loopa", rattat.listedAt);
  const { publishBlocked } = await import("./efterlysning/fortur.js");
  const holl = await publishBlocked(id).catch(() => false);
  if (!holl) {
    // Null = redan live (eller i en affär). Det är inget fel: godkännandet gäller ändå.
    await publish(id, { kind: "admin", userId: adminId });
  } else {
    console.info(`[butik] ${id} godkänd men hålls av en förtur — publiceras när den gått ut.`);
  }

  void runTraderaPublish(job.id);
}

/** Nästa steg ner, för förhandsvisningen i panelen. Ren funktion — samma som stegen själv använder. */
export { nextRung };
