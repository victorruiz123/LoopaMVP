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
 * Andrabesiktningen — `verify_findings` — är PÅ, och `VERIFY_FINDINGS=0` stänger av den.
 *
 * Den var urkopplad ett tag, av ett mätt skäl: steget kostade då 15,6 s median (upp till 54 s), var
 * den största posten på kritiska vägen, och ändrade över 16 körningar på 5 möbler betyget noll gånger
 * och fyndlistan en gång. Det var när granskningen fick alla originalbilder och även skulle leta efter
 * MISSADE skador.
 *
 * Den halvan är borta. Granskningen får nu bara ett litet utsnitt per fynd, och gör två saker som
 * båda betalar för sig: den avvisar fynd vars utsnitt inte visar någon skada, och den pekar ut när
 * flera utsnitt visar SAMMA skada ur olika bildrutor. Att stänga av den tar bort båda — utan den
 * står varje fynd som rapporterat (`NOT_RUN`), och dubbletter fångas bara på ordmatchning i dedup.ts.
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

export const VERIFY_ENABLED = process.env.VERIFY_FINDINGS !== "0";

/**
 * Send EVERY finding to the review pass. Utsnitten är små och går i ETT anrop, så priset för att
 * granska ett fynd till är några rader i svaret — och dubblettjakten kräver dessutom att alla fynd är
 * med, eftersom två utsnitt inte går att känna igen som samma skada om bara det ena skickas.
 * The threshold gate below is kept as the fallback if this is ever turned off — measured, it let 41 of
 * 42 findings through untouched.
 */
export const VERIFY_ALL_FINDINGS = true;

/**
 * Golv för vad som räknas som ett fynd över huvud taget.
 *
 * Prompten ger modellen en kalibrerad skala och säger rakt ut att allt under 50 är en gissning och
 * inte ska rapporteras. Det här är samma regel, men på vår sida av anropet: en modell som ändå
 * skickar in sin gissning ska inte kunna sätta den på säljarens kort. Marginalen ned till 45 finns
 * för att skalan är modellens egen och inte exakt — vi plockar bara bort det den själv kallar en
 * gissning, inte det den kallar osäkert.
 *
 * Kostar ingen tid: filtret är en jämförelse på ett svar vi redan fått.
 */
export const MIN_REPORT_CONFIDENCE = 45;

/**
 * Granskningen får peka ut FLER märken i ett utsnitt den ändå tittar på — men inom hårda ramar.
 *
 * Varför det ger något: utsnittet är ~5x förstorat mot vad första besiktningen såg av samma yta, och
 * skador sitter i kluster. Det som syns bredvid ett bekräftat märke är oftast ett märke till, och det
 * är just de som saknas i dag. Det kostar inget anrop och inga nya bilder — utsnitten är redan med i
 * granskningens nyttolast, bara svaret blir några rader längre.
 *
 * Varför ramarna är hårdare än för första besiktningen: ingen granskar de här fynden i sin tur. De
 * kommer från sista steget, så golvet ligger högre (70 mot 45), antalet är tak-satt så ett utsnitt
 * aldrig kan svämma över kortet, och de kan inte bära mer än S2/kosmetisk — se collectExtraMarks i
 * verify.ts.
 *
 * VAD DET KOSTAR, parvis mätt på samma jobb och samma utsnitt, med och utan frågan: 7,3 s mot 7,7 s,
 * och 215 mot 102 utdatatokens. Frågan kostar alltså några rader mer i svaret och ingen mätbar tid —
 * granskningen varierar 5,5-14,4 s mellan körningar oavsett, och den variationen är större än
 * frågan. Utbytet var ett extra fynd i tre av nio körningar.
 *
 * Det som DÄREMOT kostade tid var att vidga utsnitten för att ge frågan mer att se: 0,35 av rutan i
 * stället för 0,15 tog granskningen från 8,6 s till 14,4 s på ett jobb och över tidsgränsen på ett
 * annat. Marginalen står därför kvar där den var — se cropEvidence.
 *
 * Tiden ligger dessutom EFTER att skickkortet publicerats: run.ts publicerar inspektionens lista
 * först och granskningen fyller på, så säljarens första svar rörs inte alls.
 *
 * `VERIFY_EXTRA_MARKS=0` tar bort både frågan och fältet ur schemat — svaret blir då exakt som förut.
 */
export const EXTRA_MARKS_ENABLED = process.env.VERIFY_EXTRA_MARKS !== "0";

export const MAX_ADDED_PER_CROP = 2;
export const MAX_ADDED_TOTAL = 4;
export const MIN_ADDED_CONFIDENCE = 70;

/** A candidate finding is sent to the optional verification pass if ANY of these hold. */
export const VERIFY_CONFIDENCE_THRESHOLD = 65;
export const VERIFY_SEVERITIES = new Set(["S3", "S4"]);
export const VERIFY_IMPACTS = new Set(["structural", "functional"]);

/**
 * Omslagsurklippet — säljarens bildruta klippt fri och lagd på vitt. PÅ, `COVER_CUTOUT=0` stänger av.
 *
 * Ett Gemini-anrop per jobb, utanför säljarens väntan: det startas när inspektionen valt bildrutan
 * och är framme långt innan annonsskärmen öppnas. Med flaggan av visar kortet säljarens bildruta som
 * den är — samma väg som när masken underkänns. Se pipeline/cutout.ts.
 */
export const COVER_CUTOUT_ENABLED = process.env.COVER_CUTOUT !== "0";
