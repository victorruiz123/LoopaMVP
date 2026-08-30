import { useEffect, useState } from "react";
import { imageUrl, listJobs } from "../api";
import { useAuth } from "../auth/AuthProvider";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon, CardIcon, ChevronRight, UsersIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { JobSummary } from "../types";
import { usePageTitle } from "../lib/pageTitle";
import LegalLink from "../components/LegalLink";
import LanguagePicker from "../components/LanguagePicker";
import { reopenConsent } from "../lib/consent";
import { useLang, useT } from "../lib/i18n";

/**
 * Profilen: varje annons säljaren har skapat, samlat på ett ställe.
 *
 * Listan kommer från GET /api/jobs, som bara svarar med jobb som hör till den inloggade — kortet
 * knyts till kontot i samma ögonblick som filmningen laddas upp, inte efteråt.
 *
 * Den som lagt ut en möbel till salu har en fråga profilen ska besvara utan att man öppnar ett enda
 * kort: vad ligger ute just nu? Därför är listan delad i två — "Till salu" över "Sparade annonser".
 */
export default function ProfileScreen({
  onBack,
  onOpenJob,
  isAdmin = false,
  onOpenAdmin,
}: {
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
  /** Serverns besked ur inloggningen. Ingången ritas bara då — och prövas igen bakom varje adminväg. */
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const { user, profile, signOut } = useAuth();
  usePageTitle("Din profil");
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const cards = (jobs ?? []).filter((j) => j.hasListing);
  const valued = cards.filter((j) => j.price?.status === "ok" && j.price.default !== null);
  const totalValue = valued.reduce((sum, j) => sum + (j.price?.default ?? 0), 0);

  /**
   * Två listor, inte en.
   *
   * En annons som ligger ute hos köparna är inte samma sak som en sparad: den arbetar, den kan bli
   * såld i natt, och den är det säljaren öppnar profilen för att titta till. Därför står de först,
   * under egen rubrik. Ett misslyckat försök hör inte hit — den möbeln är fortfarande bara sparad,
   * och raden säger varför i stället för att låtsas att den är ute.
   */
  const selling = cards.filter((j) => j.sale?.status === "published" || j.sale?.status === "publishing");
  const saved = cards.filter((j) => !selling.includes(j));

  const displayName = profile?.full_name || profile?.username || user?.email?.split("@")[0] || t("Säljare");

  return (
    <div className="screen screen-light profile">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Tillbaka")}
      </button>

      <section className="profile-head">
        <div className="profile-avatar" aria-hidden>
          {initials(displayName)}
        </div>
        <div className="profile-identity">
          <h1 className="profile-name">{displayName}</h1>
          <p className="profile-email">{user?.email}</p>
        </div>
        {/* Språket byts här, bredvid namnet: det är en inställning för kontot, inte för en skärm. */}
        <LanguagePicker />
      </section>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{cards.length}</div>
          <div className="profile-stat-label">{t("Annonser")}</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{valued.length ? formatSek(totalValue) : "—"}</div>
          <div className="profile-stat-label">{t("Samlat värde")}</div>
        </div>
      </section>

      {jobs === null || cards.length === 0 ? (
        <>
          <h2 className="profile-section-title">{t("Sparade annonser")}</h2>
          {jobs === null ? (
            <div className="profile-loading">
              <div className="spinner" />
            </div>
          ) : (
            <div className="profile-empty">
              <span className="profile-empty-mark">
                <CardIcon size={22} />
              </span>
              <p className="profile-empty-title">{t("Inga annonser än")}</p>
              <p className="profile-empty-hint">
                {t("Varje möbel du säljer med Loopa hamnar här — med skick, pris och annons.")}
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          {selling.length > 0 && (
            <>
              <h2 className="profile-section-title">{t("Till salu")}</h2>
              <CardList jobs={selling} onOpenJob={onOpenJob} lang={lang} />
            </>
          )}
          {saved.length > 0 && (
            <>
              <h2 className="profile-section-title">{t("Sparade annonser")}</h2>
              <CardList jobs={saved} onOpenJob={onOpenJob} lang={lang} />
            </>
          )}
        </>
      )}

      {isAdmin && onOpenAdmin && (
        <button className="btn profile-admin-link" onClick={onOpenAdmin}>
          <UsersIcon /> {t("Adminpanel")}
        </button>
      )}

      <button className="btn btn-text profile-signout" onClick={() => void signOut()}>
        {t("Logga ut")}
      </button>

      {/* Samtycket måste gå att ta tillbaka lika lätt som det gavs, och profilen är stället man
          letar på. Knappen glömmer valet, vilket får cookierutan att komma tillbaka — se
          lib/consent.ts. */}
      <footer className="legal-footer">
        <LegalLink doc="privacy" />
        <LegalLink doc="cookies" />
        <LegalLink doc="terms" />
        <button className="legal-link legal-link-button" onClick={reopenConsent}>
          {t("Cookieinställningar")}
        </button>
      </footer>
    </div>
  );
}

/**
 * Vad de tre lägena heter för säljaren.
 *
 * Marknadsplatsen nämns inte: det är Loopa som säljer möbeln, och var annonsen råkar ligga är hur vi
 * gör det. Ett misslyckat försök står kvar som text i stället för att försvinna — annars ser kortet
 * ut som vilken sparad annons som helst, och säljaren väntar på ett besked som aldrig kommer.
 */
const SALE_LABEL = {
  publishing: "Läggs ut…",
  published: "Till salu",
  error: "Kunde inte läggas ut",
} as const;

/** Listraden, delad av båda avdelningarna — samma miniatyr, samma betyg, samma väg in i kortet. */
function CardList({
  jobs,
  onOpenJob,
  lang,
}: {
  jobs: JobSummary[];
  onOpenJob: (jobId: string) => void;
  /** Datumen skrivs på skärmens språk: "3 sep", "3 Sep", "3 sept.". */
  lang: string;
}) {
  const t = useT();
  return (
    <ul className="card-list">
      {jobs.map((j) => (
        <li key={j.id}>
          <button className="card-row" onClick={() => onOpenJob(j.id)}>
            <img
              className="card-row-thumb"
              src={j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined)}
              alt=""
            />
            <span className="card-row-body">
              <span className="card-row-title">{describe(j, t)}</span>
              <span className="card-row-meta">
                {formatDate(j.createdAt, lang)}
                {j.price?.status === "ok" ? ` · ${formatSek(j.price.default)}` : ""}
              </span>
              {j.sale && (
                <span className={`card-row-sale card-row-sale-${j.sale.status}`}>{t(SALE_LABEL[j.sale.status])}</span>
              )}
            </span>
            {j.grade && <GradeBadge grade={j.grade.grade} size={32} />}
            <span className="card-row-chevron">
              <ChevronRight size={16} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function describe(job: JobSummary, t: (sv: string) => string): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return job.listingTitle || name || t("Möbel");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(iso: string, lang: string): string {
  return new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });
}
