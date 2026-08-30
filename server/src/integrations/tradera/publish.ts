/**
 * Loopa-annonsen -> Tradera-annons.
 *
 * Det här är översättningen: de tre svaren kortet redan bär — vad möbeln ÄR (annonsgeneratorn), vad den
 * är VÄRD (prismotorn) och vilket SKICK den är i (besiktningen) — packas till en nyttolast Tradera
 * accepterar. Ingenting hämtas om, ingen ny modell körs. Knappen publicerar det som redan står på
 * skärmen.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { getJob, jobDir, persist } from "../../jobStore.js";
import { resolveCoverImageId } from "../../pipeline/cover.js";
import { adImages, adTitle, composeAd, renderAdHtml, resolveAdPrice } from "../../adContent.js";
import type { CapturedImage, ConditionJob, TraderaPublication } from "../../types.js";
import { publishToTradera, traderaConfigured, type TraderaImage } from "./tradera.js";
import { armPriceLadder } from "../../priceLadder.js";
import { loopaIdFor } from "../../loopaId.js";
import { SHIPPING_INCLUDED_SEK, traderaPriceWithShipping } from "./shipping.js";
import {
  TRADERA_CONDITION,
  TRADERA_SHIPPING_OTHER_ID,
  TRADERA_SKICK_ATTRIBUTE_ID,
  traderaCategoryFor,
  traderaPaymentOptionIds,
} from "./mapping.js";

/** Tradera tar högst 10 bilder per annons. Jobben har som mest 6 (MAX_IMAGES_PER_JOB). */
const MAX_TRADERA_IMAGES = 10;

/**
 * Annonstyp. Köp Nu är standard: priset på kortet ÄR priset, och en auktion utropad till full
 * värdering brukar sluta utan bud.
 *
 * Växeln finns för att Tradera kan säga nej. Ett nytt eller obetygsatt privatkonto är *restricted*
 * och avvisar allt utom rena auktioner med "only auctions allowed" — kontot vi kör på i dag är
 * privat, utan butik och utan omdömen, alltså precis den profilen. Slår det till är
 * `TRADERA_LISTING_MODE=auction` hela åtgärden, utan omdeploy av något annat.
 *
 * LÄSES VID ANROP, inte vid modulladdning. server.ts kallar `loadEnvFile` i sin modulkropp, och ESM
 * kör alla importerade moduler före den — en konstant här hade aldrig sett server/.env. Samma fälla
 * som listing.ts bär en varning om.
 */
function listingMode(): "auction" | "fixed" {
  return process.env.TRADERA_LISTING_MODE === "auction" ? "auction" : "fixed";
}

/** Auktionslängd i dagar, används bara i auktionsläget. Ett nytt/privat konto kräver minst 7. */
function auctionDurationDays(): number {
  const days = Number(process.env.TRADERA_AUCTION_DAYS ?? 7);
  return Number.isFinite(days) && days >= 1 ? days : 7;
}

/** Vad som kommer att publiceras, så säljaren kan se det INNAN de trycker. */
export interface PublishPlan {
  title: string;
  /** Annonsens publika ID. Står i annonstexten och är vägen tillbaka hit från Tradera. */
  loopaId: string;
  categoryId: number;
  categoryName: string;
  /**
   * Vad KÖPAREN betalar: möbeln plus hemleveransen. Det är det här talet som går till Tradera och
   * står i annonsen — inget tillkommer i kassan.
   */
  price: number;
  /** Möbelns egen andel. Det är den prisstegen sänker; frakten står stilla. */
  itemPrice: number;
  /** Fraktens andel av `price`, utskriven så gränssnittet slipper känna till beloppet. */
  shippingSek: number;
  priceSource: "seller" | "condition" | "listing";
  condition: string | null;
  imageCount: number;
  /** "fixed" = Endast Köp Nu till `price`. "auction" = utropspris `price`, inget Köp Nu. */
  mode: "auction" | "fixed";
  /** Bara satt för auktion. Traderas Köp Nu-annonser får sin längd av Tradera, inte av oss. */
  durationDays: number | null;
}

