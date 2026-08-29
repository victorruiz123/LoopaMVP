import { useEffect, useState } from "react";
import { imageUrl, listJobs } from "../api";
import type { FurnitureIdentity, JobSummary } from "../types";
import GradeBadge from "../components/GradeBadge";
import BrandSheet from "../components/BrandSheet";
import BrandAvatar from "../components/BrandAvatar";
import { ChevronRight, UserIcon } from "../components/icons";
import { useAuth } from "../auth/AuthProvider";
import { formatPriceRange } from "../lib/price";

export default function HomeScreen({
  onStartScan,
  onOpenJob,
  onOpenProfile,
}: {
  onStartScan: (identity: FurnitureIdentity) => void;
  onOpenJob: (jobId: string) => void;
  onOpenProfile: () => void;
}) {
  const { profile, user } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [brand, setBrand] = useState("");
  // Collapsed by default: the saved list used to render ABOVE the scan card, so once a few furniture
  // pieces had piled up the primary action was several screens down. History is something you look up
  // occasionally; starting a scan is why you opened the page.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const finished = jobs?.filter((j) => j.progress.stage === "done") ?? [];
  // The model name is what the price engine searches the ad corpus on; without it there is nothing to
  // price. The brand narrows that search but is not required — not every piece carries one.
  // Bara märket krävs. Modellen letar systemet upp ur bilderna och säljaren bekräftar den efteråt —
  // ett fält färre att fylla i, och identifieringen sker på bilderna i stället för på minnet.
  const canStart = brand.trim().length > 0;

  function start() {
    if (!canStart) return;
    onStartScan({ brand: brand.trim(), model: "" });
  }

  return (
    <div className="screen screen-light home">
      {/* Loopa-ordmärket i vänsterkant, profilen i höger — samma placering som i Vips egna app,
          så samma gest hittar rätt på båda hållen. */}
      <div className="app-bar">
        <span className="app-wordmark">Loopa</span>
        <button className="app-bar-profile" onClick={onOpenProfile} aria-label="Din profil">
          <UserIcon size={17} />
          <span className="app-bar-profile-name">{shortName(profile?.full_name ?? profile?.username, user?.email)}</span>
        </button>
      </div>

      <header className="home-header">
        <span className="brand-pill">
          <span className="brand-dot" /> SKICK &amp; PRIS
        </span>
        <h1 className="home-title">
          Vilken möbel
          <br />
          <span className="accent">säljer du?</span>
        </h1>
        <p className="home-lede">
          Välj märke och filma ett varv runt möbeln. Du får modellen, specifikationerna, priset och
          skicket.
        </p>
      </header>

      {/* Grupperad lista i stället för två inramade fält. Två rader som delar en yta och skiljs av
          ett hårstreck läser som ETT formulär; två boxar med var sin kant läser som två beslut. */}
      <div className="form-group">
        <button
          type="button"
          className="form-row form-row-tappable"
          onClick={() => setSheetOpen(true)}
        >
          <span className="form-row-label">Märke</span>
          <span className="form-row-value">
            {brand ? (
              <>
                <BrandAvatar name={brand} size={26} />
                <span className="form-row-text">{brand}</span>
              </>
            ) : (
              <span className="form-row-placeholder">Välj märke</span>
            )}
          </span>
          <span className="form-row-chevron">
            <ChevronRight size={17} />
          </span>
        </button>

      </div>

      <div className="home-cta">
        <button className="btn btn-primary" disabled={!canStart} onClick={start}>
          Fortsätt till filmning
        </button>
        <p className="form-hint">
          {canStart
            ? "Du får upp till fyra modellförslag när bilderna är inne."
            : "Märket behövs för att hitta modellen."}
        </p>
      </div>

      <BrandSheet
        open={sheetOpen}
        selected={brand || null}
        onSelect={(picked) => {
          setBrand(picked);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />

      {finished.length > 0 && (
        <section className="collapsible-card">
          <button className="collapsible-header" onClick={() => setHistoryOpen((v) => !v)}>
            <span className="collapsible-title">Sparade truth-cards</span>
            <span className="collapsible-meta">
              {finished.length} st
              <span className={`collapsible-chevron ${historyOpen ? "collapsible-chevron-open" : ""}`}>
                <ChevronRight size={16} />
              </span>
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
                    <div className="saved-item-title">{describe(j)}</div>
                    <div className="muted small">
                      Betyg {j.grade?.grade ?? "?"}
                      {j.price?.status === "ok" ? ` · ${formatPriceRange(j.price)}` : ""}
                    </div>
                  </div>
                  {j.grade && <GradeBadge grade={j.grade.grade} size={34} />}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Förnamnet räcker i topplisten; hela adressen gör knappen bredare än rubriken under den. */
function shortName(name: string | null | undefined, email: string | null | undefined): string {
  const source = name || email?.split("@")[0] || "Profil";
  return source.split(/\s+/)[0];
}

function describe(job: JobSummary): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return name || "Möbel";
}
