import { useState } from "react";
import type { CapturedImage, Damage } from "../types";
import {
  typeLabel,
  severityLabel,
  impactLabel,
  DAMAGE_TYPE_OPTIONS,
  SEVERITY_OPTIONS,
  IMPACT_OPTIONS,
} from "../lib/labels";
import { useT } from "../lib/i18n";
import MarkedThumb from "./MarkedThumb";
import DamageCrop from "./DamageCrop";
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
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(damage);
  /* På telefonen bär kortet ett litet UTSNITT av skadan, inte hela bevisfotot. En lista där varje
     fynd har ett stort foto blir en bildremsa man skrollar förbi i stället för en lista man läser —
     men en kvadrat i radhöjd som visar bara skadan svarar på "hur ser den ut" utan att ta någon
     plats alls, och det är den frågan säljaren ställer först. Hela bilden, med fyndet utpekat i sitt
     sammanhang, ligger kvar ett tryck bort. Datorvyn har bredden att visa den direkt, och gör det. */
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
            {t("Typ")}
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Damage["type"] })}>
              {DAMAGE_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Del")}
            <input value={draft.part} onChange={(e) => setDraft({ ...draft, part: e.target.value })} />
          </label>
          <label>
            {t("Allvarlighet")}
            <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Damage["severity"] })}>
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {severityLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Typ av påverkan")}
            <select value={draft.impact} onChange={(e) => setDraft({ ...draft, impact: e.target.value as Damage["impact"] })}>
              {IMPACT_OPTIONS.map((i) => (
                <option key={i} value={i}>
                  {impactLabel(i)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Beskrivning")}
            <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="damage-card-actions">
            <button className="btn btn-text" onClick={() => setEditing(false)}>
              {t("Avbryt")}
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
        {!hideType && <strong>{typeLabel(damage.type)}</strong>}
        <span className="muted">
          {damage.part}
          {damage.semanticLocation ? ` · ${damage.semanticLocation}` : ""}
        </span>
      </span>
      <span className={`chip chip-${damage.severity}`}>{severityLabel(damage.severity)}</span>
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
          {primaryEvidence ? (
            <span className="damage-card-open-row">
              <DamageCrop
                jobId={jobId}
                evidence={primaryEvidence}
                image={imageById.get(primaryEvidence.imageId)}
                count={damage.evidence.length}
              />
              <span className="damage-card-open-text">
                {header}
                {description}
              </span>
            </span>
          ) : (
            /* Ett fynd utan bildruta finns: säljaren kan ha lagt till det själv. Då är kortet text,
               precis som förut, och knappen är redan avstängd. */
            <>
              {header}
              {description}
            </>
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
      {damage.recaptureRequested && (
        <p className="warning-text">
          {t("Osäkert fynd — en ny, skarpare bild skulle ge en säkrare bedömning.")}
        </p>
      )}

      <div className="damage-card-actions">
        {!rejected ? (
          <button className="btn btn-text btn-remove" onClick={onDispute} disabled={disputing}>
            {disputing ? t("Bedömer närbilden…") : t("Ta bort")}
          </button>
        ) : (
          <button className="btn btn-text" onClick={() => onAction("confirm")}>
            {t("Återställ")}
          </button>
        )}
        <button className="btn btn-text" onClick={() => setEditing(true)}>
          {t("Redigera")}
        </button>
      </div>
    </div>
  );
}
