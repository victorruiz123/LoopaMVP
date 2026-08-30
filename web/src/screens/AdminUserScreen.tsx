import { useEffect, useState } from "react";
import { imageUrl, listUserJobs } from "../api";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight } from "../components/icons";
import { formatSek } from "../lib/price";
import { displayName, formatDate, initials } from "./AdminScreen";
import type { AdminUser, JobSummary } from "../types";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * En användares annonser, sedda av en admin.
 *
 * Samma rader som säljaren själv ser i sin profil, ur samma uträkning på servern — panelen ska visa
 * kortet som det ÄR, inte en andra tolkning av det. Läsning och ingenting annat: adminvägarna svarar
 * bara på GET, så det finns ingen knapp här som kan ändra i någon annans besiktning.
 */
export default function AdminUserScreen({
  user,
  onBack,
  onOpenJob,
}: {
  user: AdminUser;
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const t = useT();
  usePageTitle(displayName(user));

  useEffect(() => {
    listUserJobs(user.id)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [user.id]);

  const cards = (jobs ?? []).filter((j) => j.hasListing);
  const rest = (jobs ?? []).filter((j) => !j.hasListing);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);
  const name = displayName(user);

  return (
    <div className="screen screen-light profile admin">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Alla användare")}
      </button>

      <section className="profile-head">
        <div className="profile-avatar" aria-hidden>
          {user.avatarUrl ? <img className="admin-avatar-img" src={user.avatarUrl} alt="" /> : initials(name)}
        </div>
        <div className="profile-identity">
          <h1 className="profile-name">{name}</h1>
          <p className="profile-email">{user.email ?? user.id}</p>
        </div>
      </section>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{jobs === null ? "—" : cards.length}</div>
          <div className="profile-stat-label">{t("Annonser")}</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{valued.length ? formatSek(totalValue) : "—"}</div>
          <div className="profile-stat-label">{t("Samlat värde")}</div>
        </div>
      </section>

      <h2 className="profile-section-title">{t("Annonser")}</h2>

      {jobs === null ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : cards.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <CardIcon size={22} />
          </span>
          <p className="profile-empty-title">{t("Inga annonser")}</p>
          <p className="profile-empty-hint">
            {t("Kontot har inte fått någon besiktning hela vägen till en annons.")}
          </p>
        </div>
      ) : (
        <ul className="card-list">
          {cards.map((j) => (
            <li key={j.id}>
              <button className="card-row" onClick={() => onOpenJob(j.id)}>
                <img
                  className="card-row-thumb"
                  src={j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined)}
                  alt=""
                />
                <span className="card-row-body">
                  <span className="card-row-title">{describe(j)}</span>
                  <span className="card-row-meta">
                    {j.loopaId} · {formatDate(j.createdAt)}
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

      {/* Jobb som aldrig blev kort står med, men som text och utan väg vidare: det finns inget kort
          att öppna, och varför det saknas är det enda intressanta med raden. */}
      {rest.length > 0 && (
        <>
          <h2 className="profile-section-title">{t("Utan annons")}</h2>
          <ul className="admin-stub-list">
            {rest.map((j) => (
              <li key={j.id} className="admin-stub">
                <span className="admin-stub-title">{describe(j)}</span>
                <span className="admin-stub-meta">
                  {formatDate(j.createdAt)} · {j.error ?? j.progress.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function describe(job: JobSummary): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return job.listingTitle || name || "Möbel";
}
