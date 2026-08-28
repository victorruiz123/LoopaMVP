import { useEffect, useRef, useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import ModelSelectScreen from "./screens/ModelSelectScreen";
import SpecsScreen from "./screens/SpecsScreen";
import PriceScreen from "./screens/PriceScreen";
import ResultScreen from "./screens/ResultScreen";
import TruthCardScreen from "./screens/TruthCardScreen";
import { getJob, selectModel, type CapturedShot } from "./api";
import type { ConditionJob, ConditionResult, FurnitureIdentity, ModelCandidate } from "./types";

type Screen =
  | { name: "home" }
  | { name: "capture"; identity: FurnitureIdentity }
  | { name: "identify"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "specs"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "price"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[]; identity: FurnitureIdentity }
  | { name: "result"; jobId: string }
  | { name: "truthcard"; jobId: string; result: ConditionResult };

/**
 * Flödet: märke -> bilder -> VÄLJ MODELL -> specifikationer -> pris -> skick -> truth-card.
 *
 * Modellvalet ligger först av allt som händer efter bilderna, för att allt därefter hänger på det:
 * prismotorn söker på modellnamnet, och annonsen byggs runt den. Tidigare låg identifieringen sist,
 * där den ibland kom fram till att säljaren angett fel möbel efter att skick och pris redan räknats.
 */
export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const homeKey = useRef(0);

  const goHome = () => {
    homeKey.current += 1;
    setScreen({ name: "home" });
  };

  switch (screen.name) {
    case "home":
      return (
        <HomeScreen
          key={homeKey.current}
          onStartScan={(identity) => setScreen({ name: "capture", identity })}
          onOpenJob={(jobId) => setScreen({ name: "result", jobId })}
        />
      );
    case "capture":
      return (
        <CaptureScreen
          identity={screen.identity}
          onBack={goHome}
          onCaptured={(jobId, previewShots) =>
            setScreen({ name: "identify", jobId, identity: screen.identity, previewShots })
          }
        />
      );
    case "identify":
      return (
        <IdentifyGate
          jobId={screen.jobId}
          identity={screen.identity}
          onResolved={() =>
            setScreen({
              name: "specs",
              jobId: screen.jobId,
              identity: screen.identity,
              previewShots: screen.previewShots,
            })
          }
        />
      );
    case "specs":
      return (
        <SpecsGate
          jobId={screen.jobId}
          onNext={() => setScreen({ ...screen, name: "price" })}
          onBack={() => setScreen({ ...screen, name: "identify" })}
        />
      );
    case "price":
      return (
        <PriceScreen
          identity={screen.identity}
          jobId={screen.jobId}
          onSeeCondition={() =>
            setScreen({ name: "analysis", jobId: screen.jobId, previewShots: screen.previewShots, identity: screen.identity })
          }
        />
      );
    case "analysis":
      return (
        <AnalysisScreen
          jobId={screen.jobId}
          previewShots={screen.previewShots}
          identity={screen.identity}
          onDone={() => setScreen({ name: "result", jobId: screen.jobId })}
          onAbort={goHome}
        />
      );
    case "result":
      return (
        <ResultScreen
          jobId={screen.jobId}
          onRestart={goHome}
          onHome={goHome}
          onSeeTruthCard={async () => {
            const job = await getJob(screen.jobId);
            if (job.result) setScreen({ name: "truthcard", jobId: screen.jobId, result: job.result });
          }}
        />
      );
    case "truthcard":
      return (
        <TruthCardScreen
          result={screen.result}
          onBack={() => setScreen({ name: "result", jobId: screen.jobId })}
          onHome={goHome}
        />
      );
  }
}

/**
 * Klientens egen bortre gräns.
 *
 * Servern kan dö mellan två pollningar — den lever i minnet, så en omstart tar varje pågående körning
 * med sig. Skärmen ska då sluta snurra och säga det, inte vänta för evigt på ett jobb ingen längre
 * arbetar med. Rundligare än serverns deadline, så serverns felmeddelande hinner fram först.
 */
const CLIENT_GIVE_UP_MS = 300_000;

