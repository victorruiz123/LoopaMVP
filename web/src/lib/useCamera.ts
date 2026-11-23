/**
 * Kameran i sidan, som en hook.
 *
 * Bygger på det som redan fungerar i CaptureScreen (getUserMedia, huvudobjektivet, felnamnen) men med tre
 * skillnader som hör till foton i stället för film:
 *
 *   1. UPPLÖSNING. 1920×1440 i stället för 1280×960 — ett foto ska duga att beskära en skada ur. Och där
 *      webbläsaren har `ImageCapture` (Chrome på Android) tas bilden med `takePhoto()`: telefonens egen stillbild
 *      med autofokus, inte en ruta ur förhandsströmmen. iOS Safari saknar det och faller tillbaka på rutan.
 *   2. STRÖMMEN FÄSTS MED EN CALLBACK-REF, inte en effekt som kollar `videoRef.current`. Effekten kördes
 *      före eller efter att <video> ritats beroende på läge, och strömmen kunde hamna "ingenstans" — en svart
 *      ruta. Callback-refen körs just när elementet finns, och `start()` fäster själv om elementet redan står där.
 *   3. INGEN ANALYS. Hooken mäter ingenting och skickar inget; den som använder den får `onEvent` och avgör själv.
 *
 * ETT AVBRUTET play() ÄR INGET KAMERAFEL. Elementet har `autoPlay`, och strömmen fästs efter att det ritats,
 * så webbläsaren har redan börjat starta uppspelningen när det uttryckliga `play()` kommer. Krockar de avbryter
 * den ena den andra med `AbortError`. Det som säger något om kameran är om bilden STÅR STILL efteråt — därför
 * kollas `paused` en stund senare i stället för att avbrottet i sig räknas som fel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { fileToDataUrl, videoToDataUrl } from "./imageResize";

export type CameraStatus = "off" | "starting" | "live" | "error";
export type CameraErrorKind = "insecure" | "denied" | "missing" | "busy" | "start" | "playback" | "lost";

export interface CameraError {
  kind: CameraErrorKind;
  message: string;
}

/** Minsta det vi behöver av webbläsarens ImageCapture — typen finns inte i alla versioner av lib.dom. */
interface ImageCaptureLike {
  takePhoto(): Promise<Blob>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

/**
 * Huvudkameran, inte vidvinkeln. Zoomen sätts till 1× där enheten redovisar den: minimum är ofta
 * ultravidvinkeln, och då hamnar möbeln långt bort i en böjd rumsbild där slitaget blir några suddiga
 * bildpunkter. iOS redovisar ingen zoom och lämnas som den är — ett saknat reglage är inget fel.
 */
async function selectMainLens(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track?.getCapabilities) return;
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
    const current = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
    if (!caps.zoom || typeof caps.zoom.min !== "number") return;
    const neutral = caps.zoom.min <= 1 && (caps.zoom.max ?? 1) >= 1 ? 1 : caps.zoom.min;
    if (current !== undefined && Math.abs(current - neutral) < 0.01) return;
    const mainLens: MediaTrackConstraintSet & { zoom?: number } = { zoom: neutral };
    await track.applyConstraints({ advanced: [mainLens] });
  } catch {
    // Zoom är frivillig; att den inte gick att sätta ska inte fälla kameran.
  }
}

export function useCamera(onEvent?: (kind: CameraErrorKind) => void) {
  const t = useT();
  const streamRef = useRef<MediaStream | null>(null);
  const elRef = useRef<HTMLVideoElement | null>(null);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const [status, setStatus] = useState<CameraStatus>("off");
  const [error, setError] = useState<CameraError | null>(null);

  /** getUserMedia finns bara i en säker kontext: https eller localhost. Över vanlig http på en LAN-adress är kameran blockerad. */
  const available = typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  const fail = useCallback(
    (kind: CameraErrorKind, message: string) => {
      setStatus("error");
      setError({ kind, message });
      eventRef.current?.(kind);
    },
    [],
  );

  const bind = useCallback(
    (el: HTMLVideoElement, stream: MediaStream) => {
      if (el.srcObject === stream) return;
      el.srcObject = stream;
      el.play().catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Avbrottet levereras innan elementet hunnit börja rulla; frågan är om det är igång strax efter.
          window.setTimeout(() => {
            if (elRef.current === el && el.srcObject === stream && el.paused) fail("playback", t("Kameran kunde inte spelas upp."));
          }, 400);
          return;
        }
        console.warn("[kamera] play() misslyckades", err);
        fail("playback", t("Kameran kunde inte spelas upp."));
      });
    },
    [fail, t],
  );

  /** Callback-ref: körs när <video> ritas, och fäster strömmen om den redan finns. */
  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      elRef.current = el;
      if (el && streamRef.current) bind(el, streamRef.current);
    },
    [bind],
  );

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (elRef.current) elRef.current.srcObject = null;
    setStatus("off");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!available) {
      fail(
        "insecure",
        t("Kameran är inte tillgänglig här. Den kräver HTTPS eller localhost. Du kan ladda upp bilder du redan har."),
      );
      return;
    }
    stop();
    setStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          // 4:3 är hela sensorn på i stort sett varje telefon. En kvadratisk begäran får webbläsaren att beskära,
          // och bildvinkeln krymper så att säljaren får backa flera meter för att få in en soffa.
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      streamRef.current = stream;
      await selectMainLens(stream);
      setStatus("live");
      if (elRef.current) bind(elRef.current, stream);
    } catch (err) {
      // Webbläsarens DOMException-text är engelsk och beskriver ett API, inte ett läge en säljare kan göra något åt.
      // Namnet på felet säger däremot precis vilket läge det är.
      console.warn("[kamera] getUserMedia misslyckades", err);
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        fail("denied", t("Kameran är blockerad för den här sidan. Tillåt kameran i webbläsarens inställningar och försök igen."));
      } else if (name === "NotFoundError") {
        fail("missing", t("Ingen kamera hittades på enheten."));
      } else if (name === "NotReadableError" || name === "AbortError") {
        fail("busy", t("Kameran används av något annat just nu. Stäng andra appar som har kameran igång och försök igen."));
      } else {
        fail("start", t("Kunde inte starta kameran."));
      }
    }
  }, [available, bind, fail, stop, t]);

  /**
   * En ström vars spår har stannat är lika död som ingen ström alls — men den ser ut att finnas. iOS stänger
   * kamerans spår när appen går i bakgrunden, och webbläsaren gör det när fliken tappar enheten till något annat.
   */
  const isLive = useCallback(() => streamRef.current?.getVideoTracks().some((tr) => tr.readyState === "live") ?? false, []);

  /** Ett foto som JPEG-data-URL, eller null när kameran inte kan ge något (då är `error` satt). */
  const capture = useCallback(async (): Promise<string | null> => {
    if (!isLive()) {
      fail("lost", t("Kameran har stängts. Tryck på Försök igen."));
      return null;
    }
    const stream = streamRef.current!;
    const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    const track = stream.getVideoTracks()[0];
    if (IC && track) {
      try {
        return await fileToDataUrl(await new IC(track).takePhoto());
      } catch {
        // takePhoto saknas eller stöds inte av den här kameran: ta rutan ur strömmen i stället.
      }
    }
    return elRef.current ? videoToDataUrl(elRef.current) : null;
  }, [fail, isLive, t]);

  // Kameran släpps när skärmen lämnas: en kvarlämnad ström håller lampan tänd och kameran upptagen för allt annat.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  return { videoRef, status, error, available, start, stop, capture, isLive };
}
