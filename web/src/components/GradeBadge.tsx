import type { ConditionGrade } from "../types";

/**
 * En skala grönt -> ockra -> rött, i appens egen värme. Färgerna var tidigare hämtade rakt ur en
 * generisk Tailwind-palett, och C låg på en klarblå (#3b82f6) — mitt i en varm beige app blev betyget
 * det enda kalla på skärmen, och blått läser dessutom som information snarare än som ett omdöme på en
 * skala där grannarna är grönt och orange.
 */
const GRADE_COLORS: Record<ConditionGrade, string> = {
  A: "#2F7A50",
  B: "#62A15C",
  C: "#C9922E",
  D: "#E07B2C",
  E: "#C4442E",
  F: "#96271C",
};

export default function GradeBadge({ grade, size = 56 }: { grade: ConditionGrade; size?: number }) {
  return (
    <div
      className="grade-badge"
      style={{
        width: size,
        height: size,
        backgroundColor: GRADE_COLORS[grade],
        fontSize: size * 0.5,
      }}
    >
      {grade}
    </div>
  );
}
