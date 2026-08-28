/**
 * Truth-card -> Tradera-annons.
 *
 * Det här är översättningen: de tre svaren kortet redan bär — vad möbeln ÄR (annonsgeneratorn), vad den
 * är VÄRD (prismotorn) och vilket SKICK den är i (besiktningen) — packas till en nyttolast Tradera
 * accepterar. Ingenting hämtas om, ingen ny modell körs. Knappen publicerar det som redan står på
 * skärmen.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { getJob, jobDir, persist } from "../../jobStore.js";
import type { CapturedImage, ConditionJob, Damage, DamageType, Severity, TraderaPublication } from "../../types.js";
import { publishToTradera, traderaConfigured, type TraderaImage } from "./tradera.js";
import {
  TRADERA_CONDITION,
  TRADERA_SHIPPING_PICKUP_ID,
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
  categoryId: number;
  categoryName: string;
  price: number;
  priceSource: "condition" | "listing";
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

// Svenska etiketter för annonstexten. Duplicerade från web/src/lib/labels.ts med samma motivering som
// types.ts bär: motorn är fristående och importerar inte ur webbklienten.
const TYPE_LABELS: Record<DamageType, string> = {
  scratch: "Repa", scuff: "Skrapmärke", abrasion: "Nötning", chip: "Flisa", dent: "Buckla",
  crack: "Spricka", tear: "Reva", hole: "Hål", stain: "Fläck", discoloration: "Missfärgning",
  fading: "Blekning", rust: "Rost", corrosion: "Korrosion", pilling: "Nopprighet",
  worn_material: "Slitet material", fraying: "Fransning", compressed_upholstery: "Nertryckt stoppning",
  peeling_flaking: "Flagnande yta", deformation: "Deformation", loose_component: "Lös komponent",
  broken_component: "Trasig komponent", missing_part: "Saknad del", sagging: "Nedsjunken",
  structural_damage: "Strukturell skada", general_wear: "Allmänt slitage", other: "Övrigt",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  S1: "mindre", S2: "måttlig", S3: "stor", S4: "kritisk",
};

// ---------- Planering ----------

/**
 * Kan jobbet publiceras, och i så fall som vad?
 *
 * Tre saker måste finnas: en annonstext, ett pris och minst en bild. Saknas något sägs det rakt ut i
 * stället för att annonsen skickas iväg och avvisas av Tradera med ett engelskt valideringsfel.
 */
export function planTraderaPublish(job: ConditionJob): PublishReadiness {
  const result = job.result;
  const card = result?.listing?.result ?? null;
  if (!result) return { ok: false, reason: "Analysen är inte klar än." };
  if (!card) return { ok: false, reason: "Annonsen kunde inte skapas, så det finns inget att publicera." };

  const title = (card.listing.title || [card.identity.brand, card.identity.exactProduct].filter(Boolean).join(" ")).trim();
  if (!title) return { ok: false, reason: "Annonsen saknar rubrik." };

  const price = resolvePrice(job);
  if (!price) return { ok: false, reason: "Det finns inget pris att sätta som utropspris." };

  const images = listingImages(job);
  if (images.length === 0) return { ok: false, reason: "Jobbet har inga bilder kvar på disk." };

  const category = traderaCategoryFor({
    strong: [card.identity.category, job.selected?.productType, title, job.productContext],
    weak: [card.listing.description, card.identity.variant],
  });

  return {
    ok: true,
    plan: {
      title: title.slice(0, 80),
      categoryId: category.id,
      categoryName: category.name,
      price: price.value,
      priceSource: price.source,
      condition: result.grade ? TRADERA_CONDITION[result.grade.grade] : null,
      imageCount: images.length,
      mode: listingMode(),
      durationDays: listingMode() === "auction" ? auctionDurationDays() : null,
    },
  };
}

/**
 * Utropspriset. Besiktningens pris först — det är det enda som räknat AV för skadorna. Faller
 * prismotorn bort används annonsgeneratorns förslag, som inte sett skadorna men är bättre än inget.
 */
function resolvePrice(job: ConditionJob): { value: number; source: "condition" | "listing" } | null {
  const price = job.result?.price;
  if (price?.status === "ok" && price.default && price.default > 0) {
    return { value: Math.round(price.default), source: "condition" };
  }
  const suggested = job.result?.listing?.result?.pricing.suggestedPriceSek;
  if (suggested && suggested > 0) return { value: Math.round(suggested), source: "listing" };
  return null;
}

function listingImages(job: ConditionJob): CapturedImage[] {
  const images = job.result?.images ?? job.images ?? [];
  return images.slice(0, MAX_TRADERA_IMAGES);
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
    const readiness = planTraderaPublish(job);
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
      shippingOptionId: TRADERA_SHIPPING_PICKUP_ID,
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
  for (const image of listingImages(job)) {
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
 * Annonstexten, som HTML — Traderas annonser renderas som HTML (kontrollerat mot en publicerad
 * annons: `<br>` och `<strong>` går fram, `&` kommer tillbaka escapat).
 *
 * Skadorna listas ut i klartext. Det är hela poängen med Loopa: en köpare ska se exakt vad
 * besiktningen såg, inte "bruksslitage, se bilder".
 */
export function buildDescription(job: ConditionJob): string {
  const result = job.result!;
  const card = result.listing!.result!;
  const parts: string[] = [];

  parts.push(`<p>${escapeHtml(card.listing.description).replace(/\n+/g, "<br>")}</p>`);

  if (card.attributes.length > 0) {
    parts.push("<p><strong>Specifikationer</strong></p>");
    parts.push(
      `<ul>${card.attributes
        .map((a) => `<li>${escapeHtml(a.label)}: ${escapeHtml(a.value)}</li>`)
        .join("")}</ul>`,
    );
  }

  parts.push("<p><strong>Skick</strong></p>");
  const gradeLine = [result.grade?.label, result.grade?.rationale].filter(Boolean).join(" — ");
  if (gradeLine) parts.push(`<p>${escapeHtml(gradeLine)}</p>`);
  if (card.listing.conditionText) parts.push(`<p>${escapeHtml(card.listing.conditionText)}</p>`);

  const damages = result.damages.filter((d) => d.sellerAction !== "rejected");
  if (damages.length > 0) {
    parts.push(`<p>Besiktningen hittade ${damages.length} synliga ${damages.length === 1 ? "skada" : "skador"}:</p>`);
    parts.push(`<ul>${damages.map((d) => `<li>${escapeHtml(describeDamage(d))}</li>`).join("")}</ul>`);
  } else {
    parts.push("<p>Besiktningen hittade inga synliga skador.</p>");
  }

  parts.push(
    `<p><em>Skickbedömd med Loopa: ${result.images.length} vyer, ` +
      `${result.reviewed ? "två besiktningar" : "en besiktning"}. Hämtas hos säljaren.</em></p>`,
  );

  return parts.join("\n");
}

function describeDamage(damage: Damage): string {
  const head = [TYPE_LABELS[damage.type], damage.part].filter(Boolean).join(" på ");
  const where = damage.semanticLocation ? ` (${damage.semanticLocation})` : "";
  const severity = SEVERITY_LABELS[damage.severity];
  return `${head}${where} — ${severity}. ${damage.description}`.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { traderaConfigured };
