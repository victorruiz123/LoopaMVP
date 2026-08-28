// Mirrors experiments/condition-grading/server/src/types.ts.
// Kept as a plain duplicate (no shared package) since this whole engine is an isolated experiment.

export type DamageType =
  | "scratch" | "scuff" | "abrasion" | "chip" | "dent" | "crack" | "tear" | "hole"
  | "stain" | "discoloration" | "fading" | "rust" | "corrosion"
  | "pilling" | "worn_material" | "fraying" | "compressed_upholstery" | "peeling_flaking"
  | "deformation" | "loose_component" | "broken_component" | "missing_part" | "sagging" | "structural_damage"
  | "general_wear" | "other";

export type Severity = "S1" | "S2" | "S3" | "S4";
export type Impact = "cosmetic" | "functional" | "structural";
/**
 * `NOT_RUN` betyder att andrabesiktningen aldrig kördes — inte att fyndet underkändes och inte att det
 * godkändes. Kortet är ett attest och får inte antyda en kontroll som inte gjorts.
 *
 * Fyndet STÅR ändå: det rapporterades av inspektionen och räknas i betyg och pris precis som förut.
 * Se effectiveVerification i grade.ts och isPriceable i pricing.ts — båda filtrerade tidigare på
 * `=== "CONFIRMED"` och hade tyst tömt både betyget och prisunderlaget på varje fynd.
 */
export type VerificationState = "CONFIRMED" | "REJECTED" | "UNCERTAIN" | "NOT_RUN";
export type CoverageState = "INSPECTED_CLEAR" | "INSPECTED_DAMAGE" | "NOT_SUFFICIENTLY_VISIBLE";
export type ConditionGrade = "A" | "B" | "C" | "D" | "E" | "F";
export type CanonicalCondition = "Nyskick" | "Mycket bra skick" | "Bra skick" | "Okej skick";
export type WearLevel = "minimal" | "light" | "moderate" | "heavy" | "severe";
export type AffectedExtent = "isolated" | "moderate" | "widespread";

export interface CapturedImage {
  id: string;
  viewLabel: string | null;
  source: "video" | "manual";
  width: number;
  height: number;
  path: string;
  capturedAt: string;
}

export interface EvidenceMark {
  kind: "box" | "line";
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
}

export interface DamageEvidence {
  imageId: string;
  mark: EvidenceMark;
  cropPath?: string;
}

export interface Damage {
  id: string;
  type: DamageType;
  part: string;
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
  confidence: number;
  verification: VerificationState;
  verificationReason: string;
  evidence: DamageEvidence[];
  recaptureRequested: boolean;
  sellerAction: "confirmed" | "rejected" | "corrected" | null;
  sellerAdded: boolean;
}

export interface OverallCondition {
  overallWearLevel: WearLevel;
  affectedExtent: AffectedExtent;
  functionalityAffected: boolean;
  structuralIntegrityOk: boolean;
  clearlyUsedAppearance: boolean;
  observations: string[];
}

export interface GradeExplanation {
  grade: ConditionGrade;
  canonicalCondition: CanonicalCondition;
  label: string;
  rationale: string;
  reasons: string[];
}

/** What the seller typed before filming — the price engine searches the corpus on this. */
export interface FurnitureIdentity {
  brand: string | null;
  model: string;
}

/** One damage as the price engine valued it — its category, not ours, and what it cost. */
export interface PriceDamageLine {
  category: string | null;
  grade: number | null;
  /** share of the undamaged base price, 0-1 */
  deduction: number;
  /** "table" | "estimated_repair" | "below_materiality" | "no_valuation" */
  source: string | null;
  description: string | null;
  location: string | null;
  count?: number;
}

export interface PriceEstimate {
  status: "ok" | "no_data" | "unavailable";
  low: number | null;
  default: number | null;
  high: number | null;
  currency: "SEK";
  confidence: string | null;
  note: string | null;
  matchCount: number;
  variant: string[] | null;
  variantMethod: string | null;
  damageDeduction: number | null;
  damageLines: PriceDamageLine[];
  unavailableReason: string | null;
  requestedAt: string;
  latencyMs: number;
}

/** En egenskap generatorn hittat och kunnat belägga — mått, material, färg, årsmodell. */
export interface ListingAttribute {
  key: string;
  label: string;
  value: string;
  sourceUrl?: string | null;
}

export interface ListingSource {
  title: string;
  url: string;
  qualityTier?: 1 | 2 | 3;
}

/**
 * Annonsgeneratorns svar, som det kommer ur loopa-landing-page-main. Bara de fält truth-cardet visar
 * är typade här — resten följer med orört i `raw` för den som vill gräva.
 */
export interface GeneratedListing {
  identity: {
    brand: string | null;
    exactProduct: string | null;
    variant: string | null;
    category: string | null;
    confidence: "high" | "medium" | "low";
    uncertain: boolean;
    uncertaintyNote: string | null;
  };
  attributes: ListingAttribute[];
  pricing: {
    retailPriceSek: number | null;
    suggestedPriceSek: number | null;
    priceRangeMinSek: number | null;
    priceRangeMaxSek: number | null;
    rationale: string | null;
  };
  listing: { title: string; description: string; conditionText: string };
  sources: ListingSource[];
  /** "full" | "partial" | "fallback" — hur mycket generatorn kunde belägga. */
  status?: string;
  missingFields?: string[];
  missingNotes?: string[];
}

/** Truth-cardets halva av rapporten. Alltid satt när ett märke fanns, även när den inte gick att nå. */
export interface ListingResult {
  /** "pending" medan generatorn fortfarande kör — den startar samtidigt som besiktningen. */
  status: "pending" | "ok" | "unavailable";
  unavailableReason: string | null;
  result: GeneratedListing | null;
  latencyMs: number;
}

