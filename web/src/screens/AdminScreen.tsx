import { useEffect, useMemo, useState } from "react";
import { listUsers } from "../api";
import { ArrowLeftIcon, CardIcon, ChevronRight, MailIcon, SearchIcon, SparkIcon, TruckIcon, UserIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { AdminAnnonsRad, AdminUser, AdminDirectory } from "../types";
import AdminAdsScreen from "./AdminAdsScreen";
import AdminTraderaPostScreen from "./AdminTraderaPostScreen";
import AdminOrdrarScreen from "./AdminOrdrarScreen";
import AdminDataScreen from "./AdminDataScreen";
import AdminEfterlysningarScreen from "./AdminEfterlysningarScreen";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

export type AdminFlik = "annonser" | "anvandare" | "tradera" | "ordrar" | "data" | "efterlysningar";

/**
 * Adminpanelen: allt vi fått in och alla som lagt upp det, i två flikar.
 *
 * TVÅ LISTOR OCH ETT VAL, inte en lista med en knapp till den andra. Panelen öppnas med en av två
 * frågor i huvudet — "vad har vi fått in" eller "vem är det här" — och båda besvaras genom att
 * BLÄDDRA. Annonserna låg tidigare bakom en knapp, alltså ett sidbyte bort, och den som ville jämföra
 * de två fick navigera fram och tillbaka och tappa både sökning och rullposition på vägen.
 *
 * Annonserna är förvald flik: det är den frågan som ställs oftast.
 *
 * Vem som ser panelen avgörs på servern och bara där (server/src/admin.ts). Klienten får ett ja eller
 * nej i inloggningssvaret och ritar ingången efter det — men varje väg bakom den prövar rollen igen,
 * så en påhittad flagga i webbläsaren ger 404 och inget mer.
 */
export default function AdminScreen({
  onBack,
  onOpenUser,
  onOpenAd,
  onOpenAdId,
  flik: initialFlik = "annonser",
}: {
  onBack: () => void;
  onOpenUser: (user: AdminUser) => void;
  /** Öppnar en annons i redigeringsvyn. Frivillig: panelen ska gå att rita utan den. */
  onOpenAd?: (rad: AdminAnnonsRad) => void;
  /** Samma sak från Tradera-posten, som bara bär Loopa-id:t. */
  onOpenAdId?: (loopaId: string) => void;
  /**
   * Fliken panelen öppnar på.
   *
   * Bärs utifrån för att vägen TILLBAKA från en annons ska landa i annonsfliken och inte i den
   * förvalda. Att backa ur en annons till användarlistan är att kastas ur det man höll på med.
   */
  flik?: AdminFlik;
}) {
  const [flik, setFlik] = useState<AdminFlik>(initialFlik);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const t = useT();
  usePageTitle("Adminpanel");
  const [directory, setDirectory] = useState<AdminDirectory>("jobs");
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listUsers()
      .then((res) => {
        setUsers(res.users);
        setDirectory(res.directory);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        setUsers([]);
        setError(err instanceof Error ? err.message : "Kunde inte hämta användarna.");
      });
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users ?? [];
    return (users ?? []).filter((u) =>
      [u.email, u.name, u.id].some((field) => field?.toLowerCase().includes(q)),
    );
  }, [users, query]);

  const totalCards = (users ?? []).reduce((sum, u) => sum + u.cardCount, 0);

  return (
    <div className="screen screen-light profile admin">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Tillbaka")}
      </button>

      <header className="admin-head">
        <span className="admin-badge">Admin</span>
        <h1 className="profile-name">{t("Adminpanel")}</h1>
      </header>

      {/*
        VALET STÅR ÖVERST, före allt som skiljer de två listorna åt.
        Flikarna byter innehåll och inte sida: adressen är densamma, tillbakaknappen leder till samma
        ställe, och det enda som ändras är vad man bläddrar i. Varje lista behåller sitt eget filter
        och sin egen sökning så länge panelen är öppen.
      */}
      <div className="admin-flikar" role="tablist" aria-label={t("Adminpanel")}>
        <button
          role="tab"
          aria-selected={flik === "annonser"}
          className={`admin-flik-knapp${flik === "annonser" ? " vald" : ""}`}
          onClick={() => setFlik("annonser")}
        >
          <CardIcon size={16} /> {t("Annonser")}
        </button>
        <button
          role="tab"
          aria-selected={flik === "anvandare"}
          className={`admin-flik-knapp${flik === "anvandare" ? " vald" : ""}`}
          onClick={() => setFlik("anvandare")}
        >
          <UserIcon size={16} /> {t("Användare")}
        </button>
        <button
          role="tab"
          aria-selected={flik === "ordrar"}
          className={`admin-flik-knapp${flik === "ordrar" ? " vald" : ""}`}
          onClick={() => setFlik("ordrar")}
        >
          <TruckIcon size={16} /> {t("Ordrar")}
        </button>
        {/*
          Efterlysningarna står bredvid ordrarna och inte bredvid annonserna.
          Båda är arbetslistor: något ligger och väntar på att en människa gör en sak. Annonserna och
          användarna är register man slår upp i. Ordningen i flikraden är den ordning en arbetsdag
          har, inte den ordning modulerna byggdes.
        */}
        <button
          role="tab"
          aria-selected={flik === "efterlysningar"}
          className={`admin-flik-knapp${flik === "efterlysningar" ? " vald" : ""}`}
          onClick={() => setFlik("efterlysningar")}
        >
          <SearchIcon size={16} /> {t("Efterlysningar")}
        </button>
        {/*
          Datafliken sist bland flikarna och först i ordningen av skäl: den läses inte för att få
          något gjort idag, utan för att se om modellen blir bättre. Den som öppnar panelen för att
          jobba ska inte behöva passera den.
        */}
        <button
          role="tab"
          aria-selected={flik === "data"}
          className={`admin-flik-knapp${flik === "data" ? " vald" : ""}`}
          onClick={() => setFlik("data")}
        >
          <SparkIcon size={16} /> {t("Data")}
        </button>
        <button
          role="tab"
          aria-selected={flik === "tradera"}
          className={`admin-flik-knapp${flik === "tradera" ? " vald" : ""}`}
          onClick={() => setFlik("tradera")}
        >
          <MailIcon size={16} /> {t("Tradera-post")}
        </button>
      </div>

      {flik === "annonser" ? (
        <AdminAdsScreen inbaddad onOpenAd={(rad) => onOpenAd?.(rad)} />
      ) : flik === "data" ? (
        <AdminDataScreen />
      ) : flik === "ordrar" ? (
        <AdminOrdrarScreen onOpenAd={onOpenAdId} />
      ) : flik === "efterlysningar" ? (
        <AdminEfterlysningarScreen />
      ) : flik === "tradera" ? (
        <AdminTraderaPostScreen onOpenAd={onOpenAdId} />
      ) : (
        <>
      <p className="admin-lede">
        {t("Alla konton, nyast först")}
        {users !== null && total > 0 ? ` · ${t("{antal} konton", { antal: total })}` : ""}
      </p>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{users?.length ?? "—"}</div>
          <div className="profile-stat-label">{t("Konton")}</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{users ? totalCards : "—"}</div>
          <div className="profile-stat-label">{t("Annonser")}</div>
        </div>
      </section>

      {/* Vad listan faktiskt vilar på. Urvalet är borta — listan är alla konton — men den kan
          fortfarande vara ofullständig, och det beror på varifrån katalogen kom. Den som läser den
          ska veta vilket av fallen de ser, och vilka datum sorteringen bygger på. */}
      {users !== null && directory !== "service" && (
        <p className="admin-note">
          {directory === "profiles"
            ? "Registreringsdatum kommer från profiltabellen. Konton utan datum där dateras efter sitt första jobb."
            : "Utan SUPABASE_SERVICE_ROLE_KEY finns inget registreringsdatum: konton dateras efter sitt första jobb, och bara konton som syns i jobben kan visas alls."}
        </p>
      )}

      {users !== null && users.length > 6 && (
        <input
          className="admin-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Sök på e-post eller namn")}
          autoComplete="off"
          aria-label={t("Sök användare")}
        />
      )}

      {users === null ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : error ? (
        <p className="public-card-error">{error}</p>
      ) : shown.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <UserIcon size={22} />
          </span>
          <p className="profile-empty-title">{query ? t("Ingen träff") : t("Inga konton")}</p>
          <p className="profile-empty-hint">
            {query
              ? t("Ingen användare matchar sökningen.")
              : t("Katalogen svarade, men den innehöll inga konton.")}
          </p>
        </div>
      ) : (
        <ul className="card-list">
          {shown.map((u) => (
            <li key={u.id}>
              <button className="card-row" onClick={() => onOpenUser(u)}>
                <span className="admin-avatar" aria-hidden>
                  {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : initials(displayName(u))}
                </span>
                <span className="card-row-body">
                  <span className="card-row-title">
                    {displayName(u)}
                    {u.isAdmin && <span className="admin-tag">Admin</span>}
                  </span>
                  <span className="card-row-meta">
                    {u.cardCount === 1
                      ? t("{antal} annons", { antal: u.cardCount })
                      : t("{antal} annonser", { antal: u.cardCount })}
                    {u.jobCount > u.cardCount
                      ? ` · ${t("{antal} utan kort", { antal: u.jobCount - u.cardCount })}`
                      : ""}
                    {u.totalValue > 0 ? ` · ${formatSek(u.totalValue)}` : ""}
                  </span>
                  <span className="card-row-meta admin-row-sub">
                    {[u.name && u.email ? u.email : null, signupLabel(u)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="card-row-chevron">
                  <ChevronRight size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </div>
  );
}

/** Namnet först, adressen sedan, id:t sist — det sista är fult men aldrig fel. */
export function displayName(user: AdminUser): string {
  return user.name || user.email || user.id;
}

export function initials(name: string): string {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

/** "idag" och "igår" skrivs som ord — de två dagarna man läser listan för. Datum för allt annat. */
function dayLabel(iso: string): string {
  const day = new Date(iso);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (day >= midnight) return "idag";
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day >= yesterday) return "igår";
  return formatDate(iso);
}

/**
 * Vad datumet på raden betyder.
 *
 * Ett uppskattat datum skrivs som det är. Skillnaden mellan "registrerade sig igår" och "syntes
 * först igår" spelar roll för den som läser listan för att veta vem som faktiskt är ny.
 */
function signupLabel(user: AdminUser): string {
  if (!user.signedUpAt) return "registrering okänd";
  const when = dayLabel(user.signedUpAt);
  return user.signupApproximate ? `första jobbet ${when}` : `registrerad ${when}`;
}
