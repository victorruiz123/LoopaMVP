import { useEffect, useRef, useState } from "react";
import PhotoCaptureFlow from "../components/PhotoCaptureFlow";
import ResultScreen from "./ResultScreen";
import { TooFewImagesError, createConditionOnlyJob, ensureMediaSession } from "../api";
import { useJobPoll } from "../lib/useJobPoll";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";
import { MAX_PHOTOS, MIN_PHOTOS, orderForUpload, toPayload, type GuideShot } from "../lib/photoGuide";

/**
 * Skicktestet: bildguiden och skickbedömningen, och ingenting annat.
 *
 * Finns för att prova UX:et för att ladda upp bilder och hur besiktningen blir på dem — utan att behöva gå
 * genom märkesval, modellsökning, mått och pris först. Det som körs är exakt det som körs i produktionen för
 * skicket: samma bildguide, samma besiktning, samma godkänn/avvisa-skärm (ResultScreen). Det som INTE körs:
 *
 *   identifiering   ingen modell söks ur bilderna
 *   specifikationer inga mått, material eller annonstext
 *   pris            ingen prismotor anropas — heller inte när du rättar en skada
 *   omslagsurklipp  ingen produktbild byggs
 *
 * "Inte körs" är en garanti från servern och inte en förhoppning: `conditionOnly` i POST /api/jobs sätter de
 * uppgifterna som avbrutna och hoppar över dem (server/src/jobCreate.ts, tests/skicktest.test.ts). Jobbet är
 * privat, räknas inte i butik eller publika kort, och dina rättelser sparas inte som träningsdata.
 *
 * Nås på /skicktest.html (utvecklingsservern). Ingår inte i produktionsbygget.
 */

type Stage = "landing" | "guide" | "uploading" | "analysing" | "result";

interface LogRow {
  at: number;
  name: string;
  detail?: string;
}

/** Uppladdningen får ta högst så här länge — samma gräns som appens egen (StartingJob). */
const UPLOAD_LIMIT_MS = 150_000;

interface Run {
  jobId: string;
  imageCount: number;
  dropped: number;
  uploadMs: number;
  startedAt: number;
  resultMs: number | null;
}

