import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import { DEFECT_ITEM_SCHEMA } from "./inspect.js";
import type { RawDefect } from "./inspect.js";

/**
 * The seller points at damage the walkaround missed and photographs it close up.
 *
 * The mirror image of a dispute, and the prior leans the same way: the person standing in front of the
 * furniture saw something and went to the trouble of photographing it. A walkaround frame is a few
 * hundred soft pixels; a close-up is the better evidence. Say NO only when the photo genuinely shows an
 * undamaged surface.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_damage: {
      type: Type.BOOLEAN,
      description: "true om närbilden visar en verklig fysisk skada. false bara när ytan är hel och oskadad.",
    },
    reason: { type: Type.STRING, description: "En kort mening på svenska, riktad till säljaren." },
    defect: {
      ...DEFECT_ITEM_SCHEMA,
      description: "Skadan, i samma form som inspektionens fynd. Utelämna evidence — närbilden är beviset.",
    },
  },
  required: ["is_damage", "reason"],
};

export interface AddFromPhotoOutcome {
  isDamage: boolean;
  reason: string;
  defect: RawDefect | null;
  tokensUsed: number;
}

const SYSTEM_PROMPT = `En säljare har sett en skada som den automatiska skickbedömningen missade, och
fotograferat den på nära håll. Din uppgift är att beskriva den som ett fynd.

Utgå från att det finns en skada. Säljaren stod framför möbeln, såg något, och tog besväret att
fotografera just det stället — det är starkare underlag än ett svep på håll. Sätt is_damage=false bara
när närbilden faktiskt visar en hel, oskadad yta, eller något som är en reflex, skugga, söm, träådring,
avsiktlig designdetalj eller avtorkningsbar smuts.

Är det en skada: fyll i defect med rätt typ ur taxonomin, vilken möbeldel det är, var på delen, hur
allvarlig, vilken påverkan, och en kort konkret beskrivning av vad som syns. Hoppa över evidence —
närbilden är beviset.

Svara koncist, inget resonemang i klartext.`;

export async function assessAddedPhoto(closeUp: ImagePart, partHint: string | null): Promise<AddFromPhotoOutcome> {
  const { data, tokensUsed } = await callGeminiStructured<{ is_damage: boolean; reason: string; defect?: RawDefect }>({
    purpose: "add_from_photo",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: partHint
      ? `Närbild på en skada som säljaren pekat ut. Säljaren anger delen som: "${partHint}". Bedöm enligt schemat.`
      : "Närbild på en skada som säljaren pekat ut. Bedöm enligt schemat.",
    images: [{ ...closeUp, label: "Närbild tagen av säljaren på en skada som missades" }],
    responseSchema: RESPONSE_SCHEMA,
    resolution: "high",
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 15_000,
  });
  return { isDamage: data.is_damage, reason: data.reason, defect: data.defect ?? null, tokensUsed };
}
