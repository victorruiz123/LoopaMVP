/**
 * Loopa-annonsen -> det Facebook ska visa.
 *
 * LOOPA ÄR SANNINGEN, och den kanoniska sanningen är PRODUKTSIDAN (/butik/objekt/<loopaId>): det är dit
 * Facebook-läsaren skickas, och det som står på Facebook måste vara det som står där. Därför byggs
 * allt ur SAMMA projektion som produktsidan läser — `jobToProduct` med adminens rättelser pålagda —
 * och inte ur en egen tolkning av jobbet. Titeln är produktsidans titel, priset produktsidans pris,
 * skicket produktsidans skicketikett.
 *
 * PRISET ÄR MÖBELNS, inte möbeln plus hemleverans. Tradera- och Blocket-annonserna bär +600 kr för
 * att köpet sker DÄR, med leveransen inbakad. Facebook-läsaren köper på Loopa, där produktsidan visar
 * möbelpriset och räknar fram frakten på postnumret i kassan. Ett annat tal på Facebook än på sidan
 * det länkar till är exakt det förtroendetapp den här kanalen inte får skapa.
 *
 * INGENTING HITTAS PÅ. Uppskattade mått skrivs inte ut (samma regel som Blocket-mappningen), saknas
 * skicket står det inte, och beskrivningen är generatorns egna stycke om möbeln — kapat, aldrig
 * omskrivet.
 */

import path from "node:path";
import { adImages, adTitle } from "../../adContent.js";
import { jobToProduct } from "../../butik/normalize.js";
import { annonstext, hamta, medRattelser, tillampaPaProdukt } from "../../butik/overrides.js";
import { ZONE_FEES } from "../../butik/delivery.js";
import { baseUrl } from "../../butik/seo.js";
import type { Product } from "../../butik/types.js";
import { jobDir } from "../../jobStore.js";
import { loopaIdFor } from "../../loopaId.js";
import type { ConditionGrade, ConditionJob } from "../../types.js";
import type { GroupContentSnapshot, MarketplaceContentSnapshot } from "./types.js";

/** Facebook Marketplace tar tio bilder. Jobben har som mest sju. */
export const MAX_FACEBOOK_IMAGES = 10;

/** Marketplace-rubriken. Facebook kapar vid 100 tecken; vi kapar själva vid ett ordslut innan dess. */
export const MARKETPLACE_TITLE_MAX = 99;

/** Beskrivningens korta möbelstycke. Resten står på Loopa-sidan — det är dit vi vill ha läsaren. */
const DESCRIPTION_MAX = 600;

const SEK = new Intl.NumberFormat("sv-SE");

export function formatSek(n: number): string {
  return `${SEK.format(Math.round(n))} kr`;
}

/** Den kanoniska adressen till möbeln — samma som butiken själv skriver i sina delningskort. */
export function canonicalListingUrl(loopaId: string): string {
  return `${baseUrl()}/butik/objekt/${loopaId}`;
}

export interface FacebookListing {
  loopaId: string;
  jobId: string;
  title: string;
  /** Möbelns pris, i hela kronor. Det som står på produktsidan. */
  price: number;
  grade: ConditionGrade | null;
  /** Loopas skicketikett, t.ex. "Gott begagnat skick". Null när besiktningen saknar betyg. */
  conditionLabel: string | null;
  /** Generatorns stycke om möbeln, kapat. Aldrig omskrivet. */
  description: string;
  brand: string | null;
  model: string | null;
  categorySlug: string;
  /** Bara UPPMÄTTA mått, i hela centimeter. Null när något är uppskattat eller saknas helt. */
  dimensionsCm: { width: number | null; depth: number | null; height: number | null } | null;
  /** Bildernas sökvägar på disk, omslaget först. */
  imagePaths: string[];
  canonicalUrl: string;
  /** Regionen på varan. Stockholm så länge — se Product.region. */
  location: string;
  /**
   * Hemleveransens pris i Loopas kassa, som det står på produktsidan. INTE inräknat i `price`: på Loopa
   * betalar köparen möbeln och leveransen var för sig (butik/checkout.ts), och Facebook-läsaren köper
   * på Loopa. Tradera och Blocket bär i stället möbel + 600 kr i ett tal — se hemleverans.ts.
   */
  deliveryFeeSek: number | null;
}

export type ListingReadiness = { ok: true; listing: FacebookListing } | { ok: false; reason: string };

/**
 * Annonsen som Facebook ska få den, eller skälet till att den inte kan läggas ut.
 *
 * Samma grundkrav som Tradera- och Blocket-vägarna, med samma ord: en färdig analys, en rubrik, ett
 * pris, minst en bild. Ovanpå det kravet att jobbet alls är en butiksvara — affärsjobb och
 * annonshärledda jobb distribueras inte.
 */
