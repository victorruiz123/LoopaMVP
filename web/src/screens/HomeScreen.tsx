import { useEffect, useState } from "react";
import { imageUrl, listJobs } from "../api";
import type { JobSummary } from "../types";
import GradeBadge from "../components/GradeBadge";

export default function HomeScreen({
  onStartScan,
  onOpenJob,
}: {
  onStartScan: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  // Collapsed by default: the saved list used to render ABOVE the scan card, so once a few furniture
  // pieces had piled up the primary action was several screens down. History is something you look up
  // occasionally; starting a scan is why you opened the page.
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const finished = jobs?.filter((j) => j.progress.stage === "done") ?? [];

  return (
    <div className="screen screen-light">
      <header className="brand-header">
        <span className="brand-pill">
          <span className="brand-dot" /> CONDITION GRADING
        </span>
        <h1>
          Fotografera möbeln
          <br />
          <span className="accent">från alla håll</span>
        </h1>
      </header>

      <section className="scan-card">
        <button className="scan-icon-btn">📷</button>
        <h2>Redo att skanna?</h2>
        <p className="muted">Filma, fotografera eller ladda upp en färdig video.</p>
        <button className="btn btn-primary" onClick={onStartScan}>
          Starta skanning
        </button>
      </section>

      {finished.length > 0 && (
        <section className="collapsible-card">
          <button className="collapsible-header" onClick={() => setHistoryOpen((v) => !v)}>
            <span>🗂️ Sparade möbler</span>
            <span className="muted">
              {finished.length} st {historyOpen ? "⌄" : "›"}
            </span>
          </button>
          {historyOpen && (
            <div className="saved-list">
              {finished.map((j) => (
                <button key={j.id} className="saved-item" onClick={() => onOpenJob(j.id)}>
                  <img
                    className="saved-thumb"
                    src={j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined}
                    alt=""
                  />
                  <div className="saved-item-body">
                    <div>Möbel · {new Date(j.createdAt).toLocaleDateString("sv-SE")}</div>
                    <div className="muted">Analyserad · betyg {j.grade?.grade ?? "?"}</div>
                  </div>
                  {j.grade && <GradeBadge grade={j.grade.grade} size={36} />}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
