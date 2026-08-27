import { useRef, useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import ResultScreen from "./screens/ResultScreen";
import type { CapturedShot } from "./api";
import type { FurnitureIdentity } from "./types";

type Screen =
  | { name: "home" }
  | { name: "capture"; identity: FurnitureIdentity }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[]; identity: FurnitureIdentity }
  | { name: "result"; jobId: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  /**
   * Startsidan monteras om varje gång man landar där, och den läser sina fält ur ingenting — så en ny
   * skanning börjar alltid tom. Identiteten bars tidigare med tillbaka hit och förifyllde märke och
   * modell, vilket lät hjälpsamt men var fel: "Starta en ny skanning" betyder en ny möbel, och den
   * förra möbelns namn kvar i rutorna är ett fel som följer med hela vägen ner i prisförslaget.
   */
  const homeKey = useRef(0);

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
          onBack={() => setScreen({ name: "home" })}
          onCaptured={(jobId, previewShots) =>
            setScreen({ name: "analysis", jobId, previewShots, identity: screen.identity })
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
          onAbort={() => {
            homeKey.current += 1;
            setScreen({ name: "home" });
          }}
        />
      );
    case "result":
      return (
        <ResultScreen
          jobId={screen.jobId}
          onRestart={() => {
            // Ny nyckel tvingar fram en färsk HomeScreen även om man redan råkade stå på den.
            homeKey.current += 1;
            setScreen({ name: "home" });
          }}
          onHome={() => setScreen({ name: "home" })}
        />
      );
  }
}
