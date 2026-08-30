import { useEffect, useRef, useState } from "react";
import { actOnDamage, addDamage, addDamageFromPhoto, disputeDamage, getJob, imageUrl } from "../api";
import type { ConditionResult, Damage, DamageType } from "../types";
import GradeBadge from "../components/GradeBadge";
import DamageCard from "../components/DamageCard";
import EvidenceViewer from "../components/EvidenceViewer";
import TechnicalPanel from "../components/TechnicalPanel";
import { AlertIcon, ArrowLeftIcon, CameraIcon, ChevronRight, PhotosIcon, PlusIcon } from "../components/icons";
import FlowSteps from "../components/FlowSteps";
import {
  DAMAGE_TYPE_OPTIONS,
  IMPACT_OPTIONS,
  SEVERITY_OPTIONS,
  typeLabel,
  severityLabel,
  impactLabel,
} from "../lib/labels";
import { usePageTitle } from "../lib/pageTitle";
import { t as translate, useLang, useT } from "../lib/i18n";

/**
 * Skicket och skadorna — och EN väg vidare.
 *
 * Annonsen var förut en knapp bland tre: "se annonsen", "startsidan", "skanna en möbel till".
 * Tre knappar sida vid sida gör kortet till ett val, och ett val går att välja bort — säljaren kunde
 * skanna färdigt utan att någonsin se det kort som är hela produkten. Kortet är inte ett tillval till
 * besiktningen, det ÄR vad besiktningen blir, så det är det enda steget härifrån.
 *
 * Vägen ut finns kvar överst, som på varje annan skärm i flödet. Att backa är inte ett nästa steg.
 */
