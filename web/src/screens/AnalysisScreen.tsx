import { useEffect, useState } from "react";
import { getJob, retryJob } from "../api";
import { explainError } from "../lib/errors";
import type { CapturedShot } from "../api";
import type { AnalysisStage, ConditionJob, FurnitureIdentity } from "../types";

const CHECKLIST: { stage: AnalysisStage; label: string }[] = [
  { stage: "preparing", label: "Bilder förberedda" },
  { stage: "inspecting", label: "Inspekterar möbeln" },
  { stage: "verifying", label: "Kontrollerar osäkra fynd" },
  { stage: "grading", label: "Sammanställer skicket" },
  { stage: "pricing", label: "Hämtar prisförslag" },
];

// A stage is "reached" once we're at it or past it in this fixed order.
const STAGE_ORDER: AnalysisStage[] = ["queued", "preparing", "inspecting", "verifying", "grading", "pricing", "done"];

export default function AnalysisScreen({
  jobId,
  previewShots,
  identity,
  onDone,
  onAbort,
}: {
  jobId: string;
  previewShots: CapturedShot[];
  identity: FurnitureIdentity | null;
  onDone: () => void;
  onAbort: () => void;
}) {
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  /** Bumpas av ett omtag: pollningen stannar vid "error", så den måste startas om explicit. */
  const [attempt, setAttempt] = useState(0);

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
  }, [jobId, attempt]);

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryJob(jobId);
      setJob(null);
      setAttempt((n) => n + 1);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Kunde inte starta om analysen.");
    } finally {
      setRetrying(false);
    }
  }

  const stage = job?.progress.stage ?? "preparing";
  const stageRank = STAGE_ORDER.indexOf(stage);
  // The "verifying" step only ever gets an ● once the backend actually enters it — otherwise it's
  // skipped visually rather than shown as a fake pending step, since most inspections never need it.
  const everSawVerifying = stage === "verifying" || stageRank > STAGE_ORDER.indexOf("verifying");

  if (job?.progress.stage === "error") {
    const explained = explainError(job.error);
    return (
      <div className="screen screen-dark center-column">
        <div className="failure-card">
          <span className="failure-mark" aria-hidden="true">
            !
          </span>
          <h2 className="failure-title">{explained.title}</h2>
          <p className="failure-body">{explained.body}</p>
          {explained.retryable && (
            <button className="btn btn-primary" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Startar om…" : "Försök igen"}
            </button>
          )}
          <button className="btn btn-text failure-secondary" onClick={onAbort}>
            Tillbaka till start
          </button>
          {retryError && <p className="error-text">{retryError}</p>}
          <details className="failure-details">
            <summary>Tekniska detaljer</summary>
            <code>{job.error}</code>
          </details>
        </div>
      </div>
    );
  }

  const heroShot = previewShots[0];

  return (
    <div className="screen screen-dark center-column">
      <div className="analysis-card">
        {identity && (
          <div className="analysis-identity">{[identity.brand, identity.model].filter(Boolean).join(" ")}</div>
        )}
        {heroShot && (
          <div className="analysis-image-wrap">
            <img src={heroShot.dataUrl} alt="" />
          </div>
        )}
        <ul className="checklist">
          {CHECKLIST.filter(
            (c) => (c.stage !== "verifying" || everSawVerifying) && (c.stage !== "pricing" || !!identity),
          ).map((c) => {
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
