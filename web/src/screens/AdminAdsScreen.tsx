import { useEffect, useMemo, useState } from "react";
import { listAnnonser } from "../api";
import { ArrowLeftIcon, CardIcon, ChevronRight, SearchIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { usePageTitle } from "../lib/pageTitle";
import type { AdminAnnonsRad, AdminAnnonser, AnnonsLage } from "../types";

/**
 * Alla annonser vi fått in.
 *
 * EN RAD PER JOBB. Det är skillnaden mot allt annat i produkten: butiken visar bara det som klarar
 * `shopReadiness`, profilen bara det som blev ett kort, och de 67 av 172 jobb som aldrig blev en
 * annons syns därför ingenstans. Den här listan finns för frågan "vad får vi in", och då måste även
 * det som föll vara med — med orsaken utskriven, inte gömd.
 *
 * SORTERINGEN ÄR EN ÅSIKT. Förvalet är nyast först, för det är i den ordningen intaget läses. Men
 * kolumnerna som går att sortera på är valda för de frågor panelen finns för: vad har legat längst
 * utan att säljas, vad har många sett men ingen klickat på, var har priset vandrat längst ner.
 */
const LAGE_ETIKETT: Record<AnnonsLage, string> = {
  vantar: "Väntar på godkännande",
  live: "Ligger uppe",
  reserverad: "Reserverad",
  sald: "Såld",
  levererad: "Levererad",
  returnerad: "Returnerad",
  utkast: "Utkast",
  "utan-annons": "Ingen annons",
  pagaende: "Pågår",
  misslyckad: "Föll",
};

type Sortering = "nyast" | "langst-uppe" | "mest-visad" | "sämst-ctr" | "dyrast";

export default function AdminAdsScreen({
  onBack,
  onOpenAd,
  inbaddad = false,
}: {
  /** Vägen tillbaka. Saknas när listan ligger som en flik i adminpanelen — den har sin egen. */
  onBack?: () => void;
  onOpenAd: (rad: AdminAnnonsRad) => void;
  /**
   * Listan som en FLIK i adminpanelen i stället för en egen sida.
   *
   * Då rör den inte sidhuvudet: tillbakaknappen, rubriken och sidtiteln hör till skärmen omkring,
   * och två av varje hade sagt för läsaren att de bytt sida när de bara bytt flik. Allt som är
   * listans eget — summeringen, filtren, raderna — är sig likt.
   */
  inbaddad?: boolean;
}) {
  const [data, setData] = useState<AdminAnnonser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fraga, setFraga] = useState("");
  const [lage, setLage] = useState<AnnonsLage | "alla">("alla");
  const [sortering, setSortering] = useState<Sortering>("nyast");
  // Som flik är sidan fortfarande adminpanelen, och sidtiteln ska säga det. `null` hade betytt
  // appens standardtitel, vilket är fel sida — inte "rör inte titeln".
  usePageTitle(inbaddad ? "Adminpanel" : "Annonser");

  useEffect(() => {
    listAnnonser()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta annonserna."));
  }, []);

  const rader = useMemo(() => {
    const q = fraga.trim().toLowerCase();
    let ut = data?.rader ?? [];
    if (lage !== "alla") ut = ut.filter((r) => r.lage === lage);
    if (q) {
      ut = ut.filter((r) =>
        [r.titel, r.id, r.brand, r.model, r.categorySlug].some((f) => f?.toLowerCase().includes(q)),
      );
    }
    const kopia = [...ut];
    switch (sortering) {
      case "langst-uppe":
        // Osålt först: frågan är vad som ligger och samlar damm, inte vad som tog längst tid att sälja.
        return kopia.sort((a, b) => (b.soldAt ? -1 : 0) - (a.soldAt ? -1 : 0) || (b.dagarUppe ?? -1) - (a.dagarUppe ?? -1));
      case "mest-visad":
        return kopia.sort((a, b) => b.statistik.visningar - a.statistik.visningar);
      case "sämst-ctr":
        // Bara annonser som faktiskt setts. En annons ingen sett har ingen klickfrekvens att vara sämst i.
        return kopia
          .filter((r) => r.statistik.visningar + r.statistik.listvisningar >= 5)
          .sort((a, b) => (a.ctr ?? 1) - (b.ctr ?? 1));
      case "dyrast":
        return kopia.sort((a, b) => (b.prisNu ?? 0) - (a.prisNu ?? 0));
      default:
        // Kön överst, äldst väntande först: det är den raden någon ska trycka på nu. Resten nyast först.
        return kopia.sort((a, b) => {
          const av = a.lage === "vantar" ? 1 : 0;
          const bv = b.lage === "vantar" ? 1 : 0;
          if (av !== bv) return bv - av;
          if (av && a.begardAt && b.begardAt) return a.begardAt < b.begardAt ? -1 : 1;
          return a.createdAt < b.createdAt ? 1 : -1;
        });
    }
  }, [data, fraga, lage, sortering]);

  const s = data?.summering;

  return (
    <div className={inbaddad ? "admin-flik" : "screen screen-light profile admin"}>
      {!inbaddad && (
        <>
          <button className="btn btn-text btn-back" onClick={onBack}>
            <ArrowLeftIcon /> Tillbaka
          </button>

          <header className="admin-head">
            <span className="admin-badge">Admin</span>
            <h1 className="profile-name">Annonser</h1>
          </header>
        </>
      )}
      <p className="admin-lede">Allt som filmats, oavsett om det blev en annons.</p>

      <section className="profile-stats admin-stats-wide">
        <div className="profile-stat">
          <div className="profile-stat-value">{s?.antal ?? "—"}</div>
          <div className="profile-stat-label">Totalt</div>
        </div>
        <button
          type="button"
          className={`profile-stat admin-stat-knapp${lage === "vantar" ? " aktiv" : ""}`}
          onClick={() => setLage(lage === "vantar" ? "alla" : "vantar")}
          title="Visa bara det som väntar på godkännande"
        >
          <div className="profile-stat-value">{s?.vantar ?? "—"}</div>
          <div className="profile-stat-label">Att godkänna</div>
        </button>
        <div className="profile-stat">
          <div className="profile-stat-value">{s?.live ?? "—"}</div>
          <div className="profile-stat-label">Ligger uppe</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{s?.salda ?? "—"}</div>
          <div className="profile-stat-label">Sålda</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{s ? formatSek(s.varde) : "—"}</div>
          <div className="profile-stat-label">Värde uppe</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">{s?.visningar ?? "—"}</div>
          <div className="profile-stat-label">Visningar</div>
        </div>
        <div className="profile-stat">
          <div className="profile-stat-value">
            {s?.medianDagarTillSald === null || s === undefined ? "—" : `${s.medianDagarTillSald} d`}
          </div>
          <div className="profile-stat-label">Median till såld</div>
        </div>
      </section>

      {/*
        Mätningen började när den byggdes, och det måste stå i vyn.
        En nolla i visningskolumnen betyder "ingen har sett den" ELLER "annonsen låg uppe innan vi
        mätte", och den som läser listan kan inte skilja dem åt utan den här raden.
      */}
      {s && s.visningar === 0 && (
        <p className="admin-note">
          Inga visningar registrerade än. Mätningen skrevs aldrig före den här versionen — siffrorna
          börjar på noll vid driftsättningen och säger ingenting om trafiken dessförinnan.
        </p>
      )}

      <div className="admin-verktyg">
        <label className="admin-sok">
          <SearchIcon size={15} />
          <input
            value={fraga}
            onChange={(e) => setFraga(e.target.value)}
            placeholder="Sök titel, märke, Loopa-ID"
            aria-label="Sök annons"
            autoComplete="off"
          />
        </label>
        <select value={lage} onChange={(e) => setLage(e.target.value as AnnonsLage | "alla")} aria-label="Filtrera på läge">
          <option value="alla">Alla lägen</option>
          {Object.entries(LAGE_ETIKETT).map(([v, etikett]) => (
            <option key={v} value={v}>
              {etikett}
            </option>
          ))}
        </select>
        <select value={sortering} onChange={(e) => setSortering(e.target.value as Sortering)} aria-label="Sortera">
          <option value="nyast">Nyast först</option>
          <option value="langst-uppe">Legat längst</option>
          <option value="mest-visad">Mest visad</option>
          <option value="sämst-ctr">Lägst klickfrekvens</option>
          <option value="dyrast">Dyrast</option>
        </select>
      </div>

      {data === null ? (
        error ? (
          <p className="public-card-error">{error}</p>
        ) : (
          <div className="profile-loading">
            <div className="spinner" />
          </div>
        )
      ) : rader.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark">
            <CardIcon size={22} />
          </span>
          <p className="profile-empty-title">Ingen träff</p>
          <p className="profile-empty-hint">Ingen annons matchar filtret.</p>
        </div>
      ) : (
        <ul className="card-list annons-lista">
          {rader.map((r) => (
            <li key={r.id}>
              <button className="card-row annons-rad" onClick={() => onOpenAd(r)}>
                <span className="annons-bild" aria-hidden>
                  {r.imageUrl ? <img src={r.imageUrl} alt="" /> : <CardIcon size={18} />}
                </span>
                <span className="card-row-body">
                  <span className="card-row-title">
                    {r.titel}
                    <span className={`annons-lage annons-lage-${r.lage}`}>{LAGE_ETIKETT[r.lage]}</span>
                    {r.overstyrd && <span className="admin-tag">Rättad</span>}
                  </span>
                  <span className="card-row-meta">
                    {[
                      r.id,
                      r.grade ? `Betyg ${r.grade}` : null,
                      prisText(r),
                      r.dagarUppe !== null ? `${r.dagarUppe} d uppe` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="card-row-meta admin-row-sub">
                    {[
                      `${r.statistik.visningar} visn`,
                      `${r.statistik.listvisningar} expo`,
                      `${r.statistik.klick} klick`,
                      r.ctr !== null ? `${(r.ctr * 100).toFixed(1)} % CTR` : null,
                      r.ordrar ? `${r.ordrar} order` : null,
                      r.saknas.length ? `saknar ${r.saknas.join(", ")}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
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

/**
 * Priset som en historia och inte ett tal.
 *
 * "4 200 → 2 900 kr" säger på en rad det som är hela poängen med prisstegen: var annonsen började och
 * var den står nu. Ett ensamt pris hade dolt att möbeln sänkts fyra gånger utan att säljas.
 */
function prisText(r: AdminAnnonsRad): string | null {
  if (r.prisNu === null) return null;
  if (r.prisStart !== null && r.prisStart !== r.prisNu) return `${r.prisStart} → ${formatSek(r.prisNu)}`;
  return formatSek(r.prisNu);
}
