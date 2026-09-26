import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getFacebookGroup,
  getFacebookOverview,
  listFacebookGroups,
  listFacebookPublications,
  patchFacebookGroup,
  patchFacebookSettings,
  resolveFacebookAction,
  retryFacebookPublication,
  startFacebookRun,
} from "../api";
import type {
  FacebookAdsStatus,
  FacebookGroupDetail,
  FacebookGroupRow,
  FacebookMembershipStatus,
  FacebookOperatorProfile,
  FacebookOverview,
  FacebookPublicationStatus,
  FacebookPublications,
  FacebookRunKind,
  FacebookWorkerState,
} from "../types";

/**
 * Facebook-fliken: sessionen, grupperna, köerna och operatörsprofilen — i SAMMA panel som allt annat.
 *
 * FYRA UNDERFLIKAR med var sin fråga. Översikten svarar på "kör det, och står något och väntar på
 * mig". Grupperna svarar på "var får vi lägga ut, och varför just där" — rangordningen står utskriven
 * med sina skäl, för det är beslutet en människa ska kunna ifrågasätta. Publiceringarna svarar på "vad
 * gick ut, vad fylldes bara i, vad föll". Inställningarna bär operatörsprofilen: de SANNA uppgifter
 * roboten får svara med på medlemsfrågor, och inget annat.
 *
 * Allt här läser Facebook-LAGRET på servern, aldrig Facebook självt. Knapparna som startar en körning
 * svarar direkt och körningen skriver sitt utfall i händelseloggen; sidan hämtar om sig efter en stund.
 */
type Under = "oversikt" | "grupper" | "publiceringar" | "installningar";

const UNDER: Array<[Under, string]> = [
  ["oversikt", "Översikt"],
  ["grupper", "Grupper"],
  ["publiceringar", "Publiceringar"],
  ["installningar", "Inställningar"],
];

const MEMBERSHIP_LABEL: Record<FacebookMembershipStatus, string> = {
  UNKNOWN: "Okänt",
  NOT_MEMBER: "Inte medlem",
  JOIN_REQUESTED: "Ansökan skickad",
  PENDING_APPROVAL: "Väntar på godkännande",
  MEMBER: "Medlem",
  QUESTIONS_REQUIRED: "Frågor kräver en människa",
  JOIN_REJECTED: "Avslagen",
  JOIN_BLOCKED: "Kan inte gå med",
  NEEDS_MANUAL_ACTION: "Kräver åtgärd",
};

const ADS_LABEL: Record<FacebookAdsStatus, string> = {
  ALLOWED: "Tillåtet",
  LIKELY_ALLOWED: "Troligen tillåtet",
  UNCLEAR: "Oklart",
  PROHIBITED: "Förbjudet",
};

const PUB_LABEL: Record<FacebookPublicationStatus, string> = {
  QUEUED: "I kö",
  PREPARING: "Pågår",
  WOULD_PUBLISH: "Skulle publiceras",
  PUBLISHED: "Publicerad",
  FAILED: "Föll",
  NEEDS_MANUAL_ACTION: "Kräver åtgärd",
};

const CATEGORY_LABEL: Record<string, string> = {
  FURNITURE_BUY_SELL: "Möbler köp/sälj",
  LOCAL_BUY_SELL: "Lokal köp/sälj",
  SECONDHAND: "Secondhand",
  BRAND_COMMUNITY: "Märkesgrupp",
  GENERAL: "Anslagstavla",
  OTHER: "Övrigt",
};

const WORKER_LABEL: Record<FacebookWorkerState, string> = { running: "kör", paused: "pausad", off: "av" };

