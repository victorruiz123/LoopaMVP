import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CameraIcon, FolderIcon, PhotosIcon, SofaIcon, VideoIcon } from "../components/icons";
import { createJob, type CapturedShot } from "../api";
import type { FurnitureIdentity } from "../types";
import { extractBestFrames, EXTRACTION_TARGET_MS, type ExtractionReport } from "../lib/videoFrames";
import { requestRotationPermission, startRotationTracking, type RotationTracker } from "../lib/rotationTracker";
import { useViewMode } from "../lib/viewMode";
import WalkaroundGuide from "../components/WalkaroundGuide";
import { usePageTitle } from "../lib/pageTitle";

const MAX_UPLOAD_WIDTH = 1280;
/**
 * Måste följa MAX_IMAGES_PER_JOB i server/src/config.ts.
 *
 * Klienten tog tidigare tio bilder medan servern kapade vid sex, så bild sju till tio laddades upp,
 * skalades, visades i granskningsrutan — och kastades sedan tyst innan inspektionen. Säljaren såg tio
 * vyer och fick sex bedömda, utan att något sa det.
 */
const MAX_IMAGES = 6;
const MAX_RECORD_MS = 60000; // hard ceiling only — a lap normally ends itself well before this
const FULL_LAP_DEG = 360;
/** No orientation events within this long means no usable sensor: fall back to stopping by hand. */
const SENSOR_GRACE_MS = 2500;
/**
 * A full lap in 35-40s is about 9-10 deg/s. Above this the phone is moving faster than the frame
 * selector can find a still moment — measured on a real walkaround, every one of the eight selected
 * frames came back soft, which is what makes small marks on light paint invisible.
 */
const TOO_FAST_DEG_PER_S = 18;
/**
 * Varvet får inte ta slut innan filmen hunnit bli en film.
 *
 * Sensorn kan spreta — en glapp kompass, en telefon som vrids i handen — och utan golv räckte det för
 * att avsluta inspelningen efter ett par sekunder. Det som blev kvar var en snutt som varken gick att
 * välja bildrutor ur eller att förstå: "kunde inte läsa någon bildruta ur videon", varje gång. Ett
 * varv runt en soffa går inte att gå på under tio sekunder, så under det är det inte ett varv.
 */
const MIN_LAP_MS = 10000;
/** Under det här är inspelningen inte en film utan en tom ström eller ett feltryck. */
const MIN_CLIP_MS = 2500;
const MIN_CLIP_BYTES = 15000;
const GUIDANCE_STEPS = [
  "Stå framför möbeln",
  "Rör dig sakta mot höger sida",
  "Fortsätt runt till baksidan",
  "Fortsätt till vänster sida",
  "Kom tillbaka mot framsidan",
];

type Shot = { id: string; dataUrl: string; viewLabel: string | null; source: "video" | "manual" };
type Mode = "choose" | "photo" | "video" | "processing" | "review" | "creating";

let shotCounter = 0;

