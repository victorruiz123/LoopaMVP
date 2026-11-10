/**
 * Inställningar för produktforskningen. Allt går att styra med miljövariabler så att en mätning
 * kan byta modell eller budget utan kodändring — se scripts/research-bench.ts.
 *
 * MODELLVALET är dokumenterat, inte gissat (ai.google.dev/gemini-api/docs/models, läst 2026-10-11):
 * gemini-3.8-flash är "our most intelligent Flash model", GA sedan 2026-09-02, stöder Google Search,
 * URL context, strukturerad utdata TILLSAMMANS med verktygen (Interactions API, bara Gemini 3) och
 * thinking_level. gemini-3.7-flash avvecklades 2026-10-08 och dirigeras om till 3.8. Den gamla
 * säljarmodellen gemini-3.5-flash-lite är "fastest, most cost-effective" — en delegatmodell, inte
 * den som ska känna igen en möbel ur fem suddiga mobilbilder.
 */

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const envStr = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

/** "gemini3" (förval) kör den nya forskningen; "legacy" går den gamla vägen genom annonsgeneratorn. */
export const RESEARCH_ENGINE = envStr("LOOPA_RESEARCH_ENGINE", "gemini3");
export const researchEnabled = (): boolean => RESEARCH_ENGINE !== "legacy";

export const RESEARCH_MODEL = envStr("LOOPA_RESEARCH_MODEL", "gemini-3.8-flash");

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
const thinking = (name: string, fallback: ThinkingLevel): ThinkingLevel => {
  const v = process.env[name]?.trim();
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : fallback;
};

/**
 * Tänkandet per steg.
 *
 * KVALITETEN STYR (2026-10-25). En identifiering ska bete sig som Gemini på webben: titta noga, formulera hypoteser, söka, jämföra de
 * närmaste modellerna och granska motbevis. Det kräver tänkande och flera sökrundor; en enda sökrunda på "low" gav säkra fel (BÖRJE och
 * NÄSINGE för NORRNÄS-stolen, olika svar för samma Sits-fåtölj) — se docs/kvalitet-2026-10-25.md. Förvalet är det som mättes bäst där,
 * och `LOOPA_IDENTIFY_THINKING` byter det utan kodändring. Äldre mätningar (2026-10-21, 56 s): "high" hann inte bli klar inom den tidens
 * klocka; gemini-4-argon (100 s) inte heller — de prövades om med dagens livslängd, se dokumentet.
 */
export const IDENTIFY_THINKING = thinking("LOOPA_IDENTIFY_THINKING", "medium");
/**
 * Googles tak på utdata INKLUSIVE tänkande per anrop — det enda token-tak tjänsten själv verkställer. Det är ett skydd mot ett skenande
 * anrop, inte ett sätt att spara: ett för snävt tak avkortar svaret (mätt: 3 000 gav ett tomt svar, och 12 000 avkortade en specsökning som
 * tänkt i 53 s — allt arbetet kastades som "kunde inte tolkas") och faktureras ändå. Därför väl över vad ett normalt svar med mycket tänkande
 * kräver. 32 000 tokens är som mest ≈0,12 USD (≈1,3 SEK) i utdata.
 */
export const IDENTIFY_MAX_OUTPUT_TOKENS = envInt("LOOPA_IDENTIFY_MAX_OUTPUT_TOKENS", 32_000);
export const SPEC_MAX_OUTPUT_TOKENS = envInt("LOOPA_SPEC_MAX_OUTPUT_TOKENS", 32_000);
/** Så många produktsidor ges en specsökning att läsa vid start (från identifieringen). Kostnaden är sidorna: ≈30 000 indatatokens (≈0,25 SEK) per IKEA-sida. */
export const SPEC_MAX_START_PAGES = envInt("LOOPA_SPEC_MAX_START_PAGES", 3);
/** Specsökningen är mer mekanisk: hitta sidan, läs av tabellen. */
export const SPEC_THINKING = thinking("LOOPA_SPEC_THINKING", "medium");

