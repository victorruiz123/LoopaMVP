import { useEffect, useMemo, useState } from "react";
import { imageUrl, listJobs } from "../api";
import type { FurnitureIdentity, JobSummary } from "../types";
import GradeBadge from "../components/GradeBadge";
import { CardSearchIcon, ChevronRight, SearchIcon, CloseIcon, UserIcon } from "../components/icons";
import { useAuth } from "../auth/AuthProvider";
import { formatPriceRange } from "../lib/price";
import { KNOWN_BRANDS } from "../lib/brands";
import { LOOPA_PERCENT } from "../lib/fees";
import { POPULAR_BRANDS } from "../lib/brandSeed";
import { brandTheme } from "../lib/brandTheme";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

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
  /** Slå upp en publik annons på dess Loopa-ID — ikonen i topplisten. */
  onOpenLookup: () => void;
}) {
  const t = useT();
  const { profile, user, loading } = useAuth();
  usePageTitle(null);
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * Listan är säljarens egen och hämtas bara när det finns en säljare.
   *
   * Startsidan öppnas numera utan konto — där finns inga sparade annonser att visa, och ett anrop
   * hade bara växlat ett 401 mot en tom lista. Väntar in `loading`, annars går frågan iväg utan
   * token i den korta stund det tar att läsa sessionen ur webbläsaren.
   */
  useEffect(() => {
    if (loading) return;
    if (!user) return setJobs([]);
    listJobs()
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [loading, user?.id]);

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
          {/* Loopa-ID:t ur en annons slås upp här. Varje annons är publik, så knappen leder inte
              in i det egna kontot utan till vilket kort som helst. */}
          <button className="app-bar-icon" onClick={onOpenLookup} aria-label={t("Sök annons på Loopa-ID")}>
            <CardSearchIcon size={18} />
          </button>
          {/* Ingen knapp alls medan sessionen läses: valet står mellan ett namn och "Logga in", och
              att gissa fel i en tiondels sekund byter ut texten framför ögonen på den som läser den. */}
          {!loading && (
            <button
              className="app-bar-profile"
              onClick={onOpenProfile}
              aria-label={user ? t("Din profil") : t("Logga in")}
            >
              <UserIcon size={17} />
              <span className="app-bar-profile-name">
                {user ? shortName(profile?.full_name ?? profile?.username, user.email) : t("Logga in")}
              </span>
            </button>
          )}
        </div>
      </div>

      <header className="home-header">
        <span className="brand-pill">
          <span className="brand-dot" /> {t("SÄLJ MED LOOPA")}
        </span>
        {/* Rubriken bryts i två rader, och brytpunkten är olika på olika språk: "Vilket märke"
            väger jämnt mot "är möbeln?", men "What brand" mot "is the furniture?" gör det inte.
            Därför är raderna två egna meningar i ordlistan och inte en med ett radbrott i. */}
        <h1 className="home-title">
          {t("Vilket märke")}
          <br />
          <span className="accent">{t("är möbeln?")}</span>
        </h1>
        {/* Löftet står FÖRE första trycket, på varje skärmstorlek. Det som stod här hette
            "AI-granskning" och lovade "en färdig annons" — och den som läste det trodde sig ha
            beställt ett dokument. Erbjudandet är att möbeln blir såld; det får inte vara något
            man upptäcker först på sista skärmen. Två rader räcker på telefonen, där listan är
            resten av skärmen — stegen under är fortfarande datorvyns, som har plats för dem. */}
        <p className="home-lede">{t("Vi gör annonsen, säljer möbeln och hör av oss när den är såld.")}</p>
        <ol className="home-steps desktop-only">
          <li>{t("Välj märket")}</li>
          <li>{t("Filma ett varv")}</li>
          <li>{t("Vi säljer den åt dig")}</li>
        </ol>
      </header>

      <div className="brand-search">
        <span className="brand-search-icon">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Sök märke")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={t("Sök märke")}
        />
        {query && (
          <button type="button" className="brand-search-clear" onClick={() => setQuery("")} aria-label={t("Rensa")}>
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
            <span className="brand-tile-name">{t("Använd ”{namn}”", { namn: typed })}</span>
            <span className="brand-tile-go">
              <ChevronRight size={18} />
            </span>
          </button>
        )}
        {shown.length === 0 && !typed && <p className="muted small">{t("Inga märken.")}</p>}
      </div>

      {finished.length > 0 && (
        <section className="collapsible-card">
          <button className="collapsible-header" onClick={() => setHistoryOpen((v) => !v)}>
            <span className="collapsible-title">{t("Sparade annonser")}</span>
            <span className="collapsible-meta">
              {t("{antal} st", { antal: finished.length })}
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
                    <div className="saved-item-title">{describe(j, t)}</div>
                    <div className="muted small">
                      {t("Betyg {betyg}", { betyg: j.grade?.grade ?? "?" })}
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

      {/* Vad det kostar, i en rad. Priset på tjänsten stod förut ingenstans i appen — säljaren
          filmade, granskade och tryckte på "Sälj med Loopa" utan att ha fått veta vad Loopa tar för
          det. Raden ligger sist på sidan, under de sparade annonserna, och står kvar även för den
          som ännu inte har några. */}
      <p className="home-fee-line">{t("Loopa tar {andel} % av försäljningspriset", { andel: LOOPA_PERCENT })}</p>
    </div>
  );
}

/** Förnamnet räcker i topplisten; hela adressen gör knappen bredare än rubriken under den. */
function shortName(name: string | null | undefined, email: string | null | undefined): string {
  const source = name || email?.split("@")[0] || "Profil";
  return source.split(/\s+/)[0];
}

function describe(job: JobSummary, t: (sv: string) => string): string {
  const name = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return name || t("Möbel");
}
