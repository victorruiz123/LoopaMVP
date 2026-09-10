/**
 * Röstrundan — fristående testbänk (VOICE-TOUR.md). Ingår INTE i appen eller bygget.
 *
 * En sammanhängande runda: upp till TRE möbler i samma filmning. Säljaren gör EXAKT som i appens
 * vanliga filmning — går runt möbeln — men berättar samtidigt: vad det är, och vid varje skada går
 * de NÄRA med kameran och beskriver den. Inga extra knappar; kontrollerna är "Nästa möbel" och
 * stoppknappen, samma röda knapp som appen har.
 *
 * EN MediaRecorder per möbel, med BÅDE video- och ljudspåret i samma fil. Det är inte en stilfråga:
 * iOS Safari klarar bara en aktiv MediaRecorder åt gången, så den tidigare designen med en separat
 * obruten ljudinspelare gav TOMT ljud på iPhone. Nu åker hela möbelklippet (mp4/webm) till Aqua som
 * läser ljudspåret ur containern — och segmentens tidsstämplar blir därmed relativa möbelns klipp,
 * vilket gör all skivning trivial. Priset är ett Aqua-anrop per möbel i stället för ett per runda,
 * och att klippet måste hållas under Avalons 25 MiB: bitraten är kapad och en möbel får max 100 s
 * (varning från 85 s, sedan klipps den automatiskt vidare).
 *
 * Närbilderna tas AUTOMATISKT i efterhand: transkriptet har tidsstämplar per mening, så när säljaren
 * pratade om en skada vet vi NÄR — och eftersom de då stod nära är bildrutan vid den tidpunkten en
 * närbild. Den plockas ur möbelns videoblob med en sökning. ETT jobb per möbel skapas med bildrutor +
 * auto-närbilder + sellerNotes, och resultatet visas med appens EGNA komponenter.
 *
 * Live-återkopplingen under filmningen (manussteg, "Uppfattat:", skadekvitto, tystnadsknuff) är
 * garnityr: webbläsarens taligenkänning används där den finns — MEN INTE på iOS, där den kan kapa
 * mikrofonen från inspelningen. Ljudnivåmätaren (AnalyserNode) fungerar överallt.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./voice-tour.css";
import { extractBestFrames, type ExtractionReport } from "../lib/videoFrames";
import { LanguageProvider } from "../lib/i18n";
import { initViewMode } from "../lib/viewMode";
import GradeBadge from "../components/GradeBadge";
import DamageCard from "../components/DamageCard";
import EvidenceViewer from "../components/EvidenceViewer";
import type { ConditionJob, ConditionResult, Damage } from "../types";
import { KNOWN_BRANDS } from "../lib/brands";
import { POPULAR_BRANDS } from "../lib/brandSeed";
import {
  damageMoments,
  detectBrand,
  spokenDamageChecklist,
  DAMAGE_WORDS,
  NEXT_PIECE_COMMAND,
  type DamageMoment,
  type SpeechSegment,
} from "./voice-tour-logic";

/** Registret märkesdetekteringen söker i: appens fulla lista + startlistan (samma union som väljaren). */
const BRAND_NAMES = [...new Set([...KNOWN_BRANDS.map((b) => b.name), ...POPULAR_BRANDS])];

const MAX_PIECES = 3;
const MAX_TOUR_MS = 5 * 60_000;
/** Per möbel: varning, sedan automatiskt klipp — klippet måste hålla sig under Avalons 25 MiB. */
const PIECE_WARN_MS = 85_000;
const MAX_PIECE_MS = 100_000;
const MIN_PIECE_MS = 2500;
const MIN_PIECE_BYTES = 15000;
/** 1,8 Mbit/s video + 64 kbit/s ljud ≈ 23 MiB på 100 s — under Avalon-taket med marginal. */
const VIDEO_BPS = 1_800_000;
const AUDIO_BPS = 64_000;
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_IMAGES_PER_JOB = 6;
const MAX_CLOSEUPS_PER_PIECE = 2;

const KEY_STORAGE = "voicetour.serviceKey";

/** iOS-Safari: taligenkänning parallellt med inspelning kan ta mikrofonen ifrån den. Avstängd där. */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);

/**
 * Manuset på filmningsskärmen: vad man ska GÖRA, och ett exempel på vad man kan SÄGA. Roterar var
 * åttonde sekund; första steget visas alltid först för varje ny möbel. Skriptet är garnityr ovanpå
 * ett fritt berättande — allt som sägs transkriberas oavsett vilket steg som råkar visas.
 */
const GUIDE_STEPS: { do: string; say: string }[] = [
  { do: "Säg vad det är — typ, märke, material", say: "”Ett soffbord i massiv ek från IKEA”" },
  { do: "Gå långsamt runt möbeln, medsols", say: "”Baksidan är i fint skick”" },
  { do: "Gå NÄRA varje skada och beskriv den", say: "”Här är en repa på kanten, fem centimeter”" },
  { do: "Berätta om ålder och användning", say: "”Köpt 2019, står i ett rökfritt hem”" },
  { do: "Filma ovansidan och undersidan om det går", say: "”Undersidan ser hel ut”" },
];
const STEP_MS = 8000;
/** Tystnad längre än så här ger en påminnelse om att fortsätta prata. */
const SILENCE_NUDGE_MS = 12_000;
/** RMS över det här räknas som tal. Samma tröskel driver mätaren, taltiden och tystnadsknuffen. */
const SPEECH_RMS = 0.02;
/** Hur länge ✔-kvittot för en uppfattad skada står kvar. */
const ACK_MS = 3500;

/** Webbläsarens taligenkänning — live-FÖRHANDSVISNING, aldrig facit. Aqua transkriberar efteråt. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function makeSpeechRecognition(): SpeechRecognitionLike | null {
  if (IS_IOS) return null;
  const Ctor =
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
  if (!Ctor) return null;
  try {
    const r = new Ctor();
    r.lang = "sv-SE";
    r.continuous = true;
    r.interimResults = true;
    return r;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Inspelningsprimitiver

function pickPieceMime(): string | undefined {
  // Med ljudspår i samma fil: pröva kombinerade codec-strängar först, containern ensam som reserv.
  for (const t of [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("FileReader misslyckades"));
    r.readAsDataURL(blob);
  });
}

/**
 * Plockar bildrutor ur en videoblob vid givna tidpunkter (sekunder in i klippet).
 *
 * MediaRecorder-webm saknar duration i headern; samma trick som videoFrames.ts använder — hoppa
 * bortom slutet så webbläsaren räknar fram längden. Varje sökning har egen timeout: en missad
 * närbild får inte sänka hela rundan.
 */