/**
 * Sökbudgetar: vad prompten ber om, och var vi avbryter om den inte följs.
 *
 * "Prompten ber om" är arbetssättet; "avbryter vid" är ett skyddsnät. Det mättes att modellen utan
 * budget gör 40–57 sökningar för en uppgift som en människa löser med fem. Googles "too many tool
 * calls" är en gräns på Googles sida utan dokumenterad parameter, så den enda kontrollen vi har är
 * att be om mindre — och att avbryta, strömmat, när det inte hjälper (se geminiInteractions.ts).
 */
/**
 * IDENTIFIERINGEN ÄR HÖGST TRE SEKVENSER AV ETT ANROP, och det är KODEN som sätter gränsen — inte en mening i prompten.
 *
 * Mätt 2026-10-25 (medel-tänkande, båda verktygen, sex fall, tre olika prompter): modellen följer inget antal sökfrågor och ingen rundgräns
 * som står i prompten. "Ungefär 14, högst 20, i högst tre rundor" gav 22–24 sökfrågor i fyra av sex fall; "högst två sökanrop med fem frågor" gav 22
 * på Sits-fåtöljen; utan tak gjorde den 46 sökfrågor på 103 s utan att bli klar. Taket slog då till och hela den betalda forskningen kastades
 * (3,4–7,2 SEK per fall, inget svar). Det enda som följdes var "EXAKT ETT sökanrop med högst N frågor" (mätt 2026-10-24).
 *
 * Därför: ett anrop är ETT sökanrop med högst `IDENTIFY_ROUND_QUERIES` frågor, och svåra fall får upp till `IDENTIFY_MAX_ROUNDS` sådana anrop efter
 * varandra, där varje omgång får förra omgångens fynd. Varje omgång lämnar ett svar, så en omgång som faller eller stoppas kastar aldrig
 * de tidigare. En stark toppkandidat avslutar; tre omgångar à fem frågor är ≈ 2,3 SEK i sökavgift och ryms i säkerhetsbudgeten (cost/ledger.ts).
 *
 * ALLA TAL HÄR RÄKNAS I SÖKFRÅGOR, inte verktygsanrop (det är frågorna Google fakturerar).
 */
export const IDENTIFY_ROUND_QUERIES = envInt("LOOPA_IDENTIFY_ROUND_QUERIES", 5);
export const IDENTIFY_MAX_ROUNDS = envInt("LOOPA_IDENTIFY_MAX_ROUNDS", 3);
/** En extra sökfråga-grupp som en omgång tål innan strömmen stängs: ett verktygsanrop bär flera frågor och ses först när det utfärdats. */
export const ROUND_STRAY_QUERIES = 4;
/**
 * Skyddsnätet för kostnaden över ALLA omgångar, inte tidsgränsen — tidsgränsen (IDENTIFY_DEADLINE_MS) är det som verkligen styr. Gäller bara
 * när anroparen saknar kostnadsbok (mätskript, tester); i en omgång gäller tillåtelsen ur boken.
 */
export const IDENTIFY_MAX_QUERIES = envInt("LOOPA_IDENTIFY_MAX_QUERIES", 40);
/** Specsökningen är ETT anrop med ETT sökanrop med så här många frågor; sidorna den läser (SPEC_MAX_START_PAGES) bär det mesta. */
export const SPEC_SEARCH_BUDGET = envInt("LOOPA_SPEC_SEARCH_BUDGET", 6);
export const SPEC_MAX_QUERIES = envInt("LOOPA_SPEC_MAX_QUERIES", 30);

/**
 * Tidsbudgetar.
 *
 * IDENTIFIERINGENS LIVSLÄNGD är ett skydd mot ett anrop som hänger sig, INTE en klocka säljaren tävlar mot (se research/deadline.ts). Säljaren
 * väntar inte på den: skickgranskningen, och därefter modellvalet där förslagen ligger klara, går medan sökningen arbetar. En svår, utgången
 * modell kan behöva två–tre minuter; 180 s ger det utrymme (de uppmätta fulla svaren tog 21–85 s) och är ändå ändligt — anropet stängs på
 * strömmen (SDK:ns AbortSignal-kedja höll inte när det första skarpa försöket väntade 205 s; se geminiInteractions.ts), och en vakt ger ett ärligt
 * utfall om något ändå hänger sig. Den hårda 57-sekundersgränsen (2026-10-23) gav ingen identifiering i 7 av 11 körningar och är borttagen.
 */
