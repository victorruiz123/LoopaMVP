import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import type { Damage } from "../types.js";

/**
 * Seller dispute: they looked at the spot in person, disagree that it is damage, and photographed it
 * close up. This is NOT part of the inspection pipeline — it never runs during a scan, only when a
 * seller pushes back on one specific finding.
 *
 * The prior leans towards removal, and deliberately so. The seller stood in front of the furniture with
 * their own eyes and went to the trouble of taking another photo; the inspection saw a few hundred
 * pixels in a walkaround frame. When the close-up is ambiguous, the person who was there wins.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: {
      type: Type.STRING,
      enum: ["REMOVE", "KEEP"],
      description:
        "REMOVE om närbilden inte visar en verklig skada, eller om det är oklart. KEEP bara när närbilden TYDLIGT visar samma verkliga skada som rapporterades.",
    },
    reason: {
      type: Type.STRING,
      description: "En kort mening på svenska, riktad till säljaren. Motivera vad närbilden visar.",
    },
  },
  required: ["verdict", "reason"],
};

const SYSTEM_PROMPT = `En säljare bestrider ett fynd från en automatisk skickbedömning. Du får det
ursprungliga utsnittet som fyndet baserades på, och en NY närbild som säljaren just tagit på samma
ställe.

Närbilden väger tyngre. Den är tagen på nära håll, av någon som stod framför möbeln och tittade på
platsen med egna ögon. Det ursprungliga fyndet kom från några hundra pixlar i en översiktsbild.

Sätt KEEP bara när närbilden TYDLIGT visar samma verkliga fysiska skada som rapporterades — då ska
säljaren få veta att den finns kvar.

Sätt REMOVE i alla andra fall: när närbilden visar en ren yta, när det som syns är en reflex, skugga,
söm, träådring, designdetalj eller avtorkningsbar smuts, och även när det är oklart. Ett bestridande som
inte kan motbevisas ska vinna.

Svara koncist, inget resonemang i klartext.`;

export interface DisputeOutcome {
  verdict: "REMOVE" | "KEEP";
  reason: string;
  tokensUsed: number;
  modelUsed: string;
}

export async function adjudicateDispute(
  damage: Damage,
  originalCrop: ImagePart | null,
  closeUp: ImagePart,
): Promise<DisputeOutcome> {
  const images: ImagePart[] = [];
  if (originalCrop) images.push({ ...originalCrop, label: "Ursprungligt utsnitt som fyndet baserades på" });
  images.push({ ...closeUp, label: "NY närbild tagen av säljaren på samma ställe" });

  const { data, tokensUsed, modelUsed } = await callGeminiStructured<{ verdict: "REMOVE" | "KEEP"; reason: string }>({
    purpose: "dispute",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Bestritt fynd: ${damage.type} på ${damage.part}${damage.semanticLocation ? ` (${damage.semanticLocation})` : ""}. Ursprunglig beskrivning: ${damage.description}\nAvgör enligt schemat.`,
    images,
    responseSchema: RESPONSE_SCHEMA,
    resolution: "high",
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 15_000,
  });

  return { verdict: data.verdict, reason: data.reason, tokensUsed, modelUsed };
}