function useJobPoll(jobId: string, done: (job: ConditionJob) => boolean) {
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const until = Date.now() + CLIENT_GIVE_UP_MS;
    const poll = async () => {
      if (Date.now() > until) return setGaveUp(true);
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        setJob(j);
        // Ett fällt jobb är ett svar. Att fortsätta polla på det är att snurra på ett dött jobb.
        if (j.progress.stage === "error" || done(j)) return;
        setTimeout(poll, 1200);
      } catch {
        if (!cancelled) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return { job, gaveUp, failed: job?.progress.stage === "error" };
}

/** Väntar in identifieringen och visar kandidaterna. Hoppas över när den kunde avgöra modellen själv. */
function IdentifyGate({
  jobId,
  identity,
  onResolved,
}: {
  jobId: string;
  identity: FurnitureIdentity;
  onResolved: () => void;
}) {
  const [sent, setSent] = useState(false);
  const { job, gaveUp, failed } = useJobPoll(
    jobId,
    (j) => j.identityStatus === "needs_selection" || j.identityStatus === "unavailable" || j.identityStatus === "resolved",
  );

  async function choose(choice: { candidate?: ModelCandidate; manualModel?: string }) {
    setSent(true);
    // Servern svarar 202 och arbetar vidare i bakgrunden; specifikationsskärmen pollar själv. Att
    // vänta in hela annonsen här hade gjort valet till en tyst paus på tjugo sekunder.
    await selectModel(jobId, choice);
    onResolved();
  }

  if (sent || job?.identityStatus === "resolved") {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Bygger annonsen…</p>
        <p className="muted small">Hämtar mått, material och specifikationer</p>
      </div>
    );
  }
  // Ö.6: identifieringen får aldrig sluta i en återvändsgränd. Faller den — eller dör jobbet, eller
  // ger klienten upp — landar säljaren på samma skärm med noll kandidater och kan skriva namnet själv.
  // En misslyckad identifiering ska kosta ett handgrepp, inte en omstart.
  const stalled = gaveUp || failed || job?.identityStatus === "unavailable";
  if (!stalled && (!job || job.identityStatus === "identifying" || !job.identityStatus)) {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Letar upp modellen…</p>
        <p className="muted small">Söker efter {identity.brand}-modeller som stämmer med bilderna</p>
      </div>
    );
  }
  return (
    <>
      {stalled && (
        <p className="identify-fallback-note identify-fallback-floating">
          {gaveUp
            ? "Vi fick inget svar från servern."
            : failed
              ? job?.error ?? "Analysen avbröts."
              : "Vi kunde inte söka fram några modeller just nu."}
        </p>
      )}
      <ModelSelectScreen
        brand={identity.brand}
        candidates={job?.candidates ?? []}
        onSelect={(candidate) => choose({ candidate })}
        onManual={(manualModel) => choose({ manualModel })}
      />
    </>
  );
}

/** Väntar in annonsen efter modellvalet. */
function SpecsGate({ jobId, onNext, onBack }: { jobId: string; onNext: () => void; onBack: () => void }) {
  const { job, gaveUp, failed } = useJobPoll(jobId, (j) => {
    const l = j.result?.listing ?? j.pendingListing;
    return !!l && l.status !== "pending";
  });

  // `pendingListing` finns för att annonsen kan bli klar innan skickresultatet — och när skicket FALLER
  // kommer resultatet aldrig. Att bara läsa `result.listing` betydde att en färdig annons låg
  // oåtkomlig medan skärmen snurrade i evighet.
  const listing = job?.result?.listing ?? job?.pendingListing;
  if (!listing && (gaveUp || failed)) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">Annonsen blev inte klar</h2>
        <p className="muted small">{gaveUp ? "Vi fick inget svar från servern." : job?.error}</p>
        <button className="btn btn-primary" onClick={onNext}>
          Fortsätt ändå
        </button>
        <button className="btn btn-text" onClick={onBack}>
          Byt modell
        </button>
      </div>
    );
  }
  if (!listing || listing.status === "pending") {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Bygger annonsen…</p>
        <p className="muted small">Hämtar mått, material och specifikationer</p>
      </div>
    );
  }
  if (!listing.result) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">Annonsen kunde inte skapas</h2>
        <p className="muted small">{listing.unavailableReason}</p>
        <button className="btn btn-primary" onClick={onNext}>
          Fortsätt till priset ändå
        </button>
        <button className="btn btn-text" onClick={onBack}>
          Byt modell
        </button>
      </div>
    );
  }
  return <SpecsScreen card={listing.result} onNext={onNext} onBack={onBack} />;
}