export type PublishReadiness =
  | { ok: true; plan: PublishPlan }
  | { ok: false; reason: string };

// ---------- Planering ----------

/**
 * Kan jobbet publiceras, och i så fall som vad?
 *
 * Tre saker måste finnas: en annonstext, ett pris och minst en bild. Saknas något sägs det rakt ut i
 * stället för att annonsen skickas iväg och avvisas av Tradera med ett engelskt valideringsfel.
 */
export async function planTraderaPublish(job: ConditionJob): Promise<PublishReadiness> {
  const result = job.result;
  const card = result?.listing?.result ?? null;
  if (!result) return { ok: false, reason: "Analysen är inte klar än." };
  if (!card) return { ok: false, reason: "Annonsen kunde inte skapas, så det finns inget att publicera." };

  const title = adTitle(job);
  if (!title) return { ok: false, reason: "Annonsen saknar rubrik." };

  const price = resolveAdPrice(job);
  if (!price) return { ok: false, reason: "Det finns inget pris att sätta som utropspris." };

  const images = await listingImages(job);
  if (images.length === 0) return { ok: false, reason: "Jobbet har inga bilder kvar på disk." };

  const category = traderaCategoryFor({
    strong: [card.identity.category, job.selected?.productType, title, job.productContext],
    weak: [card.listing.description, card.identity.variant],
  });

  return {
    ok: true,
    plan: {
      title: title.slice(0, 80),
      loopaId: loopaIdFor(job.id),
      categoryId: category.id,
      categoryName: category.name,
      price: traderaPriceWithShipping(price.value),
      itemPrice: price.value,
      shippingSek: SHIPPING_INCLUDED_SEK,
      priceSource: price.source,
      condition: result.grade ? TRADERA_CONDITION[result.grade.grade] : null,
      imageCount: images.length,
      mode: listingMode(),
      durationDays: listingMode() === "auction" ? auctionDurationDays() : null,
    },
  };
}

/** Annonsens bilder, kapade till vad Tradera tar emot. Urvalet och ordningen görs i adContent.ts. */
async function listingImages(job: ConditionJob): Promise<CapturedImage[]> {
  return (await adImages(job)).slice(0, MAX_TRADERA_IMAGES);
}

// ---------- Publicering ----------

/**
 * Kör publiceringen och skriver hela tiden tillbaka var den står i jobbet.
 *
 * Anropas ALDRIG i ett HTTP-svar: Tradera köar annonsen och kön tar 10–60 s. Klienten pollar
 * `GET /api/jobs/:id/tradera` i stället, precis som den redan pollar analysen.
 */
export async function runTraderaPublish(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  try {
    // Äldre jobb saknar omslagsvalet helt och skulle annars lägga sin första bildruta överst — den
    // som ofta är svart. Räknas fram och sparas här, en gång, innan annonsen byggs.
    await resolveCoverImageId(job);

    const readiness = await planTraderaPublish(job);
    if (!readiness.ok) throw new Error(readiness.reason);
    const { plan } = readiness;

    const images = await loadImages(job);

    const result = await publishToTradera({
      ownReference: job.id,
      title: plan.title,
      description: buildDescription(job),
      categoryId: plan.categoryId,
      price: plan.price,
      images,
      condition: plan.condition,
      conditionAttributeId: TRADERA_SKICK_ATTRIBUTE_ID,
      shippingOptionId: TRADERA_SHIPPING_OTHER_ID,
      // 0 kr, för att frakten redan ligger i priset. Ett belopp här hade lagts PÅ annonspriset i
      // Traderas kassa och tagit ut de 600 kronorna en andra gång.
      shippingCost: 0,
      paymentOptionIds: traderaPaymentOptionIds(),
      durationDays: plan.durationDays ?? undefined,
      mode: plan.mode,
    });

    await update(jobId, (current) => ({
      ...current,
      status: "published",
      requestId: result.requestId,
      itemId: result.itemId,
      url: result.url,
      error: null,
      publishedAt: new Date().toISOString(),
    }));
    console.info(`[tradera] job ${jobId} publicerat som item ${result.itemId} — ${result.url}`);

    // Först nu börjar veckorna räknas: stegen sänker priset på en annons som ligger uppe, inte på ett
    // utkast. Efter publiceringen — annonsen är redan live, och ett fel här får inte se ut som att
    // den inte kom upp.
    // MÖBELPRISET, inte annonspriset. Stegen räknar i möbelkronor och frakten läggs på först vid
    // anropet mot Tradera — armeras den med `plan.price` börjar de 15 procenten äta av frakten.
    await armPriceLadder(jobId, plan.itemPrice, plan.mode);
  } catch (err) {
    const message = explainFailure(err instanceof Error ? err.message : String(err));
    console.warn(`[tradera] job ${jobId} kunde inte publiceras — ${message}`);
    await update(jobId, (current) => ({ ...current, status: "error", error: message }));
  }
}

