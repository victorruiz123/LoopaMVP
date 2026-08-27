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
export type VerificationState = "CONFIRMED" | "REJECTED" | "UNCERTAIN";
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

export interface ConditionResult {
  jobId: string;
  createdAt: string;
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

export type AnalysisStage = "queued" | "preparing" | "inspecting" | "verifying" | "grading" | "done" | "error";

export interface JobProgress {
  stage: AnalysisStage;
  message: string;
}

export interface ConditionJob {
  id: string;
  createdAt: string;
  progress: JobProgress;
  result: ConditionResult | null;
  error: string | null;
  productContext: string | null;
}

export interface JobSummary {
  id: string;
  createdAt: string;
  progress: JobProgress;
  grade: GradeExplanation | null;
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
