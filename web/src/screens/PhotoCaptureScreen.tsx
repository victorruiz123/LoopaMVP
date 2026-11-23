import { useMemo } from "react";
import PhotoCaptureFlow from "../components/PhotoCaptureFlow";
import type { CapturedShot } from "../api";
import type { FurnitureIdentity } from "../types";
import { GUIDE_STEPS, newShotId, toPayload, type GuideShot } from "../lib/photoGuide";
import { usePageTitle } from "../lib/pageTitle";
import * as flode from "../lib/flode";

/**
 * Bildguiden i huvudflödet: omslagsbild, vinklar, minst fem bilder, och sedan vidare till uppladdningen
 * (identifiering, mått, pris och skickbedömning, precis som med filmen förut).
 *
 * Bilderna lämnas som `CapturedShot[]` — samma form som resten av flödet redan förstår — så inloggningsrundan
 * (säljaren backar ur kontot och kommer tillbaka hit) fungerar: `initialShots` mappas tillbaka till
 * guidens steg via etiketten.
 */
function fromCaptured(shots: CapturedShot[] | undefined): GuideShot[] | undefined {
  if (!shots?.length) return undefined;
  const taken = new Set<string>();
  return shots.map((s) => {
    const step = GUIDE_STEPS.find((g) => g.label === s.viewLabel && !taken.has(g.id)) ?? null;
    if (step) taken.add(step.id);
    return {
      id: newShotId(),
      dataUrl: s.dataUrl,
      stepId: step?.id ?? null,
      viewLabel: step ? step.label : s.viewLabel,
      origin: "upload" as const,
    };
  });
}

export default function PhotoCaptureScreen({
  identity: _identity,
  initialShots,
  onBack,
  onCaptured,
}: {
  identity: FurnitureIdentity;
  initialShots?: CapturedShot[];
  onBack: () => void;
  onCaptured: (shots: CapturedShot[]) => void;
}) {
  usePageTitle("Fotografera möbeln");
  const initial = useMemo(() => fromCaptured(initialShots), [initialShots]);
  return (
    <PhotoCaptureFlow
      initialShots={initial}
      onExit={onBack}
      onDone={(chosen) => {
        const payload = toPayload(chosen);
        flode.klick("skicka_bilder", { varde: payload.length });
        onCaptured(payload);
      }}
    />
  );
}
