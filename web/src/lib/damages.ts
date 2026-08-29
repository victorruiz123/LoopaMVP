import type { Damage } from "../types";

/**
 * STÅR anmärkningen kvar?
 *
 * Samma regel som servern räknar betyg och pris på (damageStands i server/src/pipeline/grade.ts),
 * duplicerad här av samma skäl som labels.ts: klienten importerar inte ur motorn. Håll dem lika —
 * ett kort som visar fler anmärkningar än betyget räknat med är ett kort som säger emot sig självt.
 *
 * Säljarens ord går före modellens: har säljaren bekräftat ett fynd står det kvar även om
 * granskningen underkände det, och har säljaren avvisat det faller det oavsett vad modellen sa.
 */
export function damageStands(d: Damage): boolean {
  if (d.sellerAction === "rejected") return false;
  if (d.sellerAction === "confirmed" || d.sellerAction === "corrected") return true;
  // NOT_RUN = granskningen kördes aldrig. Fyndet står som det rapporterades.
  return d.verification === "CONFIRMED" || d.verification === "NOT_RUN";
}
