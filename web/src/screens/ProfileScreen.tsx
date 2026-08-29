import { useEffect, useState } from "react";
import { imageUrl, listJobs } from "../api";
import { useAuth } from "../auth/AuthProvider";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight } from "../components/icons";
import { formatSek } from "../lib/price";
import type { JobSummary } from "../types";

/**
 * Profilen: varje truth-card säljaren har skapat, samlat på ett ställe.
 *
 * Listan kommer från GET /api/jobs, som bara svarar med jobb som hör till den inloggade — kortet
 * knyts till kontot i samma ögonblick som filmningen laddas upp, inte efteråt.
 */
export default function ProfileScreen({
  onBack,
  onOpenJob,
}: {
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const { user, profile, signOut } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const cards = (jobs ?? []).filter((j) => j.hasTruthCard);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);

  const displayName = profile?.full_name || profile?.username || user?.email?.split("@")[0] || "Säljare";

  return (
    <div className="screen screen-light profile">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> Tillbaka
      </button>

      <section className="profile-head">
        <div className="profile-avatar" aria-hidden>
          {initials(displayName)}
        </div>
        <div className="profile-identity">
          <h1 className="profile-name">{displayName}</h1>
          <p className="profile-email">{user?.email}</p>
        </div>
      </section>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{cards.length}</div>
          <div className="profile-stat-label">Truth-cards</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{valued.length ? formatSek(totalValue) : "—"}</div>
          <div className="profile-stat-label">Samlat värde</div>
        </div>
      </section>

      <h2 className="profile-section-title">Sparade truth-cards</h2>

      {jobs === null ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : cards.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <CardIcon size={22} />
          </span>
          <p className="profile-empty-title">Inga truth-cards än</p>
          <p className="profile-empty-hint">
            Varje möbel du filmar sparas här med skick, pris och färdig annons.
          </p>
        </div>
      ) : (
        <ul className="card-list">
          {cards.map((j) => (
            <li key={j.id}>
              <button className="card-row" onClick={() => onOpenJob(j.id)}>
                <img
                  className="card-row-thumb"
                  src={j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined}
                  alt=""
                />
                <span className="card-row-body">
                  <span className="card-row-title">{describe(j)}</span>
                  <span className="card-row-meta">
                    {formatDate(j.createdAt)}
                    {j.price?.status === "ok" ? ` · ${formatSek(j.price.default)}` : ""}
                  </span>
                </span>
                {j.grade && <GradeBadge grade={j.grade.grade} size={32} />}
                <span className="card-row-chevron">
                  <ChevronRight size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="btn btn-text profile-signout" onClick={() => void signOut()}>
        Logga ut
      </button>
    </div>
  );
}

function describe(job: JobSummary): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return job.listingTitle || name || "Möbel";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}