export default function CaptureScreen({
  identity,
  onBack,
  onCaptured,
}: {
  identity: FurnitureIdentity;
  onBack: () => void;
  onCaptured: (jobId: string, previewShots: CapturedShot[]) => void;
}) {
  /**
   * Mobilvyn har en enda väg in: filma ett varv.
   *
   * Att välja märke ÄR att börja filma — valskärmen hoppas över helt, och de tre vägar som bygger på
   * filer (ladda upp video, ladda upp bilder, ta bilder för hand) finns inte alls. På en telefon står
   * möbeln framför säljaren; en filväljare leder till kamerarullen, inte till möbeln.
   */
  const videoOnly = useViewMode() === "mobile";
  usePageTitle("Filma möbeln");
  const [pickedMode, setMode] = useState<Mode>("choose");
  const mode: Mode = videoOnly && pickedMode === "choose" ? "video" : pickedMode;
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  /**
   * getUserMedia is blocked outside a secure context, so over plain http on a LAN address the two
   * camera cards lead to a black screen with no explanation — the error was only ever rendered on the
   * choose screen, which the seller has already left by then. Detect it up front instead.
   */
  const cameraAvailable =
    typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  /**
   * Räknare, inte flagga. En ny ström måste fästas på <video> igen, och med en flagga som redan stod
   * på `true` hoppade fästningen över omtaget — bilden frös på den döda strömmen.
   */
  const [streamEpoch, setStreamEpoch] = useState(0);
  const cameraStarted = streamEpoch > 0;
  const [recording, setRecording] = useState(false);
  const [recordMs, setRecordMs] = useState(0);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [tooFast, setTooFast] = useState(false);
  const paceRef = useRef<{ deg: number; at: number } | null>(null);
  /** null until we know: true once rotation actually arrives, false when the grace period lapses. */
  const [hasRotation, setHasRotation] = useState<boolean | null>(null);
  const trackerRef = useRef<RotationTracker | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  /** Vilken väg bildruteuttaget tog och hur länge det tog — synligt, så en seg körning går att felsöka. */
  const [extraction, setExtraction] = useState<ExtractionReport | null>(null);
  const [processingMs, setProcessingMs] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef(0);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /**
   * Acquires the stream ONLY. It used to attach it to videoRef here too, but this runs while mode is
   * still "choose" — the <video> element lives in the photo/video screens and has not rendered yet, so
   * `if (videoRef.current)` fell through silently. The camera turned on, the stream went nowhere, and
   * the seller got a black rectangle. Attaching belongs in the effect below, once the element exists.
   */
  async function startCamera() {
    setCameraError(null);
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          // 4:3 är hela sensorn på i stort sett varje telefon. Begäran var tidigare kvadratisk
          // (1280×1280), och eftersom ingen sensor är kvadratisk löste webbläsaren det genom att
          // beskära — bildvinkeln krympte, och säljaren fick backa flera meter för att få in soffan.
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      await widenFieldOfView(streamRef.current);
      setStreamEpoch((n) => n + 1);
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : "Kunde inte starta kameran.");
    }
  }

  // Attach the stream once the <video> for this mode is actually in the DOM.
  useEffect(() => {
    if (mode !== "photo" && mode !== "video") return;
    const el = videoRef.current;
    const stream = streamRef.current;
    if (!el || !stream || el.srcObject === stream) return;
    el.srcObject = stream;
    el.play().catch((err) => {
      setCameraError(err instanceof Error ? err.message : "Kameran kunde inte spelas upp.");
    });
  }, [mode, streamEpoch]);

  /**
   * En ström vars spår har stannat är lika död som ingen ström alls — men den ser ut att finnas.
   *
   * iOS stänger kamerans spår när appen går i bakgrunden, och webbläsaren gör det när fliken tappar
   * enheten till något annat. Kollas bara `streamRef.current` startar MediaRecorder på ett stoppat
   * spår, spelar in noll bytes, och felet dyker upp först i bildruteuttaget — långt från orsaken.
   */
  function hasLiveCamera() {
    return streamRef.current?.getVideoTracks().some((t) => t.readyState === "live") ?? false;
  }

  async function enterMode(next: "photo" | "video") {
    if (!cameraAvailable) {
      setCameraError(
        "Kameran kan bara användas över HTTPS eller på localhost. Den här sidan körs över vanlig http, " +
          "så webbläsaren blockerar den. " +
          (videoOnly
            ? "Öppna sidan över https för att kunna filma."
            : "Filma med telefonens kameraapp och välj \"Ladda upp en videofil\" i stället."),
      );
      return;
    }
    if (!hasLiveCamera()) await startCamera();
    setMode(next);
  }

  /**
   * Mobilvyn startar kameran själv — där finns inget kort att trycka på, och inspelningsskärmen ritas
   * direkt efter märkesvalet. Bara när strömmen saknas, så ett omtag efter en misslyckad film inte
   * startar om kameran i onödan.
   */
  useEffect(() => {
    if (!videoOnly || mode !== "video" || hasLiveCamera()) return;
    void enterMode("video");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoOnly, mode]);

  /** I mobilvyn finns ingen valskärm bakom kameran — vägen bakåt går hela vägen ut. */
  function leaveCamera() {
    if (videoOnly) onBack();
    else setMode("choose");
  }

  function addShot(dataUrl: string, source: Shot["source"], viewLabel: string | null = null) {
    setShots((prev) => [...prev, { id: `s${shotCounter++}`, dataUrl, viewLabel, source }]);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const scale = Math.min(1, MAX_UPLOAD_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    addShot(canvas.toDataURL("image/jpeg", 0.9), "manual");
  }

  /**
   * Same path as a camera recording: a File IS a Blob, so it goes straight into the existing
   * client-side frame selection. Nothing about the pipeline knows the difference.
   */
  async function handleVideoFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // så samma fil kan väljas igen efter ett misslyckat försök
    if (!file) return;
    setProcessingError(null);
    setMode("processing");
    try {
      const frames = await extractBestFrames(file, setExtraction);
      frames.forEach((f) => addShot(f.dataUrl, "video", f.viewLabel));
      // Straight into the analysis. The frames were picked by the selector, not by the seller, so
      // there is nothing for them to approve — and being asked to sign off on someone else's choice
      // is friction without a decision behind it. The shots are still in state, so a failed start
      // lands on the review screen where they can retry or adjust.
      await startAnalysis(frames.map((f) => ({ dataUrl: f.dataUrl, viewLabel: f.viewLabel, source: "video" as const })));
    } catch (err) {
      setProcessingError(err instanceof Error ? err.message : "Kunde inte bearbeta videon.");
      setMode("choose");
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // så samma filer kan väljas igen efter ett misslyckat försök
    const room = MAX_IMAGES - shots.length;
    if (room <= 0) {
      setProcessingError(`Redan ${MAX_IMAGES} bilder valda — ta bort någon först.`);
      return;
    }
    setProcessingError(
      picked.length > room
        ? `Tog de ${room} första — högst ${MAX_IMAGES} bilder bedöms.`
        : null,
    );
    for (const file of picked.slice(0, room)) {
      const dataUrl = await fileToResizedDataUrl(file);
      addShot(dataUrl, "manual");
    }
    if (mode === "choose") setMode("review");
  }

  async function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    if (!hasLiveCamera()) {
      setProcessingError("Kameran hade stängts av. Startar om den — tryck igen när bilden är tillbaka.");
      await startCamera();
      return;
    }
    setProcessingError(null);

    // iOS only honours requestPermission() inside the tap that triggered it, so this happens here and
    // not behind any earlier await.
    const outcome = await requestRotationPermission();
    setRotationDeg(0);
    setHasRotation(null);
    if (outcome === "granted") {
      paceRef.current = null;
      trackerRef.current = startRotationTracking((deg) => {
        setHasRotation(true);
        setRotationDeg(deg);
        const now = Date.now();
        const prev = paceRef.current;
        // Sampled over ~1s windows: instantaneous rate is far too jumpy to show a seller.
        if (!prev) paceRef.current = { deg, at: now };
        else if (now - prev.at >= 900) {
          // Farten är hur fort man vrider sig, åt vilket håll som helst — därför beloppet här, till
          // skillnad från varvet som räknas med tecken.
          setTooFast(Math.abs(deg - prev.deg) / ((now - prev.at) / 1000) > TOO_FAST_DEG_PER_S);
          paceRef.current = { deg, at: now };
        }
        // Ett helt varv åt endera hållet, och aldrig snabbare än MIN_LAP_MS.
        if (Math.abs(deg) >= FULL_LAP_DEG && Date.now() - recordStartRef.current >= MIN_LAP_MS) stopRecording();
      });
      // No events at all within the grace period means the sensor is not reporting: stop promising an
      // automatic finish and let the seller end it by hand.
      window.setTimeout(() => setHasRotation((v) => (v === null ? false : v)), SENSOR_GRACE_MS);
    } else {
      setHasRotation(false);
    }
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      setRecording(false);
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      const recordedMs = Date.now() - recordStartRef.current;
      // Felet ska sägas där det uppstod. En tom eller en sekund lång ström tog sig annars ända in i
      // bildruteuttaget och kom ut som "kunde inte läsa någon bildruta ur videon" — sant, men det
      // pekar på uttaget i stället för på inspelningen.
      if (blob.size < MIN_CLIP_BYTES || recordedMs < MIN_CLIP_MS) {
        setProcessingError(
          blob.size < MIN_CLIP_BYTES
            ? "Inspelningen blev tom — kameran verkar ha stängts av. Försök igen."
            : "Filmen blev för kort för att läsa bildrutor ur. Gå ett helt varv och låt den spela klart.",
        );
        setMode("video");
        return;
      }
      setMode("processing");
      try {
        // Inspelningens egen längd följer med: en webm från MediaRecorder har ingen längd skriven i
        // huvudet, och klockan här är det närmaste ett facit som finns om filen inte vill säga något.
        const frames = await extractBestFrames(blob, setExtraction, recordedMs);
        frames.forEach((f) => addShot(f.dataUrl, "video", f.viewLabel));
        await startAnalysis(frames.map((f) => ({ dataUrl: f.dataUrl, viewLabel: f.viewLabel, source: "video" as const })));
      } catch (err) {
        setProcessingError(err instanceof Error ? err.message : "Kunde inte bearbeta videon.");
        setMode("video");
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    recordStartRef.current = Date.now();
    setRecording(true);
    setRecordMs(0);
  }

  function stopRecording() {
    setTooFast(false);
    trackerRef.current?.stop();
    trackerRef.current = null;
    recorderRef.current?.stop();
  }

  useEffect(() => {
    if (mode !== "processing") return;
    const startedAt = Date.now();
    setProcessingMs(0);
    const timer = setInterval(() => setProcessingMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - recordStartRef.current;
      setRecordMs(elapsed);
      if (elapsed >= MAX_RECORD_MS) stopRecording();
    }, 200);
    return () => clearInterval(timer);
  }, [recording]);

  /**
   * `payloadOverride` exists because the video paths start the analysis in the same tick as they add
   * their shots: `shots` has not re-rendered yet, so reading it here would send an empty list.
   */
  async function startAnalysis(payloadOverride?: CapturedShot[]) {
    setMode("creating");
    const payload: CapturedShot[] =
      payloadOverride ?? shots.map((s) => ({ dataUrl: s.dataUrl, viewLabel: s.viewLabel, source: s.source }));
    try {
      const { jobId } = await createJob(payload, identity);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      onCaptured(jobId, payload);
    } catch (err) {
      setProcessingError(err instanceof Error ? err.message : "Kunde inte starta analysen.");
      setMode("review");
    }
  }

  // ---- choose ----
  if (mode === "choose") {
    return (
      <div className="screen screen-light">
        <button className="btn btn-text btn-back" onClick={onBack}>
          <ArrowLeftIcon /> Tillbaka
        </button>
        <h2 className="choose-title">Hur vill du visa möbeln?</h2>
        <p className="capture-identity">{[identity.brand, identity.model].filter(Boolean).join(" ")}</p>
        <button className={`choose-card ${cameraAvailable ? "" : "choose-card-unavailable"}`} onClick={() => enterMode("video")}>
          <span className="choose-icon">
            <VideoIcon />
          </span>
          <div>
            <strong>Spela in en snabb video</strong>
            <p className="muted">
              {cameraAvailable ? "Gå runt möbeln — vi väljer de bästa vyerna automatiskt." : "Kräver HTTPS — inte tillgängligt här."}
            </p>
          </div>
        </button>
        <button className={`choose-card ${cameraAvailable ? "" : "choose-card-unavailable"}`} onClick={() => enterMode("photo")}>
          <span className="choose-icon">
            <CameraIcon />
          </span>
          <div>
            <strong>Ta bilder manuellt</strong>
            <p className="muted">
              {cameraAvailable ? "Ta foton själv, gärna med närbilder på slitage." : "Kräver HTTPS — inte tillgängligt här."}
            </p>
          </div>
        </button>
        <button className="choose-card" onClick={() => videoFileInputRef.current?.click()}>
          <span className="choose-icon">
            <FolderIcon />
          </span>
          <div>
            <strong>Ladda upp en videofil</strong>
            <p className="muted">Välj en färdig film — vi extraherar bildrutorna åt dig.</p>
          </div>
        </button>
        <button className="choose-card" onClick={() => fileInputRef.current?.click()}>
          <span className="choose-icon">
            <PhotosIcon />
          </span>
          <div>
            <strong>Ladda upp bilder</strong>
            <p className="muted">Har du redan foton? Välj upp till {MAX_IMAGES} — ingen film behövs.</p>
          </div>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileUpload} />
        <input ref={videoFileInputRef} type="file" accept="video/*" style={{ display: "none" }} onChange={handleVideoFileUpload} />
        {cameraError && <p className="error-text">{cameraError}</p>}
        {processingError && <p className="error-text">{processingError}</p>}
      </div>
    );
  }

  // ---- photo capture ----
  if (mode === "photo") {
    return (
      <div className="screen screen-camera">
        <video ref={videoRef} className="camera-feed" muted playsInline autoPlay />
        {!cameraStarted && (
          <div className="camera-placeholder">
            <button className="btn btn-ghost" onClick={leaveCamera}>
              <ArrowLeftIcon /> Tillbaka
            </button>
          </div>
        )}
        <button className="btn btn-ghost capture-mode-back" onClick={leaveCamera}>
          <ArrowLeftIcon /> Tillbaka
        </button>
        {cameraError && <p className="error-text camera-error-overlay">{cameraError}</p>}
        {shots.length > 0 && (
          <div className="capture-filmstrip">
            {shots.slice(-8).map((s) => (
              <img key={s.id} src={s.dataUrl} className="filmstrip-thumb" alt="" />
            ))}
          </div>
        )}
        <div className="photo-controls">
          <button className="shutter-btn" onClick={capturePhoto} aria-label="Ta bild" />
          <button className="btn btn-primary btn-green btn-done" disabled={shots.length === 0} onClick={() => setMode("review")}>
            Klar ({shots.length})
          </button>
        </div>
      </div>
    );
  }

  // ---- video recording ----
  if (mode === "video") {
    const stepIndex = Math.min(GUIDANCE_STEPS.length - 1, Math.floor((recordMs / MAX_RECORD_MS) * GUIDANCE_STEPS.length));
    return (
      <div className="screen screen-camera">
        <video ref={videoRef} className="camera-feed" muted playsInline autoPlay />
        {/* Ingen beskärningsram här: filmen tar hela bildrutan, och en ram som antyder något annat
            hade fått säljaren att rama in möbeln i fel yta. */}
        {!recording && <WalkaroundGuide subject={[identity.brand, identity.model].filter(Boolean).join(" ")} />}
        {!recording && (
          <button className="btn btn-ghost capture-mode-back" onClick={leaveCamera}>
            <ArrowLeftIcon /> Tillbaka
          </button>
        )}
        {recording && (
          <div className="capture-top-bar">
            <span className="rec-dot" /> SPELAR IN {(recordMs / 1000).toFixed(0)}s
          </div>
        )}
        {recording && hasRotation !== false && <LapRing degrees={rotationDeg} tooFast={tooFast} />}
        {/* Utan sensor finns ingen ring att läsa riktningen ur, och riktningen är det enda säljaren
            behöver hålla i huvudet medan hen går. */}
        {recording && hasRotation === false && <DirectionPill />}
        {recording && (
          <div className="capture-guidance">
            {tooFast
              ? "Gå långsammare — annars blir bilderna suddiga"
              : hasRotation === false
                ? `${GUIDANCE_STEPS[stepIndex]} — tryck för att avsluta när du gått runt`
                : Math.abs(rotationDeg) < 20
                  ? "Börja gå — långsamt medsols, ett varv på ungefär 40 sekunder"
                  : GUIDANCE_STEPS[stepIndex]}
          </div>
        )}
        {cameraError && <p className="error-text camera-error-overlay">{cameraError}</p>}
        {processingError && <p className="error-text video-error">{processingError}</p>}
        <div className="video-controls">
          {!recording ? (
            <button className="record-btn record-btn-hint" onClick={startRecording} aria-label="Starta inspelning" />
          ) : (
            <button className="record-btn record-btn-stop" onClick={stopRecording} aria-label="Stoppa inspelning" />
          )}
        </div>
      </div>
    );
  }

  // ---- processing video ----
  if (mode === "processing") {
    const slow = processingMs > EXTRACTION_TARGET_MS;
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Bearbetar video…</p>
        <p className="muted small">
          Väljer de bästa vyerna{processingMs > 1200 ? ` · ${(processingMs / 1000).toFixed(0)} s` : ""}
        </p>
        {slow && <p className="muted small">Lång film eller långsam avkodning — det tar aldrig mer än 20 sekunder.</p>}
      </div>
    );
  }

  // ---- creating job ----
  if (mode === "creating") {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Laddar upp bilder…</p>
      </div>
    );
  }

  // ---- review ----
  return (
    <div className="screen screen-light">
      <h2>Dessa vyer kommer att inspekteras</h2>
      <p className="muted">
        {shots.length} av högst {MAX_IMAGES} bilder valda.
        {!videoOnly && shots.length < MAX_IMAGES ? " Ser något håll ut att saknas? Lägg till fler nedan." : ""}
      </p>
      {extraction && (
        <p className="muted small">
          Uttaget: {extraction.method} · {(extraction.ms / 1000).toFixed(1)} s · {extraction.buckets} vyer ·{" "}
          {extraction.framesSeen} bildrutor granskade
          {extraction.dropped > 0 ? ` · ${extraction.dropped} oduglig bortsorterad` : ""}
        </p>
      )}
      <div className="review-grid">
        {shots.map((s) => (
          <div key={s.id} className="review-thumb">
            <img src={s.dataUrl} alt="" />
            {s.viewLabel && <span className="review-thumb-label">{s.viewLabel}</span>}
            <button className="review-thumb-remove" onClick={() => setShots((prev) => prev.filter((x) => x.id !== s.id))} aria-label="Ta bort">
              ✕
            </button>
          </div>
        ))}
      </div>
      {processingError && <p className="error-text">{processingError}</p>}
      {/* Samma regel som på vägen in: i mobilvyn finns ingen väg att lägga till bilder ur filsystemet. */}
      {!videoOnly && (
        <div className="review-add-actions">
          <button className="btn btn-text" disabled={shots.length >= MAX_IMAGES} onClick={() => enterMode("photo")}>
            + Ta fler bilder
          </button>
          <button className="btn btn-text" disabled={shots.length >= MAX_IMAGES} onClick={() => fileInputRef.current?.click()}>
            + Ladda upp
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileUpload} />
        </div>
      )}
      <button className="btn btn-primary" disabled={shots.length === 0} onClick={() => startAnalysis()}>
        Starta AI-analys
      </button>
    </div>
  );
}

