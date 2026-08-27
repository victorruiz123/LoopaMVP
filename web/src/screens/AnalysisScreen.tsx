import { useEffect, useState } from "react";
import { getJob } from "../api";
import type { CapturedShot } from "../api";
import type { AnalysisStage, ConditionJob } from "../types";

const CHECKLIST: { stage: AnalysisStage; label: string }[] = [
  { stage: "preparing", label: "Bilder förberedda" },
  { stage: "inspecting", label: "Inspekterar möbeln" },
  { stage: "verifying", label: "Kontrollerar osäkra fynd" },
  { stage: "grading", label: "Sammanställer skicket" },
];

// A stage is "reached" once we're at it or past it in this fixed order.
const STAGE_ORDER: AnalysisStage[] = ["queued", "preparing", "inspecting", "verifying", "grading", "done"];

export default function AnalysisScreen({
  jobId,
  previewShots,
  onDone,
}: {
  jobId: string;
  previewShots: CapturedShot[];
  onDone: () => void;
}) {
  const [job, setJob] = useState<ConditionJob | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        setJob(j);
        if (j.progress.stage === "done") {
          onDone();
          return;
        }
        if (j.progress.stage !== "error") {
          setTimeout(poll, 500);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 1000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const stage = job?.progress.stage ?? "preparing";
  const stageRank = STAGE_ORDER.indexOf(stage);
  // The "verifying" step only ever gets an ● once the backend actually enters it — otherwise it's
  // skipped visually rather than shown as a fake pending step, since most inspections never need it.
  const everSawVerifying = stage === "verifying" || stageRank > STAGE_ORDER.indexOf("verifying");

  if (job?.progress.stage === "error") {
    return (
      <div className="screen screen-dark center-column">
        <h2>Något gick fel</h2>
        <p className="error-text">{job.error}</p>
      </div>
    );
  }

  const heroShot = previewShots[0];

  return (
    <div className="screen screen-dark center-column">
      <div className="analysis-card">
        {heroShot && (
          <div className="analysis-image-wrap">
            <img src={heroShot.dataUrl} alt="" />
          </div>
        )}
        <ul className="checklist">
          {CHECKLIST.filter((c) => c.stage !== "verifying" || everSawVerifying).map((c) => {
            const rank = STAGE_ORDER.indexOf(c.stage);
            const state = rank < stageRank ? "done" : rank === stageRank ? "active" : "pending";
            return (
              <li key={c.stage} className={`checklist-item checklist-${state}`}>
                <span className="checklist-marker">{state === "done" ? "✓" : state === "active" ? "●" : "○"}</span>
                {c.label}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
