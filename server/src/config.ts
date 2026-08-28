// Tunable MVP constants. Kept isolated for easy benchmarking later.

/**
 * TAKET för hur många bilder ett jobb får skicka in i inspektionsanropet.
 *
 * Fristående från videovägens `NUM_BUCKETS` (web/src/lib/videoFrames.ts), som styr hur många vyer
 * bildruteuttaget VÄLJER. De råkar båda vara 6 i dag och sänktes samtidigt, men de svarar på olika
 * frågor och ska kunna röra sig var för sig.
 *
 * Skillnaden som gör det viktigt: bakom videovägen står en säljare och väntar på sitt svar, och varje
 * extra bild är sekunder de ser. Bakom manuellt uppladdade produktbilder — B2B-vägen — väntar ingen
 * på samma sätt, så taket kan höjas därifrån utan att röra videoflödets svarstid. Höj det här ensamt
 * den dagen den vägen behöver fler bilder.
 */
export const MAX_IMAGES_PER_JOB = 6;

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