export default function SkickTestScreen() {
  const t = useT();
  usePageTitle("Skicktest");
  // `?job=<id>` öppnar resultatet för ett redan körd analys, utan att betala för en ny. Resultatet ligger bara i minnet
  // när sidan laddas om, så utan det här kostar varje omladdning en körning till att få se samma skador igen.
  const [reopen] = useState(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    return id && /^[\w-]{8,64}$/.test(id) ? id : null;
  });
  const [stage, setStage] = useState<Stage>(reopen ? "analysing" : "landing");
  const [shots, setShots] = useState<GuideShot[]>([]);
  const [run, setRun] = useState<Run | null>(() =>
    reopen ? { jobId: reopen, imageCount: 0, dropped: 0, uploadMs: 0, startedAt: Date.now(), resultMs: null } : null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const t0 = useRef(performance.now());
  /** Satt när bildkakan inte gick att hämta: då laddas inga bilder i godkänn/avvisa, och det ska synas — inte bli tomma rutor. */
  const [mediaError, setMediaError] = useState<string | null>(null);

  function onEvent(name: string, detail?: string) {
    setLog((rows) => [...rows.slice(-59), { at: Math.round(performance.now() - t0.current), name, detail }]);
  }

  /**
   * Bildkakan, som produktionsappen hämtar vid start (App.tsx, useMediaSession).
   *
   * Bildvägarna (`/api/jobs/…/images/…`) sätts som `src` på <img>, som inte kan bära ett Authorization-huvud, så
   * servern godtar en signerad HttpOnly-kaka i stället — och svarar 401 utan den. Testsidan ligger utanför App
   * och hämtade den aldrig: skadekorten visades, men utan en enda bild. Kakan hör till samma identitet som
   * äger jobbet (gästen, eller kontot om man är inloggad), så den hämtas både vid start och efter uppladdningen.
   */
  async function refreshMedia(when: string) {
    try {
      await ensureMediaSession();
      setMediaError(null);
      onEvent("bildsession", `${when}: ok`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMediaError(message);
      onEvent("bildsession", `${when}: FEL ${message}`);
    }
  }

  useEffect(() => {
    void refreshMedia("start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(chosen: GuideShot[]) {
    setShots(chosen);
    setSubmitError(null);
    setStage("uploading");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), UPLOAD_LIMIT_MS);
    const started = performance.now();
    onEvent("skickar", String(chosen.length));
    try {
      const out = await createConditionOnlyJob(toPayload(chosen), controller.signal);
      const uploadMs = Math.round(performance.now() - started);
      onEvent("uppladdad", `${out.imageCount} bilder · ${uploadMs} ms${out.dropped ? ` · ${out.dropped} föll bort` : ""}`);
      setRun({ jobId: out.jobId, imageCount: out.imageCount, dropped: out.dropped ?? 0, uploadMs, startedAt: Date.now(), resultMs: null });
      // Kakan igen, nu när jobbet finns: den ska höra till samma identitet som äger det, och den gamla kan ha gått ut.
      await refreshMedia("efter uppladdning");
      setStage("analysing");
    } catch (err) {
      // Tillbaka till granskningen med bilderna kvar — en uppladdning som faller ska inte kosta säljaren sina bilder.
      const aborted = err instanceof DOMException && err.name === "AbortError";
      const message = aborted
        ? t("Uppladdningen tog för lång tid. Kontrollera nätet och försök igen.")
        : err instanceof TooFewImagesError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("Något gick fel.");
      onEvent("uppladdning_fel", message);
      setSubmitError(message);
      setStage("guide");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function restart() {
    setShots([]);
    setRun(null);
    setSubmitError(null);
    setStage("landing");
  }

  return (
    <>
      {stage !== "guide" && stage !== "uploading" && (
        <TestBadge run={run} imageCount={shots.length} log={log} mediaError={mediaError} onRestart={restart} />
      )}

      {stage === "landing" && <Landing onStart={() => (onEvent("start"), setStage("guide"))} />}

      {(stage === "guide" || stage === "uploading") && (
        <PhotoCaptureFlow
          // Introt varje gång: testsidan finns för att se hela guiden, inte för att hoppa förbi den.
          alwaysShowIntro
          initialShots={shots.length > 0 ? shots : undefined}
          submitLabel={t("Starta skickbedömning")}
          busy={stage === "uploading"}
          submitError={submitError}
          onEvent={onEvent}
          onDone={(chosen) => void send(chosen)}
          onExit={() => setStage("landing")}
        />
      )}

      {stage === "analysing" && run && (
        <Analysing
          run={run}
          shots={shots}
          onResult={() => {
            const ms = Date.now() - run.startedAt;
            setRun({ ...run, resultMs: ms });
            onEvent("resultat", `${(ms / 1000).toFixed(1)} s`);
            setStage("result");
          }}
          onRetry={() => (setSubmitError(null), setStage("guide"))}
          onRestart={restart}
        />
      )}

      {stage === "result" && run && (
        <ResultScreen jobId={run.jobId} skickTest onHome={restart} onContinue={restart} />
      )}
    </>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  const t = useT();
  return (
    <div className="screen screen-light st-landing">
      <span className="st-kicker">{t("Testläge")}</span>
      <h1 className="screen-title">{t("Testa skickbedömningen")}</h1>
      <p className="muted">
        {t("Här provar du bildguiden och skickbedömningen från början till slut. Inget annat körs — du slipper välja märke och modell.")}
      </p>

      <div className="st-cols">
        <section className="st-box st-box-yes">
          <h2>{t("Det här körs")}</h2>
          <ul>
            <li>{t("Bildguiden: omslagsbild och fler vinklar, minst {antal} bilder, upp till {max}.", { antal: MIN_PHOTOS, max: MAX_PHOTOS })}</li>
            <li>{t("Skickbedömningen: AI:n letar skador i bilderna.")}</li>
            <li>{t("Du godkänner eller avvisar varje skada, och kan lägga till en missad.")}</li>
          </ul>
        </section>
        <section className="st-box st-box-no">
          <h2>{t("Det här körs inte")}</h2>
          <ul>
            <li>{t("Ingen modellsökning (identifiering).")}</li>
            <li>{t("Inga mått, material eller annonstext.")}</li>
            <li>{t("Inget pris — heller inte när du rättar en skada.")}</li>
            <li>{t("Ingen produktbild eller annons.")}</li>
          </ul>
        </section>
      </div>

      <p className="muted small">
        {t("Testjobbet är privat och syns inte i butiken. Dina rättelser sparas inte som träningsdata. Bilderna skickas till AI-tjänsten och kostar en vanlig skickbedömning.")}
      </p>

      <button className="btn btn-primary" onClick={onStart}>
        {t("Starta testet")}
      </button>
    </div>
  );
}

/** Väntan på besiktningen, med det servern faktiskt säger om var den står — och bilderna som skickades. */
function Analysing({
  run,
  shots,
  onResult,
  onRetry,
  onRestart,
}: {
  run: Run;
  shots: GuideShot[];
  onResult: () => void;
  onRetry: () => void;
  onRestart: () => void;
}) {
  const t = useT();
  const { job, gaveUp, failed } = useJobPoll(run.jobId, (j) => !!j.result && !j.result.reviewPending, 1000);
  const [elapsed, setElapsed] = useState(0);
  const done = !!job?.result && !job.result.reviewPending;

  useEffect(() => {
    if (done || failed || gaveUp) return;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - run.startedAt) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [done, failed, gaveUp, run.startedAt]);

  useEffect(() => {
    if (done) onResult();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (failed || gaveUp) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="screen-title">{t("Skickbedömningen gick inte att slutföra")}</h2>
        <p className="error-text">
          {gaveUp ? t("Inget svar från servern. Kontrollera att den körs.") : (job?.error ?? t("Något gick fel."))}
        </p>
        <button className="btn btn-primary" onClick={onRetry}>{t("Tillbaka till bilderna")}</button>
        <button className="btn btn-text" onClick={onRestart}>{t("Börja om")}</button>
      </div>
    );
  }

  return (
    <div className="screen screen-light center-column st-wait">
      <div className="spinner" />
      <h2 className="screen-title">{t("Bedömer skicket…")}</h2>
      <p className="muted">{job?.progress.message || t("Skickat. Väntar på servern…")}</p>
      <p className="muted small">
        {t("{sek} s · {antal} bilder analyseras", { sek: elapsed, antal: run.imageCount })}
      </p>
      <ul className="st-thumbs" aria-label={t("Bilderna som skickades")}>
        {/* I den ordning de skickades — guidens, inte tagningsordningen: ett omtag från granskningen ska inte hamna sist. */}
        {orderForUpload(shots).map((s) => (
          <li key={s.id}>
            <img src={s.dataUrl} alt="" />
            <span>{s.viewLabel ? t(s.viewLabel) : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * En liten flik överst: en påminnelse om att det här är ett test, och — uppfälld — vad som hände.
 * Fast och liten med flit: resultatskärmen under är produktionens och ska inte behöva ändras för att få plats.
 */
function TestBadge({
  run,
  imageCount,
  log,
  mediaError,
  onRestart,
}: {
  run: Run | null;
  imageCount: number;
  log: LogRow[];
  mediaError: string | null;
  onRestart: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="st-badge">
      <button className="st-badge-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {mediaError ? "⚠ " : ""}
        {t("SKICKTEST")} · {t("bara skick")} {open ? "▴" : "▾"}
      </button>
      {/* Utan bildkakan visas inga bilder i godkänn/avvisa. Säg det rakt ut i stället för att låta rutorna stå tomma. */}
      {mediaError && !open && (
        <p className="st-panel st-warn" role="alert">
          {t("Bilderna kan inte hämtas: bildsessionen misslyckades.")} {mediaError}
        </p>
      )}
      {open && (
        <div className="st-panel" role="region" aria-label={t("Testinfo")}>
          <p className="st-panel-line">
            {t("Körs: besiktning. Körs inte: identifiering, mått, annonstext, pris, omslagsurklipp.")}
          </p>
          {run ? (
            <dl className="st-facts">
              <dt>{t("Jobb")}</dt><dd className="st-mono">{run.jobId}</dd>
              <dt>{t("Bilder")}</dt><dd>{run.imageCount}{run.dropped ? ` (${run.dropped} ${t("föll bort")})` : ""}</dd>
              <dt>{t("Uppladdning")}</dt><dd>{(run.uploadMs / 1000).toFixed(1)} s</dd>
              <dt>{t("Till resultat")}</dt><dd>{run.resultMs === null ? "—" : `${(run.resultMs / 1000).toFixed(1)} s`}</dd>
            </dl>
          ) : (
            imageCount > 0 && <p className="st-panel-line">{t("{antal} bilder valda", { antal: imageCount })}</p>
          )}
          <h3 className="st-panel-title">{t("Händelser i guiden")}</h3>
          {log.length === 0 ? (
            <p className="st-panel-line">—</p>
          ) : (
            <ol className="st-log">
              {log.map((r, i) => (
                <li key={i}>
                  <span className="st-log-t">{(r.at / 1000).toFixed(1)}</span> {r.name}
                  {r.detail ? <span className="st-log-d"> {r.detail}</span> : null}
                </li>
              ))}
            </ol>
          )}
          <button className="btn btn-outline btn-small" onClick={onRestart}>{t("Börja om")}</button>
        </div>
      )}
    </div>
  );
}
