import { useEffect, useRef, useState } from "react";
import { actOnDamage, addDamage, addDamageFromPhoto, disputeDamage, getJob, imageUrl } from "../api";
import type { ConditionResult, Damage, DamageType } from "../types";
import GradeBadge from "../components/GradeBadge";
import DamageCard from "../components/DamageCard";
import EvidenceViewer from "../components/EvidenceViewer";
import TechnicalPanel from "../components/TechnicalPanel";
import PricePanel from "../components/PricePanel";
import {
  DAMAGE_TYPE_OPTIONS,
  IMPACT_OPTIONS,
  SEVERITY_OPTIONS,
  TYPE_LABELS,
  SEVERITY_LABELS,
  IMPACT_LABELS,
} from "../lib/labels";

export default function ResultScreen({
  jobId,
  onRestart,
  onHome,
}: {
  jobId: string;
  onRestart: () => void;
  onHome: () => void;
}) {
  const [result, setResult] = useState<ConditionResult | null>(null);
  const [imagesExpanded, setImagesExpanded] = useState(false);
  const [viewer, setViewer] = useState<{ damage: Damage; index: number } | null>(null);
  const [addingDamage, setAddingDamage] = useState(false);
  // Dispute flow: a damage is picked, the seller shoots a close-up, Gemini adjudicates.
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ tone: "good" | "warn"; title: string; reason: string } | null>(null);
  const closeUpInputRef = useRef<HTMLInputElement>(null);
  // Adding a missed damage: the mirror of a dispute — seller points, photographs, model describes.
  const [addingFromPhoto, setAddingFromPhoto] = useState(false);
  const addPhotoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getJob(jobId).then((j) => setResult(j.result));
  }, [jobId]);

  if (!result) {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Laddar resultat…</p>
      </div>
    );
  }

  const visible = result.damages.filter((d) => d.verification !== "REJECTED" || d.sellerAction);
  const activeCount = visible.filter((d) => d.sellerAction !== "rejected").length;

  function openDispute(damageId: string) {
    setVerdict(null);
    setDisputeFor(damageId);
    closeUpInputRef.current?.click();
  }

  async function handleCloseUp(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const damageId = disputeFor;
    setDisputeFor(null);
    if (!file || !damageId) return;
    setDisputing(damageId);
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await disputeDamage(jobId, damageId, dataUrl);
      setResult(r.result);
      setVerdict({
        tone: r.verdict === "REMOVE" ? "good" : "warn",
        title: r.verdict === "REMOVE" ? "Skadan togs bort" : "Skadan står kvar",
        reason: r.reason,
      });
    } catch (err) {
      setVerdict({ tone: "warn", title: "Kunde inte bedöma", reason: err instanceof Error ? err.message : "Något gick fel." });
    } finally {
      setDisputing(null);
    }
  }

  async function handleAddedPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAddingFromPhoto(true);
    setVerdict(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await addDamageFromPhoto(jobId, dataUrl);
      setResult(r.result);
      setVerdict({
        tone: r.added ? "good" : "warn",
        title: r.added ? "Skadan lades till" : "Ingen skada hittades i bilden",
        reason: r.reason,
      });
    } catch (err) {
      setVerdict({ tone: "warn", title: "Kunde inte bedöma", reason: err instanceof Error ? err.message : "Något gick fel." });
    } finally {
      setAddingFromPhoto(false);
    }
  }

  async function handleDamageAction(
    damage: Damage,
    action: "confirm" | "reject" | "edit",
    patch?: Partial<Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">>,
  ) {
    const updated = await actOnDamage(jobId, damage.id, action, patch);
    setResult(updated);
  }

  return (
    <div className="screen screen-light">
      {result.identity && (
        <h2 className="result-identity">{[result.identity.brand, result.identity.model].filter(Boolean).join(" ")}</h2>
      )}

      <div className="report-hero">
        {result.grade && (
          <section className="grade-hero">
            <GradeBadge grade={result.grade.grade} size={72} />
            <div className="grade-hero-label">{result.grade.label}</div>
            <p className="grade-hero-rationale">{result.grade.rationale}</p>
          </section>
        )}
        {result.price && <PricePanel price={result.price} />}
      </div>

      <h3 className="damage-summary-line">
        {activeCount === 0 ? "Vi hittade inga tydliga skador" : `Vi hittade ${activeCount} synlig${activeCount === 1 ? "" : "a"} skad${activeCount === 1 ? "a" : "or"}`}
      </h3>

      <div className="damage-groups">
        {groupByType(visible).map(({ type, items }) => (
          <div key={type} className="damage-group">
            <div className="damage-group-header">
              {TYPE_LABELS[type]} — {items.filter((d) => d.sellerAction !== "rejected").length}
            </div>
            <div className="damage-list">
              {items.map((d) => (
                <DamageCard
                  key={d.id}
                  jobId={jobId}
                  damage={d}
                  images={result.images}
                  hideType
                  onDispute={() => openDispute(d.id)}
                  disputing={disputing === d.id}
                  onAction={(action, patch) => handleDamageAction(d, action, patch)}
                  onOpenEvidence={(index) => setViewer({ damage: d, index })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {!addingDamage ? (
        <div className="add-damage-actions">
          <button className="btn btn-text" onClick={() => addPhotoInputRef.current?.click()} disabled={addingFromPhoto}>
            {addingFromPhoto ? "Bedömer närbilden…" : "📷 Lägg till skada med närbild"}
          </button>
          <button className="btn btn-text" onClick={() => setAddingDamage(true)}>
            + Lägg till för hand
          </button>
        </div>
      ) : (
        <AddDamageForm
          onCancel={() => setAddingDamage(false)}
          onSave={async (damage) => {
            const updated = await addDamage(jobId, damage);
            setResult(updated);
            setAddingDamage(false);
          }}
        />
      )}

      {result.coverage === "NOT_SUFFICIENTLY_VISIBLE" && (
        <div className="coverage-warning">
          ⚠️ Bedömningen är preliminär — inte hela möbeln syntes tydligt i bilderna.
          {result.coverageNote ? ` ${result.coverageNote}` : ""}
        </div>
      )}

      <div className="result-footer">
        <button className="btn btn-text" onClick={onHome}>
          Till startsidan
        </button>
        <button className="btn btn-primary" onClick={onRestart}>
          Starta en ny skanning
        </button>
      </div>

      <section className="collapsible-card">
        <button className="collapsible-header" onClick={() => setImagesExpanded((v) => !v)}>
          <span>🖼️ Tagna bilder</span>
          <span className="muted">{result.images.length} bilder ›</span>
        </button>
        {imagesExpanded && (
          <div className="taken-images-grid">
            {result.images.map((img) => (
              <img key={img.id} src={imageUrl(jobId, img.id)} alt="" />
            ))}
          </div>
        )}
      </section>

      <input
        ref={addPhotoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleAddedPhoto}
      />

      <input
        ref={closeUpInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleCloseUp}
      />

      {verdict && (
        <div className={`dispute-verdict dispute-${verdict.tone}`} onClick={() => setVerdict(null)}>
          <strong>{verdict.title}</strong>
          <p>{verdict.reason}</p>
          <span className="muted small">Tryck för att stänga</span>
        </div>
      )}

      <TechnicalPanel jobId={jobId} result={result} />

      {viewer && (
        <EvidenceViewer
          jobId={jobId}
          damage={viewer.damage}
          images={result.images}
          startIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Kunde inte läsa bilden."));
    reader.readAsDataURL(file);
  });
}

/** Groups findings by defect type for the "Repor — 4" style layout, preserving first-seen order. */
function groupByType(damages: Damage[]): Array<{ type: DamageType; items: Damage[] }> {
  const order: DamageType[] = [];
  const byType = new Map<DamageType, Damage[]>();
  for (const d of damages) {
    if (!byType.has(d.type)) {
      byType.set(d.type, []);
      order.push(d.type);
    }
    byType.get(d.type)!.push(d);
  }
  return order.map((type) => ({ type, items: byType.get(type)! }));
}

function AddDamageForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (damage: Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">) => void;
}) {
  const [type, setType] = useState<Damage["type"]>("scratch");
  const [part, setPart] = useState("");
  const [severity, setSeverity] = useState<Damage["severity"]>("S1");
  const [impact, setImpact] = useState<Damage["impact"]>("cosmetic");
  const [description, setDescription] = useState("");

  return (
    <div className="damage-card">
      <div className="damage-card-body">
        <label>
          Typ
          <select value={type} onChange={(e) => setType(e.target.value as Damage["type"])}>
            {DAMAGE_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Del
          <input value={part} onChange={(e) => setPart(e.target.value)} placeholder="t.ex. vänster armstöd" />
        </label>
        <label>
          Allvarlighet
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Damage["severity"])}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Typ av påverkan
          <select value={impact} onChange={(e) => setImpact(e.target.value as Damage["impact"])}>
            {IMPACT_OPTIONS.map((i) => (
              <option key={i} value={i}>
                {IMPACT_LABELS[i]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Beskrivning
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="damage-card-actions">
          <button className="btn btn-text" onClick={onCancel}>
            Avbryt
          </button>
          <button
            className="btn btn-primary btn-small"
            disabled={!part || !description}
            onClick={() => onSave({ type, part, semanticLocation: "", severity, impact, description })}
          >
            Lägg till
          </button>
        </div>
      </div>
    </div>
  );
}