async function grabFramesAt(blob: Blob, timesS: number[]): Promise<string[]> {
  if (timesS.length === 0) return [];
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const to = window.setTimeout(() => reject(new Error("video-metadata kom aldrig")), 10_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(to);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(to);
        reject(new Error("kunde inte öppna videon"));
      };
    });
    if (!isFinite(video.duration)) {
      video.currentTime = 1e9;
      await new Promise<void>((resolve) => {
        const to = window.setTimeout(() => resolve(), 2500);
        video.ondurationchange = () => {
          window.clearTimeout(to);
          resolve();
        };
      });
    }
    const out: string[] = [];
    const canvas = document.createElement("canvas");
    for (const t of timesS) {
      const target = Math.max(0.1, Math.min(t, (isFinite(video.duration) ? video.duration : t + 1) - 0.1));
      const seeked = await new Promise<boolean>((resolve) => {
        const to = window.setTimeout(() => resolve(false), 8000);
        video.onseeked = () => {
          window.clearTimeout(to);
          resolve(true);
        };
        video.currentTime = target;
      });
      if (!seeked || video.videoWidth === 0) continue;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      out.push(canvas.toDataURL("image/jpeg", 0.92));
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Piece {
  index: number;
  startMs: number;
  endMs: number | null;
  blob: Blob | null;
  /**
   * Transkriberingen startar så fort möbeln är färdigfilmad, inte när hela rundan är det.
   *
   * Två vinster av samma ändring: säljaren får se vad som faktiskt uppfattades MEDAN de filmar
   * nästa möbel — den enda riktiga bekräftelsen på iPhone, där live-igenkänning inte går — och
   * väntetiden efter rundan krymper, eftersom möbel 1 och 2 redan är transkriberade när
   * stoppknappen trycks. Samma tanke som prissättningen i README: lägg nätverksväntan parallellt
   * med filmningen i stället för efter den.
   */
  transcript?: Promise<TranscriptSegment[]>;
}

/** Sekunder RELATIVT möbelns eget klipp — ljudet ligger i samma fil som videon. */
type TranscriptSegment = SpeechSegment;

interface PieceResult {
  index: number;
  transcript: string;
  sellerNotes: string;
  thumbs: string[];
  closeupCount: number;
  /** Märket ur talet, om något kändes igen — skickas med jobbet och startar modellsökningen. */
  brand: string | null;
  /** Skadeögonblicken ur talet — avstämningen "hittade modellen det du nämnde?" bygger på dem. */
  moments: DamageMoment[];
  jobId: string | null;
  job: ConditionJob | null;
  error: string | null;
}

// ---------------------------------------------------------------------------------------------------
// Återkopplingen "jag hör dig"

/**
 * Nivåmätaren — staplar som rör sig med rösten.
 *
 * Den bär hela trovärdigheten på iPhone: taligenkänningen är avstängd där (den kapar mikrofonen
 * från inspelningen), så utan det här står skärmen blick stilla medan säljaren pratar. En mätare
 * som svarar inom en bildruta och står högre när man höjer rösten är det universella beskedet att
 * ljudet kommer fram, och den bygger bara på AnalyserNode — som fungerar överallt.
 *
 * Ritar UTANFÖR React: nivån ligger i en ref och staplarnas höjd sätts direkt på elementen i en
 * rAF-slinga. En omrendering per bildruta hade kostat mer än hela resten av skärmen tillsammans.
 */
function LevelMeter({
  levelRef,
  bars = 13,
  dark = false,
}: {
  levelRef: React.MutableRefObject<number>;
  bars?: number;
  /** På kameran ligger mätaren på mörk botten och byter vilofärg. */
  dark?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const elems = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const mid = (bars - 1) / 2;
    const tick = () => {
      const level = levelRef.current;
      for (let i = 0; i < elems.current.length; i++) {
        const el = elems.current[i];
        if (!el) continue;
        // Mitten reagerar mest — en klump som andas läser som en röst, en rak linje som en mätare.
        const weight = 1.5 - (Math.abs(i - mid) / mid) * 0.9;
        const h = 4 + Math.min(1, level * 9 * weight) * 28;
        el.style.height = `${h.toFixed(1)}px`;
      }
      // Färgen växlas här och inte i React: talar man är det en gång per stavelse, och en
      // omrendering per stavelse hade kostat mer än hela skärmen.
      wrap.current?.classList.toggle("vt-meter-live", level > SPEECH_RMS);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef, bars]);
  return (
    <div ref={wrap} className={`vt-meter${dark ? " vt-meter-dark" : ""}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <div
          key={i}
          className="vt-meter-bar"
          ref={(el) => {
            elems.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}

/**
 * Taltidslinjen: en ruta per sekund av möbelns klipp, ifylld där det hördes tal.
 *
 * Mätaren visar att ljudet kommer fram JUST NU; den här visar att det SPARAS. Skillnaden är hela
 * poängen — en mätare som rör sig bevisar bara att mikrofonen lever, medan en remsa som växer är
 * kvittot på att rundan bär med sig det som sagts.
 */
function SpeechStrip({ samples }: { samples: boolean[] }) {
  return (
    <div className="vt-strip" aria-hidden="true">
      {samples.slice(-60).map((spoke, i) => (
        <div key={i} className={`vt-strip-tick${spoke ? " vt-strip-spoke" : ""}`} />
      ))}
    </div>
  );
}

type Phase = "setup" | "live" | "processing" | "results";

function App() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  });
  const [fatal, setFatal] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pieceElapsedMs, setPieceElapsedMs] = useState(0);
  const [pieceCount, setPieceCount] = useState(0);
  const [results, setResults] = useState<PieceResult[]>([]);
  const [noSpeech, setNoSpeech] = useState(false);

  // Interaktiviteten under filmningen: manussteg, live-uppfattat tal, skadekvitto och tystnadsknuff.
  const [stepIndex, setStepIndex] = useState(0);
  const [liveHeard, setLiveHeard] = useState<string>("");
  const [ackUntil, setAckUntil] = useState(0);
  const [silentSince, setSilentSince] = useState<number | null>(null);
  const [recognitionActive, setRecognitionActive] = useState(false);
  /** Ackumulerad taltid för AKTUELL möbel — kvittot på att något faktiskt spelats in. */
  const [speechMs, setSpeechMs] = useState(0);
  /** En ruta per sekund: hördes tal då? Driver SpeechStrip. */
  const [strip, setStrip] = useState<boolean[]>([]);
  /** Vad Aqua hörde per FÄRDIG möbel — kommer medan nästa fortfarande filmas. */
  const [pieceHeard, setPieceHeard] = useState<Record<number, string>>({});
  const [micTest, setMicTest] = useState<"idle" | "running" | "ok" | "silent" | "denied">("idle");
  /** 0..1, läses av LevelMeter i en egen rAF-slinga. Aldrig i state — det är den heta vägen. */
  const levelRef = useRef(0);
  const speechMsRef = useRef(0);
  const lastMeterAtRef = useRef(0);
  const stripAtRef = useRef(0);
  const stripSpokeRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionOnRef = useRef(false);
  /** Debounce för röstkommandot — ett "nästa möbel" ska byta EN gång, inte en gång per interim-resultat. */
  const voiceNextAtRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastLoudRef = useRef(0);
  const pieceStartedAtRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tourStartRef = useRef(0);
  const piecesRef = useRef<Piece[]>([]);
  const pieceRecorderRef = useRef<MediaRecorder | null>(null);
  const pieceChunksRef = useRef<Blob[]>([]);
  const pieceStopRef = useRef<Promise<void> | null>(null);
  const pieceMimeRef = useRef<string | undefined>(undefined);
  const tickRef = useRef<number | null>(null);
  const advancingRef = useRef(false);

  const saveKey = (k: string) => {
    setApiKey(k);
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* privat läge — nyckeln lever sidladdningen ut */
    }
  };

  const now = () => performance.now();
  const sinceTourStart = () => now() - tourStartRef.current;

  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(path, { ...init, headers: { ...(init.headers ?? {}), "x-api-key": apiKey } });
  }

  // ---- kamera + runda -----------------------------------------------------------------------------

  async function startTour() {
    setFatal(null);
    if (!apiKey.trim()) {
      setFatal("Klistra in CONDITION_SERVICE_KEY ur server/.env i nyckelfältet först.");
      return;
    }
    if (!window.isSecureContext) {
      setFatal("Sidan körs inte i säker kontext — kamera och mikrofon är blockerade. Använd https:// eller http://localhost.");
      return;
    }

    // Bildkakan: skadekorten visar bevisfoton via <img src="/api/jobs/...">, och ett <img> kan inte
    // bära ett huvud. Samma väg som appen: POST /api/session sätter den signerade kakan.
    void api("/api/session", { method: "POST" }).catch(() => undefined);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: { noiseSuppression: true, echoCancellation: true },
      });
    } catch (err) {
      setFatal(`Kunde inte starta kamera + mikrofon: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (stream.getAudioTracks().length === 0) {
      setFatal("Ingen mikrofon i strömmen — röstrundan är poänglös utan tal.");
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    pieceMimeRef.current = pickPieceMime();

    tourStartRef.current = now();
    piecesRef.current = [];
    startPieceRecorder();
    setPieceCount(1);
    setPhase("live");
    startLiveFeedback(stream);

    tickRef.current = window.setInterval(() => {
      const ms = sinceTourStart();
      const pieceMs = now() - pieceStartedAtRef.current;
      setElapsedMs(ms);
      setPieceElapsedMs(pieceMs);
      // Manussteget följer tiden inom AKTUELL möbel, så varje ny möbel börjar om från "säg vad det är".
      setStepIndex(Math.floor(pieceMs / STEP_MS) % GUIDE_STEPS.length);
      const quiet = now() - lastLoudRef.current;
      setSilentSince(quiet > SILENCE_NUDGE_MS ? quiet : null);
      setSpeechMs(speechMsRef.current);
      // En ruta per sekund: hördes tal någon gång under den sekunden?
      if (now() - stripAtRef.current >= 1000) {
        stripAtRef.current = now();
        const spoke = stripSpokeRef.current;
        stripSpokeRef.current = false;
        setStrip((prev) => [...prev, spoke]);
      }
      // Klippet måste hålla sig under Avalons filgräns: klipp automatiskt vidare i stället för att
      // låta en lång möbel växa förbi 25 MiB och fälla transkriberingen i efterhand.
      if (pieceMs >= MAX_PIECE_MS && !advancingRef.current) {
        advancingRef.current = true;
        void (piecesRef.current.length < MAX_PIECES ? nextPiece() : finishTour()).finally(() => {
          advancingRef.current = false;
        });
      }
      if (ms >= MAX_TOUR_MS) void finishTour();
    }, 250);
  }

  /**
   * Mikrofontestet på startsidan.
   *
   * Finns för att felet det fångar är det dyraste i hela flödet: en tyst inspelning upptäcks annars
   * först EFTER att tre möbler filmats, och då är rundan förlorad — det var precis vad som hände på
   * iPhone med två parallella inspelare. Fem sekunder före start är billigare än en runda efter.
   * Testet begär bara ljud, och släpper spåret direkt efteråt.
   */
  async function runMicTest() {
    setMicTest("running");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicTest("denied");
      return;
    }
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let peak = 0;
      const until = now() + 5000;
      await new Promise<void>((resolve) => {
        const loop = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const d = (buf[i] - 128) / 128;
            sum += d * d;
          }
          const rms = Math.sqrt(sum / buf.length);
          levelRef.current = rms > levelRef.current ? rms : levelRef.current * 0.82 + rms * 0.18;
          peak = Math.max(peak, rms);
          if (now() < until) requestAnimationFrame(loop);
          else resolve();
        };
        requestAnimationFrame(loop);
      });
      setMicTest(peak > SPEECH_RMS ? "ok" : "silent");
    } catch {
      setMicTest("silent");
    } finally {
      void ctx?.close().catch(() => undefined);
      stream.getTracks().forEach((t) => t.stop());
      levelRef.current = 0;
    }
  }

  /**
   * Live-återkopplingen har TVÅ oberoende källor, båda garnityr ovanpå det riktiga flödet:
   *
   * - Webbläsarens taligenkänning visar vad som uppfattas ("Uppfattat: ...") och kvitterar när ett
   *   skadeord hörs — samma ordlista som efterbearbetningen använder för närbilderna, så kvittot
   *   lovar bara det som faktiskt kommer att hända. På iOS är den AV (kan ta mikrofonen från
   *   inspelningen); där sköter Aqua hela sanningen i efterhand.
   * - En ljudnivåmätare på vårt EGET mikrofonspår upptäcker tystnad. Den fungerar överallt och
   *   driver "fortsätt berätta"-knuffen även utan taligenkänning.
   */
  function startLiveFeedback(stream: MediaStream) {
    lastLoudRef.current = now();
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      lastMeterAtRef.current = now();
      const meter = () => {
        if (!audioCtxRef.current) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Nivån glidande utjämnad: rå RMS hoppar mellan bildrutor och gör mätaren nervös snarare
        // än levande. Snabbt upp, långsamt ner — så syns ett ord direkt men klumpen hinner andas.
        levelRef.current = rms > levelRef.current ? rms : levelRef.current * 0.82 + rms * 0.18;

        const t = now();
        const dt = t - lastMeterAtRef.current;
        lastMeterAtRef.current = t;
        const speaking = rms > SPEECH_RMS;
        if (speaking) {
          lastLoudRef.current = t;
          stripSpokeRef.current = true;
          // Taltiden räknas i mätslingan och inte i 250 ms-tickern: en stavelse mellan två tick
          // hade annars räknats som tystnad, och siffran ska kunna litas på.
          speechMsRef.current += Math.min(dt, 100);
        }
        requestAnimationFrame(meter);
      };
      requestAnimationFrame(meter);
    } catch {
      /* ingen mätare — knuffen uteblir, inget annat påverkas */
    }

    const rec = makeSpeechRecognition();
    if (!rec) return;
    recognitionRef.current = rec;
    recognitionOnRef.current = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0]?.transcript ?? "";
      const trimmed = text.trim();
      if (!trimmed) return;
      lastLoudRef.current = now();
      setLiveHeard(trimmed.length > 70 ? "…" + trimmed.slice(-70) : trimmed);
      if (DAMAGE_WORDS.test(trimmed)) setAckUntil(now() + ACK_MS);
      // Röstkommandot: "nästa möbel" byter utan knapptryck — händerna är ju upptagna med kameran.
      if (NEXT_PIECE_COMMAND.test(trimmed) && now() - voiceNextAtRef.current > 5000) {
        voiceNextAtRef.current = now();
        void nextPiece();
      }
    };
    rec.onerror = () => undefined; // 'no-speech' m.fl. — mätaren sköter knuffen
    rec.onend = () => {
      // Vissa webbläsare avslutar igenkänningen stup i kvarten; starta om så länge rundan pågår.
      if (recognitionOnRef.current) {
        try {
          rec.start();
        } catch {
          /* dubbelstart — nästa onend tar det */
        }
      }
    };
    try {
      rec.start();
      setRecognitionActive(true);
    } catch {
      recognitionRef.current = null;
    }
  }

  function stopLiveFeedback() {
    setRecognitionActive(false);
    recognitionOnRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {
      /* redan stoppad */
    }
    recognitionRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }

  function startPieceRecorder() {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = pieceMimeRef.current;
    // BÅDA spåren i samma inspelare — se filhuvudet: iOS klarar bara en MediaRecorder åt gången.
    const rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: VIDEO_BPS,
      audioBitsPerSecond: AUDIO_BPS,
    });
    pieceStartedAtRef.current = now();
    const piece: Piece = { index: piecesRef.current.length, startMs: sinceTourStart(), endMs: null, blob: null };
    piecesRef.current.push(piece);
    pieceChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) pieceChunksRef.current.push(e.data);
    };
    pieceStopRef.current = new Promise((resolve) => {
      rec.onstop = () => {
        piece.endMs = sinceTourStart();
        piece.blob = new Blob(pieceChunksRef.current, { type: mime?.split(";")[0] ?? "video/webm" });
        resolve();
      };
    });
    pieceRecorderRef.current = rec;
    rec.start(1000);
  }

  async function stopPieceRecorder(): Promise<void> {
    const rec = pieceRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    await (pieceStopRef.current ?? Promise.resolve());

    // Möbeln är färdigfilmad — skicka den på transkribering direkt. Se Piece.transcript.
    const piece = piecesRef.current[piecesRef.current.length - 1];
    if (!piece?.blob || piece.transcript) return;
    if (piece.blob.size < MIN_PIECE_BYTES || (piece.endMs ?? 0) - piece.startMs < MIN_PIECE_MS) return;
    piece.transcript = transcribe(piece.blob);
    void piece.transcript
      .then((segments) => {
        const said = segments.map((s) => s.text).join(" ").trim();
        setPieceHeard((prev) => ({ ...prev, [piece.index]: said }));
      })
      .catch(() => {
        // Felet ägs av process(), som väntar in samma promise. Här räcker att chippen uteblir —
        // en röd ruta mitt i filmningen av NÄSTA möbel vore ett avbrott utan handling bakom sig.
        setPieceHeard((prev) => ({ ...prev, [piece.index]: "" }));
      });
  }

  async function nextPiece() {
    if (piecesRef.current.length >= MAX_PIECES) return;
    // ~100 ms glapp mellan två inspelare på samma ström — säljaren märker det inte.
    await stopPieceRecorder();
    startPieceRecorder();
    setPieceCount(piecesRef.current.length);
    // Taltid och remsa gäller EN möbel: en nollställd mätare är också ett besked om att en ny
    // möbel börjat, och en remsa som fortsatte hade läst som om den förra fortfarande spelades in.
    speechMsRef.current = 0;
    stripSpokeRef.current = false;
    setSpeechMs(0);
    setStrip([]);
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function finishTour() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    stopLiveFeedback();
    await stopPieceRecorder();
    stopStream();
    setPhase("processing");
    void process();
  }

  // ---- efterbearbetning ---------------------------------------------------------------------------

  async function process() {
    try {
      const pieces = piecesRef.current.filter(
        (p) => p.blob && p.blob.size >= MIN_PIECE_BYTES && (p.endMs ?? 0) - p.startMs >= MIN_PIECE_MS,
      );
      if (pieces.length === 0) throw new Error("Ingen möbel blev tillräckligt filmad (minst 2,5 s per möbel).");

      // Transkriberingarna är nätverksväntan — starta alla direkt. Bildruteuttaget är avkodararbete
      // och körs SEKVENTIELLT med flit: parallella avkodare trängs om samma kärnor (mätt i README).
      setStatus("Transkriberar talet och väljer bildrutor…");
      // Transkriberingarna startade redan när varje möbel filmades klart (se Piece.transcript);
      // de flesta är alltså färdiga här. Bara en möbel som föll utanför får en ny start.
      const transcriptPromises = pieces.map((p) => p.transcript ?? transcribe(p.blob!));
      const frameSets: { dataUrl: string; viewLabel: string | null }[][] = [];
      for (const piece of pieces) {
        const durMs = (piece.endMs ?? 0) - piece.startMs;
        frameSets.push(
          await extractBestFrames(
            piece.blob!,
            (report: ExtractionReport) =>
              console.info(`[röstrundan] möbel ${piece.index + 1}: ${report.method} · ${(report.ms / 1000).toFixed(1)}s · ${report.buckets} vyer`),
            durMs,
          ),
        );
      }
      const transcripts = await Promise.all(transcriptPromises.map((p) => p.catch((e: Error) => e)));

      // Tomt tal ÖVERALLT är värt en egen rad i resultatet — det var precis så iOS-buggen med två
      // inspelare visade sig, och nästa mikrofonproblem ska synas direkt i stället för att se ut
      // som en tyst säljare.
      setNoSpeech(transcripts.every((t) => t instanceof Error || t.every((s) => !s.text.trim())));

      setStatus("Plockar närbilder ur filmen och startar besiktningarna…");
      const initial: PieceResult[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        const t = transcripts[i];
        const segments: TranscriptSegment[] = t instanceof Error ? [] : t;
        const transcriptText = segments.map((s) => s.text).join(" ").trim();

        // Skadeögonblicken: segment som nämner en skada. Säljaren stod då nära (instruktionen säger
        // gå nära och beskriv), så bildrutan vid den tidpunkten ÄR närbilden — ingen knapp behövs.
        const moments = damageMoments(segments, MAX_CLOSEUPS_PER_PIECE);
        const closeups = await grabFramesAt(piece.blob!, moments.map((m) => m.tS)).catch(() => [] as string[]);

        // Märket ur talet. Med det ifyllt startar backend modellsökningen ur bilderna — samma väg
        // som när säljaren väljer märke på startsidan; "märket räcker för att starta".
        const brand = detectBrand(transcriptText, BRAND_NAMES);

        const notes = buildSellerNotes(transcriptText, moments, closeups.length);
        const images = buildImages(closeups, frameSets[i]);
        const r: PieceResult = {
          index: piece.index,
          transcript: transcriptText,
          sellerNotes: notes,
          thumbs: images.map((im) => im.dataUrl),
          closeupCount: closeups.length,
          brand,
          moments,
          jobId: null,
          job: null,
          error: t instanceof Error ? t.message : null,
        };
        try {
          const res = await api("/api/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images, sellerNotes: notes || null, brand }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
          r.jobId = (await res.json()).jobId as string;
        } catch (err) {
          r.error = [r.error, err instanceof Error ? err.message : String(err)].filter(Boolean).join(" · ");
        }
        initial.push(r);
      }
      setResults(initial);
      setPhase("results");
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      setPhase("results");
    }
  }

  /** Möbelns klipp (video+ljud) till Aqua via serverproxyn. Segmenten är klipprelativa. */
  async function transcribe(blob: Blob): Promise<TranscriptSegment[]> {
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Klippet är ${(blob.size / 1024 / 1024).toFixed(0)} MiB — för stort för transkribering (max 24). Filma kortare per möbel.`,
      );
    }
    const audioDataUrl = await blobToDataUrl(blob);
    const res = await api("/api/voice-tour/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioDataUrl, language: "sv" }),
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
      throw new Error(`Transkriberingen misslyckades: ${msg}`);
    }
    const data = (await res.json()) as { text: string; segments: TranscriptSegment[] };
    // Ett svar utan segment men med text: behandla hela klippet som ETT segment så inget tal tappas.
    if (data.segments.length === 0 && data.text) return [{ start: 0, end: Number.MAX_SAFE_INTEGER, text: data.text }];
    return data.segments;
  }

  function buildSellerNotes(transcriptText: string, moments: { said: string }[], closeupCount: number): string {
    const parts: string[] = [];
    if (transcriptText) parts.push(transcriptText);
    moments.slice(0, closeupCount).forEach((m, i) => {
      parts.push(`Närbild ${i + 1} togs när säljaren sa: "${m.said}"`);
    });
    return parts.join("\n");
  }

  function buildImages(closeups: string[], frames: { dataUrl: string; viewLabel: string | null }[]) {
    // Närbilderna först — de är skadeögonblicken och får aldrig trängas ut av vanliga vyer.
    const closeupShots = closeups.slice(0, MAX_CLOSEUPS_PER_PIECE).map((dataUrl) => ({
      dataUrl,
      viewLabel: "närbild — säljaren beskrev en skada här",
      source: "manual" as const,
    }));
    const rest = frames.slice(0, MAX_IMAGES_PER_JOB - closeupShots.length).map((f) => ({
      dataUrl: f.dataUrl,
      viewLabel: f.viewLabel,
      source: "video" as const,
    }));
    return [...closeupShots, ...rest];
  }

  /**
   * Ett varv är filmat men inte uppladdat — då sitter hela rundan i minnet och en omladdning tar
   * den med sig. Blobbarna går inte att återskapa: möbeln står kanske inte ens kvar. Vakten gäller
   * under filmningen OCH under efterbearbetningen, alltså precis så länge något är oersättligt.
   */
  useEffect(() => {
    if (phase !== "live" && phase !== "processing") return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [phase]);

  // Videoelementet finns bara i kameravyn, så strömmen kopplas när vyn har bytts — inte i startTour,
  // där elementet ännu inte är monterat.
  useEffect(() => {
    if (phase !== "live") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.muted = true;
    void video.play().catch(() => undefined);
  }, [phase]);

  // ---- pollning -----------------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== "results") return;
    const pending = () =>
      results.some((r) => r.jobId && (!r.job || (r.job.progress.stage !== "done" && r.job.progress.stage !== "error")));
    if (!pending()) return;
    const t = window.setInterval(async () => {
      const updated = await Promise.all(
        results.map(async (r) => {
          if (!r.jobId) return r;
          if (r.job && (r.job.progress.stage === "done" || r.job.progress.stage === "error")) return r;
          try {
            const res = await api(`/api/jobs/${r.jobId}`);
            if (!res.ok) return r;
            return { ...r, job: (await res.json()) as ConditionJob };
          } catch {
            return r;
          }
        }),
      );
      setResults(updated);
    }, 2500);
    return () => window.clearInterval(t);
  }, [phase, results]);

  // Skadekortens confirm/reject/edit går till samma endpoints som i appen — bara med maskinnyckeln
  // i stället för Supabase-token. Svaret är det omräknade resultatet; det skrivs rakt in i jobbet.
  async function damageAction(
    r: PieceResult,
    damageId: string,
    action: "confirm" | "reject" | "edit",
    patch?: Partial<Damage>,
  ) {
    if (!r.jobId) return;
    try {
      const res = await api(`/api/jobs/${r.jobId}/damages/${damageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, patch }),
      });
      if (!res.ok) return;
      const result = (await res.json()) as ConditionResult;
      setResults((prev) =>
        prev.map((p) => (p.index === r.index && p.job ? { ...p, job: { ...p.job, result } } : p)),
      );
    } catch {
      /* pollningen hämtar rätt läge vid nästa varv */
    }
  }

  // ---- vyer ---------------------------------------------------------------------------------------

  const mmss = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Filmningen: appens egen kameravy — fullskärm, topplist med REC, guidning i överkant och den
  // röda stoppknappen. Enda tillägget är "Nästa möbel". Inga andra knappar; närbilderna sköts av
  // efterbearbetningen.
  if (phase === "live") {
    const acked = now() < ackUntil;
    const step = GUIDE_STEPS[stepIndex];
    const pieceTimeLeft = MAX_PIECE_MS - pieceElapsedMs;
    return (
      <div className="screen screen-camera">
        <video ref={videoRef} className="camera-feed" muted playsInline autoPlay />
        <div className="capture-top-bar">
          <span className="rec-dot" /> SPELAR IN {mmss(elapsedMs)} · Möbel {pieceCount}/{MAX_PIECES}
        </div>

        {/* Guidningen i prioritetsordning: tidsvarningen (klippet närmar sig maxlängd), skadekvittot
            (grönt — uppfattat), tystnadsknuffen (upprepa/fortsätt), annars manuset. */}
        {pieceElapsedMs > PIECE_WARN_MS ? (
          <div className="capture-guidance vt-guide-danger">
            <b>Runda av den här möbeln</b> — om {Math.max(0, Math.ceil(pieceTimeLeft / 1000))} s klipper jag
            vidare automatiskt.
          </div>
        ) : acked ? (
          <div className="capture-guidance vt-guide-ok">
            <b>Skada uppfattad</b> — närbilden tas från det här ögonblicket. Håll kameran nära någon sekund
            till.
          </div>
        ) : silentSince !== null ? (
          <div className="capture-guidance vt-guide-warn">
            <b>Jag hör dig inte</b> — fortsätt berätta, eller säg det igen lite tydligare.
            <div className="vt-guide-say">T.ex: {step.say}</div>
          </div>
        ) : (
          // Nyckeln byter vid varje steg, så React monterar om rutan och intoningen spelas.
          <div className="capture-guidance vt-guide-in" key={stepIndex}>
            <b>{step.do}</b>
            <div className="vt-guide-say">Säg t.ex: {step.say}</div>
          </div>
        )}

        {/* HÖRSELPANELEN — det som gör att man tror på att den lyssnar.
            Tre lager, i stigande varaktighet: mätaren rör sig NU, remsan visar den senaste
            minuten, taltiden summerar hela möbeln. Alla tre bygger på ljudnivån och fungerar
            därför också på iPhone, där taligenkänning inte kan användas. */}
        <div className="vt-hearing">
          <LevelMeter levelRef={levelRef} dark />
          {strip.length > 1 && <SpeechStrip samples={strip} />}
          <div className="vt-hearing-text">
            {speechMs > 500 ? (
              <>
                <b>{(speechMs / 1000).toFixed(0)} s tal</b> inspelat för den här möbeln
              </>
            ) : (
              <>Börja prata — staplarna blir gröna när jag hör dig</>
            )}
          </div>
          {/* Vad taligenkänningen uppfattar just nu. Bara förhandsvisning, och saknas helt på iOS. */}
          {liveHeard && <div className="vt-hearing-heard">”{liveHeard}”</div>}
        </div>

        {/* Bekräftelsen på FÖRRA möbeln, transkriberad medan den här filmas. Det är det enda
            beviset på faktiskt uppfattade ORD som går att ge på en iPhone. */}
        {Object.entries(pieceHeard)
          .filter(([i]) => Number(i) === pieceCount - 2)
          .map(([i, said]) => (
            <div key={i} className={`vt-piece-toast${said ? "" : " vt-piece-toast-bad"}`}>
              {said ? (
                <>
                  <b>Möbel {Number(i) + 1} uppfattad:</b> ”{said.length > 90 ? said.slice(0, 90) + "…" : said}”
                </>
              ) : (
                <>
                  <b>Möbel {Number(i) + 1}:</b> inget tal kunde uppfattas
                </>
              )}
            </div>
          ))}

        <div className="video-controls" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            {pieceCount < MAX_PIECES && (
              <button className="btn btn-ghost" onClick={() => void nextPiece()}>
                ➜ Nästa möbel
              </button>
            )}
            <button className="record-btn record-btn-stop" onClick={() => void finishTour()} aria-label="Avsluta rundan" />
          </div>
          {recognitionActive && pieceCount < MAX_PIECES && <div className="vt-hint">…eller säg ”nästa möbel”</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen-light" style={{ maxWidth: 520, margin: "0 auto", padding: "16px 14px 48px", minHeight: "100vh" }}>
      <header className="app-bar" style={{ marginBottom: 16 }}>
        <span className="app-wordmark">Loopa</span>
        <span className="chip chip-neutral">Röstrundan</span>
      </header>

      {phase === "setup" && (
        <div className="card-panel" style={{ padding: 20 }}>
          <h2 className="vt-result-title" style={{ marginBottom: 6 }}>
            Filma och berätta
          </h2>
          <p className="vt-lede">
            Gå runt möbeln som vanligt — men prata medan du gör det. Det du säger blir ledtrådar till
            besiktningen.
          </p>

          <ol className="vt-steps">
            <li className="vt-step">
              <span className="vt-step-n">1</span>
              <div className="vt-step-body">
                <div className="vt-step-title">Säg vad det är</div>
                <div className="vt-step-sub">Typ, märke och material. Känns märket igen söks modellen upp.</div>
              </div>
            </li>
            <li className="vt-step">
              <span className="vt-step-n">2</span>
              <div className="vt-step-body">
                <div className="vt-step-title">Gå nära varje skada och beskriv den</div>
                <div className="vt-step-sub">Närbilden tas automatiskt när du pratar om den — ingen knapp.</div>
              </div>
            </li>
            <li className="vt-step">
              <span className="vt-step-n">3</span>
              <div className="vt-step-body">
                <div className="vt-step-title">Tryck ”Nästa möbel”</div>
                <div className="vt-step-sub">
                  Upp till {MAX_PIECES} möbler i samma runda, max {Math.round(MAX_PIECE_MS / 1000)} s per möbel.
                </div>
              </div>
            </li>
          </ol>

          <label className="vt-label" htmlFor="vt-key">
            Servicenyckel
          </label>
          <input
            id="vt-key"
            className="vt-input"
            style={{ marginBottom: 16 }}
            type="password"
            value={apiKey}
            onChange={(e) => saveKey(e.target.value)}
            placeholder="CONDITION_SERVICE_KEY ur server/.env"
          />
          {/* Mikrofontestet före starten — se runMicTest. */}
          <div
            className={
              "vt-mic" +
              (micTest === "ok" ? " vt-mic-ok" : micTest === "silent" ? " vt-mic-warn" : micTest === "denied" ? " vt-mic-bad" : "")
            }
          >
            {micTest === "running" ? (
              <>
                <LevelMeter levelRef={levelRef} />
                <p className="vt-mic-text" style={{ margin: "8px 0 0" }}>
                  Säg något — staplarna ska röra sig och bli gröna
                </p>
              </>
            ) : (
              <>
                <p className="vt-mic-text">
                  {micTest === "ok" && "Mikrofonen fungerar — jag hörde dig tydligt."}
                  {micTest === "silent" && "Jag hörde ingenting. Kontrollera mikrofontillståndet och prova igen."}
                  {micTest === "denied" && "Mikrofonen nekades. Tillåt den i webbläsarens inställningar."}
                  {micTest === "idle" && "Testa mikrofonen först — en tyst runda upptäcks annars för sent."}
                </p>
                {/* btn-outline och inte btn-ghost: panelen är numera en LJUS yta, och btn-ghost är
                    mörk platta med vit text. Den svarta lådan som stod här förut tvingade fram det
                    omvända valet, och en gång blev det vit text på vitt. */}
                <button className="btn btn-outline btn-small" style={{ width: "100%" }} onClick={() => void runMicTest()}>
                  {micTest === "idle" ? "Testa mikrofonen (5 s)" : "Testa igen"}
                </button>
              </>
            )}
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={() => void startTour()}>
            Starta rundan
          </button>
          {fatal && <p className="error-text" style={{ marginBottom: 0 }}>{fatal}</p>}
          <p style={{ fontSize: "var(--fs-xs)", color: "var(--muted-soft)", marginBottom: 0 }}>
            Kräver servern igång (<code>npm run server:dev</code>) med AQUA_API_KEY och GEMINI_API_KEY satta.
            Max {MAX_TOUR_MS / 60000} min per runda.
          </p>
        </div>
      )}

      {phase === "processing" && (
        <div className="card-panel" style={{ padding: 20 }}>
          <div className="center-column" style={{ textAlign: "center" }}>
            <div className="spinner" />
            <p>{status || "Bearbetar…"}</p>
          </div>
          {/* Det som redan hörts, medan resten arbetar. En spinner ensam säger inget om huruvida
              rundan bar med sig talet — och det är just det säljaren undrar i det här ögonblicket. */}
          {Object.entries(pieceHeard).map(([i, said]) => (
            <div key={i} className={`vt-check ${said ? "vt-check-found" : "vt-check-missing"}`}>
              <span className="vt-check-mark">{said ? "✔" : "⚠"}</span>
              <span className="vt-check-body">
                <b>Möbel {Number(i) + 1}:</b>{" "}
                {said ? (
                  <span className="vt-check-said">”{said.length > 110 ? said.slice(0, 110) + "…" : said}”</span>
                ) : (
                  "inget tal uppfattat"
                )}
              </span>
            </div>
          ))}
          {fatal && <p className="error-text">{fatal}</p>}
        </div>
      )}

      {phase === "results" && (
        <div>
          {fatal && (
            <div className="card-panel" style={{ padding: 16 }}>
              <p style={{ color: "#C4442E", fontSize: 14, margin: 0 }}>{fatal}</p>
            </div>
          )}
          {noSpeech && (
            <div className="card-panel" style={{ padding: 14, marginBottom: 12, borderLeft: "4px solid #E07B2C" }}>
              <b>🎙 Inget tal uppfattades i inspelningen.</b>
              <p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.8 }}>
                Kontrollera att Safari fick mikrofontillstånd (aA-menyn i adressfältet → Webbplatsinställningar),
                att ingen annan app använder mikrofonen, och att du inte har ljudlöst-brytaren i ett läge som
                stänger av mikrofonen i vissa tillbehör. Prova en kort runda och prata direkt från start.
              </p>
            </div>
          )}
          {results.map((r) => (
            <PieceCard key={r.index} r={r} onDamageAction={damageAction} />
          ))}
          <div style={{ textAlign: "center", margin: "24px 0" }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              ↻ Ny runda
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PieceCard({
  r,
  onDamageAction,
}: {
  r: PieceResult;
  onDamageAction: (r: PieceResult, damageId: string, action: "confirm" | "reject" | "edit", patch?: Partial<Damage>) => void;
}) {
  const [evidence, setEvidence] = useState<{ damage: Damage; index: number } | null>(null);
  const job = r.job;
  const stage = job?.progress.stage;
  const result = job?.result ?? null;
  const damages: Damage[] = result?.damages ?? [];

  return (
    <div className="card-panel" style={{ padding: 16, marginBottom: 14 }}>
      <div className="vt-result-head">
        {result?.grade ? <GradeBadge grade={result.grade.grade} size={44} /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="vt-result-title">Möbel {r.index + 1}</h3>
          {/* label och canonicalCondition är ofta SAMMA sträng ("Nyskick · Nyskick" i röktestet).
              Visa den bara en gång, och bara den publika formuleringen. */}
          {result?.grade && (
            <div className="vt-result-sub">
              {result.grade.label === result.grade.canonicalCondition
                ? result.grade.canonicalCondition
                : `${result.grade.label} · ${result.grade.canonicalCondition}`}
            </div>
          )}
        </div>
        {r.brand && (
          <span className="chip chip-neutral" title="Märket uppfattades i det du sa">
            {r.brand} 🎙
          </span>
        )}
      </div>

      {/* Modellsökningen — startar för att märket hördes i talet. Kandidatvalet görs inte här
          (testbänken bedömer skadedetektionen), men att sökningen LEVER ska synas. */}
      {r.brand && job?.identityStatus === "identifying" && (
        <p style={{ fontSize: 13, opacity: 0.7, margin: "0 0 8px" }}>🔎 Letar modell hos {r.brand}…</p>
      )}
      {r.brand && job?.identityStatus === "needs_selection" && (job.candidates?.length ?? 0) > 0 && (
        <p style={{ fontSize: 13, opacity: 0.8, margin: "0 0 8px" }}>
          🔎 Troliga modeller: {job.candidates!.slice(0, 3).map((c) => c.model).join(", ")}
        </p>
      )}

      <div className="vt-thumbs">
        {r.thumbs.map((t, i) => (
          <img key={i} src={t} alt="" className={`vt-thumb${i < r.closeupCount ? " vt-thumb-closeup" : ""}`} />
        ))}
      </div>
      {r.closeupCount > 0 && (
        <p className="vt-quote-meta" style={{ margin: "0 0 10px" }}>
          {r.closeupCount === 1 ? "Närbilden i ram" : `${r.closeupCount} närbilder i ram`} togs automatiskt där du
          pratade om skador
        </p>
      )}

      {/* Sista länken i kedjan: hörd -> sparad -> förstådd -> ANVÄND. Att visa transkriptet säger
          bara att orden fångades; raden under säger att de faktiskt följde med in i besiktningen,
          vilket är det säljaren egentligen undrar. */}
      {r.transcript ? (
        <blockquote className="vt-quote">
          <p className="vt-quote-text">”{r.transcript}”</p>
          {r.sellerNotes && (
            <p className="vt-quote-meta">
              Skickades med som ledtråd till besiktningen
              {r.brand ? ` · märket ”${r.brand}” plockades ur talet` : ""}
            </p>
          )}
        </blockquote>
      ) : (
        <p className="vt-quote-meta" style={{ margin: "4px 0 12px" }}>Inget tal uppfattat för den här möbeln.</p>
      )}

      {r.error && <p className="error-text">{r.error}</p>}

      {r.jobId && stage !== "done" && stage !== "error" && (
        <p className="vt-status">
          <span className="spinner spinner-small" style={{ width: 16, height: 16, flex: "none" }} />
          {job?.progress.message ?? "I kö…"}
        </p>
      )}
      {stage === "error" && <p className="error-text">{job?.error ?? "Analysen misslyckades."}</p>}

      {stage === "done" && result && (
        <>
          {result.grade && <p style={{ fontSize: 13, opacity: 0.8 }}>{result.grade.rationale}</p>}

          {/* Avstämningen: för varje skada du NÄMNDE — rapporterade modellen något som svarar mot
              den? En ⚠ betyder inte automatiskt en miss (du kan ha friskrivit: "INGA repor"), men
              den pekar ut exakt vad som är värt att dubbelkolla i bilderna. */}
          {r.moments.length > 0 && (
            <div style={{ margin: "0 0 12px" }}>
              {spokenDamageChecklist(r.moments, damages.map((d) => d.type)).map((c, i) => (
                <div key={i} className={`vt-check ${c.found ? "vt-check-found" : "vt-check-missing"}`}>
                  <span className="vt-check-mark">{c.found ? "✔" : "⚠"}</span>
                  <span className="vt-check-body">
                    <span className="vt-check-said">”{c.said.length > 70 ? c.said.slice(0, 70) + "…" : c.said}”</span>
                    {c.found ? " — motsvarande skada rapporterad" : " — ingen motsvarande skada rapporterad"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {damages.length === 0 && <p style={{ fontSize: 14 }}>Inga skador rapporterade.</p>}
          <div className="damage-list">
            {damages.map((d) => (
              <DamageCard
                key={d.id}
                jobId={r.jobId!}
                damage={d}
                images={result.images}
                disputing={false}
                onDispute={() => undefined}
                onAction={(action, patch) => onDamageAction(r, d.id, action, patch)}
                onOpenEvidence={(index) => setEvidence({ damage: d, index })}
              />
            ))}
          </div>
          {evidence && (
            <EvidenceViewer
              jobId={r.jobId!}
              damage={evidence.damage}
              images={result.images}
              startIndex={evidence.index}
              onClose={() => setEvidence(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

initViewMode();
createRoot(document.getElementById("root")!).render(
  <LanguageProvider>
    <App />
  </LanguageProvider>,
);
