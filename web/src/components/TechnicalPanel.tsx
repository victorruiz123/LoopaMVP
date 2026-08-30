import { useEffect, useState } from "react";
import { ChevronRight, SlidersIcon } from "./icons";
import { t } from "../lib/i18n";
import { cropUrl, debugUrl, getDebugTrace, imageUrl } from "../api";
import { impactLabel, severityLabel, typeLabel } from "../lib/labels";
import { CONFIDENCE_LABELS, DEDUCTION_SOURCE_LABELS, formatSek, variantLabel } from "../lib/price";
import type { ConditionResult, Damage, DebugTrace, PriceEstimate } from "../types";

/**
 * Deliberately NOT part of the seller-facing report above it: confidence, verification state and
 * model metadata are exactly what ResultScreen is designed to keep out of a seller's way. This is a
 * collapsed inspection view for judging the engine's output, and it reads the debug trace the server
 * already produces rather than adding anything to the API.
 */
export default function TechnicalPanel({ jobId, result }: { jobId: string; result: ConditionResult }) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || trace) return;
    getDebugTrace(jobId)
      .then(setTrace)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta debug-data."));
  }, [open, jobId, trace]);

  const cacheHits = trace ? trace.geminiCalls.filter((c) => c.cached).length : 0;

  return (
    <section className="collapsible-card tech-panel">
      <button className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-title collapsible-title-icon">
          <SlidersIcon size={17} />
          {t("Teknisk information")}
        </span>
        <span className="collapsible-meta">
          <span className={`collapsible-chevron ${open ? "collapsible-chevron-open" : ""}`}>
            <ChevronRight size={16} />
          </span>
        </span>
      </button>

      {!open ? null : error ? (
        <p className="error-text">{error}</p>
      ) : !trace ? (
        <p className="muted tech-loading">{t("Hämtar debug-data…")}</p>
      ) : (
        <div className="tech-body">
          <TechSection title={t("Körning")}>
            <dl className="tech-kv">
              <Row k={t("Täckning")} v={<CoverageValue result={result} />} />
              <Row k={t("Modell")} v={result.modelUsed} />
              <Row
                k={t("Cache")}
                v={
                  trace.geminiCalls.length === 0
                    ? "inga anrop"
                    : `${cacheHits} av ${trace.geminiCalls.length} anrop från cache${cacheHits === trace.geminiCalls.length ? " — körningen kostade ingenting" : ""}`
                }
              />
              <Row k={t("Tokens")} v={`${result.tokensUsed.toLocaleString("sv-SE")} (~$${result.costUsd.toFixed(4)})`} />
              <Row k={t("Total tid")} v={`${(result.latencyMs / 1000).toFixed(1)} s`} />
              <Row k={t("Dedup")} v={`${trace.dedupBefore} fynd → ${trace.dedupAfter} skador`} />
            </dl>
          </TechSection>

          {result.price && <PriceSection price={result.price} />}

          <TechSection title={`Gemini-anrop (${trace.geminiCalls.length})`}>
            <table className="tech-table">
              <thead>
                <tr><th>{t("Syfte")}</th><th>{t("Modell")}</th><th>{t("Cache")}</th><th>{t("Tokens")}</th><th>{t("Tid")}</th></tr>
              </thead>
              <tbody>
                {trace.geminiCalls.map((c, i) => (
                  <tr key={i}>
                    <td>{c.purpose}</td>
                    <td>{c.modelUsed}</td>
                    <td>{c.cached ? "Cache" : "Nytt"}</td>
                    <td>{c.tokensUsed.toLocaleString("sv-SE")}</td>
                    <td>{c.cached ? "—" : `${(c.latencyMs / 1000).toFixed(1)} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {trace.geminiCalls.length === 1 && (
              <p className="muted tech-note">{t("Verifieringsanropet hoppades över — inget fynd var osäkert nog att motivera det.")}</p>
            )}
          </TechSection>

          {trace.overallCondition && (
            <TechSection title={t("Helhetsbedömning")}>
              <dl className="tech-kv">
                <Row k={t("Slitagenivå")} v={trace.overallCondition.overallWearLevel} />
                <Row k={t("Utbredning")} v={trace.overallCondition.affectedExtent} />
                <Row k={t("Funktion påverkad")} v={trace.overallCondition.functionalityAffected ? "ja" : "nej"} />
                <Row k={t("Struktur intakt")} v={trace.overallCondition.structuralIntegrityOk ? "ja" : "NEJ"} />
                <Row k={t("Ser tydligt använd ut")} v={trace.overallCondition.clearlyUsedAppearance ? "ja" : "nej"} />
              </dl>
              {trace.overallCondition.observations.length > 0 && (
                <ul className="tech-list">
                  {trace.overallCondition.observations.map((o, i) => <li key={i}>{o}</li>)}
                </ul>
              )}
            </TechSection>
          )}

          <TechSection title={t("Betygsspår")}>
            <ul className="tech-list">
              {trace.gradeTrace.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </TechSection>

          {trace.partsInspected && trace.partsInspected.length > 0 && (
            <TechSection title={`Delar som granskades (${trace.partsInspected.length})`}>
              <table className="tech-table">
                <thead><tr><th>{t("Del")}</th><th>{t("Syntes")}</th><th>{t("Fynd")}</th></tr></thead>
                <tbody>
                  {trace.partsInspected.map((x, i) => (
                    <tr key={i} className={x.defectsFound === 0 && x.visible ? "tech-part-clean" : undefined}>
                      <td>{x.part}</td>
                      <td>{x.visible ? "ja" : <span className="tech-flag">nej</span>}</td>
                      <td>{x.defectsFound}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted tech-note">
                Modellens egen redovisning av svepet. En del som saknas i listan granskades aldrig.
              </p>
            </TechSection>
          )}

          <TechSection title={`Bildrutor som analyserades (${result.images.length})`}>
            <div className="tech-frames">
              {result.images.map((img, i) => (
                <figure key={img.id}>
                  <img src={imageUrl(jobId, img.id)} alt="" />
                  <figcaption>
                    <strong>Bild {i}</strong>
                    <span className="muted">
                      {img.viewLabel ?? "utan etikett"} · {img.source === "video" ? "videoruta" : "foto"} · {img.width}×{img.height}
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </TechSection>

          <TechSection title={`Fynd (${result.damages.length})`}>
            {result.damages.length === 0 ? (
              <p className="muted">{t("Inga fynd rapporterades.")}</p>
            ) : (
              <div className="tech-findings">
                {result.damages.map((d) => <FindingRow key={d.id} jobId={jobId} damage={d} />)}
              </div>
            )}
          </TechSection>

          <a className="debug-link" href={debugUrl(jobId)} target="_blank" rel="noreferrer">
            Rå JSON ›
          </a>
        </div>
      )}
    </section>
  );
}

/**
 * What the price engine did with our findings. It values, it never detects — so every row here is its
 * own verdict on a damage WE reported, and `source` says how firm that verdict is: a measured table
 * row, an estimated repair cost, or an explicit refusal to value it.
 */
function PriceSection({ price }: { price: PriceEstimate }) {
  if (price.status !== "ok") {
    return (
      <TechSection title={t("Prissättning")}>
        <dl className="tech-kv">
          <Row k={t("Status")} v={<span className="tech-flag">{price.status}</span>} />
          <Row k={t("Orsak")} v={price.unavailableReason ?? "—"} />
          <Row k={t("Svarstid")} v={`${(price.latencyMs / 1000).toFixed(1)} s`} />
        </dl>
      </TechSection>
    );
  }
  const valued = price.damageLines.filter((l) => l.deduction > 0);
  return (
    <TechSection title={t("Prissättning")}>
      <dl className="tech-kv">
        <Row k={t("Intervall")} v={`${formatSek(price.low)} — ${formatSek(price.default)} — ${formatSek(price.high)}`} />
        <Row k={t("Underlag")} v={`${price.matchCount} annonser`} />
        <Row k={t("Möbeltyp")} v={`${price.variant?.map((v) => t(variantLabel(v))).join(", ") || "—"}${price.variantMethod ? ` (${price.variantMethod})` : ""}`} />
        <Row k={t("Säkerhet")} v={(price.confidence && t(CONFIDENCE_LABELS[price.confidence])) ?? price.confidence ?? "—"} />
        <Row
          k={t("Skadeavdrag")}
          v={
            price.damageDeduction
              ? `${(price.damageDeduction * 100).toFixed(0)} % över ${valued.length} värderad(e) post(er)`
              : "inget"
          }
        />
        <Row k={t("Svarstid")} v={`${(price.latencyMs / 1000).toFixed(1)} s`} />
      </dl>
      {price.damageLines.length > 0 && (
        <table className="tech-table">
          <thead>
            <tr><th>{t("Kategori")}</th><th>{t("Grad")}</th><th>{t("Avdrag")}</th><th>{t("Värdering")}</th></tr>
          </thead>
          <tbody>
            {price.damageLines.map((line, i) => (
              <tr key={i} className={line.deduction === 0 ? "tech-part-clean" : undefined}>
                <td>{line.category ?? "omappad"}{line.count && line.count > 1 ? ` ×${line.count}` : ""}</td>
                <td>{line.grade ?? "—"}</td>
                <td>{line.deduction ? `${(line.deduction * 100).toFixed(0)} %` : "—"}</td>
                <td>{(line.source && t(DEDUCTION_SOURCE_LABELS[line.source])) ?? line.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {price.note && <p className="muted tech-note">{price.note}</p>}
    </TechSection>
  );
}

function CoverageValue({ result }: { result: ConditionResult }) {
  const insufficient = result.coverage === "NOT_SUFFICIENTLY_VISIBLE";
  return (
    <>
      <span className={insufficient ? "tech-flag" : undefined}>{result.coverage}</span>
      {result.coverageNote ? <span className="muted"> — {result.coverageNote}</span> : null}
    </>
  );
}

function FindingRow({ jobId, damage }: { jobId: string; damage: Damage }) {
  const crop = damage.evidence.find((e) => e.cropPath)?.cropPath;
  return (
    <div className={`tech-finding tech-finding-${damage.verification}`}>
      {crop ? (
        <img className="tech-crop" src={cropUrl(jobId, crop)} alt="" title={t("Utsnittet som verifieringen bedömde")} />
      ) : (
        <div className="tech-crop tech-crop-empty" title={t("Inget utsnitt — fyndet gick aldrig till verifiering")}>—</div>
      )}
      <div className="tech-finding-body">
        <div className="tech-finding-title">
          <strong>{typeLabel(damage.type)}</strong>
          <span className="muted">{damage.part}{damage.semanticLocation ? ` · ${damage.semanticLocation}` : ""}</span>
        </div>
        <div className="tech-badges">
          <span className={`chip chip-${damage.severity}`}>{damage.severity} {severityLabel(damage.severity)}</span>
          <span className="chip chip-neutral">{impactLabel(damage.impact)}</span>
          <span className="chip chip-neutral">{damage.confidence}% säkerhet</span>
          <span className={`chip chip-verify-${damage.verification}`}>{damage.verification}</span>
          {damage.sellerAction && <span className="chip chip-neutral">säljare: {damage.sellerAction}</span>}
        </div>
        <p className="tech-finding-desc">{damage.description}</p>
        {damage.verificationReason && <p className="muted tech-finding-reason">Granskning: {damage.verificationReason}</p>}
      </div>
    </div>
  );
}

function TechSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="tech-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
