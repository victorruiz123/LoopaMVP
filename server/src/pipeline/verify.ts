import path from "node:path";
import { mkdir } from "node:fs/promises";
import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import { cropEvidence, loadImageAsBase64 } from "../imageUtils.js";
import { VERIFY_ALL_FINDINGS, VERIFY_CONFIDENCE_THRESHOLD, VERIFY_IMPACTS, VERIFY_SEVERITIES } from "../config.js";
import { buildVerifyPayload, type CropAttempt } from "./verifyPayload.js";
import { DEFECT_ITEM_SCHEMA, mapRawDefect, type RawDefect } from "./inspect.js";
import type { CallMeta, CapturedImage, Damage } from "../types.js";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reviews: {
      type: Type.ARRAY,
      description: "En rad per fynd från första besiktningen, i samma ordning som de listas.",
      items: {
        type: Type.OBJECT,
        properties: {
          finding_index: { type: Type.INTEGER, description: "1-baserat, matchar numreringen i listan." },
          verdict: {
            type: Type.STRING,
            enum: ["KEEP", "REJECT"],
            description: "KEEP är standard. REJECT bara när utsnittet uppenbart inte visar en skada — reflex, skugga, söm, träådring, designdetalj eller avtorkningsbar smuts.",
          },
          reason: { type: Type.STRING, description: "En kort mening på svenska." },
        },
        required: ["finding_index", "verdict", "reason"],
      },
    },
    additional_defects: {
      type: Type.ARRAY,
      description:
        "Skador som första besiktningen MISSADE. Titta särskilt efter nedsuttenhet, missfärgning, blankslitning och slitage på ben, kanter och ändar. Tom lista om du inte hittar något nytt — hitta aldrig på för att fylla listan.",
      items: DEFECT_ITEM_SCHEMA,
    },
  },
  required: ["reviews", "additional_defects"],
};

interface RawReview {
  finding_index: number;
  verdict: "KEEP" | "REJECT";
  reason: string;
}

interface RawResponse {
  reviews: RawReview[];
  additional_defects: RawDefect[];
}

const SYSTEM_PROMPT = `Du är ANDRA BESIKTAREN. Du får alla bilder av möbeln, en lista över vad första
besiktningen hittade, och ett förstorat utsnitt per fynd.

Du har två uppgifter, och den andra är minst lika viktig som den första.

1. GRANSKA det som hittats. Utgå från att första besiktningen hade rätt — de allra flesta fynd ska
   behållas. Sätt REJECT bara när utsnittet UPPENBART inte visar en skada: en reflex eller glansdager,
   en skugga, en söm, träets naturliga ådring, en avsiktlig designdetalj, eller smuts som torkas bort.
   Är du tveksam: behåll fyndet. Ett felaktigt borttaget fynd är värre än ett tveksamt som står kvar.
   Kräv INTE att skadan syns i flera bilder — många skador syns bara från ett håll.

   MÖRKA BLANKA YTOR — svart trä, lack, metall, läder — är det vanligaste stället att bli lurad. Där
   ser en glansdager ut precis som en ljus repa. Skilj dem så här:
   - En REFLEX följer föremålets form: den ligger längs en kant, en rundning eller en fasett, löper
     jämnt med den, och tonar mjukt ut i ändarna. Den finns bara för att ljuset råkar falla så.
   - En REPA struntar i föremålets form: den korsar ytan i sin egen riktning, har hårda oregelbundna
     kanter, och slutar tvärt. Under den syns blottat underlag i annan kulör, inte bara ljusare svart.
   Formuleringen "syns i ljusvinkel", "framträder i visst ljus" eller liknande är i sig ett skäl att
   AVFÄRDA: en verklig skada syns oavsett hur ljuset faller. Är märket bara där för ljusets skull är
   det inte en skada, hur tydligt det än ser ut.

2. HITTA DET SOM MISSATES. Gå igenom hela möbeln i bilderna på nytt, oberoende av listan. Första
   besiktningen missar systematiskt vissa saker — titta särskilt efter:
   - NEDSUTTEN STOPPNING: tyget är inte slätt och rakt utan veckat, en sits som buktar nedåt, en dyna
     utan fyllighet. Jämför sitsens mitt mot kanterna och den använda sitsen mot ytor ingen suttit på.
   - MISSFÄRGNING och fläckar: ojämn färg där ytan borde vara enfärgad, mörkare där kroppen tagit i.
   - BLANKSLITNING: nedtryckta glansiga fibrer i stället för uppresta matta.
   - Slitage på BEN, KANTER och ÄNDAR, som är små i bild och lätt förbises.
   Lägg bara till sådant du faktiskt kan peka ut i en bild. Hittar du inget nytt är tom lista rätt svar.

Svara koncist, inget resonemang i klartext.`;

/** Which candidates are ambiguous/high-stakes enough to justify the one optional verification call. */
export function needsVerification(d: Damage): boolean {
  return (
    VERIFY_ALL_FINDINGS ||
    d.confidence < VERIFY_CONFIDENCE_THRESHOLD ||
    VERIFY_SEVERITIES.has(d.severity) ||
    VERIFY_IMPACTS.has(d.impact)
  );
}

export interface VerifyOutcome {
  verified: Damage[];
  callMeta: CallMeta | null;
}

/**
 * Auto-confirms clear, low-stakes findings directly (no API call). Flagged findings (low confidence,
 * possible S3/S4, or structural/functional impact) are cropped and sent together in ONE batched call.
 * Skips the call entirely if nothing needs it — this is the "at most 2 Gemini calls" optional stage.
 */
