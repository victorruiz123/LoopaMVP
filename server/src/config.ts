// Tunable MVP constants. Kept isolated for easy benchmarking later.

/** Hard cap on images sent into the single main inspection call (selected video frames + manual photos). */
export const MAX_IMAGES_PER_JOB = 10;

/**
 * Send EVERY finding to the review pass. The second inspector both sanity-checks what was found and
 * looks for what was missed, so there is no useful subset to gate on. The threshold gate below is kept
 * as the fallback if this is ever turned off — measured, it let 41 of 42 findings through untouched.
 */
export const VERIFY_ALL_FINDINGS = true;

/** A candidate finding is sent to the optional verification pass if ANY of these hold. */
export const VERIFY_CONFIDENCE_THRESHOLD = 65;
export const VERIFY_SEVERITIES = new Set(["S3", "S4"]);
export const VERIFY_IMPACTS = new Set(["structural", "functional"]);
