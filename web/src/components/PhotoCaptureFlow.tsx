import { useCallback, useEffect, useRef, useState } from "react";
import PhotoGuide from "./PhotoGuide";
import { ArrowLeftIcon, CheckIcon, CloseIcon, PhotosIcon, PlusIcon } from "./icons";
import { useT } from "../lib/i18n";
import { useCamera, type CameraErrorKind } from "../lib/useCamera";
import { fileToDataUrl } from "../lib/imageResize";
import {
  EXTRA_STEP,
  GUIDE_STEPS,
  MAX_PHOTOS,
  MIN_PHOTOS,
  canPlace,
  canSubmit,
  distinctShots,
  firstMissingCore,
  makeShot,
  missingCore,
  nextOpenStep,
  photoCount,
  placeShot,
  remainingToMin,
  removeShot,
  shotFor,
  stepIndex,
  stepLabels,
  takenByStep,
  type GuideShot,
  type GuideStep,
  type ShotOrigin,
} from "../lib/photoGuide";

/**
 * Bildguiden: en omslagsbild, sedan några håll, och minst fem bilder innan man får gå vidare.
 *
 * TRE LÄGEN, och bara ett av dem har kameran på:
 *   intro   — hur man tar bra bilder. Visas före kameran: behörighetsfrågan ska komma när säljaren själv
 *             tryckt "Börja fota", inte som en ruta över en text de inte hunnit läsa.
 *   step    — ett steg i taget, ovanpå kameran (eller på en mörk yta när kameran är av). Ta bild, ladda upp
 *             eller hoppa över. Efter en bild går guiden vidare av sig själv.
 *   review  — alla bilder, vad som saknas, och "lägg till fler". Här prövas minimikravet — inte vid varje steg.
 *
 * INGEN AI HÄR. Guiden ger råd om hur man fotograferar och låter säljaren avgöra om bilden duger. Det den
 * VET är bara vilket steg en bild hör till (etiketten följer med in i besiktningen) och hur många som finns.
 *
 * SKÄRMEN ÄGER INGEN REGEL. Vad som räknas som en bild, vad som saknas, i vilken ordning de skickas: allt det
 * står i lib/photoGuide.ts och prövas i tests/photoGuide.test.ts. Här ritas det bara.
 *
 * Komponenten skickar inget själv. `onDone` får bilderna; vem som skickar dem och vart bestämmer anroparen —
 * skicktestsidan (screens/SkickTestScreen) och senare fångstskärmen använder samma guide.
 */

const SEEN_KEY = "loopa.photoguide.intro-seen";

function introSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function markIntroSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Privat läge kan kasta. Introt visas då en gång till, vilket är ofarligt.
  }
}

type Phase = "intro" | "step" | "review";

const TIPS: Array<{ title: string; text: string }> = [
  { title: "Gott om ljus", text: "Öppna gardinerna, ingen blixt." },
  { title: "Hela möbeln syns", text: "Backa så att den får plats." },
  { title: "Gå nära på detaljer", text: "Material, mönster och eventuellt slitage." },
];

export interface PhotoCaptureFlowProps {
  /** Säljaren har minst fem bilder och trycker på knappen i granskningen. */
  onDone: (shots: GuideShot[]) => void;
  /** Vägen ut ur guiden. Har säljaren tagit bilder frågas först om de får kastas. */
  onExit: () => void;
  /** Texten på knappen i granskningen. */
  submitLabel?: string;
  /** Visa introt varje gång (true), eller bara första gången per session (standard). */
  alwaysShowIntro?: boolean;
  initialShots?: GuideShot[];
  /** Händelser för den som vill mäta eller logga: `vinkel_tagen`, `vinkel_hoppad`, `kamera_fel` … Guiden skickar själv ingenting. */
  onEvent?: (name: string, detail?: string) => void;
  /** Sant medan anroparen skickar bilderna: knappen står av så att inget skickas två gånger. */
  busy?: boolean;
  /** Ett fel från anroparens uppladdning, visat ovanför knappen. */
  submitError?: string | null;
}

