/**
 * Produktforskningen: identifiering + specifikationssökning med Gemini 3 (Interactions API).
 *
 * Det här är det INTERNA kontraktet mellan modulens delar. Det som annonsen och väljarskärmen ser
 * (ListingAttribute, ModelCandidate, SourceRef) byggs ur de här typerna i pipeline.ts — de typerna
 * ändras så lite som möjligt, för de har många läsare.
 */

/**
 * Hur väl ett påstående är belagt.
 *
 *   page_confirmed — vi hämtade källsidan själva och fann både modellnamnet och värdet på den.
 *   cited          — modellen pekade ut en källa som sök-/URL-verktyget faktiskt besökte, men sidan
 *                    gick inte att bekräfta i efterhand (blockerad hämtning, JS-renderad, annan form).
 *   unverified     — ingen känd källa bakom påståendet. Mått i det här läget når aldrig annonsen.
 */
export type VerificationLevel = "page_confirmed" | "cited" | "unverified";

export interface ResearchSource {
  url: string;
  title: string;
  /** 1 = tillverkare/officiell, 2 = känd återförsäljare, 3 = övrigt. Härlett ur adressen, aldrig ur modellen. */
  tier: 1 | 2 | 3;
  /** Sidan hämtades av URL-verktyget i anropet (url_context_result med status ok). */
  retrieved: boolean;
  /** Adressen står som citat (url_citation) i modellens svar eller i dess egen källista. */
  cited: boolean;
}

export interface ResearchDimension {
  /** Kanonisk typ i snake_case på engelska: overall_width, seat_height, shade_diameter … Fri när ingen känd typ passar. */
  type: string;
  /** Nyckel som annonsen och måttminnet använder: "bredd", "sitthojd", … eller en slug av typen. */
  key: string;
  /** Svensk etikett som visas: "Bredd", "Sitthöjd", "Skärmdiameter". */
  label: string;
  /** Normaliserat tal. Längder i cm, vikt i kg. */
  value: number;
  /** Övre gräns när källan anger ett spann (65–85 cm). */
  valueMax: number | null;
  unit: "cm" | "kg";
  /** Värdet som det skrivs i annonsen: "42 cm", "42,5 cm", "65–85 cm", "6,2 kg". */
  display: string;
  /** Som källan skrev det, oförändrat — för kontroll och för imperial-enheter. */
  rawValue: string;
  /** Vilken variant måttet gäller när produkten finns i flera, annars null. */
  appliesTo: string | null;
  sourceUrl: string | null;
  verification: VerificationLevel;
  verified: boolean;
  /** Citat ur källan, när modellen lämnade ett. */
  quote: string | null;
}

export interface ResearchMaterial {
  /** Vilken del: "Stomme", "Klädsel", "Sits", "Ben", "Bordsskiva" … */
  component: string;
  /** Materialet som källan anger: "Massiv björk", "100 % polyester", "Polyuretanskum 35 kg/m³". */
  material: string;
  /** Ytbehandling, sammansättning, täthet — allt som preciserar utan att vara själva materialet. */
  detail: string | null;
  appliesTo: string | null;
  sourceUrl: string | null;
  verification: VerificationLevel;
  verified: boolean;
  quote: string | null;
}

export interface ResearchFact {
  label: string;
  value: string;
  /** Vilket utförande uppgiften gäller (ett artikelnummer per sitthöjd), annars null. Aldrig en del av etiketten. */
  appliesTo?: string | null;
  sourceUrl: string | null;
  verification: VerificationLevel;
}

/**
 * En dokumenterad variant av produkten: den storlek, höjd eller konfiguration som ändrar måtten.
 * Färger och klädsel är inga varianter i den här meningen — de ändrar inte något mått.
 */
export interface ResearchVariant {
  /** Som källan namnger den: "63 cm", "3-sits", "Utdragen". Kort. */
  label: string;
  /** Vad som skiljer den från de andra, när modellen sa det: "sitthöjd", "bredd". */
  differsBy: string | null;
  sourceUrl: string | null;
}

