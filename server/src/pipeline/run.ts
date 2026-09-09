import path from "node:path";
import { GEMINI_MODEL } from "../gemini.js";
import { jobDir, updateProgress, completeJob, failJob, saveDebugTrace, getJobSync, persist } from "../jobStore.js";
import { loadImageAsBase64 } from "../imageUtils.js";
import { dropSpeculativePrice, estimatePrice, pricingSignature, stashSpeculativePrice } from "../pricing.js";

import { COVER_CUTOUT_ENABLED, VERIFY_ENABLED } from "../config.js";
import type { CallMeta, CapturedImage, ConditionResult, Damage, DebugTrace, FurnitureIdentity, ListingResult } from "../types.js";
import { DAMAGE_TYPES, inspectFurniture } from "./inspect.js";
import { needsVerification, verifyFindings } from "./verify.js";
import { dedupeDamages } from "./dedup.js";
import { gradeCondition } from "./grade.js";
import { coverFirst, pickCoverImageId } from "./cover.js";
import { byggOmslag } from "./bild/omslag.js";

/**
 * Runs the full ConditionInput -> ConditionResult pipeline. AT MOST 2 Gemini calls: one main inspection
 * call (always), and one optional batched verification call (only if any finding needs it). No per-view,
 * per-tile, or per-defect calls, and no multi-minute retry chains — this is what keeps the whole run
 * inside the ~30s SLA.
 */
/**
 * Tidtagning per steg, en rad per körning.
 *
 * Finns för att latensarbete utan mätning är gissningar. Raden skrivs alltid, även när körningen
 * faller, så en misslyckad körning säger var den stod när den föll.
 */
class StageTimer {
  private readonly startedAt = Date.now();
  private mark = Date.now();
  private readonly stages: Array<[string, number]> = [];

  lap(name: string): void {
    const now = Date.now();
    this.stages.push([name, now - this.mark]);
    this.mark = now;
  }

  report(extra: Record<string, string | number | boolean>): void {
    const parts = this.stages.map(([n, ms]) => `${n}=${ms}`);
    const meta = Object.entries(extra).map(([k, v]) => `${k}=${v}`);
    console.info(`[timing] ${parts.join(" ")} total=${Date.now() - this.startedAt} ${meta.join(" ")}`);
  }
}

/**
 * Bilderna BESIKTNINGEN ska titta på: allt utom omslagsbilden.
 *
 * Omslagsbilden är komponerad för annonsen, inte för bedömningen — säljaren blir ombedd att ta den
 * efter varvet, i möbelns egen höjd och snett framifrån. Skicket avgörs av varvet, som redan sett
 * möbeln från alla håll.
 *
 * SKÄLET ATT HÅLLA DEN UTANFÖR ÄR LATENS, och den är mätt: bildrutorna går i ETT inspektionsanrop där
 * fyra bilder kostar 21 s och åtta kostar 37 s (se videoFrames.ts). En sjunde bild är alltså ett par
 * sekunder som säljaren står och tittar på en snurra — betalt för en vy varvet redan täcker.
 *
 * INDEXEN FÖLJER MED. Modellen pekar ut bevis som `image_index` in i den lista den fick, och
 * `mapRawDefect` slår upp i samma lista — så länge båda är den här. Att i stället filtrera efteråt
 * hade flyttat varje index ett steg och satt bevisbilder på fel foto, vilket är ett fel man ser
 * först på kortet, långt från koden som orsakade det.
 */
export function tillBedomning(images: CapturedImage[]): CapturedImage[] {
  const bedomda = images.filter((i) => i.role !== "cover");
  // Ett jobb som BARA bär en omslagsbild ska bedömas på den och inte på ingenting. Det kan inte hända
  // via appen, som alltid filmar först, men en klient som skickar en enda bild med rollen satt ska
  // få en besiktning och inte ett tomt anrop.
  return bedomda.length > 0 ? bedomda : images;
}

