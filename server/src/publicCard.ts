import { listJobs } from "./jobStore.js";
import { damageStands } from "./pipeline/grade.js";
import { loopaIdFor, normalizeLoopaId } from "./loopaId.js";
import type {
  ConditionJob,
  Damage,
  FurnitureIdentity,
  GeneratedListing,
  GradeExplanation,
  Impact,
  ProductImage,
  Severity,
} from "./types.js";

/**
 * Den publika annonsen.
 *
 * Kortet är publikt med flit: Tradera-annonsen bär ett Loopa-ID, och den som läser annonsen ska kunna
 * slå upp hela besiktningen bakom priset — skicket, varje skada, måtten och källorna. En annons som
 * påstår "AI-granskad" utan att gå att kontrollera är bara ett påstående till.
 *
 * Det som INTE följer med är lika medvetet. Ägaren, säljarens egna bildrutor och bevisbilderna stannar
 * bakom inloggningen: fotografierna är tagna i någons hem, och de behövs inte för att kontrollera ett
 * skick — skadorna sitter på renderingen, som byggs ur måtten. Publikt betyder att kortet går att
 * läsa, inte att allt bakom det ligger öppet.
 *
 * ETT undantag, och det är omslaget: möbeln urklippt mot vitt (se pipeline/cutout.ts). Den bilden är
 * härledd ur en av säljarens bildrutor men visar bara möbeln — rummet, hemmet och allt annat som
 * råkade vara i bild är bortklippt. Den som läser en annons ska se VAD som säljs, och att visa
 * tillverkarens katalogbild av en ny exemplar i stället vore att svara på frågan med fel möbel.
 */

/** En skada som den står på det publika kortet. Bevisbilder och säljarens granskningsläge följer inte med. */
export interface PublicDamage {
  id: string;
  type: Damage["type"];
  part: string;
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
}

/** Priset, nedskalat till det kortet visar. Prismotorns egen matchningsstatistik är inte publik. */
export interface PublicPrice {
  status: "ok" | "no_data" | "unavailable";
  low: number | null;
  default: number | null;
  high: number | null;
  currency: "SEK";
  damageDeduction: number | null;
  unavailableReason: string | null;
}

export interface PublicCard {
  loopaId: string;
  createdAt: string;
  identity: FurnitureIdentity | null;
  card: GeneratedListing;
  grade: GradeExplanation | null;
  price: PublicPrice | null;
  damages: PublicDamage[];
  /** Hur många vyer besiktningen såg. Bildrutorna själva är inte publika — antalet är det som säger något. */
  imageCount: number;
  reviewed: boolean;
  productImage: ProductImage | null;
  /**
   * Kortets omslag. `cutout` = säljarens möbel mot vitt, hämtad på adressen nedan.
   *
   * Bara urklipp här. Går det inte att göra ett har det publika kortet inget omslag av möbeln som
   * säljs — och då är tillverkarens produktbild kvar som kortets sista utväg, precis som förut.
   * Säljarens RÅA bildruta blir aldrig publik, hur gärna kortet än vill ha en bild.
   */
  cover: { url: string; kind: "cutout" } | null;
  /** Annonsen på Tradera, när kortet är publicerat dit. Kortet finns även utan den. */
  tradera: { status: string; url: string | null } | null;
}

/**
 * Skador som ska stå på kortet.
 *
 * Samma filtrering som Tradera-annonsen och annonsskärmen gör: en anmärkning säljaren avvisat är
 * inte längre ett fynd — och inte heller en som andra besiktningen underkänt. Ett fynd som betyget och
 * priset räknat bort får inte stå kvar på kortet: då står det ett falsklarm på köparens attest.
 * Ordningen är oförändrad, för numren i listan är de som står som nålar på renderingen och som
 * punkter i annonstexten.
 */
export function publicDamages(damages: Damage[]): PublicDamage[] {
  return damages
    .filter(damageStands)
    .map((d) => ({
      id: d.id,
      type: d.type,
      part: d.part,
      semanticLocation: d.semanticLocation,
      severity: d.severity,
      impact: d.impact,
      description: d.description,
    }));
}

/**
 * Urklippet, var det än hann skrivas.
 *
 * Samma två ställen som annonsen och produktbilden: det byggs i sitt eget spår och landar antingen i
 * resultatet eller på jobbet, beroende på vilket spår som var först.
 */
export function cutoutOf(job: ConditionJob) {
  return job.result?.coverCutout ?? job.coverCutout ?? null;
}

/** Annonsen kan sitta på tre ställen — i resultatet, kvar på jobbet när besiktningen föll, eller ännu inte inflyttad. */
function listingOf(job: ConditionJob) {
  return job.result?.listing ?? job.listing ?? job.pendingListing ?? null;
}

/**
 * Kortet, eller null när jobbet inte är en annons.
 *
 * Ett jobb utan färdig annons har inget publikt att visa: det finns varken modell, mått eller
 * annonstext, bara ett skick utan möbel att hänga det på. Då är rätt svar att ID:t inte finns.
 */
export function publicCardFor(job: ConditionJob): PublicCard | null {
  const listing = listingOf(job);
  if (listing?.status !== "ok" || !listing.result) return null;

  const result = job.result;
  const price = result?.price ?? null;

  return {
    loopaId: loopaIdFor(job.id),
    createdAt: job.createdAt,
    identity: job.identity ?? null,
    card: listing.result,
    grade: result?.grade ?? null,
    price: price && {
      status: price.status,
      low: price.low,
      default: price.default,
      high: price.high,
      currency: price.currency,
      damageDeduction: price.damageDeduction,
      unavailableReason: price.unavailableReason,
    },
    damages: publicDamages(result?.damages ?? []),
    imageCount: (result?.images ?? job.images ?? []).length,
    reviewed: result?.reviewed ?? false,
    productImage: result?.productImage ?? job.productImage ?? null,
    cover: cutoutOf(job) ? { url: `/api/cards/${loopaIdFor(job.id)}/cover`, kind: "cutout" } : null,
    tradera: job.tradera ? { status: job.tradera.status, url: job.tradera.url } : null,
  };
}

/**
 * Jobbet bakom ett Loopa-ID.
 *
 * Genomsökning och inte ett register: ID:t är härlett ur jobb-id:t (se loopaId.ts), så jobben ÄR
 * registret. Samma svep som profillistan redan gör, och jobStore håller dem i minnet efteråt.
 */
export async function jobByLoopaId(raw: string): Promise<ConditionJob | undefined> {
  const wanted = normalizeLoopaId(raw);
  if (!wanted) return undefined;
  for (const job of await listJobs()) {
    if (loopaIdFor(job.id) === wanted) return job;
  }
  return undefined;
}