export default function PhotoCaptureFlow({
  onDone,
  onExit,
  submitLabel,
  alwaysShowIntro = false,
  initialShots,
  onEvent,
  busy = false,
  submitError = null,
}: PhotoCaptureFlowProps) {
  const t = useT();
  const [shots, setShots] = useState<GuideShot[]>(initialShots ?? []);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const [initialPhase] = useState<Phase>(() =>
    initialShots?.length ? "review" : alwaysShowIntro || !introSeen() ? "intro" : "step",
  );
  const [phase, setPhase] = useState<Phase>(initialPhase);
  /** Introt öppnat som en påminnelse mitt i guiden — då är knappen "Fortsätt fota" och inte "Börja fota". */
  const [introFromTips, setIntroFromTips] = useState(false);
  const [activeId, setActiveId] = useState<string>(GUIDE_STEPS[0].id);
  /** Steget är en extra bild: ingen plats i stegraden, och guiden går tillbaka till granskningen efteråt. */
  const [extraMode, setExtraMode] = useState(false);
  /** Steget öppnades från granskningen (ta om, eller "Ta {steg}"): efter bilden går vi tillbaka dit, inte vidare i guiden. */
  const [returnToReview, setReturnToReview] = useState(false);
  /** Säljaren har valt kameran. Hoppas introt över (redan sett) börjar vi direkt i kameran — det är vad en andra omgång vill. */
  const [wantCamera, setWantCamera] = useState(initialPhase === "step");
  const [capturing, setCapturing] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [flash, setFlash] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  const emit = useCallback((name: string, detail?: string) => onEvent?.(name, detail), [onEvent]);
  const cam = useCamera((kind: CameraErrorKind) => emit("kamera_fel", kind));

  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const stepFileRef = useRef<HTMLInputElement>(null);
  const extraFilesRef = useRef<HTMLInputElement>(null);

  // Kameran är på i stegvyn när säljaren valt den, och släpps i de andra lägena: en kamera som lyser i
  // granskningen är en lampa som är tänd i onödan, och håller kameran upptagen för allt annat.
  useEffect(() => {
    if (phase === "step" && wantCamera && cam.status === "off") void cam.start();
    if (phase !== "step" && cam.status !== "off") cam.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, wantCamera, cam.status]);

  useEffect(() => {
    if (phase === "intro") emit("foto_tips");
    if (phase === "review") emit("granskar_bilder", String(shotsRef.current.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const step: GuideStep = extraMode ? EXTRA_STEP : (GUIDE_STEPS.find((s) => s.id === activeId) ?? GUIDE_STEPS[0]);
  const count = photoCount(shots);
  const missing = missingCore(shots);
  const full = shots.length >= MAX_PHOTOS;

  // ── Lägga till en bild ─────────────────────────────────────────────────────

  function goReview() {
    setExtraMode(false);
    setReturnToReview(false);
    setPhase("review");
  }

  /** En bild är tagen eller vald. `stepId` null = en extra bild. */
  function accept(dataUrl: string, origin: ShotOrigin, forStep: GuideStep | null): boolean {
    if (!canPlace(shotsRef.current, forStep?.id ?? null)) {
      setNote(t("Du har redan {max} bilder, det är max.", { max: MAX_PHOTOS }));
      return false;
    }
    const next = placeShot(shotsRef.current, makeShot(dataUrl, forStep, origin));
    shotsRef.current = next;
    setShots(next);
    setNote(null);
    return true;
  }

  function feedback(label: string, total: number) {
    setFlash(true);
    later(() => setFlash(false), 140);
    // Bara Android vibrerar; iOS ignorerar anropet. Ett kvitto på något man inte ser sker i ljuset från kameran.
    navigator.vibrate?.(12);
    setAnnounce(t("Bild sparad: {vy}. {antal} av minst {min}.", { vy: t(label), antal: total, min: MIN_PHOTOS }));
  }

  /** Efter en bild i ett steg: tillbaka till granskningen, eller nästa öppna steg — eller granskningen när inget är kvar. */
  function afterShot(from: GuideStep) {
    if (extraMode || returnToReview) return later(goReview, 350);
    const next = nextOpenStep(shotsRef.current, from.id);
    later(() => (next ? setActiveId(next.id) : goReview()), 350);
  }

  async function onShutter() {
    if (capturing || readingFiles) return;
    if (!canPlace(shotsRef.current, extraMode ? null : step.id)) {
      setNote(t("Du har redan {max} bilder, det är max.", { max: MAX_PHOTOS }));
      return;
    }
    setCapturing(true);
    try {
      const url = await cam.capture();
      if (!url) return;
      if (accept(url, "camera", extraMode ? null : step)) {
        emit(extraMode ? "extra_bild_tagen" : "vinkel_tagen", step.id);
        feedback(step.label, photoCount(shotsRef.current));
        afterShot(step);
      }
    } finally {
      setCapturing(false);
    }
  }

  /** Läser filer från filväljaren. `forStep` null = extra bilder (flera åt gången), annars EN bild till steget. */
  async function readFiles(files: File[], forStep: GuideStep | null) {
    if (files.length === 0) return;
    setReadingFiles(true);
    setNote(null);
    let added = 0;
    try {
      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          emit("fel_filtyp");
          setNote(t("Det där är ingen bildfil."));
          continue;
        }
        let url: string;
        try {
          url = await fileToDataUrl(file);
        } catch {
          emit("bild_olaslig");
          setNote(t("Den bilden gick inte att läsa. Prova en JPEG- eller PNG-fil."));
          continue;
        }
        if (!accept(url, "upload", forStep)) break;
        added++;
        emit(forStep ? "vinkel_fran_fil" : "extra_bild_fran_fil", forStep?.id ?? "extra");
      }
    } finally {
      setReadingFiles(false);
    }
    if (added > 0) {
      feedback((forStep ?? EXTRA_STEP).label, photoCount(shotsRef.current));
      if (forStep) afterShot(forStep);
      else if (phase === "step") later(goReview, 350);
    }
  }

  // ── Navigering ─────────────────────────────────────────────────────────────

  function skip() {
    if (!extraMode && !shotFor(shots, step.id)) emit("vinkel_hoppad", step.id);
    if (extraMode || returnToReview) return goReview();
    const next = nextOpenStep(shots, step.id);
    if (next) setActiveId(next.id);
    else goReview();
  }

  /** Öppnar ett steg från granskningen. Efter bilden går guiden tillbaka dit. */
  function openStep(id: string) {
    setActiveId(id);
    setExtraMode(false);
    setReturnToReview(true);
    setNote(null);
    setPhase("step");
  }

  function openExtra() {
    setExtraMode(true);
    setReturnToReview(true);
    setNote(null);
    setPhase("step");
  }

  function startShooting() {
    markIntroSeen();
    if (introFromTips) {
      setIntroFromTips(false);
      setPhase("step");
      return;
    }
    setWantCamera(true);
    setPhase("step");
  }

  function startWithUploads() {
    markIntroSeen();
    emit("bilder_fran_galleri");
    setWantCamera(false);
    setPhase("step");
  }

  function askLeave() {
    if (shots.length === 0) return onExit();
    emit("lamna_bekrafta");
    setLeaveConfirm(true);
  }

  function backFromStep() {
    if (extraMode || returnToReview || shots.length > 0) return goReview();
    setPhase("intro");
  }

  // ── Intro ──────────────────────────────────────────────────────────────────
  if (phase === "intro") {
    return (
      <div className="screen screen-light pg-intro">
        <button className="btn btn-back" onClick={introFromTips ? () => (setIntroFromTips(false), setPhase("step")) : onExit}>
          <ArrowLeftIcon /> {t("Tillbaka")}
        </button>
        <h1 className="screen-title">{t("Bra bilder ger en bättre annons")}</h1>
        <p className="muted pg-lede">{t("Fota från flera håll – då blir annonsen mer trovärdig och attraktiv.")}</p>

        <ol className="pg-tips">
          {TIPS.map((tip, i) => (
            <li key={tip.title} className="pg-tip">
              <span className="pg-tip-nr" aria-hidden="true">{i + 1}</span>
              <span>
                <strong>{t(tip.title)}</strong>
                <span className="pg-tip-text">{t(tip.text)}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="pg-steps-overview">
          <ol className="pg-dots" aria-label={t("Stegen")}>
            {GUIDE_STEPS.map((s) => (
              <li key={s.id} className={`pg-dot${s.core ? " pg-dot-core" : ""}`}>
                <span className="pg-dot-mark" aria-hidden="true" />
                <span className="pg-dot-label">{t(s.short)}</span>
              </li>
            ))}
          </ol>
          <p className="muted small">{t("Minst {antal} bilder. De två sista är valfria.", { antal: MIN_PHOTOS })}</p>
        </div>

        <div className="pg-actions">
          <button className="btn btn-primary" onClick={startShooting}>
            {introFromTips ? t("Fortsätt fota") : t("Börja fota")}
          </button>
          {!introFromTips && (
            <button className="btn btn-outline" onClick={startWithUploads}>
              {t("Jag har bilderna redan – ladda upp")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Granskning ─────────────────────────────────────────────────────────────
  if (phase === "review") {
    const kvar = remainingToMin(shots);
    const first = firstMissingCore(shots);
    const extras = shots.filter((s) => s.stepId === null);
    const identical = shots.length - distinctShots(shots).length;
    const ok = canSubmit(shots);

    return (
      <div className="screen screen-light pg-review">
        <button className="btn btn-back" onClick={askLeave}>
          <ArrowLeftIcon /> {t("Tillbaka")}
        </button>
        <h2 className="screen-title">{t("Dina bilder")}</h2>
        <p className="muted">
          {t("{antal} av högst {max} bilder", { antal: shots.length, max: MAX_PHOTOS })}
        </p>

        <div className="review-grid pg-grid">
          {GUIDE_STEPS.map((s) => {
            const shot = shotFor(shots, s.id);
            return shot ? (
              <div key={s.id} className="review-thumb pg-tile">
                <button className="pg-tile-hit" onClick={() => (emit("vinkel_ta_om", s.id), openStep(s.id))} aria-label={t("Ta om: {vy}", { vy: t(s.label) })}>
                  <img src={shot.dataUrl} alt={t(s.label)} />
                </button>
                <span className="review-thumb-label">{t(s.label)}</span>
                <button
                  className="review-thumb-remove"
                  onClick={() => (emit("ta_bort_bild", s.id), setShots((prev) => removeShot(prev, shot.id)))}
                  aria-label={t("Ta bort")}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ) : (
              <button
                key={s.id}
                className={`pg-tile pg-tile-empty${s.core ? " pg-tile-core" : ""}`}
                onClick={() => openStep(s.id)}
                aria-label={t("Ta bild: {vy}", { vy: t(s.label) })}
              >
                <PlusIcon size={18} />
                <span className="pg-tile-name">{t(s.label)}</span>
                <span className="pg-tile-sub">{s.core ? t("Hoppad") : t("Valfri")}</span>
              </button>
            );
          })}
          {extras.map((shot) => (
            <div key={shot.id} className="review-thumb pg-tile">
              <img src={shot.dataUrl} alt={t("Extra bild")} />
              <span className="review-thumb-label">{t("Extra bild")}</span>
              <button
                className="review-thumb-remove"
                onClick={() => (emit("ta_bort_bild", "extra"), setShots((prev) => removeShot(prev, shot.id)))}
                aria-label={t("Ta bort")}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
        </div>
        <p className="muted small pg-hint-row">{t("Tryck på en bild för att ta om den.")}</p>

        {/* Under minimum: säg exakt hur många som saknas, och erbjud att hoppa till det första sidan som saknas. */}
        {!ok && (
          <div className="review-missing" role="status">
            {kvar === 1
              ? t("Du behöver 1 bild till för att gå vidare.")
              : t("Du behöver {antal} bilder till för att gå vidare.", { antal: kvar })}
            {identical > 0 && <> {t("Några bilder är identiska och räknas bara en gång.")}</>}
            {first && (
              <>
                {" "}
                <button className="btn btn-text btn-inline" onClick={() => openStep(first.id)}>
                  {t("Ta {steg}", { steg: t(first.label).toLowerCase() })}
                </button>
              </>
            )}
          </div>
        )}
        {/* Över minimum men med en kärnvinkel som saknas: rådgivning, inget krav. Besiktningen kan inte uttala sig om det som inte syns. */}
        {ok && missing.length > 0 && (
          <p className="review-missing">
            {t("Saknas: {vyer}. Besiktningen kan inte säga något om de sidorna.", { vyer: stepLabels(missing).map((l) => t(l)).join(", ") })}{" "}
            <button className="btn btn-text btn-inline" onClick={() => openStep(missing[0].id)}>
              {t("Ta dem nu")}
            </button>
          </p>
        )}

        <section className="pg-more">
          <h3 className="pg-more-title">{t("Lägg till fler bilder")}</h3>
          <p className="muted small">{t("Närbilder på detaljer gör annonsen mer trovärdig.")}</p>
          <div className="review-add-actions">
            <button className="btn btn-text icon-btn" disabled={full || readingFiles} onClick={openExtra}>
              <PlusIcon size={15} /> {t("Ta bild")}
            </button>
            <button className="btn btn-text icon-btn" disabled={full || readingFiles} onClick={() => extraFilesRef.current?.click()}>
              <PlusIcon size={15} /> {readingFiles ? t("Läser…") : t("Ladda upp")}
            </button>
            <input
              ref={extraFilesRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void readFiles(files, null);
              }}
            />
          </div>
          {full && <p className="muted small">{t("Du har redan {max} bilder, det är max.", { max: MAX_PHOTOS })}</p>}
        </section>

        {note && <p className="error-text" role="alert">{note}</p>}
        {submitError && <p className="error-text" role="alert">{submitError}</p>}
        {ok && <p className="muted small pg-more-hint">{t("Fler vinklar ger en mer övertygande annons.")}</p>}

        <button
          className="btn btn-primary"
          disabled={!ok || busy || readingFiles}
          onClick={() => onDone(shots)}
        >
          {busy
            ? t("Skickar…")
            : ok
              ? (submitLabel ?? t("Fortsätt med mina bilder"))
              : kvar === 1
                ? t("Lägg till 1 bild till")
                : t("Lägg till {antal} bilder till", { antal: kvar })}
        </button>

        <div className="visually-hidden" aria-live="polite">{announce}</div>
        {leaveConfirm && <LeaveDialog count={shots.length} onStay={() => (emit("lamna_stanna"), setLeaveConfirm(false))} onLeave={onExit} />}
      </div>
    );
  }

  // ── Steg ───────────────────────────────────────────────────────────────────
  const taken = takenByStep(shots);
  const have = !extraMode && !!shotFor(shots, step.id);
  const cameraOn = cam.status === "live" || cam.status === "starting";
  const last = !extraMode && stepIndex(step.id) === GUIDE_STEPS.length - 1;
  const skipLabel = extraMode ? t("Avbryt") : last ? t("Klar") : have ? t("Nästa") : t("Hoppa över");

  return (
    <div className="screen screen-camera pg-camera">
      <video ref={cam.videoRef} className={`camera-feed pg-feed${cameraOn ? "" : " pg-feed-off"}`} muted playsInline autoPlay />
      <div className={`pg-flash${flash ? " pg-flash-on" : ""}`} aria-hidden="true" />

      <div className="pg-topbar">
        {/* Bara pilen: på en smal telefon ryms inte "Tillbaka", räknaren, Tips och Klar på en rad. */}
        <button className="btn btn-ghost pg-chip" onClick={backFromStep} aria-label={t("Tillbaka")}>
          <ArrowLeftIcon />
        </button>
        <span className={`pg-count${count >= MIN_PHOTOS ? " pg-count-ok" : ""}`}>
          {count >= MIN_PHOTOS && <CheckIcon size={13} />}
          {t("{antal} av minst {min}", { antal: count, min: MIN_PHOTOS })}
        </span>
        <span className="pg-topbar-right">
          <button className="btn btn-ghost pg-chip" onClick={() => (emit("foto_tips_oppnad"), setIntroFromTips(true), setPhase("intro"))}>
            {t("Tips")}
          </button>
          {!extraMode && shots.length > 0 && !returnToReview && (
            <button className="btn btn-ghost pg-chip" onClick={goReview}>
              {t("Klar")}
            </button>
          )}
        </span>
      </div>

      <PhotoGuide
        stations={extraMode ? [EXTRA_STEP] : GUIDE_STEPS}
        activeId={step.id}
        taken={taken}
        onJump={(id) => (setActiveId(id), setNote(null))}
        stepLabel={extraMode ? t("Extra bild · {antal} av {max}", { antal: shots.length + 1, max: MAX_PHOTOS }) : undefined}
        hideStrip={extraMode}
        stripLabel={(s) => (s as GuideStep).short ?? s.label}
      />

      {/* Kameran är av eller har fallit: säg varför, och ge uppladdning som den enda tydliga vägen — aldrig en återvändsgränd. */}
      {!cameraOn && (
        <div className="pg-nocam" role="status">
          {cam.error ? (
            <>
              <p>{cam.error.message}</p>
              <div className="pg-nocam-actions">
                <button className="btn btn-primary btn-small" onClick={() => (emit("ladda_upp_istallet"), stepFileRef.current?.click())}>
                  <PhotosIcon size={16} /> {t("Välj från galleriet")}
                </button>
                {cam.available && (
                  <button className="btn btn-outline btn-small" onClick={() => void cam.start()}>
                    {t("Försök igen")}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p>{t("Kameran är av. Ladda upp en bild till det här steget, eller starta kameran.")}</p>
              <div className="pg-nocam-actions">
                <button className="btn btn-primary btn-small" onClick={() => stepFileRef.current?.click()}>
                  <PhotosIcon size={16} /> {t("Ladda upp")}
                </button>
                {cam.available && (
                  <button className="btn btn-outline btn-small" onClick={() => (setWantCamera(true), void cam.start())}>
                    {t("Starta kameran")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {have && cameraOn && <p className="pg-have">{t("Bilden är tagen. Ta en ny för att byta ut den.")}</p>}
      {note && <p className="error-text camera-error-overlay" role="alert">{note}</p>}

      <div className="guided-controls">
        <button className="btn btn-ghost guided-side" onClick={() => stepFileRef.current?.click()} disabled={readingFiles}>
          <PhotosIcon size={18} />
          {readingFiles ? t("Läser…") : t("Ladda upp")}
        </button>
        {cameraOn ? (
          <button
            className="shutter-btn"
            onClick={() => void onShutter()}
            disabled={capturing || cam.status !== "live"}
            aria-label={t("Ta bild: {vy}", { vy: t(step.label) })}
          />
        ) : (
          <span className="guided-shutter-gap" />
        )}
        <button className="btn btn-ghost guided-side" onClick={skip}>
          {skipLabel}
        </button>
      </div>

      <input
        ref={stepFileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void readFiles(files.slice(0, 1), extraMode ? null : step);
        }}
      />
      <div className="visually-hidden" aria-live="polite">{announce}</div>
    </div>
  );
}

/** "Lämna fotograferingen?" — bilderna ligger bara i minnet, så att gå ut är att kasta dem. */
function LeaveDialog({ count, onStay, onLeave }: { count: number; onStay: () => void; onLeave: () => void }) {
  const t = useT();
  return (
    <div className="pg-modal-scrim" role="presentation">
      <div className="pg-modal" role="alertdialog" aria-modal="true" aria-labelledby="pg-leave-title">
        <h3 id="pg-leave-title">{t("Lämna fotograferingen?")}</h3>
        <p className="muted">{t("Du har {antal} bilder som inte är skickade. De sparas inte om du lämnar.", { antal: count })}</p>
        <div className="pg-actions">
          <button className="btn btn-primary" onClick={onStay} autoFocus>{t("Stanna")}</button>
          <button className="btn btn-outline" onClick={onLeave}>{t("Lämna")}</button>
        </div>
      </div>
    </div>
  );
}
