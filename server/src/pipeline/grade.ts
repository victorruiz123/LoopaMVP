import type {
  CanonicalCondition,
  ConditionGrade,
  Damage,
  GradeExplanation,
  OverallCondition,
  Severity,
  WearLevel,
} from "../types.js";

const SEVERITY_RANK: Record<Severity, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };
const GRADE_RANK: Record<ConditionGrade, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
const RANK_TO_GRADE: ConditionGrade[] = ["A", "B", "C", "D", "E", "F"];

/**
 * Deterministic A-F rubric thresholds — tunable without touching the grading logic itself.
 *
 * The final grade is the WORSE of two independently-derived grades: gradeFromDefects (CONFIRMED local
 * damages only) and gradeFromOverallCondition (Gemini's holistic wear/functionality/structure read from
 * the SAME inspection call). Neither can improve on the other, per Loopa's rubric: "A/B must not be used
 * for furniture that visually appears clearly used across multiple surfaces."
 */
export const RUBRIC = {
  fMinSeverity: "S4" as Severity,
  eMinSeverity: "S4" as Severity,
  dMinSeverity: "S3" as Severity,
  dMultiCountThreshold: 3,
  cMinSeverity: "S2" as Severity,
  cMultiCountThreshold: 3,
  wearToGrade: {
    minimal: "A" as ConditionGrade,
    light: "B" as ConditionGrade,
    moderate: "C" as ConditionGrade,
    heavy: "D" as ConditionGrade,
    severe: "E" as ConditionGrade,
  } satisfies Record<WearLevel, ConditionGrade>,
};

const GRADE_LABELS: Record<ConditionGrade, string> = {
  A: "Nyskick",
  B: "Mycket gott skick",
  C: "Gott begagnat skick",
  D: "Slitet skick",
  E: "Dåligt skick",
  F: "Ej brukbart",
};

/** Vips' public listing only exposes 4 canonical strings — E/F items still need one, so they floor at the worst public tier. */
const CANONICAL_MAP: Record<ConditionGrade, CanonicalCondition> = {
  A: "Nyskick",
  B: "Mycket bra skick",
  C: "Bra skick",
  D: "Okej skick",
  E: "Okej skick",
  F: "Okej skick",
};

export function gradeCondition(allDamages: Damage[], overallCondition: OverallCondition | null): GradeExplanation {
  const confirmed = allDamages.filter((d) => effectiveVerification(d) === "CONFIRMED");
  const defectResult = gradeFromDefects(confirmed);
  const wearResult = overallCondition ? gradeFromOverallCondition(overallCondition) : { grade: "A" as ConditionGrade, reasons: [] };

  const finalRank = Math.max(GRADE_RANK[defectResult.grade], GRADE_RANK[wearResult.grade]);
  const finalGrade = RANK_TO_GRADE[finalRank];
  const wearDominates = GRADE_RANK[wearResult.grade] > GRADE_RANK[defectResult.grade];

  return {
    grade: finalGrade,
    canonicalCondition: CANONICAL_MAP[finalGrade],
    label: GRADE_LABELS[finalGrade],
    rationale: buildRationale(finalGrade, confirmed, overallCondition, wearDominates),
    reasons: [...defectResult.reasons, ...wearResult.reasons],
  };
}

function gradeFromDefects(confirmed: Damage[]): { grade: ConditionGrade; reasons: string[] } {
  if (confirmed.length === 0) {
    return { grade: "A", reasons: ["Inga bekräftade lokala skador hittades."] };
  }

  const maxRank = Math.max(...confirmed.map((d) => SEVERITY_RANK[d.severity]));
  const hasStructural = confirmed.some((d) => d.impact === "structural");
  const hasFunctional = confirmed.some((d) => d.impact === "functional");
  const s2PlusCount = confirmed.filter((d) => SEVERITY_RANK[d.severity] >= SEVERITY_RANK.S2).length;
  const s1Count = confirmed.filter((d) => d.severity === "S1").length;
  const reasons: string[] = [];

  if (maxRank >= SEVERITY_RANK[RUBRIC.fMinSeverity] && (hasStructural || hasFunctional)) {
    reasons.push(describeWorst(confirmed), "Skadan påverkar funktion eller struktur allvarligt.");
    return { grade: "F", reasons };
  }
  if (maxRank >= SEVERITY_RANK[RUBRIC.eMinSeverity] || hasStructural) {
    reasons.push(describeWorst(confirmed));
    if (hasStructural) reasons.push("Minst en skada bedöms påverka möbelns struktur.");
    return { grade: "E", reasons };
  }
  if (maxRank >= SEVERITY_RANK[RUBRIC.dMinSeverity] || s2PlusCount >= RUBRIC.dMultiCountThreshold) {
    reasons.push(describeWorst(confirmed));
    if (s2PlusCount >= RUBRIC.dMultiCountThreshold) reasons.push(`${s2PlusCount} skador av måttlig grad eller värre.`);
    if (hasFunctional) reasons.push("Minst en skada kan påverka användningen.");
    return { grade: "D", reasons };
  }
  if (maxRank >= SEVERITY_RANK[RUBRIC.cMinSeverity] || s1Count >= RUBRIC.cMultiCountThreshold) {
    reasons.push(describeWorst(confirmed));
    if (s1Count >= RUBRIC.cMultiCountThreshold) reasons.push(`${s1Count} mindre skador hittades sammanlagt.`);
    return { grade: "C", reasons };
  }
  reasons.push(`${confirmed.length} mindre kosmetisk skada${confirmed.length > 1 ? "r" : ""} hittades.`);
  return { grade: "B", reasons };
}