/**
 * Något som inte hänger ihop i de samlade uppgifterna. Visas aldrig som en dom över säljaren — det är
 * en anledning för oss att utelämna eller märka ett fält hellre än att visa två sanningar.
 */
export interface FactIssue {
  code:
    | "conflicting_values"
    | "variant_ambiguous"
    | "variant_unmatched"
    | "seat_vs_overall"
    | "implausible_relation"
    | "material_conflict"
    | "unit_converted"
    | "no_evidence"
    | "extraction_failed"
    | "source_unreachable"
    | "listing_text_unsupported";
  severity: "info" | "warning";
  /** Svenska, kort. Går att visa för säljaren. */
  message: string;
  /** Vilka rader (måttyp, materialkomponent) det gäller. */
  keys?: string[];
}

export interface IdentityCandidate {
  brand: string;
  model: string;
  variant: string | null;
  productType: string | null;
  confidence: "strong" | "likely" | "possible";
  /** Synliga detaljer som talar FÖR just den här modellen. */
  evidence: string[];
  /** Vad som skiljer den från de andra kandidaterna. */
  distinguishingDetail: string | null;
  /** Produktsida modellen såg. Betrodd först när den hämtats och bekräftats. */
  sourceUrl: string | null;
  /** Sidor med en produktbild av exakt den här modellen och varianten (inte begagnatsajter). */
  productPages?: string[];
  discontinued: boolean | null;
}

export interface ResearchUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  /** Antal Google-sökningar modellen gjorde — det som faktureras per fråga. */
  searchQueries: number;
  /**
   * Anropet avbröts innan tjänsten hann rapportera sin användning, så indatatokens är UPPSKATTADE ur
   * bilder och prompt, och utdata/tänkande/sökresultat är okända (0). Kostnaden är då en nedre gräns
   * för tokens — sökfrågorna är däremot exakta (de räknas ur själva tidslinjen).
   */
  tokensEstimated?: boolean;
}

/** Ett steg i anropets tidslinje: en sökning, en sidhämtning, tänkande eller svaret. */
export interface TimelineEntry {
  index: number;
  /** google_search_call, google_search_result, url_context_call, url_context_result, thought, model_output … */
  type: string;
  /** Millisekunder sedan anropet började. */
  startMs: number;
  endMs: number | null;
  queries?: string[];
  urls?: Array<{ url: string; status: string | null }>;
  /** Längden på svarstexten, för model_output. */
  chars?: number;
  note?: string;
}

export interface ResearchTimings {
  firstEventMs: number | null;
  totalMs: number;
  /** Väggklocka inne i sökningarna (modellen bestämde sig → resultatet klart). */
  searchMs: number;
  /** Väggklocka inne i sidhämtningarna. */
  urlFetchMs: number;
  /** Resten: tänkande, svar, första svarsfördröjning. */
  modelMs: number;
  /**
   * Tiden från att anropet skickades tills strömmen öppnades (svarshuvudet): anslutning, uppladdning av bilderna, kö.
   * Skiljer väntan på nätet från väntan på modellen — `firstEventMs` är redan modellens egen första händelse.
   */
  openMs?: number | null;
  /** Väggklocka inne i synliga tänkandesteg (sammanfattningar). Tänkandet före första händelsen räknas i `firstEventMs`. */
  thinkMs?: number;
  /** Väggklocka medan svaret skrevs (det strukturerade JSON-svaret). */
  outputMs?: number;
  /** Antal sökrundor (sökanrop): varje är en serieväntan på modellens nästa beslut. */
  searchRounds?: number;
}

/** Ett försök som föll innan det sista — för att se om och varför en reserv eller ett omförsök gjordes. */
export interface ResearchFailure {
  model: string;
  kind: string;
  message: string;
  ms: number;
  toolCalls: number;
  searchQueries: number;
  /** Uppskattad kostnad för försöket som föll (sökfrågor exakta, tokens uppskattade när anropet avbröts). */
  costUsd?: number;
}

