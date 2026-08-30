import { useEffect, useMemo, useState } from "react";
import { listUsers } from "../api";
import { ArrowLeftIcon, ChevronRight, UserIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import type { AdminUser, AdminDirectory } from "../types";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * Adminpanelen: de konton som registrerade sig idag eller igår, med vägen in till deras annonser.
 *
 * Urvalet görs på servern (server/src/admin.ts) och inte här — det är samma fönster oavsett vem som
 * frågar, och vyn behöver aldrig hämta hem hela användarlistan för att sedan kasta det mesta.
 *
 * Vem som ser den avgörs på servern och bara där (server/src/admin.ts). Klienten får ett ja eller nej
 * i inloggningssvaret och ritar ingången efter det — men varje väg bakom den prövar rollen igen, så
 * en påhittad flagga i webbläsaren ger 404 och inget mer.
 */
export default function AdminScreen({
  onBack,
  onOpenUser,
}: {
  onBack: () => void;
  onOpenUser: (user: AdminUser) => void;
}) {
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
        <h1 className="profile-name">{t("Nya användare")}</h1>
      </header>
      <p className="admin-lede">
        {t("Konton som registrerade sig idag eller igår")}
        {users !== null && total > 0
          ? ` · ${t("{antal} av {total} konton", { antal: users.length, total })}`
          : ""}
      </p>

      <section className="profile-stats">
        <div className="profile-stat">
          <div className="profile-stat-value">{users?.length ?? "—"}</div>
          <div className="profile-stat-label">{t("Nya konton")}</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{users ? totalCards : "—"}</div>
          <div className="profile-stat-label">{t("Annonser")}</div>
        </div>
      </section>

      {/* Vad urvalet faktiskt vilar på. Ett datumfilter som i tysthet gissar datumet vore ett värre
          fel än inget filter alls — den som läser listan ska veta vilket av de två den ser. */}
      {users !== null && directory !== "service" && (
        <p className="admin-note">
          {directory === "profiles"
            ? "Registreringsdatum kommer från profiltabellen. Konton utan datum där räknas från sitt första jobb."
            : "Utan SUPABASE_SERVICE_ROLE_KEY finns inget registreringsdatum: konton räknas som nya efter sitt första jobb, och bara konton som syns i jobben kan visas alls."}
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
          <p className="profile-empty-title">{query ? t("Ingen träff") : t("Inga nya konton")}</p>
          <p className="profile-empty-hint">
            {query
              ? t("Ingen av de nya användarna matchar sökningen.")
              : t(
                  "Ingen har registrerat sig idag eller igår. Kontona som fanns sedan tidigare ligger kvar — de visas bara inte här.",
                )}
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

/** "idag" / "igår" för fönstrets två dagar, datum för allt annat. */
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
