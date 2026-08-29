import { useState } from "react";
import type { CapturedImage, Damage } from "../types";
import {
  TYPE_LABELS,
  SEVERITY_LABELS,
  IMPACT_LABELS,
  DAMAGE_TYPE_OPTIONS,
  SEVERITY_OPTIONS,
  IMPACT_OPTIONS,
} from "../lib/labels";
import MarkedThumb from "./MarkedThumb";
import { PhotosIcon } from "./icons";
import { useViewMode } from "../lib/viewMode";

export default function DamageCard({
  onDispute,
  disputing,
  jobId,
  damage,
  images,
  hideType,
  onAction,
  onOpenEvidence,
}: {
  jobId: string;
  damage: Damage;
  images: CapturedImage[];
  /** opens the close-up capture that backs a dispute */
  onDispute: () => void;
  disputing?: boolean;
  /** when rendered under a "{Type} — N" group header, skip repeating the type in this card */
  hideType?: boolean;
  onAction: (
    action: "confirm" | "reject" | "edit",
    patch?: Partial<Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">>,
  ) => void;
  onOpenEvidence: (index: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(damage);
  /* På telefonen är kortet text, inte foto: en lista där varje fynd bär ett stort bevisfoto blir en
     bildremsa man skrollar förbi i stället för en lista man läser. Bilden ligger ett tryck bort.
     Datorvyn har bredden att visa den direkt, och gör det. */
  const mobile = useViewMode() === "mobile";

  const rejected = damage.sellerAction === "rejected";
  const imageById = new Map(images.map((img) => [img.id, img]));
  const [primaryEvidence, ...restEvidence] = damage.evidence;

  function saveEdit() {
    onAction("edit", {
      type: draft.type,
      part: draft.part,
      semanticLocation: draft.semanticLocation,
      severity: draft.severity,
      impact: draft.impact,
      description: draft.description,
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="damage-card">
        <div className="damage-card-body">
          <label>
            Typ
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Damage["type"] })}>
              {DAMAGE_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Del
            <input value={draft.part} onChange={(e) => setDraft({ ...draft, part: e.target.value })} />
          </label>
          <label>
            Allvarlighet
            <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Damage["severity"] })}>
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Typ av påverkan
            <select value={draft.impact} onChange={(e) => setDraft({ ...draft, impact: e.target.value as Damage["impact"] })}>
              {IMPACT_OPTIONS.map((i) => (
                <option key={i} value={i}>
                  {IMPACT_LABELS[i]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Beskrivning
            <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="damage-card-actions">
            <button className="btn btn-text" onClick={() => setEditing(false)}>
              Avbryt
            </button>
            <button className="btn btn-primary btn-small" onClick={saveEdit}>
              Spara
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Samma rubrik och text i båda lägena — på telefonen ligger de i själva tryckytan, på datorn
  // ovanför och under bilden. Span, inte div/p: det som står inuti en knapp måste vara inline.
  const header = (
    <span className="damage-card-header-row">
      <span className="damage-card-title">
        {!hideType && <strong>{TYPE_LABELS[damage.type]}</strong>}
        <span className="muted">
          {damage.part}
          {damage.semanticLocation ? ` · ${damage.semanticLocation}` : ""}
        </span>
      </span>
      <span className={`chip chip-${damage.severity}`}>{SEVERITY_LABELS[damage.severity]}</span>
    </span>
  );
  const description = <span className="damage-desc">{damage.description}</span>;

  return (
    <div className={`damage-card ${rejected ? "damage-card-rejected" : ""}`}>
      {mobile ? (
        <button
          type="button"
          className="damage-card-open"
          onClick={() => onOpenEvidence(0)}
          disabled={damage.evidence.length === 0}
        >
          {header}
          {description}
          {damage.evidence.length > 0 && (
            <span className="damage-evidence-hint">
              <PhotosIcon size={15} />
              {damage.evidence.length === 1 ? "Visa bilden" : `Visa ${damage.evidence.length} bilder`}
            </span>
          )}
        </button>
      ) : (
        <>
          {header}
          {primaryEvidence && (
            <button className="damage-evidence-main" onClick={() => onOpenEvidence(0)}>
              <MarkedThumb jobId={jobId} evidence={primaryEvidence} image={imageById.get(primaryEvidence.imageId)} size="lg" />
            </button>
          )}
          {restEvidence.length > 0 && (
            <div className="evidence-mini-rail">
              {restEvidence.map((ev, i) => (
                <MarkedThumb key={i} jobId={jobId} evidence={ev} image={imageById.get(ev.imageId)} onClick={() => onOpenEvidence(i + 1)} />
              ))}
            </div>
          )}
          {description}
        </>
      )}
      {damage.recaptureRequested && <p className="warning-text">Osäkert fynd — en ny, skarpare bild skulle ge en säkrare bedömning.</p>}

      <div className="damage-card-actions">
        {!rejected ? (
          <button className="btn btn-text btn-remove" onClick={onDispute} disabled={disputing}>
            {disputing ? "Bedömer närbilden…" : "Ta bort"}
          </button>
        ) : (
          <button className="btn btn-text" onClick={() => onAction("confirm")}>
            Återställ
          </button>
        )}
        <button className="btn btn-text" onClick={() => setEditing(true)}>
          Redigera
        </button>
      </div>
    </div>
  );
}