/** Spårbarhet för ett anrop: vad modellen sökte, vad den hämtade, hur lång tid varje steg tog, vad det kostade. */
export interface ResearchTrace {
  model: string;
  purpose: string;
  label: string | null;
  latencyMs: number;
  attempts: number;
  /** Försöket gjordes med strängare budget efter "too many tool calls". */
  reduced: boolean;
  searchQueries: string[];
  fetchedUrls: Array<{ url: string; status: string }>;
  citations: Array<{ url: string; title: string | null }>;
  usage: ResearchUsage;
  /** Uppskattad kostnad i USD ur den publicerade prislistan (se config.ts). */
  estimatedCostUsd: number;
  finishStatus: string;
  thoughtSummary: string | null;
  timeline: TimelineEntry[];
  timings: ResearchTimings;
  toolCalls: number;
  stoppedBy: "completed" | "time_budget" | "tool_budget" | "error";
  error: { kind: string; message: string } | null;
  settings: {
    thinkingLevel: string;
    tools: string[];
    structured: boolean;
    images: number;
    imageKb: number;
    maxSearchQueries: number | null;
  };
  failures: ResearchFailure[];
}

/** Var tiden gick i ett helt steg (identifiering eller specsökning), uppmätt i koden runt anropen. */
export interface StageTimings {
  /** Läsa och förbereda bilderna. */
  prepareImagesMs?: number;
  /** Väggklocka i Gemini-anropen, omförsök och andra omgångar inräknade. */
  geminiMs: number;
  /** Tolka modellens JSON. */
  parseMs: number;
  /** Verifiera mått och material mot källsidorna (bara specsökningen). */
  verifyMs?: number;
  totalMs: number;
}

/** Sammanfattning av ett helt steg: det som loggas, sparas på jobbet och jämförs mellan körningar. */
export interface ResearchRunSummary {
  purpose: "identify" | "specs";
  /** Identifiering: alltid 1 sedan tidsgränsen på 60 s (ingen andra omgång). Specsökning: antal anrop. */
  passes: number;
  /** Alla Gemini-försök, omförsök efter "too many tool calls" och reservmodell inräknade. */
  attempts: number;
  model: string;
  totalMs: number;
  searchQueries: number;
  toolCalls: number;
  fetchedPages: number;
  costUsd: number;
  /** Minst ett försök avbröts utan rapporterad användning: `costUsd` är en nedre gräns för tokenkostnaden. */
  costIsLowerBound?: boolean;
  stoppedBy: "completed" | "time_budget" | "tool_budget" | "error";
  failures: ResearchFailure[];
  stages: StageTimings;
  /**
   * Identifieringens hårda tidsgräns: hur mycket den fick, hur mycket den tog och om den nåddes. Det är det här som visar att
   * "säljaren väntar aldrig mer än 60 s" faktiskt håller, körning för körning.
   */
  deadline?: { limitMs: number; elapsedMs: number; hit: boolean };
}

export interface IdentifyOk {
  kind: "ok";
  category: string | null;
  observations: string[];
  candidates: IdentityCandidate[];
  /** Den första kandidaten är en exakt modellträff med stark evidens — inte bara "bäst av fyra". */
  exactMatch: boolean;
  uncertaintyNote: string | null;
  sources: ResearchSource[];
  /** Spåret för det sista anropet. Alla anrop (båda omgångarna) finns i `traces`. */
  trace: ResearchTrace;
  traces: ResearchTrace[];
  summary: ResearchRunSummary;
  /** Löpande text för den som vill läsa — och för struktureringens prompt. */
  researchText: string;
  /**
   * Kandidater modellen angav men som INTE visas för säljaren, med skälet. Finns för att kunna mäta sållningen (och för att en
   * sållad kandidat som visade sig vara rätt ska synas i spåren) — ingenting här når skärmen.
   */
  dropped?: DroppedCandidate[];
}

export interface DroppedCandidate {
  brand: string;
  model: string;
  confidence: "strong" | "likely" | "possible";
  /** Platsen i modellens egen lista (0 = först), så att listan före sållningen går att återskapa i en mätning. */
  position: number;
  /** no_evidence: ingen synlig detalj bakom den. (Förut även low_confidence för "möjliga" kandidater — de visas numera, märkta.) */
  reason: "no_evidence";
}