/** En pil pekar medsols runt en cirkel, för lägen där varvringen inte kan ritas. */
function DirectionPill() {
  return (
    <div className="capture-direction">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          className="capture-direction-arc"
          d="M12 4.5a7.5 7.5 0 1 1-7.06 4.96"
        />
        <path className="capture-direction-head" d="M8.5 2.6 L12 4.5 L10.2 8" />
      </svg>
      Gå medsols runt möbeln
    </div>
  );
}

const RING_R = 48;
const RING_C = 64;

/** Punkt på varvringen. 0° är rakt upp, positiv riktning medsols — samma räkning som säljaren går. */
function ringPoint(deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: RING_C + RING_R * Math.cos(rad), y: RING_C + RING_R * Math.sin(rad) };
}

/**
 * Varvet, ritat som det ska gås.
 *
 * `degrees` är NETTOvridningen med tecken: ringen visar hur långt runt möbeln säljaren faktiskt har
 * kommit, inte hur mycket telefonen har rört sig. Går man tillbaka backar den, för då är man ju också
 * tillbaka. Tecknet ger dessutom hållet gratis — hela ringen speglas när någon går motsols, så pilarna
 * pekar dit personen är på väg i stället för dit vi hoppades. Möbelsymbolen i mitten är det man går runt.
 */