/**
 * Traderas avslag är på engelska och säger inte vad man ska göra. Det enda vi kan förutse är
 * restriktionen mot fastpris — den träffar hela Köp Nu-läget, inte den enskilda annonsen, och
 * åtgärden är en miljövariabel. Säg det rakt ut i stället för att låta säljaren läsa API-engelska.
 */
function explainFailure(message: string): string {
  if (listingMode() === "fixed" && /only auctions?/i.test(message)) {
    return (
      "Tradera tillåter bara auktioner på det här kontot, så Köp Nu gick inte igenom. " +
      "Sätt TRADERA_LISTING_MODE=auction på servern och försök igen. " +
      `(Traderas svar: ${message})`
    );
  }
  return message;
}

/** Markerar jobbet som "publicerar" innan bakgrundsarbetet startar, så knappen kan låsas direkt. */
export async function markTraderaPublishing(job: ConditionJob): Promise<TraderaPublication> {
  const publication: TraderaPublication = {
    status: "publishing",
    requestId: null,
    itemId: null,
    url: null,
    error: null,
    startedAt: new Date().toISOString(),
    publishedAt: null,
  };
  job.tradera = publication;
  await persist(job);
  return publication;
}

async function update(
  jobId: string,
  patch: (current: TraderaPublication) => TraderaPublication,
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const current: TraderaPublication = job.tradera ?? {
    status: "publishing",
    requestId: null,
    itemId: null,
    url: null,
    error: null,
    startedAt: new Date().toISOString(),
    publishedAt: null,
  };
  job.tradera = patch(current);
  await persist(job);
}

async function loadImages(job: ConditionJob): Promise<TraderaImage[]> {
  const dir = path.join(jobDir(job.id), "originals");
  const images: TraderaImage[] = [];
  for (const image of await listingImages(job)) {
    try {
      const data = await readFile(path.join(dir, image.path));
      images.push({ data, mime: image.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" });
    } catch {
      // En bild som inte går att läsa ska inte stoppa annonsen — de andra räcker.
    }
  }
  if (images.length === 0) throw new Error("Ingen av jobbets bilder gick att läsa från disk.");
  return images;
}

// ---------- Annonstexten ----------

/**
 * Annonstexten som går upp på Tradera.
 *
 * Vad som står i den avgörs i adContent.ts, tillsammans med den text Blocket-exporten visar — det är
 * SAMMA annons om samma möbel, och två texter som beskrev skicket var för sig hade förr eller senare
 * beskrivit det olika. Det som är Traderas eget ligger här: HTML som renderingsform, och
 * leveransstycket, som bara stämmer när annonsen ligger på Loopas eget konto.
 */
export function buildDescription(job: ConditionJob): string {
  return renderAdHtml(composeAd(job, { delivery: true }));
}

export { traderaConfigured };