export interface ResearchUnavailable {
  kind: "unavailable";
  /** Text för loggen och, grovt, för säljaren. */
  reason: string;
  /**
   * Felets art: billing | timeout | deadline | tool_limit | tool_budget | quota | overloaded | http | network |
   * empty | aborted | unparseable | no_images | unknown. `deadline` = tidsgränsen på 60 s nåddes (anropet eller vakten). Det är den som styr vad som händer härnäst —
   * se pipeline/identifieringsval.ts.
   */
  failKind: string | null;
  trace: ResearchTrace | null;
  summary: ResearchRunSummary | null;
}

export type IdentifyOutcome = IdentifyOk | ResearchUnavailable;

export interface SpecIdentity {
  brand: string;
  model: string;
  variant: string | null;
  category: string | null;
  confidence: "high" | "medium" | "low";
  /** Stämmer det modellen hittade online med bilderna? */
  matchesPhotos: boolean | null;
  note: string | null;
  discontinued: boolean | null;
}

/**
 * ENDA SANNINGEN OM PRODUKTEN. Allt som visas för säljaren — måttlistan, materialen, övriga
 * specifikationer, annonstexten, måttritningen, det färdiga kortet — läses ur det här objektet (via
 * `viewForVariant`), aldrig ur varandra. Det är vad som hindrar två skärmar från att säga olika saker.
 *
 * Innehåller ALLA varianter forskningen hittade. Vilken variant som gäller bestäms i
 * `viewForVariant` och bara där; se pipeline/productFacts.ts.
 */
export interface ProductFacts {
  version: 1;
  identity: SpecIdentity;
  /** Varianter vars mått skiljer sig åt. Tom när produkten finns i ett utförande. */
  variants: ResearchVariant[];
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  retailPrice: { valueSek: number; sourceUrl: string | null; verification: VerificationLevel } | null;
  sources: ResearchSource[];
  conflicts: string[];
  missing: string[];
  issues: FactIssue[];
  /** Sidor med en produktbild av exakt den här modellen (tillverkare, återförsäljare, katalog) — underlag för kandidatbilden. */
  productPages?: string[];
  /** När forskningen gjordes (ms sedan epoch). */
  researchedAt: number;
}

export interface SpecOk {
  kind: "ok";
  identity: SpecIdentity;
  /** Varianter forskningen dokumenterat med skilda mått. Tom när produkten finns i ett utförande. */
  variants: ResearchVariant[];
  /** Sidor med en produktbild av exakt den här modellen — underlag för kandidatbilden. */
  productPages: string[];
  productFacts: ProductFacts;
  /** Svaret kom ur det verifierade faktaminnet och inte ur ett nytt anrop. */
  fromCache?: boolean;
  /** Ett första svar från snabbspåret (reducerat anrop) medan det fulla anropet pågår. Visas aldrig som slutligt. */
  provisional?: true;
  dimensions: ResearchDimension[];
  materials: ResearchMaterial[];
  facts: ResearchFact[];
  retailPrice: { valueSek: number; sourceUrl: string | null; verification: VerificationLevel } | null;
  /** Källor som motsäger varandra, som modellen själv såg. */
  conflicts: string[];
  /** Vad som söktes men inte gick att belägga. */
  missing: string[];
  /** Påståenden som sållades bort i verifieringen — för felsökning, visas aldrig. */
  rejected: Array<{ what: string; why: string }>;
  sources: ResearchSource[];
  trace: ResearchTrace;
  summary: ResearchRunSummary;
  researchText: string;
}

export type SpecOutcome = SpecOk | ResearchUnavailable;

/** En bild till anropet. `resolution` följer Gemini 3:s media_resolution per bild. */
export interface ResearchImage {
  mimeType: string;
  base64: string;
  resolution?: "low" | "medium" | "high" | "ultra_high";
}
