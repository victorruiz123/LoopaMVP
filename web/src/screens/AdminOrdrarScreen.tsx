import { useCallback, useEffect, useState } from "react";
import { andraOrder, getOrderDetalj, listaOrdrar } from "../api";
import { TruckIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { useT } from "../lib/i18n";
import type { AdminOrderDetalj, AdminOrderRad, AdminOrdrar } from "../types";

/**
 * Orderfliken: alla köp, och framför allt det som väntar på oss.
 *
 * LISTAN ÄR EN ARBETSLISTA. Överst ligger det som kräver en människa — betalt utan tider, tider utan
 * bokad frakt, begärd retur — äldst först, för den som väntat längst har mest rätt att bli otålig.
 * Talet högst upp är det fliken finns för att få ner till noll.
 *
 * FRAKTEN BOKAS HÄR, i tre tryck som speglar verkligheten: köparen lämnar sina tider, vi bekräftar
 * EN tid när budfirman svarat, och vi markerar levererat när möbeln står inne. Tiden vi bokar
 * behöver inte vara en av köparens tre — budfirman kan svara "torsdag i stället", och då är det den
 * tiden som gäller. Köparen får beskedet automatiskt.
 */
export default function AdminOrdrarScreen({ onOpenAd }: { onOpenAd?: (loopaId: string) => void }) {
  const t = useT();
  const [data, setData] = useState<AdminOrdrar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oppen, setOppen] = useState<AdminOrderDetalj | null>(null);
  const [visaKlara, setVisaKlara] = useState(false);

  const ladda = useCallback(() => {
    listaOrdrar()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta ordrarna."));
  }, []);

  useEffect(ladda, [ladda]);

  const oppna = async (rad: AdminOrderRad) => {
    setError(null);
    try {
      setOppen(await getOrderDetalj(rad.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte öppna ordern.");
    }
  };

  const rader = (data?.rader ?? []).filter((r) => visaKlara || r.attGora);
  const s = data?.summering;

  if (oppen) {
    return <OrderDetalj detalj={oppen} onStang={() => { setOppen(null); ladda(); }} onOpenAd={onOpenAd} />;
  }

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {s ? `${s.attGora} ${s.attGora === 1 ? t("order väntar på oss") : t("ordrar väntar på oss")}` : t("Hämtar…")}
        {s && s.antal > 0 ? ` · ${s.antal} ${t("totalt")} · ${formatSek(s.omsattning)}` : ""}
      </p>

      {error && <p className="public-card-error">{error}</p>}

      {s && (
        <section className="profile-stats admin-stats-wide">
          <div className="profile-stat">
            <div className="profile-stat-value">{s.attGora}</div>
            <div className="profile-stat-label">{t("Att göra")}</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{s.betalda}</div>
            <div className="profile-stat-label">{t("Betalda")}</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{s.bokade}</div>
            <div className="profile-stat-label">{t("Frakt bokad")}</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{s.levererade}</div>
            <div className="profile-stat-label">{t("Levererade")}</div>
          </div>
        </section>
      )}

      <div className="admin-verktyg">
        <label className="admin-sok">
          <input type="checkbox" checked={visaKlara} onChange={(e) => setVisaKlara(e.target.checked)} />{" "}
          {t("Visa även avslutade")}
        </label>
        <button className="btn btn-small btn-outline" onClick={ladda}>{t("Uppdatera")}</button>
      </div>

      {data === null && !error ? (
        <div className="profile-loading"><div className="spinner" /></div>
      ) : rader.length === 0 ? (
        <div className="profile-empty">
          <span className="profile-empty-mark"><TruckIcon size={22} /></span>
          <p className="profile-empty-title">{t("Inget väntar")}</p>
          <p className="profile-empty-hint">{t("Ingen order behöver något av oss just nu.")}</p>
        </div>
      ) : (
        <ul className="card-list">
          {rader.map((r) => (
            <li key={r.id}>
              <button className="card-row" onClick={() => void oppna(r)}>
                <span className="card-row-body">
                  <span className="card-row-title">
                    {r.titel}
                    <span className="admin-tag" style={{ background: statusFarg(r.status) }}>{statusText(r.status)}</span>
                  </span>
                  <span className="card-row-meta">
                    {r.reference} · {formatSek(r.priceSek + r.deliveryFeeSek)} · {r.postalCode ?? "—"}
                    {r.deliveryDate ? ` · ${datum(r.deliveryDate)} ${r.deliveryWindow ?? ""}` : ""}
                  </span>
                  {r.attGora && (
                    <span className="card-row-meta" style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {r.attGora}
                      {r.vantatTimmar !== null && r.vantatTimmar >= 24 ? ` · väntat ${Math.floor(r.vantatTimmar / 24)} dygn` : ""}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** En order i sin helhet: parterna, tiderna, historiken och de tre knapparna. */
function OrderDetalj({
  detalj,
  onStang,
  onOpenAd,
}: {
  detalj: AdminOrderDetalj;
  onStang: () => void;
  onOpenAd?: (loopaId: string) => void;
}) {
  const t = useT();
  const [order, setOrder] = useState(detalj);
  const [datumIn, setDatumIn] = useState(order.deliveryDate ?? order.requestedSlots[0]?.date ?? "");
  const [tidIn, setTidIn] = useState(order.deliveryWindow ?? order.requestedSlots[0]?.window ?? "08–12");
  const [anteckning, setAnteckning] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  const gor = async (atgard: Parameters<typeof andraOrder>[1]) => {
    setBusy(true);
    setFel(null);
    try {
      const ny = await andraOrder(order.id, atgard);
      setOrder(ny);
      setAnteckning("");
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Åtgärden gick inte igenom.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-flik">
      <button className="btn btn-text btn-back" onClick={onStang}>← {t("Alla ordrar")}</button>

      <header className="admin-head">
        <h2 style={{ margin: 0, fontSize: 20 }}>{order.titel}</h2>
        <span className="admin-tag" style={{ background: statusFarg(order.status) }}>{statusText(order.status)}</span>
      </header>
      <p className="admin-lede">
        {order.reference} · {formatSek(order.priceSek)} + {formatSek(order.deliveryFeeSek)} {t("frakt")}
        {order.loopaId && onOpenAd ? " · " : ""}
        {order.loopaId && onOpenAd && (
          <button className="btn btn-text" style={{ padding: 0 }} onClick={() => onOpenAd(order.loopaId!)}>
            {order.loopaId}
          </button>
        )}
      </p>

      {fel && <p className="public-card-error">{fel}</p>}

      <section className="admin-note">
        <div><strong>{t("Köpare")}:</strong> {order.buyerEmail ?? t("adress saknas")}</div>
        <div><strong>{t("Levereras till")}:</strong> {order.postalCode ?? "—"} ({order.deliveryZone ?? t("zon okänd")})</div>
        <div>
          <strong>{t("Säljare")}:</strong>{" "}
          {order.sellerEmail ?? <span style={{ color: "var(--accent)" }}>{t("går inte att nå — jobbet saknar e-post")}</span>}
        </div>
      </section>

      {/* Köparens önskemål. Ordningen är deras prioritering och visas som den är. */}
      <section className="admin-note">
        <strong>{t("Köparens tider")}</strong>
        {order.requestedSlots.length === 0 ? (
          <p style={{ margin: "6px 0 0" }}>{t("Köparen har inte lämnat några tider ännu.")}</p>
        ) : (
          <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {order.requestedSlots.map((s) => (
              <li key={`${s.date}-${s.window}`}>
                <button
                  type="button"
                  className="btn btn-text"
                  style={{ padding: 0 }}
                  onClick={() => { setDatumIn(s.date); setTidIn(s.window); }}
                >
                  {datum(s.date)} {s.window}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {order.status !== "delivered" && order.status !== "cancelled" && order.status !== "returned" && (
        <section className="admin-note">
          <strong>{t("Boka frakt")}</strong>
          <p style={{ margin: "6px 0 10px" }}>
            {t("Tiden behöver inte vara en av köparens tre. Köparen får beskedet automatiskt.")}
          </p>
          <div className="butik-field-row" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input type="date" value={datumIn} onChange={(e) => setDatumIn(e.target.value)} className="admin-search" style={{ width: "auto" }} />
            <select value={tidIn} onChange={(e) => setTidIn(e.target.value)} className="admin-search" style={{ width: "auto" }}>
              <option value="08–12">08–12</option>
              <option value="12–17">12–17</option>
            </select>
            <button
              className="btn btn-small"
              disabled={busy || !datumIn}
              onClick={() => void gor({ gor: "boka", datum: datumIn, tid: tidIn })}
            >
              {order.deliveryDate ? t("Ändra bokad tid") : t("Bekräfta frakt")}
            </button>
            {order.status === "scheduled" && (
              <button className="btn btn-small btn-outline" disabled={busy} onClick={() => void gor({ gor: "levererad" })}>
                {t("Markera levererad")}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="admin-note">
        <strong>{t("Anteckning")}</strong>
        <p style={{ margin: "6px 0 10px" }}>{t("Intern som förval. Kryssa i rutan för att köparen ska se den.")}</p>
        <textarea
          className="admin-search"
          rows={2}
          value={anteckning}
          onChange={(e) => setAnteckning(e.target.value)}
          placeholder={t("t.ex. Budfirman svarar först på måndag")}
        />
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
          <button className="btn btn-small btn-outline" disabled={busy || !anteckning.trim()} onClick={() => void gor({ gor: "anteckna", text: anteckning })}>
            {t("Spara intern")}
          </button>
          <button className="btn btn-small btn-outline" disabled={busy || !anteckning.trim()} onClick={() => void gor({ gor: "anteckna", text: anteckning, publik: true })}>
            {t("Spara och visa för köparen")}
          </button>
        </div>
      </section>

      <section className="admin-note">
        <strong>{t("Historik")}</strong>
        <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {order.handelser.map((h, i) => (
            <li key={`${h.at}-${i}`} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span style={{ color: "var(--muted-soft)", fontSize: "var(--fs-xs)", minWidth: 104, whiteSpace: "nowrap" }}>
                {new Date(h.at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}{" "}
                {new Date(h.at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span>
                {h.note}
                {!h.publik && <span className="admin-tag" style={{ background: "var(--muted-soft)" }}>{t("intern")}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function statusText(status: AdminOrderRad["status"]): string {
  const map: Record<AdminOrderRad["status"], string> = {
    pending: "Kassa påbörjad",
    paid: "Betald",
    booking: "Bokar frakt",
    scheduled: "Frakt bokad",
    delivered: "Levererad",
    cancel_requested: "Ångrat av köparen",
    return_requested: "Retur begärd",
    returned: "Returnerad",
    cancelled: "Avbruten",
  };
  return map[status];
}

function statusFarg(status: AdminOrderRad["status"]): string {
  if (status === "delivered") return "var(--accent)";
  if (status === "scheduled") return "#1d4ed8";
  if (status === "paid" || status === "booking") return "#b45309";
  if (status === "cancelled" || status === "return_requested") return "#b91c1c";
  return "var(--muted-soft)";
}

function datum(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
}
