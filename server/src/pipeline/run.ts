import path from "node:path";
import { GEMINI_MODEL } from "../gemini.js";
import { jobDir, updateProgress, completeJob, failJob, saveDebugTrace } from "../jobStore.js";
import { loadImageAsBase64 } from "../imageUtils.js";
import { estimatePrice } from "../pricing.js";
import type { CallMeta, CapturedImage, ConditionResult, Damage, DebugTrace, FurnitureIdentity } from "../types.js";
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
export async function runConditionGrading(
  jobId: string,
  images: CapturedImage[],
  productContext: string | null,
  identity: FurnitureIdentity | null = null,
): Promise<void> {
  const dir = jobDir(jobId);
  const startedAt = Date.now();
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
    const inspection = await inspectFurniture(images, dir, productContext);
    track(inspection.callMeta);

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

    await updateProgress(jobId, { stage: "grading", message: "Sammanställer skicket…" });
    const dedupBefore = verified.length;
    const damages = dedupeDamages(verified);
    const grade = gradeCondition(damages, inspection.overallCondition);

    // The price is a SECOND opinion on the same findings, computed by a separate engine that never
    // looks for damage itself. It runs last because it needs both halves of the grading: the confirmed
    // damage list to deduct from, and the canonical condition string to search on.
    let price = null;
    if (identity) {
      await updateProgress(jobId, { stage: "pricing", message: "Hämtar prisförslag…" });
      price = await estimatePrice(identity, damages, grade.canonicalCondition, await coverImage(dir, images));
    }

    const latencyMs = Date.now() - startedAt;
    const result: ConditionResult = {
      jobId,
      createdAt: new Date().toISOString(),
      identity,
      price,
      coverage: inspection.coverage,
      coverageNote: inspection.coverageNote,
      grade,
      damages,
      overallCondition: inspection.overallCondition,
      images,
      modelUsed: summarizeModelUsage(calls),
      tokensUsed,
      costUsd: estimateCostUsd(tokensUsed),
      geminiCallCount: calls.length,
      latencyMs,
    };

    await completeJob(jobId, result);

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
      totalLatencyMs: latencyMs,
    };
    await saveDebugTrace(jobId, trace);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
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
