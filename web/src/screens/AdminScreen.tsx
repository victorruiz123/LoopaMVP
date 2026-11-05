import { useEffect, useMemo, useState } from "react";
import { listUsers } from "../api";
import { ArrowLeftIcon, CardIcon, ChatIcon, ChevronRight, GlobeIcon, MailIcon, ShieldIcon, VideoIcon, SearchIcon, SparkIcon, TruckIcon, UserIcon, UsersIcon, CheckCircleIcon, SlidersIcon, CopyIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { AdminAnnonsRad, AdminUser, AdminDirectory, UtskickForval } from "../types";
import AdminAdsScreen from "./AdminAdsScreen";
import AdminTraderaPostScreen from "./AdminTraderaPostScreen";
import AdminOrdrarScreen from "./AdminOrdrarScreen";
import AdminDataScreen from "./AdminDataScreen";
import AdminKundresaScreen, { type KundresaVy } from "./AdminKundresaScreen";
import AdminResorScreen from "./AdminResorScreen";
import AdminEfterlysningarScreen from "./AdminEfterlysningarScreen";
import AdminFeedbackScreen from "./AdminFeedbackScreen";
import AdminUtskickScreen from "./AdminUtskickScreen";
import AdminFacebookScreen from "./AdminFacebookScreen";
import AdminRobotHalsaScreen from "./AdminRobotHalsaScreen";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * Kundresans vyer är panelens egna flikar. Samma namn som vyerna (AdminKundresaScreen, KundresaVy), så
 * att en flik och en vy aldrig behöver översättas mellan varandra.
 */
const KUNDRESA_FLIKAR = ["laget", "oversikt", "saljflode", "ingangar", "varifran", "lankar", "saljare"] as const satisfies readonly KundresaVy[];
type KundresaFlik = (typeof KUNDRESA_FLIKAR)[number];
const arKundresa = (f: AdminFlik): f is KundresaFlik => (KUNDRESA_FLIKAR as readonly string[]).includes(f);

export type AdminFlik = KundresaFlik | "annonser" | "anvandare" | "uppladdning" | "tradera" | "ordrar" | "data" | "efterlysningar" | "feedback" | "utskick" | "facebook" | "robotar";

/**
 * Panelens flikar, i grupper efter ärende.
 *
 * ANVÄNDARDATA först: hur det går, var säljarna fastnar, varifrån de kommer och vilka de är — och
 * sist fördjupningarna: varje uppladdningsförsök, modellens träffsäkerhet och vad säljarna tycker.
 * Läget just nu står först och är förvalt — panelen öppnas med frågan "hur går det?". Sedan arbetslistorna i ANNONSER & AFFÄRER, i den ordning en arbetsdag har dem, och
 * KANALERNA, som läses av den som sköter dem. KONTAKT sist: Utskick är det enda i panelen som når
 * utåt, till riktiga inkorgar, och en flik man råkar trycka på ska inte vara den.
 */
const ADMIN_GRUPPER: Array<{ id: string; namn: string; flikar: Array<{ id: AdminFlik; namn: string; ikon: typeof UserIcon }> }> = [
  {
    id: "data",
    namn: "Användardata",
    flikar: [
      { id: "laget", namn: "Läget just nu", ikon: CheckCircleIcon },
      { id: "oversikt", namn: "Översikt", ikon: CardIcon },
      { id: "saljflode", namn: "Säljflödet", ikon: SlidersIcon },
      { id: "ingangar", namn: "Ingångar", ikon: GlobeIcon },
      { id: "varifran", namn: "Varifrån", ikon: SearchIcon },
      { id: "lankar", namn: "Kampanjlänkar", ikon: CopyIcon },
      { id: "saljare", namn: "Säljarna", ikon: UsersIcon },
      { id: "uppladdning", namn: "Uppladdning", ikon: VideoIcon },
      { id: "data", namn: "Data", ikon: SparkIcon },
      { id: "feedback", namn: "Feedback", ikon: ChatIcon },
    ],
  },
  {
    id: "affar",
    namn: "Annonser & affärer",
    flikar: [
      { id: "annonser", namn: "Annonser", ikon: CardIcon },
      { id: "ordrar", namn: "Ordrar", ikon: TruckIcon },
      { id: "efterlysningar", namn: "Efterlysningar", ikon: SearchIcon },
    ],
  },
  {
    id: "kanaler",
    namn: "Kanaler",
    flikar: [
      { id: "tradera", namn: "Tradera-post", ikon: MailIcon },
      { id: "facebook", namn: "Facebook", ikon: SparkIcon },
      { id: "robotar", namn: "Robotar", ikon: ShieldIcon },
    ],
  },
  {
    id: "kontakt",
    namn: "Kontakt",
    flikar: [
      { id: "anvandare", namn: "Användare", ikon: UserIcon },
      { id: "utskick", namn: "Utskick", ikon: MailIcon },
    ],
  },
];

/**
 * Adminpanelen: allt vi fått in och alla som lagt upp det, i två flikar.
 *
 * TVÅ LISTOR OCH ETT VAL, inte en lista med en knapp till den andra. Panelen öppnas med en av två
 * frågor i huvudet — "vad har vi fått in" eller "vem är det här" — och båda besvaras genom att
 * BLÄDDRA. Annonserna låg tidigare bakom en knapp, alltså ett sidbyte bort, och den som ville jämföra
 * de två fick navigera fram och tillbaka och tappa både sökning och rullposition på vägen.
 *
 * Läget just nu är förvald flik: panelen öppnas med frågan "hur går det?", och den fliken svarar på den.
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
  flik: initialFlik = "laget",
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
  /** En grupp som datafliken skickat hit för ett utskick. Töms när den använts eller återställts. */
  const [utskickForval, setUtskickForval] = useState<UtskickForval | null>(null);
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
      // Telefonnumret är sökbart utan att formen städas: den som söker klistrar in numret som det
      // står i listan, och det är exakt strängen vi jämför mot.
      [u.email, u.name, u.id, u.telefon].some((field) => field?.toLowerCase().includes(q)),
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
      {/*
        FLIKARNA I FYRA GRUPPER, MED VAR SIN FÄRG. Tretton flikar på en rad rann över skärmkanten, och
        de sista gick varken att se eller nå. Nu står de i grupper efter vad man kommer för — förstå
        användarna, sköta annonserna, sköta kanalerna, nå folk — och raderna bryts i stället för att
        rinna över. Färgen följer gruppen, och gruppens namn står alltid i text bredvid: färgen hjälper
        ögat, den bär inte betydelsen ensam.
      */}
      <nav className="admin-grupper" aria-label={t("Adminpanel")}>
        {ADMIN_GRUPPER.map((g) => (
          <div key={g.id} className={`admin-grupp admin-grupp-${g.id}`} role="tablist" aria-label={t(g.namn)}>
            <span className="admin-grupp-namn">{t(g.namn)}</span>
            <div className="admin-grupp-flikar">
              {g.flikar.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={flik === f.id}
                  className={`admin-grupp-flik${flik === f.id ? " vald" : ""}`}
                  onClick={() => {
                    // Utskicket öppnat för hand: hela listan, inte en grupp som datafliken skickade hit tidigare.
                    if (f.id === "utskick") setUtskickForval(null);
                    setFlik(f.id);
                  }}
                >
                  <f.ikon size={16} /> {f.id === "facebook" ? f.namn : t(f.namn)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {flik === "annonser" ? (
        <AdminAdsScreen inbaddad onOpenAd={(rad) => onOpenAd?.(rad)} />
      ) : flik === "uppladdning" ? (
        <AdminResorScreen
          onOpenUserId={(id) => {
            const u = users?.find((x) => x.id === id);
            if (u) onOpenUser(u);
          }}
        />
      ) : arKundresa(flik) ? (
        // En och samma skärm för alla sju flikarna, så att perioden, filtren och den hämtade datan
        // ligger kvar när man byter mellan dem — bara vyn byts.
        <AdminKundresaScreen
          vy={flik}
          onVisaVy={setFlik}
          onOpenUserId={(id) => {
            const u = users?.find((x) => x.id === id);
            if (u) onOpenUser(u);
          }}
          onVisaFlik={setFlik}
        />
      ) : flik === "data" ? (
        <AdminDataScreen
          onOpenUserId={(id) => {
            const u = users?.find((x) => x.id === id);
            if (u) onOpenUser(u);
          }}
          onVisaTrafik={() => setFlik("varifran")}
          onVisaUppladdning={() => setFlik("uppladdning")}
          onSkickaTill={(forval) => {
            setUtskickForval(forval);
            setFlik("utskick");
          }}
        />
      ) : flik === "ordrar" ? (
        <AdminOrdrarScreen onOpenAd={onOpenAdId} />
      ) : flik === "efterlysningar" ? (
        <AdminEfterlysningarScreen />
      ) : flik === "feedback" ? (
        <AdminFeedbackScreen />
      ) : flik === "utskick" ? (
        <AdminUtskickScreen forval={utskickForval} />
      ) : flik === "tradera" ? (
        <AdminTraderaPostScreen onOpenAd={onOpenAdId} />
      ) : flik === "facebook" ? (
        <AdminFacebookScreen onOpenAd={onOpenAdId} />
      ) : flik === "robotar" ? (
        <AdminRobotHalsaScreen />
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
          placeholder={t("Sök på e-post, namn eller telefon")}
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
                    {/* Telefonnumret står i listan därför att det är det enda sättet att se VILKA som
                        går att nå — 180 av 270 har ett, och det syntes inte någonstans förut. */}
                    {[u.name && u.email ? u.email : null, u.telefon, signupLabel(u)].filter(Boolean).join(" · ")}
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