export async function facebookListingFor(rajob: ConditionJob): Promise<ListingReadiness> {
  const job = await medRattelser(rajob);
  if (!job.result) return { ok: false, reason: "Analysen är inte klar än." };
  const loopaId = loopaIdFor(job.id);

  const harlett = jobToProduct(job, "live");
  if (!harlett) return { ok: false, reason: "Det här jobbet är inte en butiksvara — en affärsskanning distribueras inte." };
  const overstyrning = await hamta(loopaId);
  const product: Product = tillampaPaProdukt(harlett, overstyrning);

  const title = (product.title || adTitle(job)).replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, reason: "Annonsen saknar rubrik." };

  const price = product.priceSek;
  if (!price || price <= 0) return { ok: false, reason: "Det finns inget pris att sätta i annonsen." };

  const images = (await adImages(job)).slice(0, MAX_FACEBOOK_IMAGES);
  if (images.length === 0) return { ok: false, reason: "Jobbet har inga bilder kvar på disk." };
  const dir = path.join(jobDir(job.id), "originals");

  const text = annonstext(job, overstyrning);
  const description = shortDescription(text?.description ?? "");

  const dims = product.dimensions;
  const cm = (mm: number | null) => (typeof mm === "number" && Number.isFinite(mm) && mm > 0 ? Math.round(mm / 10) : null);
  const dimensionsCm =
    dims && !dims.estimated && (dims.widthMm || dims.depthMm || dims.heightMm)
      ? { width: cm(dims.widthMm), depth: cm(dims.depthMm), height: cm(dims.heightMm) }
      : null;

  return {
    ok: true,
    listing: {
      loopaId,
      jobId: job.id,
      title,
      price: Math.round(price),
      grade: product.condition?.grade ?? null,
      conditionLabel: product.condition?.label ?? null,
      description,
      brand: product.brand,
      model: product.model,
      categorySlug: product.categorySlug,
      dimensionsCm,
      imagePaths: images.map((image) => path.join(dir, image.path)),
      canonicalUrl: canonicalListingUrl(loopaId),
      location: product.region || "Stockholm",
      deliveryFeeSek: product.homeDeliveryAvailable && ZONE_FEES.length ? Math.min(...ZONE_FEES) : null,
    },
  };
}

/** Leveransraden, som produktsidan säger den: priset är möbelns, leveransen läggs till i kassan. */
function deliveryLine(l: FacebookListing): string | null {
  return l.deliveryFeeSek ? `Hemleverans i Stockholm: ${formatSek(l.deliveryFeeSek)} (läggs till i kassan på Loopa).` : null;
}

/**
 * Kapar beskrivningen vid ett meningsslut. Meningar som lovar hämtning eller frakt tas bort — de
 * gäller kanalen de skrevs för, och på Facebook är löftet i stället länken till Loopa.
 */
export function shortDescription(text: string, max = DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const meningar = clean.split(/(?<=[.!?])\s+/).filter((m) => !/(hämt|avhämt|frakt|levereras|leverans|skicka[rs]?(?![a-zà-ÿ])|postas|budbil)/i.test(m));
  let out = "";
  for (const m of meningar) {
    if ((out + " " + m).trim().length > max) break;
    out = `${out} ${m}`.trim();
  }
  if (!out) out = clean.slice(0, max).replace(/\s+\S*$/, "").trim();
  return out;
}

/** Rubriken kapad vid ett ordslut, helst. En rubrik som slutar mitt i ett ord ser ut som ett fel. */
export function capTitle(title: string, max = MARKETPLACE_TITLE_MAX): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space >= max - 20 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "");
}

function dimensionsLine(l: FacebookListing): string | null {
  if (!l.dimensionsCm) return null;
  const parts = [
    l.dimensionsCm.width !== null ? `B ${l.dimensionsCm.width}` : null,
    l.dimensionsCm.depth !== null ? `D ${l.dimensionsCm.depth}` : null,
    l.dimensionsCm.height !== null ? `H ${l.dimensionsCm.height}` : null,
  ].filter(Boolean);
  return parts.length ? `Mått: ${parts.join(" × ")} cm` : null;
}

/**
 * Marketplace-texten.
 *
 *   {{rubrik}}          (Marketplace har ett eget rubrikfält; texten börjar med stycket)
 *   {{kort beskrivning}}
 *   Skick: …  Mått: …  Pris: …
 *   Köp möbeln och se fullständig information via Loopa:
 *   {{kanonisk adress}}
 */
