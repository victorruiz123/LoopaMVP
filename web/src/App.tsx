import { useRef, useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import PriceScreen from "./screens/PriceScreen";
import ResultScreen from "./screens/ResultScreen";
import TruthCardScreen from "./screens/TruthCardScreen";
import { getJob, type CapturedShot } from "./api";
import type { ConditionResult, FurnitureIdentity } from "./types";

type Screen =
  | { name: "home" }
  | { name: "capture"; identity: FurnitureIdentity }
  | { name: "price"; identity: FurnitureIdentity; jobId: string; previewShots: CapturedShot[] }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[]; identity: FurnitureIdentity }
  | { name: "result"; jobId: string }
  | { name: "truthcard"; jobId: string; result: ConditionResult };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  /**
   * Startsidan monteras om varje gång man landar där, och den läser sina fält ur ingenting — så en ny
   * skanning börjar alltid tom. Identiteten bars tidigare med tillbaka hit och förifyllde märke och
   * modell, vilket lät hjälpsamt men var fel: "Starta en ny skanning" betyder en ny möbel, och den
   * förra möbelns namn kvar i rutorna är ett fel som följer med hela vägen ner i prisförslaget.
   */
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
            setScreen({ name: "price", identity: screen.identity, jobId, previewShots })
          }
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
          // Truth-cardet är sista steget: modellen och specifikationerna, med skicket och priset
          // inbakade. Resultatet skickas med så vyn slipper hämta om det som redan står på skärmen.
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