function LapRing({ degrees, tooFast }: { degrees: number; tooFast: boolean }) {
  const turned = Math.abs(degrees);
  const pct = Math.min(1, turned / FULL_LAP_DEG);
  const c = 2 * Math.PI * RING_R;
  const head = pct * FULL_LAP_DEG;
  const headAt = ringPoint(head);
  return (
    <div className="lap-ring">
      <svg viewBox="0 0 128 128" width="128" height="128">
        <g transform={degrees < 0 ? "translate(128 0) scale(-1 1)" : undefined}>
          <circle cx={RING_C} cy={RING_C} r={RING_R} className="lap-ring-track" />
          <circle
            cx={RING_C} cy={RING_C} r={RING_R}
            className={`lap-ring-fill ${tooFast ? "lap-ring-fill-fast" : ""}`}
            strokeDasharray={`${c * pct} ${c}`}
            transform={`rotate(-90 ${RING_C} ${RING_C})`}
          />
          {[90, 180, 270].map((deg) => {
            const p = ringPoint(deg);
            return (
              <circle key={deg} className={turned >= deg ? "lap-tick lap-tick-done" : "lap-tick"} cx={p.x} cy={p.y} r="3.4" />
            );
          })}
          {/* Vart nästa steg går. Pilarna ligger framför huvudet och tänds i tur och ordning. */}
          {[24, 46].map((ahead, i) => {
            const p = ringPoint(head + ahead);
            return (
              <path
                key={ahead}
                className="lap-ring-lead"
                style={{ animationDelay: `${i * 0.32}s` }}
                transform={`translate(${p.x} ${p.y}) rotate(${head + ahead})`}
                d="M-3 -4.5 L1.5 0 L-3 4.5"
              />
            );
          })}
          <g transform={`translate(${headAt.x} ${headAt.y}) rotate(${head})`}>
            <circle r="10" className={`lap-ring-head ${tooFast ? "lap-ring-head-fast" : ""}`} />
            <path className="lap-ring-head-arrow" d="M-2.5 -4 L1.5 0 L-2.5 4" />
          </g>
        </g>
      </svg>
      <span className="lap-ring-center">
        <SofaIcon size={28} />
        <span className="lap-ring-label">{Math.round(turned)}°</span>
      </span>
    </div>
  );
}

/**
 * Vidast möjliga bild.
 *
 * Många telefoner öppnar bakkameran med en optisk zoom över minimum, och i en trång vardagsrumsvinkel
 * är varje snäpp zoom ett steg bakåt säljaren måste ta. Där zoomen går att styra (Chrome på Android)
 * skruvas den ner till minimum. iOS redovisar ingen zoom i getCapabilities och lämnas som den är —
 * ett saknat reglage är inget fel, så tystnaden här är avsiktlig.
 */
async function widenFieldOfView(stream: MediaStream) {
  const track = stream.getVideoTracks()[0];
  if (!track?.getCapabilities) return;
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & { zoom?: { min: number } };
    const current = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
    if (!caps.zoom || typeof caps.zoom.min !== "number") return;
    if (current !== undefined && current <= caps.zoom.min) return;
    const widest: MediaTrackConstraintSet & { zoom?: number } = { zoom: caps.zoom.min };
    await track.applyConstraints({ advanced: [widest] });
  } catch {
    /* Zoom är frivillig; att den inte gick att sätta ska inte fälla kameran. */
  }
}

function pickMimeType(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return "video/webm";
}

async function fileToResizedDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_UPLOAD_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