export async function runConditionGrading(
  jobId: string,
  images: CapturedImage[],
  productContext: string | null,
  identity: FurnitureIdentity | null = null,
): Promise<void> {
  const dir = jobDir(jobId);
  const startedAt = Date.now();
  const timer = new StageTimer();
  const calls: CallMeta[] = [];
  let tokensUsed = 0;
  const track = (m: CallMeta | null) => {
    if (!m) return;
    calls.push(m);
    tokensUsed += m.tokensUsed;
  };

  try {
    await updateProgress(jobId, { stage: "preparing", message: "Bilder förberedda." });

    await updateProgress(jobId, { stage: "inspecting", message: "Inspekterar möbeln…" });
    const inspection = await inspectFurniture(tillBedomning(images), dir, productContext);
    track(inspection.callMeta);
    timer.lap("inspect");

    // Omslaget avgörs här, medan inspektionens vy-val fortfarande finns i handen. Duglighetsspärren
    // kör över det om bildrutan är svart eller utbränd — se cover.ts.
    /**
     * ALLA bilder, inte `tillBedomning`: omslagsbilden är själva poängen här.
     *
     * `coverImageIndex` pekar in i den lista inspektionen fick — alltså den utan omslagsbilden — och
     * det stämmer fortfarande, för den listan är ett prefix av den här: omslagsbilden ligger sist,
     * efter varvets bildrutor. Skulle den ordningen någon gång vändas pekar vy-valet på fel bild, och
     * det är därför appen lägger omslagsbilden sist och inte först.
     */
    const coverImageId = await pickCoverImageId(
      images,
      path.join(dir, "originals"),
      inspection.coverImageIndex,
    );

    // Omslaget klipps ut här och inte senare: bildrutan är vald, och urklippet ska vara framme när
    // säljaren når annonsen — flera skärmar och en modellsökning bort. Det väntas aldrig in.
    startCover(jobId, dir, images, coverImageId);

    /**
     * Andrabesiktningen är urkopplad (VERIFY_ENABLED, default av). Med flaggan AV går fynden rakt
     * från inspektionen till dedup, grade och pris, och kortet publiceras EN gång — det finns inget
     * att vänta in, så det ska inte finnas något delresultat heller.
     *
     * Med flaggan PÅ är beteendet exakt som före urkopplingen: delresultat först, spekulativt pris
     * parallellt med granskningen, slutresultat sedan.
     */
    let verified: Damage[];
    let speculation: { abort: AbortController; signature: string; promise: Promise<Awaited<ReturnType<typeof estimatePrice>>> } | null = null;
    let toVerify: Damage[] = [];

    if (!VERIFY_ENABLED) {
      // NOT_RUN, inte CONFIRMED: fyndet står som det rapporterades, men kortet får inte påstå att
      // någon granskat det. Se effectiveVerification i grade.ts — tillståndet räknas i betyget.
      verified = inspection.defects.map((d): Damage => ({
        ...d,
        verification: "NOT_RUN",
        verificationReason: "",
      }));
    } else {
      // ---- Delresultat, publicerat innan granskningen ens börjat ---------------------------------
      // Granskningen förbättrar fyndlistan men är inte ett villkor för den: faller den bort behålls
      // fynden som de rapporterades (se catch nedan). Alltså finns det ett giltigt svar redan här, och
      // att hålla det inne i 14-65 sekunder till gav säljaren en spinner i stället för sitt resultat.
      const provisionalDamages = dedupeDamages(
        inspection.defects.map((d): Damage => ({ ...d, verification: "CONFIRMED", verificationReason: "Granskningen pågår." })),
      );
      const provisionalGrade = gradeCondition(provisionalDamages, inspection.overallCondition);
      await completeJob(
        jobId,
        buildResult({
          jobId, inspection, damages: provisionalDamages, images, calls, tokensUsed,
          grade: provisionalGrade,
          identity, price: null, reviewPending: true, reviewed: false, listing: null,
          coverImageId, startedAt,
        }),
      );
      timer.lap("publish_provisional");

      /**
       * Prissättningen startas SPEKULATIVT här, på den preliminära listan, och löper parallellt med
       * granskningen. Ändras listan kastas svaret och anropet avbryts; utdata blir då bit för bit
       * densamma som utan spekulation.
       */
      speculation = identity
        ? (() => {
            const abort = new AbortController();
            const signature = pricingSignature(provisionalDamages, provisionalGrade.canonicalCondition);
            const promise = coverImage(dir, images, coverImageId)
              .then((cover) =>
                estimatePrice(identity, provisionalDamages, provisionalGrade.canonicalCondition, cover, abort.signal),
              )
              // Ett fel i spekulationen får aldrig nå slutresultatet — den seriella vägen tar över.
              .catch(() => null);
            return { abort, signature, promise };
          })()
        : null;

      toVerify = inspection.defects.filter(needsVerification);
      verified = inspection.defects;
      if (toVerify.length > 0) {
        await updateProgress(jobId, { stage: "verifying", message: `Kontrollerar ${toVerify.length} osäkra fynd…` });
        try {
          const verifyResult = await verifyFindings(inspection.defects, images, dir);
          verified = verifyResult.verified;
          track(verifyResult.callMeta);
        } catch (err) {
          console.warn(
            `[condition-grading] verification unavailable, grading on the inspection alone — ${
              err instanceof Error ? err.message.slice(0, 200) : String(err)
            }`,
          );
          // Findings KEEP their standing when the review cannot run. The review is an improvement on a
          // finding, never a precondition for it to count.
          verified = inspection.defects.map((d): Damage => ({
            ...d,
            verification: "CONFIRMED",
            verificationReason: "Granskningen kunde inte genomföras — fyndet står kvar som det rapporterades.",
          }));
        }
      } else {
        verified = inspection.defects.map((d) => ({ ...d, verification: "CONFIRMED", verificationReason: "Tydligt fynd, hög säkerhet — accepterat direkt." }));
      }
    }

    timer.lap("verify");

    const dedupBefore = verified.length;
    const damages = dedupeDamages(verified);
    const grade = gradeCondition(damages, inspection.overallCondition);
    timer.lap("dedup_grade");

    // The price is a SECOND opinion on the same findings, computed by a separate engine that never
    // looks for damage itself. It needs both halves of the grading: the confirmed damage list to
    // deduct from, and the canonical condition string to search on.
    // Priset ligger INTE här längre. Det behöver modellen, och modellen väljer säljaren efter
    // identifieringen — se finalizeWithModel. Skickkortet publiceras utan pris och fylls på sedan.
    let priceSpeculation: "hit" | "miss" | "failed" | "skipped" = "skipped";
    if (speculation) {
      const finalSignature = pricingSignature(damages, grade.canonicalCondition);
      const hit = finalSignature === speculation.signature;
      priceSpeculation = hit ? "hit" : "miss";
      if (hit && identity) {
        // Träff: granskningen ändrade ingenting som priset beror på, så anropet som redan löper
        // svarar på exakt rätt fråga. Det SPARAS åt prisspåret i stället för att avbrytas — se
        // takeSpeculativePrice i pricing.ts för varför det förr kastades och vad det kostade.
        // Löftet, inte talet: publiceringen av skicket får inte vänta in ett anrop som ännu löper.
        stashSpeculativePrice(jobId, { identity, signature: finalSignature, promise: speculation.promise });
      } else {
        speculation.abort.abort();
        dropSpeculativePrice(jobId);
      }
    }

    const result = buildResult({
      jobId, inspection, damages, images, calls, tokensUsed, grade,
      identity, price: null, reviewPending: false, reviewed: VERIFY_ENABLED, listing: null,
      coverImageId, startedAt,
    });
    // Publiceras UTAN att vänta in annonsen. Skicket och priset är färdiga; att hålla dem inne tills
    // annonsen är klar hade gjort den långsammaste av tre parallella grenar till allas tempo.
    await completeJob(jobId, result);
    timer.lap("price_publish");

    const trace: DebugTrace = {
      jobId,
      defectFamiliesChecked: DAMAGE_TYPES,
      rawDefects: inspection.defects,
      partsInspected: inspection.partsInspected,
      verifiedDefects: verified,
      verifiedIds: toVerify.map((d) => d.id),
      rejectedByVerification: verified.filter((d) => d.verification === "REJECTED"),
      confirmedFindings: damages.filter((d) => d.verification === "CONFIRMED"),
      dedupBefore,
      dedupAfter: damages.length,
      overallCondition: inspection.overallCondition,
      gradeTrace: grade.reasons,
      geminiCalls: calls,
      totalLatencyMs: result.latencyMs,
    };
    await saveDebugTrace(jobId, trace);

    timer.report({
      images: images.length,
      calls: calls.length,
      cache_hits: calls.filter((c) => c.cached).length,
      fallback_model: calls.some((c) => c.modelUsed !== GEMINI_MODEL),
      findings: damages.length,
      verified: toVerify.length,
      price_speculation: priceSpeculation,
      outcome: "ok",
    });
  } catch (err) {
    timer.lap("failed");
    timer.report({
      images: images.length,
      calls: calls.length,
      cache_hits: calls.filter((c) => c.cached).length,
      fallback_model: calls.some((c) => c.modelUsed !== GEMINI_MODEL),
      outcome: "error",
      error: JSON.stringify(err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)),
    });
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Annonsens produktbilder, startade och släppta.
 *
 * Ingen väntar på dem: `void` med flit, och varje fel sväljs. Det som skulle hända annars är att en
 * modell som inte svarar tar med sig hela skickbedömningen, för bilder kortet klarar sig utan.
 *
 * DET HÄR ÄR JOBBETS TYNGSTA EFTERARBETE. Galleriet är upp till fem varv med den stora modellen, en
 * dryg minut styck, alltså flera minuter efter att säljaren redan fått sitt svar. Att det ligger
 * utanför väntan är hela förutsättningen för att det får kosta så mycket.
 */
function startCover(jobId: string, dir: string, images: CapturedImage[], coverImageId: string | null): void {
  if (!images.length || !COVER_CUTOUT_ENABLED) return;
  /**
   * Omslagsrutan väljs på möbelns synlighet, inte på skickets.
   *
   * `coverImageId` väljer den ruta som visar SKADORNA bäst — rätt för skickrapporten, fel för ett
   * omslag: en närbild på ett armstöd säger ingenting om vilken möbel som säljs. byggOmslag
   * poängsätter varje ruta med den lilla modellen (en sekund styck), bygger produktbilder ur de
   * bästa med den stora, och väljer omslaget bland dem som FAKTISKT blev bra. Saknas urvalsmodellen
   * används `coverImageId` — inspektionens egen vy-utpekning — i stället. Se pipeline/bild/omslag.ts.
   *
   * Null = det gick inte att göra en enda produktbild. Då visar kortet katalogbilden eller säljarens
   * bildruta som den är: hellre det än ett urklipp där soffan saknar ett ben.
   */
  void byggOmslag(jobId, dir, images, coverImageId)
    .then(async (cutout) => {
      if (!cutout) return;
      const job = getJobSync(jobId);
      if (!job) return;
      job.coverCutout = cutout;
      if (job.result) job.result.coverCutout = cutout;
      await persist(job);
    })
    .catch(() => {});
}

/** Assembles a ConditionResult. Shared so the provisional and the final one cannot drift apart. */
function buildResult(a: {
  jobId: string;
  inspection: { coverage: ConditionResult["coverage"]; coverageNote: string | null; overallCondition: ConditionResult["overallCondition"] };
  damages: Damage[];
  images: CapturedImage[];
  calls: CallMeta[];
  tokensUsed: number;
  grade: ConditionResult["grade"];
  identity: FurnitureIdentity | null;
  price: ConditionResult["price"];
  reviewPending: boolean;
  reviewed: boolean;
  listing: ListingResult | null;
  coverImageId: string | null;
  startedAt: number;
}): ConditionResult {
  return {
    jobId: a.jobId,
    createdAt: new Date().toISOString(),
    identity: a.identity,
    price: a.price,
    reviewPending: a.reviewPending,
    reviewed: a.reviewed,
    listing: a.listing,
    coverage: a.inspection.coverage,
    coverageNote: a.inspection.coverageNote,
    grade: a.grade,
    damages: a.damages,
    overallCondition: a.inspection.overallCondition,
    images: a.images,
    coverImageId: a.coverImageId,
    // Omslaget hör till identifieringsspåret, som kör bredvid det här. completeJob flyttar in det
    // från jobbet när det landat — här finns bara skicket att veta något om.
    productImage: null,
    // Urklippet likaså: det byggs bredvid (se startCover) och flyttas in av completeJob.
    coverCutout: null,
    modelUsed: summarizeModelUsage(a.calls),
    tokensUsed: a.tokensUsed,
    costUsd: estimateCostUsd(a.tokensUsed),
    geminiCallCount: a.calls.length,
    latencyMs: Date.now() - a.startedAt,
  };
}

/**
 * One frame for the price engine to read the furniture TYPE out of — "Landskrona" alone spans sofa,
 * corner sofa, armchair and footstool. Best-effort: a missing file must not cost the whole price step.
 */
async function coverImage(dir: string, images: CapturedImage[], coverImageId: string | null = null): Promise<string | null> {
  const first = coverFirst(images, coverImageId)[0];
  if (!first) return null;
  try {
    const part = await loadImageAsBase64(path.join(dir, "originals", first.path));
    return part.base64;
  } catch {
    return null;
  }
}

/** Rough blended estimate for the debug cost readout; not billing-accurate. */
function estimateCostUsd(tokens: number): number {
  const blendedPerMillion = 0.6; // ~$0.10-$0.40/M in, higher out, blended for a mixed vision call
  return Math.round((tokens / 1_000_000) * blendedPerMillion * 10000) / 10000;
}

function summarizeModelUsage(calls: CallMeta[]): string {
  if (calls.length === 0) return "unknown";
  const fallbackCalls = calls.filter((c) => c.modelUsed !== GEMINI_MODEL);
  if (fallbackCalls.length === 0) return GEMINI_MODEL;
  return `${GEMINI_MODEL} (${fallbackCalls[0].modelUsed} fallback for ${fallbackCalls.length}/${calls.length} calls)`;
}