function gradeFromOverallCondition(oc: OverallCondition): { grade: ConditionGrade; reasons: string[] } {
  let grade = RUBRIC.wearToGrade[oc.overallWearLevel];
  const reasons: string[] = [`Helhetsintryck: ${oc.overallWearLevel} slitage, ${oc.affectedExtent === "widespread" ? "utbrett" : oc.affectedExtent === "moderate" ? "måttligt utbrett" : "isolerat"}.`];

  if (oc.functionalityAffected && GRADE_RANK[grade] < GRADE_RANK.D) {
    grade = "D";
    reasons.push("Funktionen bedöms vara påverkad.");
  }
  if (!oc.structuralIntegrityOk && GRADE_RANK[grade] < GRADE_RANK.E) {
    grade = "E";
    reasons.push("Strukturell integritet bedöms vara påverkad.");
  }
  return { grade, reasons };
}

function effectiveVerification(d: Damage): "CONFIRMED" | "REJECTED" | "UNCERTAIN" {
  if (d.sellerAction === "rejected") return "REJECTED";
  if (d.sellerAction === "confirmed" || d.sellerAction === "corrected") return "CONFIRMED";
  return d.verification;
}

function describeWorst(confirmed: Damage[]): string {
  const worst = [...confirmed].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
  return `Allvarligaste bekräftade fyndet: ${worst.type} på ${worst.part} (${worst.severity}).`;
}

const TYPE_LABELS_SV: Partial<Record<Damage["type"], string>> = {
  scratch: "repor", scuff: "skrapmärken", stain: "fläckar", discoloration: "missfärgningar",
  crack: "sprickor", dent: "bucklor", worn_material: "slitage", general_wear: "slitage",
};

/** ONE short seller-facing sentence — the primary thing the report shows, not a bullet list. */
function buildRationale(grade: ConditionGrade, confirmed: Damage[], oc: OverallCondition | null, wearDominates: boolean): string {
  const n = confirmed.length;
  const impactClause = confirmed.some((d) => d.impact === "structural")
    ? " Möbeln bedöms ha strukturella skador."
    : confirmed.some((d) => d.impact === "functional")
      ? " Funktionen kan vara påverkad."
      : n > 0
        ? " Inga funktionella eller strukturella skador hittades."
        : "";

  if (n === 0 && (!oc || !wearDominates)) {
    return grade === "A" ? "Inga synliga tecken på användning hittades." : "Inga enskilda skador hittades, men möbeln bedöms ändå visa tecken på användning.";
  }

  if (n > 0) {
    const worstType = [...confirmed].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0].type;
    const label = TYPE_LABELS_SV[worstType] ?? "skador";
    const wearClause = wearDominates && oc ? ` Möbeln uppvisar även ${oc.affectedExtent === "widespread" ? "utbrett" : "märkbart"} allmänt slitage.` : "";
    return `Möbeln är tydligt använd med ${n} synlig${n === 1 ? "" : "a"} skad${n === 1 ? "a" : "or"}, bland annat ${label}.${wearClause}${impactClause}`;
  }

  // n === 0 but wear dominates
  return `Inga enskilda skador bekräftades, men möbeln uppvisar ${oc!.overallWearLevel === "severe" ? "mycket kraftigt" : "tydligt"} allmänt slitage.${impactClause}`;
}
