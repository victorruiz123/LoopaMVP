import { useEffect, useRef, useState } from "react";
import { createJob, type CapturedShot } from "../api";
import type { FurnitureIdentity } from "../types";
import { extractBestFrames, EXTRACTION_TARGET_MS, type ExtractionReport } from "../lib/videoFrames";
import { requestRotationPermission, startRotationTracking, type RotationTracker } from "../lib/rotationTracker";

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
  const [mode, setMode] = useState<Mode>("choose");
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  /**
   * getUserMedia is blocked outside a secure context, so over plain http on a LAN address the two
   * camera cards lead to a black screen with no explanation — the error was only ever rendered on the
   * choose screen, which the seller has already left by then. Detect it up front instead.
   */
  const cameraAvailable =
    typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const [cameraStarted, setCameraStarted] = useState(false);
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
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      setCameraStarted(true);
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
  }, [mode, cameraStarted]);

  async function enterMode(next: "photo" | "video") {
    if (!cameraAvailable) {
      setCameraError(
        "Kameran kan bara användas över HTTPS eller på localhost. Den här sidan körs över vanlig http, " +
          "så webbläsaren blockerar den. Filma med telefonens kameraapp och välj \"Ladda upp en videofil\" i stället.",
      );
      return;
    }
    if (!streamRef.current) await startCamera();
    setMode(next);
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
          setTooFast(((deg - prev.deg) / ((now - prev.at) / 1000)) > TOO_FAST_DEG_PER_S);
          paceRef.current = { deg, at: now };
        }
        if (deg >= FULL_LAP_DEG) stopRecording();
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
      setMode("processing");
      try {
        const frames = await extractBestFrames(blob, setExtraction);
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
        <button className="btn btn-ghost btn-back" onClick={onBack}>
          ← Tillbaka
        </button>
        <h2 className="choose-title">Hur vill du visa möbeln?</h2>
        <p className="capture-identity">{[identity.brand, identity.model].filter(Boolean).join(" ")}</p>
        <button className={`choose-card ${cameraAvailable ? "" : "choose-card-unavailable"}`} onClick={() => enterMode("video")}>
          <span className="choose-icon">🎥</span>
          <div>
            <strong>Spela in en snabb video</strong>
            <p className="muted">
              {cameraAvailable ? "Gå runt möbeln — vi väljer de bästa vyerna automatiskt." : "Kräver HTTPS — inte tillgängligt här."}
            </p>
          </div>
        </button>
        <button className={`choose-card ${cameraAvailable ? "" : "choose-card-unavailable"}`} onClick={() => enterMode("photo")}>
          <span className="choose-icon">📷</span>
          <div>
            <strong>Ta bilder manuellt</strong>
            <p className="muted">
              {cameraAvailable ? "Ta foton själv, gärna med närbilder på slitage." : "Kräver HTTPS — inte tillgängligt här."}
            </p>
          </div>
        </button>
        <button className="choose-card" onClick={() => videoFileInputRef.current?.click()}>
          <span className="choose-icon">📁</span>
          <div>
            <strong>Ladda upp en videofil</strong>
            <p className="muted">Välj en färdig film — vi extraherar bildrutorna åt dig.</p>
          </div>
        </button>
        <button className="choose-card" onClick={() => fileInputRef.current?.click()}>
          <span className="choose-icon">🖼️</span>
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
            <button className="btn btn-ghost" onClick={() => setMode("choose")}>
              ← Tillbaka
            </button>
          </div>
        )}
        <div className="capture-overlay-frame" />
        <button className="btn btn-ghost capture-mode-back" onClick={() => setMode("choose")}>
          ← Tillbaka
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
        <div className="capture-overlay-frame" />
        {!recording && (
          <button className="btn btn-ghost capture-mode-back" onClick={() => setMode("choose")}>
            ← Tillbaka
          </button>
        )}
        {recording && (
          <div className="capture-top-bar">
            <span className="rec-dot" /> SPELAR IN {(recordMs / 1000).toFixed(0)}s
          </div>
        )}
        {recording && hasRotation !== false && <LapRing degrees={rotationDeg} tooFast={tooFast} />}
        <div className="capture-guidance">
          {!recording
            ? "Tryck för att börja spela in och gå långsamt runt möbeln"
            : tooFast
              ? "🐌 Gå långsammare — annars blir bilderna suddiga"
              : hasRotation === false
                ? `${GUIDANCE_STEPS[stepIndex]} — tryck för att avsluta när du gått runt`
                : rotationDeg < 20
                  ? "Börja gå — långsamt, ett varv på ungefär 40 sekunder"
                  : GUIDANCE_STEPS[stepIndex]}
        </div>
        {cameraError && <p className="error-text camera-error-overlay">{cameraError}</p>}
        {processingError && <p className="error-text video-error">{processingError}</p>}
        <div className="video-controls">
          {!recording ? (
            <button className="record-btn" onClick={startRecording} aria-label="Starta inspelning" />
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
        {shots.length < MAX_IMAGES ? " Ser något håll ut att saknas? Lägg till fler nedan." : ""}
      </p>
      {extraction && (
        <p className="muted small">
          Uttaget: {extraction.method} · {(extraction.ms / 1000).toFixed(1)} s · {extraction.buckets} vyer ·{" "}
          {extraction.framesSeen} bildrutor granskade
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
      <div className="review-add-actions">
        <button className="btn btn-text" disabled={shots.length >= MAX_IMAGES} onClick={() => enterMode("photo")}>
          + Ta fler bilder
        </button>
        <button className="btn btn-text" disabled={shots.length >= MAX_IMAGES} onClick={() => fileInputRef.current?.click()}>
          + Ladda upp
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileUpload} />
      </div>
      <button className="btn btn-primary" disabled={shots.length === 0} onClick={() => startAnalysis()}>
        Starta AI-analys
      </button>
    </div>
  );
}

/** Fills as the seller turns; ticks at 90/180/270 mark the four sides. */
function LapRing({ degrees, tooFast }: { degrees: number; tooFast: boolean }) {
  const pct = Math.min(1, degrees / FULL_LAP_DEG);
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="lap-ring">
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r={r} className="lap-ring-track" />
        <circle
          cx="40" cy="40" r={r}
          className={`lap-ring-fill ${tooFast ? "lap-ring-fill-fast" : ""}`}
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 40 40)"
        />
        {[90, 180, 270].map((deg) => (
          <circle
            key={deg}
            className={degrees >= deg ? "lap-tick lap-tick-done" : "lap-tick"}
            cx={40 + r * Math.cos(((deg - 90) * Math.PI) / 180)}
            cy={40 + r * Math.sin(((deg - 90) * Math.PI) / 180)}
            r="3"
          />
        ))}
      </svg>
      <span className="lap-ring-label">{Math.round(degrees)}°</span>
    </div>
  );
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
