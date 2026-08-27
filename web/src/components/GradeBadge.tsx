import type { ConditionGrade } from "../types";

const GRADE_COLORS: Record<ConditionGrade, string> = {
  A: "#16a34a",
  B: "#22c55e",
  C: "#3b82f6",
  D: "#f97316",
  E: "#ef4444",
  F: "#b91c1c",
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
