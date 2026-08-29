import { useEffect, useMemo, useState } from "react";
import { imageUrl, listJobs } from "../api";
import type { FurnitureIdentity, JobSummary } from "../types";
import GradeBadge from "../components/GradeBadge";
import { CardSearchIcon, ChevronRight, SearchIcon, CloseIcon, UserIcon } from "../components/icons";
import { useAuth } from "../auth/AuthProvider";
import { formatPriceRange } from "../lib/price";
import { KNOWN_BRANDS } from "../lib/brands";
import { POPULAR_BRANDS } from "../lib/brandSeed";
import { brandTheme } from "../lib/brandTheme";
import { usePageTitle } from "../lib/pageTitle";

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const POPULAR_SET = new Set(POPULAR_BRANDS.map(fold));
/** Startlistans stavning vinner, resten av korpusen följer efter — samma union som sökarket hade. */
const ALL_BRANDS = [
  ...POPULAR_BRANDS,
  ...KNOWN_BRANDS.map((b) => b.name).filter((n) => !POPULAR_SET.has(fold(n))),
];

/**
 * Märket väljs direkt ur listan — inget ark, ingen bekräftelseknapp.
 *
 * Att välja märke ÄR att börja: det finns inget andra beslut på den här skärmen att vänta in, så en
 * "fortsätt"-knapp hade bara varit ett extra tryck för att bekräfta något som redan var sagt. Vägen
 * tillbaka finns på nästa skärm.
 */
export default function HomeScreen({
  onStartScan,
  onOpenJob,
  onOpenProfile,
  onOpenLookup,
}: {
  onStartScan: (identity: FurnitureIdentity) => void;
  onOpenJob: (jobId: string) => void;
  onOpenProfile: () => void;
  /** Slå upp ett publikt truth-card på dess Loopa-ID — ikonen i topplisten. */
  onOpenLookup: () => void;
}) {
  const { profile, user } = useAuth();
  usePageTitle(null);
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const finished = jobs?.filter((j) => j.progress.stage === "done") ?? [];

  const shown = useMemo(() => {
    const q = fold(query);
    if (!q) return ALL_BRANDS;
    const hits = ALL_BRANDS.filter((n) => fold(n).includes(q));
    hits.sort((a, b) => Number(!fold(a).startsWith(q)) - Number(!fold(b).startsWith(q)));
    return hits;
  }, [query]);

  const typed = query.trim();
  const exact = shown.some((n) => fold(n) === fold(typed));

  return (
    <div className="screen screen-light home">
      {/* Loopa-ordmärket i vänsterkant, uppslaget och profilen i höger. */}
      <div className="app-bar">
        <span className="app-wordmark">Loopa</span>
        <div className="app-bar-actions">
          {/* Loopa-ID:t ur en annons slås upp här. Varje truth-card är publikt, så knappen leder inte
              in i det egna kontot utan till vilket kort som helst. */}
          <button className="app-bar-icon" onClick={onOpenLookup} aria-label="Sök truth-card på Loopa-ID">
            <CardSearchIcon size={18} />
          </button>
          <button className="app-bar-profile" onClick={onOpenProfile} aria-label="Din profil">
            <UserIcon size={17} />
            <span className="app-bar-profile-name">{shortName(profile?.full_name ?? profile?.username, user?.email)}</span>
          </button>
        </div>
      </div>

      <header className="home-header">
        <span className="brand-pill">
          <span className="brand-dot" /> AI-GRANSKNING
        </span>
        <h1 className="home-title">
          Vilket märke
          <br />
          <span className="accent">är möbeln?</span>
        </h1>
        {/* Vänsterspalten i datorvyn har plats att säga vad appen gör innan man klickar.
            Telefonen har det inte — där är listan hela skärmen — så texten finns bara i
            datorläget, utelämnad och inte gömd. */}
        <p className="home-lede desktop-only">
          Filma ett varv runt möbeln. Du får skick, pris och en färdig annons.
        </p>
        <ol className="home-steps desktop-only">
          <li>Välj märket</li>
          <li>Filma ett varv</li>
          <li>Få ditt truth-card</li>
        </ol>
      </header>

      <div className="brand-search">
        <span className="brand-search-icon">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Sök märke"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Sök märke"
        />
        {query && (
          <button type="button" className="brand-search-clear" onClick={() => setQuery("")} aria-label="Rensa">
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {/* Rullande lista, inte ett ark. Märkena är många nog att man bläddrar, få nog att man hittar. */}
      <div className="brand-scroll">
        {shown.map((name) => {
          const t = brandTheme(name);
          return (
            <button
              key={name}
              className={`brand-tile brand-font-${t.font}`}
              style={{ background: t.bg, color: t.ink }}
              onClick={() => onStartScan({ brand: name, model: "" })}
            >
              <span className="brand-tile-name">{name}</span>
              <span className="brand-tile-go" style={{ color: t.accent }}>
                <ChevronRight size={18} />
              </span>
            </button>
          );
        })}

        {typed && !exact && (
          <button className="brand-tile brand-tile-custom" onClick={() => onStartScan({ brand: typed, model: "" })}>
            <span className="brand-tile-name">Använd ”{typed}”</span>
            <span className="brand-tile-go">
              <ChevronRight size={18} />
            </span>
          </button>
        )}
        {shown.length === 0 && !typed && <p className="muted small">Inga märken.</p>}
      </div>

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
                  {/* Samma omslag som ligger överst på kortet. Säljarens egen bildruta är reserven —
                      den finns alltid, medan produktbilden bara finns när en källa gick att belägga. */}
                  <img
                    className="saved-thumb"
                    src={j.coverImageUrl ?? (j.thumbnailImageId ? imageUrl(j.id, j.thumbnailImageId) : undefined)}
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
