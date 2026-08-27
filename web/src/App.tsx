import { useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import ResultScreen from "./screens/ResultScreen";
import type { CapturedShot } from "./api";

type Screen =
  | { name: "home" }
  | { name: "capture" }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[] }
  | { name: "result"; jobId: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  switch (screen.name) {
    case "home":
      return (
        <HomeScreen
          onStartScan={() => setScreen({ name: "capture" })}
          onOpenJob={(jobId) => setScreen({ name: "result", jobId })}
        />
      );
    case "capture":
      return (
        <CaptureScreen
          onBack={() => setScreen({ name: "home" })}
          onCaptured={(jobId, previewShots) => setScreen({ name: "analysis", jobId, previewShots })}
        />
      );
    case "analysis":
      return (
        <AnalysisScreen
          jobId={screen.jobId}
          previewShots={screen.previewShots}
          onDone={() => setScreen({ name: "result", jobId: screen.jobId })}
        />
      );
    case "result":
      return (
        <ResultScreen
          jobId={screen.jobId}
          onRestart={() => setScreen({ name: "capture" })}
          onHome={() => setScreen({ name: "home" })}
        />
      );
  }
}
