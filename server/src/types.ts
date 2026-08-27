// Condition Grading engine — public contract.
// Kept deliberately independent: no imports from Visual Discovery / Pricing / matcher code.

export type DamageType =
  // surface damage
  | "scratch"
  | "scuff"
  | "abrasion"
  | "chip"
  | "dent"
  | "crack"
  | "tear"
  | "hole"
  // color / contamination
  | "stain"
  | "discoloration"
  | "fading"
  | "rust"
  | "corrosion"
  // material wear
  | "pilling"
  | "worn_material"
  | "fraying"
  | "compressed_upholstery"
  | "peeling_flaking"
  // shape / structure
  | "deformation"
  | "loose_component"
  | "broken_component"
  | "missing_part"
  | "sagging"
  | "structural_damage"
  // catch-all for a locally visible but non-specific worn patch
  | "general_wear"
  | "other";

export type Severity = "S1" | "S2" | "S3" | "S4";
export type Impact = "cosmetic" | "functional" | "structural";
export type VerificationState = "CONFIRMED" | "REJECTED" | "UNCERTAIN";
export type CoverageState = "INSPECTED_CLEAR" | "INSPECTED_DAMAGE" | "NOT_SUFFICIENTLY_VISIBLE";
export type ConditionGrade = "A" | "B" | "C" | "D" | "E" | "F";

/** One image sent into the inspection: either a client-selected video frame or a manually captured/uploaded photo. */
export interface CapturedImage {
  id: string;
  /** client-assigned, for display only (e.g. "Framifrån", "Höger sida", "Närbild") — never used for grading logic */
  viewLabel: string | null;
  source: "video" | "manual";
  width: number;
  height: number;
  /** relative path under the job's data dir, e.g. "originals/img_0.jpg" */
  path: string;
  capturedAt: string;
}

/** A region of interest on one evidence image, normalized to [0,1] against that image's natural size. */
export interface EvidenceMark {
  kind: "box" | "line";
  /** box: x,y,w,h normalized 0-1. line: x1,y1,x2,y2 normalized 0-1 (box fields unused). */
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
  /** relative path to a high-res crop generated from the ORIGINAL image, if produced during verification */
  cropPath?: string;
}

/** One PHYSICAL defect — may carry multiple evidence entries if seen in more than one supplied image. */
export interface Damage {
  id: string;
  type: DamageType;
  part: string;
  /** finer-grained location within the part, used to tell two distinct defects on the same part apart */
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
  /** 0-100 */
  confidence: number;
  verification: VerificationState;
  verificationReason: string;
  evidence: DamageEvidence[];
  recaptureRequested: boolean;
  /** seller review state, mutated via correction endpoints; null = untouched */
  sellerAction: "confirmed" | "rejected" | "corrected" | null;
  /** true if this entry was added manually by the seller rather than detected */
  sellerAdded: boolean;
}

export type WearLevel = "minimal" | "light" | "moderate" | "heavy" | "severe";
export type AffectedExtent = "isolated" | "moderate" | "widespread";

/** Holistic, non-localized visible-condition read, produced by the SAME main inspection call. */
export interface OverallCondition {
  overallWearLevel: WearLevel;
  affectedExtent: AffectedExtent;
  functionalityAffected: boolean;
  structuralIntegrityOk: boolean;
  clearlyUsedAppearance: boolean;
  observations: string[];
}

/** One row of the inspection sweep: the model must account for every part, damaged or not. */
export interface PartInspection {
  part: string;
  visible: boolean;
  defectsFound: number;
}

export type AnalysisStage = "queued" | "preparing" | "inspecting" | "verifying" | "grading" | "pricing" | "done" | "error";

export interface JobProgress {
  stage: AnalysisStage;
  message: string;
}

/** Vips' canonical public-facing condition strings — must match CLAUDE.md exactly. */
export type CanonicalCondition = "Nyskick" | "Mycket bra skick" | "Bra skick" | "Okej skick";

export interface GradeExplanation {
  grade: ConditionGrade;
  canonicalCondition: CanonicalCondition;
  /** Loopa's own richer label, e.g. "Gott begagnat skick" — shown big in the seller report */
  label: string;
  /** ONE short, seller-facing sentence (max ~2) explaining the grade. This is what the UI shows. */
  rationale: string;
  /** longer bullet trace, debug-only, never shown in the seller report */
  reasons: string[];
}

/** What the seller typed before filming. The price engine needs a name to search the corpus for. */
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
  /** "table" | "estimated_repair" | "below_materiality" | "no_valuation" — how it was valued, or why it was not */
  source: string | null;
  description: string | null;
  location: string | null;
  count?: number;
}

/**
 * The price half of the report. Always present once an identity was given, even when there is no
 * number: `status` says which of the three cases this is, and the seller-facing text explains it.
 */
export interface PriceEstimate {
  /** ok = a range; no_data = engine ran but found nothing comparable; unavailable = engine not reached */
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
  /** total deduction actually applied for the findings, as a share of the undamaged base */
  damageDeduction: number | null;
  damageLines: PriceDamageLine[];
  unavailableReason: string | null;
  requestedAt: string;
  latencyMs: number;
}

export interface ConditionResult {
  jobId: string;
  createdAt: string;
  /** brand + model as the seller typed them; null when the scan was started without them */
  identity: FurnitureIdentity | null;
  /** null only when no identity was given — otherwise always set, possibly to a status that has no number */
  price: PriceEstimate | null;
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

export interface ConditionJob {
  id: string;
  createdAt: string;
  progress: JobProgress;
  result: ConditionResult | null;
  error: string | null;
  /** optional free-text product context (name/category) the caller may supply; grading must work without it */
  productContext: string | null;
  /** what the seller typed on the start screen — carried so a re-price after a correction has it */
  identity: FurnitureIdentity | null;
  /**
   * The curated frames, stored at CREATION time rather than only in the finished result.
   *
   * A run that dies upstream — Gemini 503/504 — used to take the walkaround with it: the files stayed
   * on disk but nothing recorded which they were, so the only way forward was to film again. They are
   * what a retry replays.
   */
  images?: CapturedImage[];
}

// ---- debug trace (never sent to the normal seller UI; see GET /api/jobs/:id/debug) ----

export interface CallMeta {
  purpose: string;
  tokensUsed: number;
  cached: boolean;
  modelUsed: string;
  latencyMs: number;
}

export interface DebugTrace {
  jobId: string;
  defectFamiliesChecked: DamageType[];
  rawDefects: Damage[];
  /** The model's own account of which parts it swept — a part missing here was never inspected. */
  partsInspected: PartInspection[];
  /** Post-verification, pre-dedup — exactly what dedupeDamages received. This is the freeze point a
   *  recorded test fixture replays from, so it has to be the full list, not just a count. */
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
