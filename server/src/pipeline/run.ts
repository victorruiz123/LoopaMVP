import path from "node:path";
import { GEMINI_MODEL } from "../gemini.js";
import { jobDir, updateProgress, completeJob, failJob, saveDebugTrace, getJobSync, persist } from "../jobStore.js";
import { loadImageAsBase64 } from "../imageUtils.js";
import { estimatePrice, pricingSignature } from "../pricing.js";
import { generateListing } from "../listing.js";
import type { CallMeta, CapturedImage, ConditionResult, Damage, DebugTrace, FurnitureIdentity, ListingResult } from "../types.js";
import { DAMAGE_TYPES, inspectFurniture } from "./inspect.js";
import { needsVerification, verifyFindings } from "./verify.js";
import { dedupeDamages } from "./dedup.js";
import { gradeCondition } from "./grade.js";

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

  // Annonsgeneratorn behöver bara bildrutorna och märket — inte betyget, inte skadelistan. Den startar
  // därför HÄR, samtidigt som besiktningen, och väntas in allra sist. Kedjad efter besiktningen hade
  // den lagt sina 15-26 sekunder ovanpå i stället för bredvid. Utanför try-blocket, så även felvägen
  // kan vänta in den.
  const pendingListing: ListingResult | null = identity
    ? { status: "pending", unavailableReason: null, result: null, latencyMs: 0 }
    : null;
  const listingPromise = generateListing(identity, images, dir).catch(() => null);

  try {
    await updateProgress(jobId, { stage: "preparing", message: "Bilder förberedda." });

    await updateProgress(jobId, { stage: "inspecting", message: "Inspekterar möbeln…" });
    const inspection = await inspectFurniture(images, dir, productContext);
    track(inspection.callMeta);
    timer.lap("inspect");

    // ---- Delresultat, publicerat innan granskningen ens börjat -----------------------------------
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
        identity, price: null, reviewPending: true, listing: pendingListing, startedAt,
      }),
    );

    timer.lap("publish_provisional");

    /**
     * Prissättningen startas SPEKULATIVT här, på den preliminära listan, och löper parallellt med
     * granskningen.
     *
     * Granskningen ändrar sällan vad prismotorn matas med — mätt över 16 inspelade körningar avslog
     * den ett fynd en gång och lade aldrig till något. När listan står oförändrad är det spekulativa
     * svaret exakt det seriella svaret, bara ~5 sekunder tidigare. När den ändras kastas det och
     * anropet avbryts; utdata blir då bit för bit densamma som utan spekulation.
     */
    const speculation = identity
      ? (() => {
          const abort = new AbortController();
          const signature = pricingSignature(provisionalDamages, provisionalGrade.canonicalCondition);
          const promise = coverImage(dir, images)
            .then((cover) =>
              estimatePrice(identity, provisionalDamages, provisionalGrade.canonicalCondition, cover, abort.signal),
            )
            // Ett fel i spekulationen får aldrig nå slutresultatet — den seriella vägen tar över.
            .catch(() => null);
          return { abort, signature, promise };
        })()
      : null;

    const toVerify = inspection.defects.filter(needsVerification);
    let verified = inspection.defects;
    if (toVerify.length > 0) {
      await updateProgress(jobId, { stage: "verifying", message: `Kontrollerar ${toVerify.length} osäkra fynd…` });
      try {
        const verifyResult = await verifyFindings(inspection.defects, images, dir);
        verified = verifyResult.verified;
        track(verifyResult.callMeta);
      } catch (err) {
        // This pass is OPTIONAL by design, so losing it must not lose the whole run along with the
        // inspection that already succeeded. Findings that never needed a second opinion are accepted
        // as before; the flagged ones stay UNCERTAIN rather than being confirmed on no evidence, which
        // keeps them out of the grade instead of silently inflating it.
        console.warn(
          `[condition-grading] verification unavailable, grading on the inspection alone — ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        // Findings KEEP their standing when the review cannot run. Marking them UNCERTAIN here was
        // catastrophic once every finding went to review: gradeCondition counts only CONFIRMED, so a
        // single failed review call — a 503, a timeout — silently emptied the whole damage list and
        // graded the furniture A. The review is an improvement on a finding, never a precondition
        // for it to count.
        verified = inspection.defects.map((d): Damage => ({
          ...d,
          verification: "CONFIRMED",
          verificationReason: "Granskningen kunde inte genomföras — fyndet står kvar som det rapporterades.",
        }));
      }
    } else {
      // Nothing ambiguous enough to justify the optional call — accept all findings directly.
      verified = inspection.defects.map((d) => ({ ...d, verification: "CONFIRMED", verificationReason: "Tydligt fynd, hög säkerhet — accepterat direkt." }));
    }

    timer.lap("verify");

    const dedupBefore = verified.length;
    const damages = dedupeDamages(verified);
    const grade = gradeCondition(damages, inspection.overallCondition);
    timer.lap("dedup_grade");

    // The price is a SECOND opinion on the same findings, computed by a separate engine that never
    // looks for damage itself. It needs both halves of the grading: the confirmed damage list to
    // deduct from, and the canonical condition string to search on.
    // Träffade spekulationen? Frågan ställs på den mappade listan prismotorn faktiskt fick, inte på
    // skadeobjekten — se pricingSignature.
    let priceSpeculation: "hit" | "miss" | "failed" | "skipped" = "skipped";
    let price: Awaited<ReturnType<typeof estimatePrice>> = null;
    if (speculation) {
      const finalSignature = pricingSignature(damages, grade.canonicalCondition);
      if (finalSignature === speculation.signature) {
        price = await speculation.promise;
        priceSpeculation = price ? "hit" : "failed";
      } else {
        // Avbryt, konkurrera inte om kvot med ett svar vi ändå kastar.
        speculation.abort.abort();
        priceSpeculation = "miss";
      }
      if (!price) {
        price = await estimatePrice(identity, damages, grade.canonicalCondition, await coverImage(dir, images));
      }
    } else if (identity) {
      price = await estimatePrice(identity, damages, grade.canonicalCondition, await coverImage(dir, images));
    }

    const result = buildResult({
      jobId, inspection, damages, images, calls, tokensUsed, grade,
      identity, price, reviewPending: false, listing: pendingListing, startedAt,
    });
    // Publiceras UTAN att vänta in annonsen. Skicket och priset är färdiga; att hålla dem inne tills
    // truth-cardet är klart hade gjort den långsammaste av tre parallella grenar till allas tempo.
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

    // Sista publiceringen: truth-cardet, när det landar.
    const listing = await listingPromise;
    if (listing) await completeJob(jobId, { ...result, listing });
    timer.lap("listing_wait");
    timer.report({
      images: images.length,
      calls: calls.length,
      cache_hits: calls.filter((c) => c.cached).length,
      fallback_model: calls.some((c) => c.modelUsed !== GEMINI_MODEL),
      findings: damages.length,
      verified: toVerify.length,
      listing: listing?.status ?? "none",
      price: price?.status ?? "none",
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
    // Annonsgrenen kan mycket väl ha lyckats — den delar inga anrop med besiktningen. Spara den på
    // jobbet så ett omtag slipper göra om den och felskärmen kan erbjuda truth-cardet ändå.
    try {
      const listing = await listingPromise;
      const job = getJobSync(jobId);
      if (job && listing) {
        job.listing = listing;
        await persist(job);
      }
    } catch {
      // en förlorad annons får inte skriva över det verkliga felet ovan
    }
  }
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
  listing: ListingResult | null;
  startedAt: number;
}): ConditionResult {
  return {
    jobId: a.jobId,
    createdAt: new Date().toISOString(),
    identity: a.identity,
    price: a.price,
    reviewPending: a.reviewPending,
    listing: a.listing,
    coverage: a.inspection.coverage,
    coverageNote: a.inspection.coverageNote,
    grade: a.grade,
    damages: a.damages,
    overallCondition: a.inspection.overallCondition,
    images: a.images,
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
async function coverImage(dir: string, images: CapturedImage[]): Promise<string | null> {
  const first = images[0];
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