export function marketplaceCopy(l: FacebookListing): { title: string; description: string } {
  const rader = [
    l.description,
    "",
    l.conditionLabel ? `Skick: ${l.conditionLabel}` : null,
    dimensionsLine(l),
    `Pris: ${formatSek(l.price)}`,
    deliveryLine(l),
    "",
    "Köp möbeln och se fullständig information via Loopa:",
    l.canonicalUrl,
  ].filter((r): r is string => r !== null);
  return { title: capTitle(l.title), description: rader.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Grupp-inlägget. Rubrik och pris i första raden — det är den som syns i flödet. */
export function groupPostCopy(l: FacebookListing): string {
  const rader = [
    `${l.title} säljes – ${formatSek(l.price)}`,
    "",
    l.description || null,
    l.description ? "" : null,
    l.conditionLabel ? `Skick: ${l.conditionLabel}` : null,
    dimensionsLine(l),
    deliveryLine(l),
    "",
    "Fler bilder och köp via Loopa:",
    l.canonicalUrl,
  ].filter((r): r is string => r !== null);
  return rader.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function marketplaceSnapshot(l: FacebookListing, category: string): MarketplaceContentSnapshot {
  const copy = marketplaceCopy(l);
  return {
    title: copy.title,
    price: l.price,
    description: copy.description,
    category,
    condition: l.conditionLabel,
    location: l.location,
    imageCount: l.imagePaths.length,
    canonicalUrl: l.canonicalUrl,
  };
}

/**
 * Säljinlägget i en köp/sälj-grupp ("Sälj något"). Samma formulär som Marketplace — rubrik, pris och
 * beskrivning är egna fält — så det är Marketplace-texten som gäller, med Loopa-adressen sist.
 */
export function groupListingCopy(l: FacebookListing): { title: string; description: string } {
  return marketplaceCopy(l);
}

export function groupSnapshot(l: FacebookListing): GroupContentSnapshot {
  return { kind: "post", text: groupPostCopy(l), imageCount: l.imagePaths.length, canonicalUrl: l.canonicalUrl };
}

export function groupListingSnapshot(l: FacebookListing): GroupContentSnapshot {
  const copy = groupListingCopy(l);
  return { kind: "listing", text: copy.description, title: copy.title, price: l.price, imageCount: l.imagePaths.length, canonicalUrl: l.canonicalUrl };
}

// ---------------------------------------------------------------------------
// Marketplace-fälten
// ---------------------------------------------------------------------------

/**
 * Loopas nio butikskategorier -> etiketter att pröva i Marketplace-kategoriväljaren, bäst först.
 *
 * VERIFIERAT 2026-09-25 mot den riktiga ytan: Marketplace har INGA möbelunderkategorier. Väljaren är en
 * dialog med knappar per kategori, och "Möbler" (under rubriken Hem och trädgård) är ett löv som väljs
 * direkt. Belysning ligger inte under Möbler hos Facebook men har ingen egen kategori som passar bättre
 * än Hushåll; Möbler står kvar som reserv överallt eftersom det aldrig är ett felaktigt val för en
 * möbelbutik.
 */
export const MARKETPLACE_CATEGORY_CANDIDATES: Record<string, string[]> = {
  soffor: ["Möbler", "Furniture"],
  fatoljer: ["Möbler", "Furniture"],
  bord: ["Möbler", "Furniture"],
  stolar: ["Möbler", "Furniture"],
  forvaring: ["Möbler", "Furniture"],
  sangar: ["Möbler", "Furniture"],
  "skrivbord-kontor": ["Möbler", "Furniture"],
  belysning: ["Hushåll", "Möbler", "Furniture"],
  ovrigt: ["Möbler", "Furniture"],
};

export function marketplaceCategoryCandidates(categorySlug: string): string[] {
  return MARKETPLACE_CATEGORY_CANDIDATES[categorySlug] ?? MARKETPLACE_CATEGORY_CANDIDATES.ovrigt;
}

/**
 * Loopas betyg -> Marketplace-skicket, bäst först.
 *
 * VERIFIERAT 2026-09-25: Facebooks svenska alternativ är exakt "Nytt", "Använd – nyskick",
 * "Använd – i gott skick" och "Använd – i använt skick". Samma försiktighet som Tradera och Blocket:
 * A blir inte "Nytt" — nytt är ett påstående om möbelns historia som en bildbesiktning inte kan
 * belägga — och B ("Mycket gott skick" med enstaka märken) blir "i gott skick", inte "nyskick".
 */
export const MARKETPLACE_CONDITION_CANDIDATES: Record<ConditionGrade, string[]> = {
  A: ["Använd – nyskick", "Used - like new"],
  B: ["Använd – i gott skick", "Used - good"],
  C: ["Använd – i gott skick", "Used - good"],
  D: ["Använd – i använt skick", "Used - fair"],
  E: ["Använd – i använt skick", "Used - fair"],
  F: ["Använd – i använt skick", "Used - fair"],
};

export function marketplaceConditionCandidates(grade: ConditionGrade | null): string[] {
  return grade ? MARKETPLACE_CONDITION_CANDIDATES[grade] : [];
}
