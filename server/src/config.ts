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
 * Andrabesiktningen — `verify_findings` — körs INTE i det skarpa flödet sedan 2026-08-28.
 *
 * Skälet är mätt: steget kostade 15,6 s median (upp till 54 s) och var den enskilt största posten på
 * kritiska vägen, men över 16 inspelade körningar på 5 möbler ändrade det betyget noll gånger och
 * fyndlistan en gång.
 *
 * Koden är kvar och flaggan finns för att mätningen ska gå att göra om. `VERIFY_FINDINGS=1` ger exakt
 * det beteende som gällde före urkopplingen. Underlaget bakom beslutet saknar möbler med strukturella
 * eller funktionella skador — precis där en andrabesiktning borde vara värd mest — så posten är öppen,
 * inte stängd.
 */
/**
 * EN deadline för hela jobbet, satt när det skapas.
 *
 * Alla tidigare gränser satt på enskilda anrop, och därför band ingen av dem helheten: inspektionen
 * har 60 s + 30 s reserv, identifieringen sin egen budget, prismotorn sin. Ett jobb kunde stå i
 * minuter utan att någon enskild gräns överskreds — och när processen startade om band ingenting alls.
 *
 * Den här klockan bryr sig inte om vilken fas jobbet står i eller hur många omförsök som pågår.
 */
export const JOB_DEADLINE_MS = Number(process.env.JOB_DEADLINE_MS ?? 240_000);

export const VERIFY_ENABLED = process.env.VERIFY_FINDINGS === "1";

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