export async function verifyFindings(defects: Damage[], images: CapturedImage[], jobDir: string): Promise<VerifyOutcome> {
  const toVerify = defects.filter(needsVerification);
  const autoConfirmed = defects.filter((d) => !needsVerification(d));

  const confirmedDirectly: Damage[] = autoConfirmed.map((d) => ({
    ...d,
    verification: "CONFIRMED",
    verificationReason: "Tydligt fynd, hög säkerhet — accepterat direkt.",
  }));

  if (toVerify.length === 0) {
    return { verified: confirmedDirectly, callMeta: null };
  }

  const imageById = new Map(images.map((img) => [img.id, img]));
  const cropsDir = path.join(jobDir, "crops");
  await mkdir(cropsDir, { recursive: true });

  // ALL images: the second inspector has to be able to find what the first one missed, which it cannot
  // do from crops alone. Labelled by index so evidence coordinates refer to something identifiable.
  const referenceParts: ImagePart[] = [];
  for (let i = 0; i < images.length; i++) {
    const part = await loadImageAsBase64(path.join(jobDir, "originals", images[i].path));
    referenceParts.push({ ...part, label: `Bild ${i}` });
  }

  // Crop FIRST, number after: the numbering has to come from the crops that actually exist.
  const attempts: CropAttempt[] = [];
  for (const d of toVerify) {
    const primary = d.evidence[0];
    const image = primary ? imageById.get(primary.imageId) : undefined;
    if (!primary || !image) {
      attempts.push({ damage: d, cropRelPath: null });
      continue;
    }
    const originalAbs = path.join(jobDir, "originals", image.path);
    const cropRelPath = path.join("crops", `${d.id}.jpg`).replace(/\\/g, "/");
    try {
      await cropEvidence(originalAbs, primary.mark, path.join(jobDir, cropRelPath));
      attempts.push({ damage: d, cropRelPath });
    } catch {
      attempts.push({ damage: d, cropRelPath: null });
    }
  }

  const { numbered, uncroppable } = buildVerifyPayload(attempts, images);

  // Everything failed to crop — there is nothing to show the model, so skip the call entirely.
  if (numbered.length === 0) {
    return { verified: [...confirmedDirectly, ...uncroppable.map(markUncroppable)], callMeta: null };
  }

  // Each crop carries its own label part, emitted immediately before the image, so "Utsnitt 3"
  // is something the model can actually see rather than something the prompt merely claims.
  const cropParts: ImagePart[] = [];
  for (const crop of numbered) {
    const part = await loadImageAsBase64(path.join(jobDir, crop.cropRelPath));
    cropParts.push({ ...part, label: crop.label });
  }

  const findingList = numbered
    .map((c, i) => `Fynd ${i + 1}: ${c.damage.type} på ${c.damage.part} (${c.damage.semanticLocation}). ${c.damage.description}`)
    .join("\n");
  const userPrompt = `Först ${images.length} hela bilder av möbeln, märkta Bild 0-${images.length - 1}. Därefter ${numbered.length} förstorade utsnitt, ett per fynd.\n\nFörsta besiktningen hittade:\n${findingList}\n\nGranska dessa enligt schemat, och gå sedan igenom hela möbeln på nytt efter det som missats.`;

  const { data, tokensUsed, cached, modelUsed, latencyMs } = await callGeminiStructured<RawResponse>({
    purpose: "verify_findings",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    images: [...referenceParts, ...cropParts],
    responseSchema: RESPONSE_SCHEMA,
    resolution: "high",
    primaryTimeoutMs: 45_000,
    fallbackTimeoutMs: 20_000,
  });

  const verdictByIndex = new Map((data.reviews ?? []).map((r) => [r.finding_index, r]));
  const reviewed: Damage[] = numbered.map(({ damage: d, cropRelPath, index }) => {
    const r = verdictByIndex.get(index);
    const evidence = d.evidence.map((e, ei) => (ei === 0 ? { ...e, cropPath: cropRelPath } : e));
    // No verdict returned means the reviewer said nothing about it — keep it. Silence is not rejection.
    if (!r) return { ...d, verification: "CONFIRMED", verificationReason: "Granskad utan invändning.", evidence };
    return {
      ...d,
      verification: r.verdict === "REJECT" ? "REJECTED" : "CONFIRMED",
      verificationReason: r.reason,
      evidence,
    };
  });

  // Defects the first pass missed, in the same shape as any other finding.
  const added: Damage[] = (data.additional_defects ?? []).map((raw, i) => ({
    ...mapRawDefect(raw, images, `add_${i}`),
    verification: "CONFIRMED" as const,
    verificationReason: "Hittad av andra besiktaren.",
  }));

  return {
    verified: [...confirmedDirectly, ...reviewed, ...added, ...uncroppable.map(markUncroppable)],
    callMeta: { purpose: "verify_findings", tokensUsed, cached, modelUsed, latencyMs },
  };
}

/**
 * A candidate that never reached the reviewer keeps its standing. It must never inherit another crop's
 * verdict, and it must not be dropped either: failing to CROP a finding says nothing about whether the
 * damage is real, and UNCERTAIN would remove it from the grade for a purely technical reason.
 */
function markUncroppable(d: Damage): Damage {
  return { ...d, verification: "CONFIRMED", verificationReason: "Kunde inte beskäras — inte granskad, fyndet står kvar." };
}