export const IDENTIFY_DEADLINE_MS = envInt("LOOPA_IDENTIFY_DEADLINE_MS", 180_000);
/**
 * Tid som alltid lämnas kvar EFTER modellanropet: lösning av Googles omdirigeringsadresser (högst 3 s, research/redirects.ts), tolkning, sållning
 * och skrivning till jobbet (några millisekunder). Anropets egen budget är tiden kvar minus den här, så att anropet stänger sig självt före
 * livslängden i stället för att avbrytas av den.
 */
export const IDENTIFY_RESERVE_MS = envInt("LOOPA_IDENTIFY_RESERVE_MS", 4_000);
/**
 * Ett modellanrop — det första eller ett omförsök efter ett TILLFÄLLIGT fel — startas bara om så här mycket tid finns kvar. Det fulla
 * anropet har aldrig blivit klart på under 38 s (14 sparade körningar: 38–54 s), så under ≈30 s skulle det bara kosta pengar.
 */
export const IDENTIFY_MIN_CALL_MS = envInt("LOOPA_IDENTIFY_MIN_CALL_MS", 30_000);
export const SPEC_TIMEOUT_MS = envInt("LOOPA_SPEC_TIMEOUT_MS", 180_000);

/** Så många bildrutor som skickas. Omslaget först, resten spridda över varvet. */
export const RESEARCH_MAX_IMAGES = envInt("LOOPA_RESEARCH_MAX_IMAGES", 6);
/**
 * Bilderna rörs bara när de är större än så här. Klienten laddar redan upp ≤1280 px, så i praktiken
 * går originalen igenom orörda. Gemini 3 räknar tokens per bild efter media_resolution, inte efter
 * pixlar (high = 1120 tokens oavsett), så en nedskalning sparar ingenting — den kostar bara detaljer.
 */
export const RESEARCH_IMAGE_MAX_SIDE = envInt("LOOPA_RESEARCH_IMAGE_MAX_SIDE", 1600);
export const RESEARCH_IMAGE_QUALITY = envInt("LOOPA_RESEARCH_IMAGE_QUALITY", 90);
const resolution = (): "low" | "medium" | "high" | "ultra_high" => {
  const v = process.env.LOOPA_RESEARCH_IMAGE_RESOLUTION?.trim();
  return v === "low" || v === "medium" || v === "high" || v === "ultra_high" ? v : "high";
};
export const RESEARCH_IMAGE_RESOLUTION = resolution();

/** Verifiering av källsidor i efterhand (egen hämtning). 0 stänger av. */
export const PAGE_VERIFY_ENABLED = process.env.LOOPA_PAGE_VERIFY !== "0";
export const PAGE_VERIFY_TIMEOUT_MS = envInt("LOOPA_PAGE_VERIFY_TIMEOUT_MS", 8_000);
export const PAGE_VERIFY_MAX_PAGES = envInt("LOOPA_PAGE_VERIFY_MAX_PAGES", 6);
export const PAGE_VERIFY_BUDGET_MS = envInt("LOOPA_PAGE_VERIFY_BUDGET_MS", 15_000);

/**
 * Prislista per 1M tokens i USD (ai.google.dev/gemini-api/docs/pricing, 2026-10-11, standardnivå,
 * priserna som gäller t.o.m. 2026-12-31) plus sökavgiften: 5 000 fria sökningar per månad, sedan
 * 14 USD per 1 000. Kostnaden som skrivs i spåret räknar sökningarna som betalda — det är den övre
 * gränsen, inte en faktura.
 */
export const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  // Mätmodell (scripts/identify-eval.ts), inte en produktionsmodell: standardnivån 2/10 USD t.o.m. 2026-11-30, 4/20 därefter.
  "gemini-4-argon": { input: 2.0, output: 10.0 },
};
export const SEARCH_PRICE_USD = 14 / 1000;

export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; searchQueries: number }): number {
  const price = PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION["gemini-3.8-flash"];
  const tokens = (usage.inputTokens * price.input + (usage.outputTokens + usage.thoughtTokens) * price.output) / 1_000_000;
  return Math.round((tokens + usage.searchQueries * SEARCH_PRICE_USD) * 10_000) / 10_000;
}