export default function ResultScreen({
  jobId,
  onHome,
  onContinue,
}: {
  jobId: string;
  onHome: () => void;
  /** Vidare till annonsen. Får resultatet med sig, så steget aldrig kan falla på en hämtning. */
  onContinue: (result: ConditionResult) => void;
}) {
  const [result, setResult] = useState<ConditionResult | null>(null);
  const t = useT();
  const { lang } = useLang();
  usePageTitle("Skickbedömning");
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
    let cancelled = false;
    // Delresultatet publiceras innan andrabesiktningen är klar, så vyn fortsätter fråga tills
    // granskningen landat — annars stod säljaren kvar med en fyndlista märkt "pågår" för alltid.
    const poll = async () => {
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        if (j.result) setResult(j.result);
        if (j.result?.reviewPending || j.result?.listing?.status === "pending") setTimeout(poll, 1500);
      } catch {
        if (!cancelled) setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!result) {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>{t("Laddar resultat…")}</p>
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
        title: r.verdict === "REMOVE" ? t("Skadan togs bort") : t("Skadan står kvar"),
        reason: r.reason,
      });
    } catch (err) {
      setVerdict({
        tone: "warn",
        title: t("Kunde inte bedöma"),
        reason: err instanceof Error ? err.message : t("Något gick fel."),
      });
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
        title: r.added ? t("Skadan lades till") : t("Ingen skada hittades i bilden"),
        reason: r.reason,
      });
    } catch (err) {
      setVerdict({
        tone: "warn",
        title: t("Kunde inte bedöma"),
        reason: err instanceof Error ? err.message : t("Något gick fel."),
      });
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
    <div className="screen screen-light result-screen">
      <button className="btn btn-text btn-back" onClick={onHome}>
        <ArrowLeftIcon /> {t("Startsidan")}
      </button>

      <FlowSteps current={4} />

      {result.identity && (
        <h2 className="result-identity">{[result.identity.brand, result.identity.model].filter(Boolean).join(" ")}</h2>
      )}

      {/* Domen och det den vilar på: betyg, granskningens status, underlaget. I datorvyn blir det
          här en fäst vänsterspalt som står kvar medan fynden rullar förbi — på telefonen är
          omslaget genomskinligt och raderna ligger kvar precis där de låg. */}
      <div className="result-rail">
        {/* Bara betyget här. Priset stod i steget före och är samma siffra — upprepat på skadesidan
            läser det som ett nytt besked, och skadelistan under det som en andra nedräkning. */}
        {result.grade && (
          <section className="grade-hero">
            <GradeBadge grade={result.grade.grade} size={72} />
            <div className="grade-hero-label">{result.grade.label}</div>
            <p className="grade-hero-rationale">{result.grade.rationale}</p>
          </section>
        )}

        {result.reviewPending && (
          <div className="review-banner">
            <span className="review-spinner" aria-hidden="true" />
            {t("Andrabesiktningen pågår — listan kan ändras när den är klar.")}
          </div>
        )}

        {/* Kortet är ett attest. Det ska säga vad det bygger på — antal vyer, hur många besiktningar,
            när — i stället för att låta läsaren anta det starkare alternativet. */}
        <p className="provenance">
          {result.images.length === 1
            ? t("{antal} vy", { antal: result.images.length })
            : t("{antal} vyer", { antal: result.images.length })}{" "}
          · {result.reviewed ? t("två besiktningar") : t("en besiktning")} ·{" "}
          {new Date(result.createdAt).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" })}
        </p>
      </div>

      {/* Fynden och vad man gör med dem. Datorvyns högerspalt. */}
      <div className="result-main">
        <h3 className="damage-summary-line">
          {activeCount === 0
            ? t("Vi hittade inga tydliga skador")
            : activeCount === 1
              ? t("Vi hittade {antal} synlig skada", { antal: activeCount })
              : t("Vi hittade {antal} synliga skador", { antal: activeCount })}
        </h3>

        <div className="damage-groups">
          {groupByType(visible).map(({ type, items }) => (
            <div key={type} className="damage-group">
              <div className="damage-group-header">
                {typeLabel(type)} — {items.filter((d) => d.sellerAction !== "rejected").length}
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
            <button className="btn btn-text icon-btn" onClick={() => addPhotoInputRef.current?.click()} disabled={addingFromPhoto}>
              <CameraIcon size={17} />
              {addingFromPhoto ? t("Bedömer närbilden…") : t("Lägg till skada med närbild")}
            </button>
            <button className="btn btn-text icon-btn" onClick={() => setAddingDamage(true)}>
              <PlusIcon size={16} />
              {t("Lägg till för hand")}
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
            <span className="coverage-warning-mark" aria-hidden="true">
              <AlertIcon size={17} />
            </span>
            <span>
              {t("Bedömningen är preliminär — inte hela möbeln syntes tydligt i bilderna.")}
              {result.coverageNote ? ` ${result.coverageNote}` : ""}
            </span>
          </div>
        )}

        <button className="btn btn-primary next-step" onClick={() => onContinue(result)}>
          <span>{t("Se annonsen")}</span>
          <span className="next-step-meta">
            {result.listing?.status === "pending" ? t("skapas…") : result.listing?.status === "ok" ? t("klart") : ""}
            <ChevronRight size={18} />
          </span>
        </button>
        <p className="form-hint">
          {t("Sista steget före försäljningen. Annonsen är det köparen ser — skadorna du rättat här följer med dit.")}
        </p>
      </div>

      <section className="collapsible-card">
        <button className="collapsible-header" onClick={() => setImagesExpanded((v) => !v)}>
          <span className="collapsible-title collapsible-title-icon">
            <PhotosIcon size={17} />
            {t("Tagna bilder")}
          </span>
          <span className="collapsible-meta">
            {result.images.length}
            <span className={`collapsible-chevron ${imagesExpanded ? "collapsible-chevron-open" : ""}`}>
              <ChevronRight size={16} />
            </span>
          </span>
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
          <span className="muted small">{t("Tryck för att stänga")}</span>
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
    reader.onerror = () => reject(new Error(translate("Kunde inte läsa bilden.")));
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
  const t = useT();
  const [type, setType] = useState<Damage["type"]>("scratch");
  const [part, setPart] = useState("");
  const [severity, setSeverity] = useState<Damage["severity"]>("S1");
  const [impact, setImpact] = useState<Damage["impact"]>("cosmetic");
  const [description, setDescription] = useState("");

  return (
    <div className="damage-card">
      <div className="damage-card-body">
        <label>
          {t("Typ")}
          <select value={type} onChange={(e) => setType(e.target.value as Damage["type"])}>
            {DAMAGE_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Del")}
          <input
            value={part}
            onChange={(e) => setPart(e.target.value)}
            placeholder={t("t.ex. vänster armstöd")}
          />
        </label>
        <label>
          {t("Allvarlighet")}
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Damage["severity"])}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {severityLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Typ av påverkan")}
          <select value={impact} onChange={(e) => setImpact(e.target.value as Damage["impact"])}>
            {IMPACT_OPTIONS.map((i) => (
              <option key={i} value={i}>
                {impactLabel(i)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Beskrivning")}
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="damage-card-actions">
          <button className="btn btn-text" onClick={onCancel}>
            {t("Avbryt")}
          </button>
          <button
            className="btn btn-primary btn-small"
            disabled={!part || !description}
            onClick={() => onSave({ type, part, semanticLocation: "", severity, impact, description })}
          >
            {t("Lägg till")}
          </button>
        </div>
      </div>
    </div>
  );
}
