import { mergeDamageGroup, plausiblySameDamage } from "./dedup.js";
import type { NormalizedRect } from "../imageUtils.js";
import type { CapturedImage, Damage } from "../types.js";

/**
 * Numbering for the verification call, kept apart from verify.ts so it can be unit-tested without
 * pulling in the Gemini client or sharp.
 *
 * The numbers MUST be derived from the crops that actually exist, not from a damage's position in
 * the candidate list. Numbering by position was the earlier bug: descriptions were emitted for every
 * candidate while the image list only grew when a crop succeeded, so one failed crop shifted every
 * following image and each verdict landed on the wrong damage.
 */

export interface CropAttempt {
  damage: Damage;
  /** Path (relative to the job dir) of the crop that was written, or null if none could be produced. */
  cropRelPath: string | null;
  /** Var i originalbilden utsnittet togs. Utan den går en ruta i utsnittet inte att placera i bilden. */
  rect: NormalizedRect | null;
}

export interface NumberedCrop {
  damage: Damage;
  cropRelPath: string;
  rect: NormalizedRect | null;
  /** 1-based, matches the crop_index the model is asked to return. */
  index: number;
  /** Text emitted immediately before this crop's image in the request. */
  label: string;
}

export interface VerifyPayload {
  /** Successful attempts in crop order — crop_index k refers to numbered[k - 1]. */
  numbered: NumberedCrop[];
  /** Candidates with no crop. They are never sent to the model and must not receive a verdict. */
  uncroppable: Damage[];
}

export function buildVerifyPayload(attempts: CropAttempt[], images: CapturedImage[]): VerifyPayload {
  const numbered: NumberedCrop[] = [];
  const uncroppable: Damage[] = [];

  for (const attempt of attempts) {
    if (!attempt.cropRelPath) {
      uncroppable.push(attempt.damage);
      continue;
    }
    const d = attempt.damage;
    const index = numbered.length + 1;
    numbered.push({
      damage: d,
      cropRelPath: attempt.cropRelPath,
      rect: attempt.rect,
      index,
      label:
        `Utsnitt för Fynd ${index}: typ="${d.type}", del="${d.part}" (${d.semanticLocation}), ` +
        `förstorat ur Bild ${images.findIndex((im) => im.id === d.evidence[0]?.imageId)}.`,
    });
  }

  return { numbered, uncroppable };
}

/**
 * Slår ihop de fynd granskningen pekat ut som SAMMA fysiska skada.
 *
 * Granskningen ser alla utsnitt i ett och samma anrop och är därför den enda i kedjan som kan jämföra
 * hur skadorna FAKTISKT ser ut. Ordmatchningen i dedup.ts kan bara jämföra vad de kallas, och två
 * bildrutor av samma skav heter sällan exakt samma sak. Det här är alltså den starkare dubblettjakten
 * — och den kostar ingen extra tid, för domen kom med i det anrop som ändå gjordes.
 *
 * `reviewed` är i utsnittsordning: post k-1 är det utsnitt modellen numrerar k.
 *
 * Två spärrar mot en felaktig hopslagning, båda med samma skäl — modellen ser ett förstorat utsnitt
 * utan sammanhang, och två ben ser likadana ut i närbild:
 *   - lägesorden får inte motsäga varandra, och skadetypen måste vara av samma familj
 *     (`plausiblySameDamage`),
 *   - de måste komma ur OLIKA bildrutor. Samma skada två gånger i samma bildruta är inte "sedd ur
 *     flera håll" utan en dubbelrapportering, och den fångas på överlappande rutor i dedup.ts där
 *     koordinaterna faktiskt går att jämföra.
 */
export function mergeReviewedDuplicates(reviewed: Damage[], links: ReadonlyMap<number, number>): Damage[] {
  if (reviewed.length <= 1 || links.size === 0) return reviewed;

  const parent = reviewed.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (const [from, to] of links) {
    const a = reviewed[from - 1];
    const b = reviewed[to - 1];
    if (!a || !b || from === to) continue;
    if (!plausiblySameDamage(a, b)) continue;
    if (a.evidence[0]?.imageId === b.evidence[0]?.imageId) continue;
    const ra = find(from - 1);
    const rb = find(to - 1);
    if (ra !== rb) parent[ra] = rb;
  }

  const clusters = new Map<number, Damage[]>();
  reviewed.forEach((d, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), d]);
  });

  return [...clusters.values()].map((cluster) => {
    if (cluster.length === 1) return cluster[0];
    const merged = mergeDamageGroup(cluster);
    // Ett underkänt utsnitt av en skada som godkänts i en annan bildruta är ett dåligt utsnitt, inte
    // ett underkänt fynd: skadan är sedd i flera bildrutor och det är starkare stöd än ett suddigt
    // närbildsutsnitt är motbevis. Underkänns ALLA utsnitten faller skadan.
    const kept = cluster.find((d) => d.verification === "CONFIRMED");
    return {
      ...merged,
      verification: kept ? "CONFIRMED" : "REJECTED",
      verificationReason: (kept ?? cluster[0]).verificationReason,
    };
  });
}