/** En modellkandidat ur identifieringen. Samma form som landningssidans SellerProductCandidate. */
export interface ModelCandidate {
  brand: string;
  model: string;
  variant: string | null;
  productType: string | null;
  confidence: "strong" | "likely" | "possible";
  /** Kort text som skiljer kandidaterna åt, t.ex. "hög rygg, teakstomme". */
  distinguishingDetail: string | null;
}

/**
 * Var identifieringen står.
 *
 * `needs_selection` är inte ett fel utan hela poängen: tvetydighet mellan VERKLIGA produkter lämnas
 * till säljaren i stället för att slås ut med fler modellanrop. Bryggan behandlade det tidigare som
 * ett misslyckande, så just det fall kandidatflödet finns för visade "Annonsen kunde inte skapas".
 */
export type IdentityStatus = "identifying" | "needs_selection" | "resolved" | "unavailable";

export interface ConditionResult {
  jobId: string;
  createdAt: string;
  identity: FurnitureIdentity | null;
  price: PriceEstimate | null;
  /**
   * true medan andrabesiktningen fortfarande kör. Resultatet är giltigt och visas — fynden står som
   * de rapporterades — men listan kan ännu ändras när granskningen landar.
   */
  reviewPending: boolean;
  /**
   * Om andrabesiktningen faktiskt kördes. Kortet är ett attest och ska kunna säga vad det bygger på —
   * en (1) besiktning eller två — i stället för att låta läsaren anta det starkare alternativet.
   */
  reviewed: boolean;
  /** modell, specifikationer och annonstext — null bara när inget märke angavs */
  listing: ListingResult | null;
  coverage: CoverageState;
  coverageNote: string | null;
  grade: GradeExplanation | null;
  damages: Damage[];
  overallCondition: OverallCondition | null;
  images: CapturedImage[];
  modelUsed: string;
  tokensUsed: number;
  costUsd: number;
  geminiCallCount: number;
  latencyMs: number;
}

export type AnalysisStage = "queued" | "preparing" | "inspecting" | "verifying" | "grading" | "pricing" | "done" | "error";

export interface JobProgress {
  stage: AnalysisStage;
  message: string;
}

/**
 * Var publiceringen till Tradera står. Saknas fältet har jobbet aldrig publicerats — det är inte
 * samma sak som ett misslyckat försök, och knappen ska se olika ut i de två fallen.
 */
export interface TraderaPublication {
  status: "publishing" | "published" | "error";
  requestId: number | null;
  itemId: number | null;
  url: string | null;
  error: string | null;
  startedAt: string;
  publishedAt: string | null;
}

/** Vad som KOMMER att publiceras. Visas i bekräftelsesteget så säljaren ser det innan de trycker. */
export interface TraderaPlan {
  title: string;
  categoryId: number;
  categoryName: string;
  price: number;
  priceSource: "condition" | "listing";
  condition: string | null;
  imageCount: number;
  /** "fixed" = Endast Köp Nu till `price`. "auction" = utropspris `price`, inget Köp Nu. */
  mode: "auction" | "fixed";
  /** Bara satt för auktion — Traderas Köp Nu-annonser får sin längd av Tradera, inte av oss. */
  durationDays: number | null;
}

/** Svaret från GET/POST /api/jobs/:id/tradera. */
export interface TraderaState {
  configured: boolean;
  missingEnv: string[];
  publication: TraderaPublication | null;
  plan: TraderaPlan | null;
  blockedReason: string | null;
}

export interface ConditionJob {
  id: string;
  createdAt: string;
  progress: JobProgress;
  result: ConditionResult | null;
  error: string | null;
  productContext: string | null;
  identity: FurnitureIdentity | null;
  /** bildrutorna jobbet skapades med — det ett omtag spelar upp igen */
  images?: CapturedImage[];
  /** Var modellidentifieringen står. Driver kandidatskärmen. */
  identityStatus?: IdentityStatus;
  /** Upp till fyra troliga modeller av märket, bäst först. */
  candidates?: ModelCandidate[];
  /** Den säljaren valde, eller den identifieringen kunde avgöra själv. */
  selected?: ModelCandidate | null;
  identityError?: string | null;
  /** När nuvarande fas började — för fasloggningen. */
  phaseStartedAt?: number;
  /** Annonsen när den blev klar före skickresultatet — flyttas in i resultatet när det finns. */
  pendingListing?: ListingResult | null;
  /** Annonsen på Tradera, när säljaren valt att publicera den dit. */
  tradera?: TraderaPublication | null;
}

export interface JobSummary {
  id: string;
  createdAt: string;
  progress: JobProgress;
  grade: GradeExplanation | null;
  identity: FurnitureIdentity | null;
  price: PriceEstimate | null;
  thumbnailImageId: string | null;
  error: string | null;
}

// ---- debug trace (GET /api/jobs/:id/debug) ----

export interface CallMeta {
  purpose: string;
  tokensUsed: number;
  cached: boolean;
  modelUsed: string;
  latencyMs: number;
}

export interface PartInspection {
  part: string;
  visible: boolean;
  defectsFound: number;
}

export interface DebugTrace {
  jobId: string;
  defectFamiliesChecked: DamageType[];
  rawDefects: Damage[];
  partsInspected?: PartInspection[];
  /** Post-verification, pre-dedup — what dedupeDamages actually received. */
  verifiedDefects: Damage[];
  verifiedIds: string[];
  rejectedByVerification: Damage[];
  confirmedFindings: Damage[];
  dedupBefore: number;
  dedupAfter: number;
  overallCondition: OverallCondition | null;
  gradeTrace: string[];
  geminiCalls: CallMeta[];
  totalLatencyMs: number;
}