export default function AdminFacebookScreen({ onOpenAd }: { onOpenAd?: (loopaId: string) => void }) {
  const [under, setUnder] = useState<Under>("oversikt");
  const [overview, setOverview] = useState<FacebookOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kvitto, setKvitto] = useState<string | null>(null);

  const ladda = useCallback(() => {
    getFacebookOverview()
      .then(setOverview)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta Facebook-läget."));
  }, []);
  useEffect(ladda, [ladda]);

  const kor = async (kind: FacebookRunKind, opts: { groupIds?: string[]; max?: number } = {}) => {
    setKvitto(null);
    setError(null);
    try {
      const r = await startFacebookRun(kind, opts);
      setKvitto(r.started ? `Körningen "${kind}" startade i bakgrunden. Utfallet skrivs i händelseloggen — ladda om om en stund.` : (r.reason ?? "Körningen startade inte."));
      setTimeout(ladda, 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Körningen gick inte att starta.");
    }
  };

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {overview
          ? overview.enabled
            ? `Facebook-distributionen är på · ${overview.dryRun ? "TORRKÖRNING — Publicera trycks aldrig" : "SKARPT LÄGE"} · ${overview.mode === "mock" ? "attrapp" : "riktiga Facebook"}`
            : "Facebook-distributionen är av (FACEBOOK_ENABLED är inte satt på servern)"
          : "Hämtar…"}
      </p>
      {error && <p className="public-card-error">{error}</p>}
      {kvitto && <p className="annons-kvitto">{kvitto}</p>}

      <div className="admin-flikar admin-underflikar" role="tablist" aria-label="Facebook">
        {UNDER.map(([id, etikett]) => (
          <button key={id} type="button" role="tab" aria-selected={under === id} className={`admin-flik-knapp${under === id ? " vald" : ""}`} onClick={() => setUnder(id)}>
            {etikett}
          </button>
        ))}
      </div>

      {under === "oversikt" && overview && <Oversikt overview={overview} kor={kor} ladda={ladda} onOpenAd={onOpenAd} />}
      {under === "grupper" && <Grupper kor={kor} />}
      {under === "publiceringar" && <Publiceringar onOpenAd={onOpenAd} />}
      {under === "installningar" && overview && <Installningar overview={overview} ladda={ladda} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Översikten
// ---------------------------------------------------------------------------

function Oversikt({ overview: o, kor, ladda, onOpenAd }: { overview: FacebookOverview; kor: (k: FacebookRunKind) => void; ladda: () => void; onOpenAd?: (id: string) => void }) {
  const session = o.session;
  return (
    <>
      <h2 className="profile-section-title">Session</h2>
      <section className="profile-stats admin-stats-wide">
        <Tal etikett="Session" varde={session?.status ?? "OKÄND"} />
        <Tal etikett="Kontrollerad" varde={session ? datum(session.checkedAt) : "—"} />
        <Tal etikett="Marketplace" varde={WORKER_LABEL[o.workers.marketplace]} />
        <Tal etikett="Gruppinlägg" varde={WORKER_LABEL[o.workers.groupPublishing]} />
        <Tal etikett="Upptäckt" varde={WORKER_LABEL[o.workers.discovery]} />
        <Tal etikett="Auto-join" varde={WORKER_LABEL[o.workers.autoJoin]} />
      </section>
      <p className="admin-note">
        {session ? session.detail : "Ingen sessionskontroll gjord än. Logga in med `npm run facebook:login` på servern och kör en kontroll."}
        {o.browserBusyWith ? ` · Webbläsaren är upptagen med ${o.browserBusyWith}.` : ""}
      </p>
      {(session?.status === "CHECKPOINT" || session?.status === "RESTRICTED") && (
        <p className="public-card-error">
          Facebook visade en kontrollpunkt eller spärr. Alla arbetare står stilla tills en människa löst det i webbläsaren och markerat åtgärden som klar under Publiceringar.
        </p>
      )}

      <h2 className="profile-section-title">Grupper</h2>
      <section className="profile-stats admin-stats-wide">
        <Tal etikett="Upptäckta" varde={o.groups.discovered} />
        <Tal etikett="Validerade" varde={o.groups.validated} />
        <Tal etikett="Ansökan skickad" varde={o.groups.joinRequested} />
        <Tal etikett="Väntar" varde={o.groups.pending} />
        <Tal etikett="Medlem" varde={o.groups.member} />
        <Tal etikett="Postbara" varde={o.groups.postEligible} />
        <Tal etikett="Påslagna" varde={o.groups.enabled} />
        <Tal etikett="Förbjudna" varde={o.groups.prohibited} />
      </section>
      <p className="admin-note">Senaste upptäcktsvarv: {o.lastDiscoveryAt ? datum(o.lastDiscoveryAt) : "aldrig"}.</p>

      <h2 className="profile-section-title">Publiceringar</h2>
      <section className="profile-stats admin-stats-wide">
        {(Object.keys(PUB_LABEL) as FacebookPublicationStatus[]).map((s) => (
          <Tal key={s} etikett={`MP ${PUB_LABEL[s]}`} varde={o.marketplace[s] ?? 0} />
        ))}
      </section>
      <section className="profile-stats admin-stats-wide">
        {(Object.keys(PUB_LABEL) as FacebookPublicationStatus[]).map((s) => (
          <Tal key={s} etikett={`Grupp ${PUB_LABEL[s]}`} varde={o.groupPosts[s] ?? 0} />
        ))}
      </section>
      {o.manualActionsOpen > 0 && <p className="public-card-error">{o.manualActionsOpen} åtgärd(er) väntar på en människa — se Publiceringar.</p>}

      <h2 className="profile-section-title">Kör nu</h2>
      <div className="annons-knappar">
        <button className="btn btn-outline btn-small" disabled={!o.enabled} onClick={() => kor("session")}>Kontrollera sessionen</button>
        <button className="btn btn-outline btn-small" disabled={!o.enabled} onClick={() => kor("discover")}>Sök grupper</button>
        <button className="btn btn-outline btn-small" disabled={!o.enabled} onClick={() => kor("validate")}>Validera grupper</button>
        <button className="btn btn-outline btn-small" disabled={!o.enabled} onClick={() => kor("recheck")}>Kontrollera ansökningar</button>
        <button className="btn btn-outline btn-small" disabled={!o.enabled} onClick={() => kor("queue")}>Kör kön</button>
        <button className="btn btn-text btn-small" onClick={ladda}>Ladda om</button>
      </div>
      <p className="admin-note">
        Gränser: {o.limits.maxJoinsPerDay} ansökningar/dag · {o.limits.maxGroupPostsPerDay} gruppinlägg/dag · {o.limits.maxMarketplacePerDay} Marketplace/dag · minst {o.limits.minSecondsBetweenWrites} s mellan skrivningar · högst {o.limits.maxGroupsPerListing} grupper per annons.
        {" "}Ansökningar startas per grupp under Grupper — aldrig härifrån.
      </p>

      <h2 className="profile-section-title">Senaste händelserna</h2>
      {o.events.length === 0 ? (
        <p className="admin-note">Inget har hänt än.</p>
      ) : (
        <ul className="annons-logg">
          {o.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={e.level === "error" ? "fb-rad-fel" : e.level === "warning" ? "fb-rad-varning" : ""}>
              <span className="annons-logg-tid">{datum(e.at)}</span>
              <span>
                <strong>{e.worker}</strong> {e.action}
                {e.target ? (
                  onOpenAd && /^LP-/.test(e.target) ? (
                    <>
                      {" "}
                      <button className="lank-knapp" onClick={() => onOpenAd(e.target!.split(" ")[0])}>{e.target}</button>
                    </>
                  ) : (
                    ` ${e.target}`
                  )
                ) : (
                  ""
                )}
                {" — "}
                {e.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Grupperna
// ---------------------------------------------------------------------------

type MedlemsFilter = "alla" | "MEMBER" | "pending" | "not_member" | "QUESTIONS_REQUIRED" | "NEEDS_MANUAL_ACTION";

function Grupper({ kor }: { kor: (k: FacebookRunKind, opts?: { groupIds?: string[]; max?: number }) => Promise<void> | void }) {
  const [rader, setRader] = useState<FacebookGroupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [medlem, setMedlem] = useState<MedlemsFilter>("alla");
  const [ads, setAds] = useState<FacebookAdsStatus | "alla">("alla");
  const [bara, setBara] = useState<"alla" | "enabled">("alla");
  const [q, setQ] = useState("");
  const [vald, setVald] = useState<string | null>(null);

  const ladda = useCallback(() => {
    listFacebookGroups()
      .then((r) => setRader(r.grupper))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta grupperna."));
  }, []);
  useEffect(ladda, [ladda]);

  const visade = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rader ?? []).filter((g) => {
      if (medlem === "pending" && !(g.membershipStatus === "JOIN_REQUESTED" || g.membershipStatus === "PENDING_APPROVAL")) return false;
      if (medlem === "not_member" && ["MEMBER", "JOIN_REQUESTED", "PENDING_APPROVAL"].includes(g.membershipStatus)) return false;
      if (medlem !== "alla" && medlem !== "pending" && medlem !== "not_member" && g.membershipStatus !== medlem) return false;
      if (ads !== "alla" && g.adsStatus !== ads) return false;
      if (bara === "enabled" && !g.enabledForDistribution) return false;
      if (t && !`${g.name} ${g.geography} ${g.canonicalUrl}`.toLowerCase().includes(t)) return false;
      return true;
    });
  }, [rader, medlem, ads, bara, q]);

  return (
    <>
      <div className="admin-verktyg">
        <label className="admin-sok">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Sök grupp eller ort" aria-label="Sök grupp" autoComplete="off" />
        </label>
        <select value={medlem} onChange={(e) => setMedlem(e.target.value as MedlemsFilter)} aria-label="Medlemskap">
          <option value="alla">Alla medlemskap</option>
          <option value="MEMBER">Medlem</option>
          <option value="pending">Väntar</option>
          <option value="not_member">Inte medlem</option>
          <option value="QUESTIONS_REQUIRED">Frågor kräver människa</option>
          <option value="NEEDS_MANUAL_ACTION">Kräver åtgärd</option>
        </select>
        <select value={ads} onChange={(e) => setAds(e.target.value as FacebookAdsStatus | "alla")} aria-label="Regler">
          <option value="alla">Alla regler</option>
          {(Object.keys(ADS_LABEL) as FacebookAdsStatus[]).map((s) => (
            <option key={s} value={s}>{ADS_LABEL[s]}</option>
          ))}
        </select>
        <select value={bara} onChange={(e) => setBara(e.target.value as "alla" | "enabled")} aria-label="Distribution">
          <option value="alla">Alla</option>
          <option value="enabled">Bara påslagna</option>
        </select>
        <button className="btn btn-text btn-small" onClick={ladda}>Ladda om</button>
      </div>
      {error && <p className="public-card-error">{error}</p>}
      {rader === null ? (
        <div className="profile-loading"><div className="spinner" /></div>
      ) : visade.length === 0 ? (
        <p className="admin-note">Inga grupper matchar. Kör "Sök grupper" under Översikt för att upptäcka grupper på riktiga Facebook.</p>
      ) : (
        <div className="fb-tabell-wrap">
          <table className="fb-tabell">
            <thead>
              <tr>
                <th>Grupp</th>
                <th>Kategori</th>
                <th>Ort</th>
                <th>Medl.</th>
                <th>Relevans</th>
                <th>Regler</th>
                <th>Medlemskap</th>
                <th>Postbar</th>
                <th>Distribution</th>
                <th>Senast postat</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visade.map((g) => (
                <tr key={g.id} className={vald === g.id ? "vald" : ""} onClick={() => setVald(vald === g.id ? null : g.id)}>
                  <td>
                    <strong>{g.name}</strong>
                    <br />
                    <small>{g.visibility === "PUBLIC" ? "offentlig" : g.visibility === "PRIVATE" ? "privat" : "synlighet okänd"}</small>
                  </td>
                  <td>{CATEGORY_LABEL[g.category] ?? g.category}</td>
                  <td>{g.geography || "—"}</td>
                  <td>{g.memberCount?.toLocaleString("sv-SE") ?? "—"}</td>
                  <td>{g.relevanceScore}</td>
                  <td><span className={`fb-tag fb-ads-${g.adsStatus}`}>{ADS_LABEL[g.adsStatus]}</span></td>
                  <td><span className={`fb-tag fb-medlem-${g.membershipStatus}`}>{MEMBERSHIP_LABEL[g.membershipStatus]}</span></td>
                  <td>{g.postEligible ? "ja" : "nej"}</td>
                  <td>{g.enabledForDistribution ? "på" : "av"}</td>
                  <td>{g.lastPostedAt ? datum(g.lastPostedAt) : "—"}</td>
                  <td>{g.publishedCount ? `${g.publishedCount} publ.` : ""}{g.queuedCount ? ` ${g.queuedCount} i kö` : ""}{!g.lastValidatedAt ? "ej validerad" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {vald && <GruppDetalj id={vald} kor={kor} onChanged={ladda} />}
    </>
  );
}

function GruppDetalj({ id, kor, onChanged }: { id: string; kor: (k: FacebookRunKind, opts?: { groupIds?: string[]; max?: number }) => Promise<void> | void; onChanged: () => void }) {
  const [detalj, setDetalj] = useState<FacebookGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sparar, setSparar] = useState(false);

  const ladda = useCallback(() => {
    getFacebookGroup(id)
      .then(setDetalj)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta gruppen."));
  }, [id]);
  useEffect(ladda, [ladda]);

  const patcha = async (patch: Parameters<typeof patchFacebookGroup>[1]) => {
    setSparar(true);
    setError(null);
    try {
      await patchFacebookGroup(id, patch);
      ladda();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ändringen gick inte igenom.");
    } finally {
      setSparar(false);
    }
  };

  if (error && !detalj) return <p className="public-card-error">{error}</p>;
  if (!detalj) return <div className="profile-loading"><div className="spinner" /></div>;
  const g = detalj.group;

  return (
    <section className="card-block fb-detalj">
      <h2 className="profile-section-title">{g.name}</h2>
      <p className="admin-note">
        <a href={g.canonicalUrl} target="_blank" rel="noreferrer">{g.canonicalUrl}</a> · {CATEGORY_LABEL[g.category] ?? g.category} · {g.geography || "ort okänd"} ·{" "}
        {g.memberCount?.toLocaleString("sv-SE") ?? "?"} medlemmar · hittad via: {g.discoveredVia.join(", ") || "—"}
      </p>
      {error && <p className="public-card-error">{error}</p>}

      <h3>Rangordning: {g.relevanceScore} p</h3>
      <ul className="admin-kanaler">
        {g.rankingReasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <h3>Regler: {ADS_LABEL[g.adsStatus]} {g.rulesLastCheckedAt ? `(lästa ${datum(g.rulesLastCheckedAt)})` : "(inte lästa)"}</h3>
      {g.rulesEvidence.length > 0 && (
        <ul className="admin-kanaler">
          {g.rulesEvidence.map((r, i) => (
            <li key={i} className={/^FÖRBUD/.test(r) ? "kanal-nej" : /^TILLÅTET/.test(r) ? "kanal-gar" : "kanal-torr"}>{r}</li>
          ))}
        </ul>
      )}
      {g.rulesText && <textarea readOnly rows={6} value={g.rulesText} className="fb-regler" />}

      <h3>Medlemskap: {MEMBERSHIP_LABEL[g.membershipStatus]}</h3>
      <p className="admin-note">
        {g.membershipDetail ?? "—"} · {g.joinAttempts} försök · ansökt {g.joinRequestedAt ? datum(g.joinRequestedAt) : "—"} · medlem sedan {g.joinedAt ? datum(g.joinedAt) : "—"} · kontrollerad {g.membershipLastCheckedAt ? datum(g.membershipLastCheckedAt) : "—"}
      </p>
      <ul className="admin-kanaler">
        <li className={g.joinEligible ? "kanal-gar" : "kanal-nej"}>Får ansöka: {g.joinEligible ? "ja" : `nej — ${g.joinReasons.join("; ")}`}</li>
        <li className={g.postEligible ? "kanal-gar" : "kanal-nej"}>Postbar: {g.postEligible ? "ja" : `nej — ${g.postReasons.join("; ")}`}</li>
        <li className={g.enabledForDistribution ? "kanal-gar" : "kanal-nej"}>Distribution: {g.enabledForDistribution ? "på" : "av"} ({g.enabledForDistributionSetBy ?? "aldrig satt"})</li>
      </ul>
      <div className="annons-knappar">
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => kor("validate", { groupIds: [g.id] })}>Läs om reglerna</button>
        <button className="btn btn-outline btn-small" disabled={sparar || !g.joinEligible} onClick={() => { if (window.confirm(`Skicka en RIKTIG medlemsansökan till ${g.name}?`)) void kor("join", { groupIds: [g.id], max: 1 }); }}>Ansök om medlemskap</button>
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => kor("recheck", { groupIds: [g.id] })}>Kontrollera medlemskapet</button>
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => patcha({ enabledForDistribution: !g.enabledForDistribution })}>{g.enabledForDistribution ? "Stäng av distribution" : "Slå på distribution"}</button>
        {["QUESTIONS_REQUIRED", "NEEDS_MANUAL_ACTION", "JOIN_REJECTED", "JOIN_BLOCKED"].includes(g.membershipStatus) && (
          <>
            <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => patcha({ resetMembership: true })}>Nollställ medlemskapet</button>
            <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => patcha({ membershipStatus: "MEMBER", note: "Gick med för hand." })}>Jag har gått med för hand</button>
          </>
        )}
      </div>

      {g.questions.length > 0 && (
        <>
          <h3>Medlemsfrågor</h3>
          <ul className="annons-logg">
            {g.questions.map((q, i) => (
              <li key={i}>
                <span className="annons-logg-tid">{datum(q.askedAt)}</span>
                <span>
                  <strong>{q.text}</strong>
                  {q.options?.length ? ` [${q.options.join(" / ")}]` : ""} → {q.answerable ? `"${q.answer}"` : "INGET SVAR"} · {q.basis}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {g.history.length > 0 && (
        <>
          <h3>Medlemskapshistorik</h3>
          <ul className="annons-logg">
            {[...g.history].reverse().map((h, i) => (
              <li key={i}>
                <span className="annons-logg-tid">{datum(h.at)}</span>
                <span>{h.from} → {h.to} · {h.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Publiceringar i gruppen</h3>
      {detalj.publications.length === 0 ? (
        <p className="admin-note">Inget har köats till den här gruppen.</p>
      ) : (
        <ul className="annons-logg">
          {detalj.publications.map((p) => (
            <li key={`${p.listingId}-${p.queuedAt}`}>
              <span className="annons-logg-tid">{datum(p.attemptedAt ?? p.queuedAt)}</span>
              <span>
                {p.listingId} · {PUB_LABEL[p.status]}{p.dryRun ? " (torr)" : ""}
                {p.composer === "listing" ? " · säljinlägg" : ""}
                {p.facebookPostUrl ? <> · <a href={p.facebookPostUrl} target="_blank" rel="noreferrer">{p.composer === "listing" ? "säljinlägget" : "inlägget"}</a></> : ""}
                {p.failureReason ? ` · ${p.failureReason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {g.aboutText && (
        <>
          <h3>Om gruppen (som Facebook visar det)</h3>
          <textarea readOnly rows={5} value={g.aboutText} className="fb-regler" />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Publiceringarna
// ---------------------------------------------------------------------------

function Publiceringar({ onOpenAd }: { onOpenAd?: (id: string) => void }) {
  const [data, setData] = useState<FacebookPublications | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visaKlara, setVisaKlara] = useState(false);

  const ladda = useCallback(() => {
    listFacebookPublications()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta publiceringarna."));
  }, []);
  useEffect(ladda, [ladda]);

  const retry = async (kind: "marketplace" | "group", listingId: string, groupId: string | null, status: FacebookPublicationStatus) => {
    const confirmed = status === "NEEDS_MANUAL_ACTION" ? window.confirm("Har du kontrollerat på Facebook att det INTE redan ligger en annons/ett inlägg? Ett omförsök kan annars ge dubbletter.") : true;
    if (!confirmed) return;
    try {
      await retryFacebookPublication({ kind, listingId, groupId, confirmedNoDuplicate: status === "NEEDS_MANUAL_ACTION" });
      ladda();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gick inte att köa om.");
    }
  };

  if (error && !data) return <p className="public-card-error">{error}</p>;
  if (!data) return <div className="profile-loading"><div className="spinner" /></div>;

  const oppna = data.manualActions.filter((a) => visaKlara || !a.resolvedAt);

  return (
    <>
      {error && <p className="public-card-error">{error}</p>}
      <h2 className="profile-section-title">Kräver en människa ({data.manualActions.filter((a) => !a.resolvedAt).length})</h2>
      <label className="admin-sok">
        <input type="checkbox" checked={visaKlara} onChange={(e) => setVisaKlara(e.target.checked)} /> Visa avklarade
      </label>
      {oppna.length === 0 ? (
        <p className="admin-note">Inget väntar på dig.</p>
      ) : (
        <ul className="annons-logg">
          {oppna.map((a) => (
            <li key={a.id} className={a.resolvedAt ? "" : "fb-rad-fel"} style={a.resolvedAt ? { opacity: 0.55 } : undefined}>
              <span className="annons-logg-tid">{datum(a.at)}</span>
              <span>
                <strong>{a.kind}</strong> ({a.context.worker}) {a.reason}
                {a.url ? <> · <a href={a.url} target="_blank" rel="noreferrer">sidan</a></> : ""}
                {a.lastCompletedStep ? ` · sista steg: ${a.lastCompletedStep}` : ""}
                {a.screenshot ? ` · skärmbild: ${a.screenshot}` : ""}
                {a.context.listingId && onOpenAd ? <> · <button className="lank-knapp" onClick={() => onOpenAd(a.context.listingId!)}>{a.context.listingId}</button></> : ""}
                {!a.resolvedAt && (
                  <>
                    {" "}
                    <button className="btn btn-outline btn-small" onClick={() => resolveFacebookAction(a.id).then(ladda).catch(() => undefined)}>Markera som klar</button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="profile-section-title">Marketplace ({data.marketplace.length})</h2>
      {data.marketplace.length === 0 ? (
        <p className="admin-note">Ingen annons har köats till Marketplace.</p>
      ) : (
        <ul className="annons-logg">
          {data.marketplace.map((p) => (
            <li key={p.listingId}>
              <span className="annons-logg-tid">{datum(p.attemptedAt ?? p.queuedAt)}</span>
              <span>
                {onOpenAd ? <button className="lank-knapp" onClick={() => onOpenAd(p.listingId)}>{p.listingId}</button> : p.listingId} ·{" "}
                <span className={`fb-tag fb-pub-${p.status}`}>{PUB_LABEL[p.status]}</span>
                {p.dryRun ? " (torrkörning)" : ""}
                {p.contentSnapshot ? ` · ${p.contentSnapshot.title} · ${p.contentSnapshot.price} kr` : ""}
                {p.facebookUrl ? <> · <a href={p.facebookUrl} target="_blank" rel="noreferrer">annonsen</a></> : ""}
                {p.failureReason ? ` · ${p.failureReason}` : ""}
                {(p.status === "FAILED" || p.status === "WOULD_PUBLISH" || p.status === "NEEDS_MANUAL_ACTION") && (
                  <>
                    {" "}
                    <button className="btn btn-outline btn-small" onClick={() => retry("marketplace", p.listingId, null, p.status)}>Köa om</button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="profile-section-title">Gruppinlägg ({data.groups.length})</h2>
      {data.groups.length === 0 ? (
        <p className="admin-note">Inget gruppinlägg har köats. Grupper måste vara medlem + postbara + påslagna.</p>
      ) : (
        <ul className="annons-logg">
          {data.groups.map((p) => (
            <li key={`${p.listingId}-${p.groupId}`}>
              <span className="annons-logg-tid">{datum(p.attemptedAt ?? p.queuedAt)}</span>
              <span>
                {onOpenAd ? <button className="lank-knapp" onClick={() => onOpenAd(p.listingId)}>{p.listingId}</button> : p.listingId} → {p.groupId} ·{" "}
                <span className={`fb-tag fb-pub-${p.status}`}>{PUB_LABEL[p.status]}</span>
                {p.dryRun ? " (torrkörning)" : ""}
                {p.composer === "listing" ? " · säljinlägg" : ""}
                {p.facebookPostUrl ? <> · <a href={p.facebookPostUrl} target="_blank" rel="noreferrer">{p.composer === "listing" ? "säljinlägget" : "inlägget"}</a></> : ""}
                {p.failureReason ? ` · ${p.failureReason}` : ""}
                {(p.status === "FAILED" || p.status === "WOULD_PUBLISH" || p.status === "NEEDS_MANUAL_ACTION") && (
                  <>
                    {" "}
                    <button className="btn btn-outline btn-small" onClick={() => retry("group", p.listingId, p.groupId, p.status)}>Köa om</button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inställningarna
// ---------------------------------------------------------------------------

const PROFIL_FALT: Array<[keyof FacebookOperatorProfile, string, string]> = [
  ["displayName", "Visningsnamn", "Det namn kontot har på Facebook."],
  ["city", "Stad", "Där operatören faktiskt bor. Används för \"Bor du i Stockholm?\"."],
  ["region", "Region", "T.ex. Stockholms län."],
  ["interests", "Intressen", "Vad du är intresserad av i grupperna, kort och sant."],
  ["businessAffiliation", "Företagsrelation", "T.ex. \"Jag arbetar med Loopa, en tjänst som säljer begagnade möbler åt privatpersoner.\" Skrivs ut som det står när en grupp frågar."],
  ["defaultJoinReason", "Anledning att gå med", "Kort och sann. Används för \"Varför vill du gå med?\"."],
];

function Installningar({ overview, ladda }: { overview: FacebookOverview; ladda: () => void }) {
  const [profil, setProfil] = useState<FacebookOperatorProfile>(overview.settings.operatorProfile);
  const [maxGrupper, setMaxGrupper] = useState(overview.settings.maxGroupsPerListing === null ? "" : String(overview.settings.maxGroupsPerListing));
  const [sparar, setSparar] = useState(false);
  const [kvitto, setKvitto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProfil(overview.settings.operatorProfile);
    setMaxGrupper(overview.settings.maxGroupsPerListing === null ? "" : String(overview.settings.maxGroupsPerListing));
  }, [overview]);

  const spara = async (patch: Parameters<typeof patchFacebookSettings>[0], text: string) => {
    setSparar(true);
    setError(null);
    setKvitto(null);
    try {
      await patchFacebookSettings(patch);
      setKvitto(text);
      ladda();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gick inte att spara.");
    } finally {
      setSparar(false);
    }
  };
  const s = overview.settings;

  return (
    <>
      {kvitto && <p className="annons-kvitto">{kvitto}</p>}
      {error && <p className="public-card-error">{error}</p>}
      <h2 className="profile-section-title">Pausknappar</h2>
      <p className="admin-note">Miljön på servern avgör vad som är PÅ (FACEBOOK_*). Knapparna här pausar det som är på, utan omstart.</p>
      <div className="annons-knappar">
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => spara({ discoveryPaused: !s.discoveryPaused }, "Upptäckten uppdaterad.")}>Upptäckt: {s.discoveryPaused ? "pausad — slå på" : "kör — pausa"}</button>
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => spara({ autoJoinPaused: !s.autoJoinPaused }, "Auto-join uppdaterad.")}>Auto-join: {s.autoJoinPaused ? "pausad — slå på" : "kör — pausa"}</button>
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => spara({ marketplacePaused: !s.marketplacePaused }, "Marketplace uppdaterad.")}>Marketplace: {s.marketplacePaused ? "pausad — slå på" : "kör — pausa"}</button>
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => spara({ groupPublishingPaused: !s.groupPublishingPaused }, "Gruppinlägg uppdaterad.")}>Gruppinlägg: {s.groupPublishingPaused ? "pausade — slå på" : "kör — pausa"}</button>
      </div>

      <h2 className="profile-section-title">Grupper per annons</h2>
      <p className="admin-note">
        Taket för hur många grupper en ny annons köas till — ratten för utrullningen (3 → 5 → 10). Urvalet per möbel står i panelens händelselogg. Tomt = miljöns FACEBOOK_MAX_GROUPS_PER_LISTING ({overview.limits.maxGroupsPerListing}).
      </p>
      <div className="annons-knappar">
        <input type="number" min={0} max={50} value={maxGrupper} onChange={(e) => setMaxGrupper(e.target.value)} placeholder={String(overview.limits.maxGroupsPerListing)} style={{ width: 90 }} aria-label="Max grupper per annons" />
        <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => spara({ maxGroupsPerListing: maxGrupper.trim() === "" ? null : Number(maxGrupper) }, "Taket för grupper per annons sparat.")}>Spara taket</button>
      </div>

      <h2 className="profile-section-title">Operatörsprofil</h2>
      <p className="admin-note">
        De SANNA uppgifter roboten får svara med på medlemsfrågor. Ett tomt fält betyder att frågan inte kan besvaras — gruppen blir då "Frågor kräver en människa" i stället för att roboten gissar. Skriv aldrig något här som inte stämmer.
      </p>
      <div className="annons-form">
        {PROFIL_FALT.map(([falt, etikett, hjalp]) => (
          <label key={falt} className="annons-falt annons-falt-bred">
            <span>{etikett}</span>
            <input value={profil[falt]} onChange={(e) => setProfil({ ...profil, [falt]: e.target.value })} placeholder={hjalp} />
            <small className="annons-falt-not">{hjalp}</small>
          </label>
        ))}
      </div>
      <div className="annons-knappar">
        <button className="btn" disabled={sparar} onClick={() => spara({ operatorProfile: profil }, "Operatörsprofilen sparad.")}>Spara profilen</button>
      </div>
      {s.updatedAt && <p className="admin-note">Senast ändrad {datum(s.updatedAt)}{s.updatedBy ? ` av ${s.updatedBy}` : ""}.</p>}

      <h2 className="profile-section-title">Miljön på servern</h2>
      <ul className="admin-kanaler">
        <li className={overview.enabled ? "kanal-gar" : "kanal-nej"}>FACEBOOK_ENABLED: {overview.enabled ? "på" : "av"}</li>
        <li className={overview.dryRun ? "kanal-torr" : "kanal-gar"}>FACEBOOK_DRY_RUN: {overview.dryRun ? "true — Publicera trycks aldrig" : "false — SKARPT"}</li>
        <li className={overview.flags.autoDiscover ? "kanal-gar" : "kanal-nej"}>FACEBOOK_AUTO_DISCOVER: {overview.flags.autoDiscover ? "på" : "av"}</li>
        <li className={overview.flags.autoJoin ? "kanal-gar" : "kanal-nej"}>FACEBOOK_AUTO_JOIN: {overview.flags.autoJoin ? "på" : "av"}</li>
        <li className={overview.flags.marketplaceEnabled ? "kanal-gar" : "kanal-nej"}>FACEBOOK_MARKETPLACE_ENABLED: {overview.flags.marketplaceEnabled ? "på" : "av"}</li>
        <li className={overview.flags.groupPublishingEnabled ? "kanal-gar" : "kanal-nej"}>FACEBOOK_GROUP_PUBLISHING_ENABLED: {overview.flags.groupPublishingEnabled ? "på" : "av"}</li>
        <li>Profil: {overview.profileDir}</li>
      </ul>
    </>
  );
}

function Tal({ etikett, varde }: { etikett: string; varde: string | number }) {
  return (
    <div className="profile-stat">
      <div className="profile-stat-value">{varde}</div>
      <div className="profile-stat-label">{etikett}</div>
    </div>
  );
}

function datum(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
