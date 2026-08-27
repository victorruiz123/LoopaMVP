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
}

export interface NumberedCrop {
  damage: Damage;
  cropRelPath: string;
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
      index,
      label:
        `Utsnitt för Fynd ${index}: typ="${d.type}", del="${d.part}" (${d.semanticLocation}), ` +
        `förstorat ur Bild ${images.findIndex((im) => im.id === d.evidence[0]?.imageId)}.`,
    });
  }

  return { numbered, uncroppable };
}
