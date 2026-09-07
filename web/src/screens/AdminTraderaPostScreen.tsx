import { useCallback, useEffect, useState } from "react";
import { hamtaTraderaPost, listTraderaPost, markeraTraderaPost } from "../api";
import { MailIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { useT } from "../lib/i18n";
import type { TraderaPost, TraderaPostKind, TraderaPosten } from "../types";

/**
 * Tradera-posten: det Gmail-bevakaren sett — sålda varor, frågor, bud — och vad den gjorde åt det.
 *
 * LISTAN ÄR EN ATT-GÖRA-LISTA, inte en logg. En fråga på Tradera ska besvaras av en människa på
 * Tradera; det här är påminnelsen. Kryssrutan är panelens egen och rör aldrig mejlet i Gmail — den
 * säger "jag har sett det", inget mer. Övrigt-mejl (kvitton, kampanjer) ligger nedvikta: de finns
 * kvar för att man ska kunna upptäcka en formulering tolkaren missat, inte för att läsas dagligen.
 */
export default function AdminTraderaPostScreen({ onOpenAd }: { onOpenAd?: (loopaId: string) => void }) {
  const t = useT();
  const [data, setData] = useState<TraderaPosten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hamtar, setHamtar] = useState(false);
  const [visaOvrigt, setVisaOvrigt] = useState(false);
  const [visaHanterade, setVisaHanterade] = useState(false);

  const ladda = useCallback(() => {
    listTraderaPost()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta posten."));
  }, []);

  useEffect(ladda, [ladda]);

  async function hamtaNu() {
    setHamtar(true);
    setError(null);
    try {
      setData(await hamtaTraderaPost());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hämtningen misslyckades.");
    } finally {
      setHamtar(false);
    }
  }

  async function kryssa(post: TraderaPost) {
    const uppdaterad = await markeraTraderaPost(post.id, !post.handledAt).catch(() => null);
    if (!uppdaterad || !data) return;
    setData({
      ...data,
      poster: data.poster.map((p) => (p.id === uppdaterad.id ? uppdaterad : p)),
      status: { ...data.status, ohanterade: data.status.ohanterade + (uppdaterad.handledAt ? -1 : 1) },
    });
  }

  const status = data?.status;
  const poster = (data?.poster ?? []).filter(
    (p) => (visaOvrigt || p.kind !== "ovrigt") && (visaHanterade || !p.handledAt),
  );

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {status?.configured
          ? t("Läser {konto} var {min}:e minut", { konto: status.account ?? "", min: status.pollMinutes })
          : t("Gmail-bevakningen är av")}
        {status?.lastPollAt ? ` · ${t("senast")} ${nar(status.lastPollAt)}` : ""}
      </p>

      {status && !status.configured && (
        <p className="admin-note">
          {status.missing.length
            ? `Saknar ${status.missing.join(", ")} i server/.env. Skapa ett applösenord för Gmail-kontot (Google-kontot → Säkerhet → Tvåstegsverifiering → Applösenord) och starta om servern.`
            : "TRADERA_MAIL_WATCH=0 stänger av bevakningen."}
        </p>
      )}
      {status?.lastError && <p className="admin-note">{t("Senaste hämtningen misslyckades")}: {status.lastError}</p>}
      {data?.resultat && !data.resultat.error && (
        <p className="admin-note">
          {t("{antal} nya mejl", { antal: data.resultat.nya })} · {data.resultat.salda} {t("sålda")} · {data.resultat.fragor}{" "}
          {t("frågor")}
        </p>
      )}
      {error && <p className="public-card-error">{error}</p>}

      <div className="admin-verktyg">
        <button className="btn btn-small" onClick={hamtaNu} disabled={hamtar || !status?.configured}>
          {hamtar ? t("Läser Gmail…") : t("Läs Gmail nu")}
        </button>
        <label className="admin-sok">
          <input type="checkbox" checked={visaHanterade} onChange={(e) => setVisaHanterade(e.target.checked)} /> {t("Visa avkryssade")}
        </label>
        <label className="admin-sok">
          <input type="checkbox" checked={visaOvrigt} onChange={(e) => setVisaOvrigt(e.target.checked)} /> {t("Visa övriga mejl")}
        </label>
      </div>

      {data === null && !error ? (
        <div className="profile-loading">
          <div className="spinner" />
        </div>
      ) : poster.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <MailIcon size={22} />
          </span>
          <p className="profile-empty-title">{t("Inget att göra")}</p>
          <p className="profile-empty-hint">{t("Inga olästa sålda varor, frågor eller bud från Tradera.")}</p>
        </div>
      ) : (
        <ul className="admin-stub-list">
          {poster.map((p) => (
            <li key={p.id} className="admin-stub" style={p.handledAt ? { opacity: 0.55 } : undefined}>
              <span className="admin-stub-title">
                <span className="admin-tag" style={{ marginLeft: 0, marginRight: 7, background: farg(p.kind) }}>
                  {etikett(p.kind)}
                </span>
                {p.title ?? p.subject}
                {p.amountSek ? ` · ${formatSek(p.amountSek)}` : ""}
              </span>
              <span className="admin-stub-meta">
                {nar(p.receivedAt)}
                {p.alias ? ` · ${p.alias}` : ""}
                {p.itemId ? ` · #${p.itemId}` : ""}
                {" · "}
                {utfall(p)}
              </span>
              {p.kind === "fraga" && <span className="admin-stub-meta" style={{ whiteSpace: "pre-wrap" }}>{p.excerpt}</span>}
              <span className="admin-stub-meta" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {t("Öppna på Tradera")}
                  </a>
                )}
                {p.loopaId && onOpenAd && (
                  <button className="btn btn-text" style={{ padding: 0 }} onClick={() => onOpenAd(p.loopaId!)}>
                    {p.loopaId}
                  </button>
                )}
                <label>
                  <input type="checkbox" checked={!!p.handledAt} onChange={() => void kryssa(p)} /> {t("Hanterad")}
                </label>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function etikett(kind: TraderaPostKind): string {
  return kind === "sald" ? "Såld" : kind === "fraga" ? "Fråga" : kind === "bud" ? "Bud" : "Övrigt";
}

function farg(kind: TraderaPostKind): string | undefined {
  return kind === "sald" ? "var(--accent)" : kind === "fraga" ? "#b45309" : kind === "bud" ? "#1d4ed8" : "var(--muted-soft)";
}

function utfall(p: TraderaPost): string {
  switch (p.outcome) {
    case "sald":
      return `Markerad såld i Loopa (${p.loopaId})`;
    case "redan-sald":
      return p.outcomeNote ?? "Var redan såld";
    case "okand-annons":
      return p.outcomeNote ?? "Ingen annons hos oss";
    default:
      return p.loopaId ? `Gäller ${p.loopaId}` : (p.outcomeNote ?? "Noterad");
  }
}

function nar(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
