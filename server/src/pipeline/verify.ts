import path from "node:path";
import { mkdir } from "node:fs/promises";
import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import { cropEvidence, loadImageAsBase64, markFromCrop } from "../imageUtils.js";
import {
  EXTRA_MARKS_ENABLED,
  MAX_ADDED_PER_CROP,
  MAX_ADDED_TOTAL,
  MIN_ADDED_CONFIDENCE,
  VERIFY_ALL_FINDINGS,
  VERIFY_CONFIDENCE_THRESHOLD,
  VERIFY_IMPACTS,
  VERIFY_SEVERITIES,
} from "../config.js";
import { buildVerifyPayload, mergeReviewedDuplicates, type NumberedCrop, type CropAttempt } from "./verifyPayload.js";
import { DAMAGE_TYPES, mapRawDefect, type RawDefect } from "./inspect.js";
import type { CallMeta, CapturedImage, Damage, Severity } from "../types.js";

/**
 * Granskningen utgår från det första besiktningen hittat, och tittar bara i UTSNITTEN.
 *
 * Den letade en gång efter missade skador i hela bilderna, och det var den halvan som kostade: den
 * krävde att alla originalbilder skickades med (2,4-5,3 MB) och fördubblade svarets omfång. Den
 * halvan är fortfarande borta — nyttolasten är utsnitten och ingenting annat.
 *
 * Kvar, och nytt, är den billiga delen av samma idé: när modellen ändå har ett ~5x förstorat utsnitt
 * framför sig får den säga om det syns FLER märken i det. Skador sitter i kluster, och första
 * besiktningen såg samma yta i en vidbild där ett märke är några pixlar — det är därför den hittar
 * ett av tre skav på samma benkant. Att fråga om resten kostar inga bilder och inget anrop, bara
 * några rader i svaret. Ramarna står i config.ts: högst två per utsnitt, högst fyra totalt, golv 70,
 * och de kan inte bära ett värre betyg än S2/kosmetisk.
 *
 * En skada som varken syns i något utsnitt eller hittades av första besiktningen förblir missad.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reviews: {
      type: Type.ARRAY,
      description: "En rad per utsnitt, i samma ordning som de visas.",
      items: {
        type: Type.OBJECT,
        properties: {
          finding_index: { type: Type.INTEGER, description: "1-baserat, matchar numreringen." },
          verdict: {
            type: Type.STRING,
            enum: ["KEEP", "REJECT"],
            description:
              "KEEP när du kan peka ut avvikelsen i utsnittet. REJECT när du inte kan det — reflex, skugga, söm, träådring, tygmönster, designdetalj, avtorkningsbar smuts, oskärpa, eller helt enkelt ett oskadat parti.",
          },
          duplicate_of: {
            type: Type.INTEGER,
            description:
              "Numret på det FÖRSTA utsnitt som visar samma fysiska skada som detta, när skadan är fotad ur flera håll. 0 när fyndet är ensamt om sin skada. Två likadana skador på olika ställen är inte dubbletter, inte heller när de sitter på samma del — är du osäker, sätt 0.",
          },
          reason: { type: Type.STRING, description: "Högst åtta ord." },
          // MEDVETET utanför required: ett obligatoriskt fält vill fyllas i, och det är precis vad
          // ett tillagt märke inte ska göra. Utelämnat betyder tom lista, och tom lista är normalen.
          // Fältet finns bara när frågan ställs — ett schema som beskriver något prompten inte ber om
          // kostar tokens och inbjuder till gissningar.
          ...(EXTRA_MARKS_ENABLED ? { extra_marks: {
            type: Type.ARRAY,
            description:
              "FLER märken som syns i JUST DET HÄR utsnittet, utöver det i mitten. Gå igenom hela utsnittet kant till kant. Ta med sådant du kan peka ut lika tydligt som ett fynd du godkänner — aldrig reflex, skugga, söm, träådring, tygmönster, designdetalj eller smuts. Högst två.",
            items: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING, enum: DAMAGE_TYPES },
                semantic_location: { type: Type.STRING, description: "Läge inom delen, på svenska: 'strax ovanför', 'längre ned på kanten'." },
                severity: { type: Type.STRING, enum: ["S1", "S2", "S3", "S4"] },
                description: { type: Type.STRING, description: "Kort, konkret visuellt bevis på svenska. Vad ser du, och hur skiljer det sig från ytan omkring?" },
                confidence: { type: Type.NUMBER, description: "0-100. Under 70 tas märket inte med alls — är du inte så säker, utelämna det." },
                x: { type: Type.NUMBER, description: "Rutan i UTSNITTETS koordinater: 0-1 från utsnittets vänsterkant." },
                y: { type: Type.NUMBER, description: "0-1 från utsnittets överkant." },
                w: { type: Type.NUMBER, description: "0-1, rutans bredd i utsnittet." },
                h: { type: Type.NUMBER, description: "0-1, rutans höjd i utsnittet." },
              },
              required: ["type", "semantic_location", "severity", "description", "confidence", "x", "y", "w", "h"],
            },
          } } : {}),
        },
        required: ["finding_index", "verdict", "duplicate_of", "reason"],
      },
    },
  },
  required: ["reviews"],
};

interface RawExtraMark {
  type: RawDefect["type"];
  semantic_location: string;
  severity: Severity;
  description: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RawReview {
  finding_index: number;
  verdict: "KEEP" | "REJECT";
  duplicate_of?: number;
  reason: string;
  extra_marks?: RawExtraMark[];
}

interface RawResponse {
  reviews: RawReview[];
}

const EXTRA_MARKS_BLOCK = `
3) FLER MÄRKEN I SAMMA UTSNITT. Gå igenom HELA utsnittet, kant till kant, inte bara märket i mitten. Utsnittet är kraftigt förstorat mot vad första besiktningen såg av samma yta, och där det sitter ett märke sitter det oftast fler: samma kant har stött emot samma sak många gånger. Första besiktningen såg den här ytan i en vidbild och rapporterade det tydligaste märket — de andra är kvar åt dig.

Varje ytterligare märke du kan peka ut lägger du i extra_marks, med en ruta i UTSNITTETS egna koordinater (0-1 från utsnittets vänster- och överkant). Kravet är detsamma som för KEEP: du ska kunna säga vad du ser och hur det skiljer sig från ytan omkring, och samma sak gäller det som ALDRIG är en skada — reflex, skugga, söm, ådring, mönster, designdetalj, smuts, oskärpa. Ta inte med märket i mitten en gång till. Högst två per utsnitt, och ser du inget mer är tom lista rätt svar.
`;

const SYSTEM_PROMPT = `Du är ANDRA BESIKTAREN. Du får ett förstorat utsnitt per fynd som första besiktningen rapporterat, numrerade i ordning, med typ och läge angivet. Fyndet som ska bedömas ligger MITT I utsnittet — ytan runt omkring är med som sammanhang.

Du svarar på ${EXTRA_MARKS_ENABLED ? "TRE" : "TVÅ"} frågor per utsnitt.

1) VERDIKT. Frågan är inte "kan det sitta en skada här?" utan "SER JAG den?". Svara KEEP när du kan peka ut avvikelsen och säga hur den skiljer sig från ytan omkring: en linje, ett märke, en fläck, ett parti där ytskiktet är borta. Kan du inte det, svara REJECT.

REJECT gäller särskilt: reflexer och glansdagrar · skuggor · sömmar, stickningar och paspoal · träets ådring och kvistar · tygets mönster, bindning och lugg · avsiktliga designdetaljer och skarvar · damm, ludd, smulor, hårstrån och annat som torkas bort · oskärpa och komprimeringsbrus i förstoringen · ett parti som helt enkelt är oskadat.

Normalt bruksslitage ÄR en skada och ska behållas när det SYNS: nötta kanter, blankslitna ytor, missfärgning, nedsutten stoppning. Det är påståenden utan synligt stöd i utsnittet som ska bort — aldrig små skador för att de är små.

Du dömer utsnittet, inte möbeln. Att en begagnad möbel "säkert" har slitage är inget skäl att behålla ett fynd du inte kan se, och att första besiktningen skrev en övertygande beskrivning är inte heller ett bevis.

2) DUBBLETT. Flera utsnitt kan visa SAMMA fysiska skada, tagna ur olika bildrutor — samma märke, samma ställe på möbeln, samma form. Sätt då duplicate_of till numret på det FÖRSTA utsnittet som visar den skadan, så att skadan kan märkas ut i alla bildrutor den syns i i stället för att räknas flera gånger. Två skador av samma sort på olika ställen är INTE dubbletter — varken ett skav på vartdera benet eller två skav på SAMMA ben. Två utsnitt av samma del visar samma skada bara när märket sitter på samma ställe på delen: samma avstånd från kant och ände, samma form och riktning. Sätt 0 när fyndet är ensamt om sin skada, och 0 när du är osäker.

${EXTRA_MARKS_ENABLED ? EXTRA_MARKS_BLOCK : ""}
Håll varje motivering under åtta ord.`;

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

  // Crop FIRST, number after: the numbering has to come from the crops that actually exist.
  // Parallellt, men med ordningen bevarad genom Promise.all: varje beskärning är ett eget
  // sharp-anrop, och tio fynd betydde tio sharp-anrop efter varandra innan granskningen kunde börja.
  const attempts: CropAttempt[] = await Promise.all(
    toVerify.map(async (d): Promise<CropAttempt> => {
      const primary = d.evidence[0];
      const image = primary ? imageById.get(primary.imageId) : undefined;
      if (!primary || !image) return { damage: d, cropRelPath: null, rect: null };
      const originalAbs = path.join(jobDir, "originals", image.path);
      const cropRelPath = path.join("crops", `${d.id}.jpg`).replace(/\\/g, "/");
      try {
        const rect = await cropEvidence(originalAbs, primary.mark, path.join(jobDir, cropRelPath));
        return { damage: d, cropRelPath, rect };
      } catch {
        return { damage: d, cropRelPath: null, rect: null };
      }
    }),
  );

  const { numbered, uncroppable } = buildVerifyPayload(attempts, images);

  // Everything failed to crop — there is nothing to show the model, so skip the call entirely.
  if (numbered.length === 0) {
    return { verified: [...confirmedDirectly, ...uncroppable.map(markUncroppable)], callMeta: null };
  }

  // Each crop carries its own label part, emitted immediately before the image, so "Utsnitt 3"
  // is something the model can actually see rather than something the prompt merely claims.
  const cropParts: ImagePart[] = await Promise.all(
    numbered.map(async (crop) => ({ ...(await loadImageAsBase64(path.join(jobDir, crop.cropRelPath))), label: crop.label })),
  );

  const findingList = numbered
    .map((c, i) => `Fynd ${i + 1}: ${c.damage.type} på ${c.damage.part} (${c.damage.semanticLocation}). ${c.damage.description}`)
    .join("\n");
  const userPrompt = `${numbered.length} förstorade utsnitt, ett per fynd, i nummerordning.\n\nFörsta besiktningen rapporterade:\n${findingList}\n\nSäg för varje utsnitt om det visar en verklig skada, och om det visar samma skada som ett tidigare utsnitt.`;

  const { data, tokensUsed, cached, modelUsed, latencyMs } = await callGeminiStructured<RawResponse>({
    purpose: "verify_findings",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // BARA utsnitten. Originalbilderna behövdes för att leta missade skador — den uppgiften är borta,
    // och med den den största posten i nyttolasten.
    images: cropParts,
    responseSchema: RESPONSE_SCHEMA,
    resolution: "high",
    // Snävare än förut: anropet är en bråkdel så stort, och steget ska alltid hinna köra.
    primaryTimeoutMs: 20_000,
    fallbackTimeoutMs: 12_000,
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

  // Dubbletterna slås ihop FÖRE returen, så att resten av kedjan ser en skada med bevis i flera
  // bildrutor i stället för flera skador. Både betyget och priset räknar poster.
  const links = new Map<number, number>();
  for (const r of data.reviews ?? []) {
    const target = r.duplicate_of ?? 0;
    if (target > 0 && target !== r.finding_index) links.set(r.finding_index, target);
  }
  const deduped = mergeReviewedDuplicates(reviewed, links);
  if (deduped.length < reviewed.length) {
    console.info(`[verify] granskningen kände igen ${reviewed.length - deduped.length} dubblett(er) — samma skada ur flera bildrutor.`);
  }

  const added = EXTRA_MARKS_ENABLED ? collectExtraMarks(numbered, verdictByIndex, images) : [];
  if (added.length > 0) {
    console.info(`[verify] ${added.length} extra märke(n) utpekade i utsnitt granskningen ändå såg.`);
  }

  return {
    verified: [...confirmedDirectly, ...deduped, ...added, ...uncroppable.map(markUncroppable)],
    callMeta: { purpose: "verify_findings", tokensUsed, cached, modelUsed, latencyMs },
  };
}

/**
 * De extra märkena, omräknade till fynd i originalbildens koordinater.
 *
 * Fyra spärrar, alla av samma skäl: de här fynden kommer ur sista steget och granskas därför aldrig
 * i sin tur.
 *   - bara från utsnitt som SJÄLVA godkänts. Kunde modellen inte se skadan den skulle döma, är den
 *     inte den som ska peka ut ytterligare märken i samma utsnitt.
 *   - golv på confidence, högre än första besiktningens (70 mot 45).
 *   - tak på antal, per utsnitt och totalt, så ett enda utsnitt aldrig kan svämma över kortet.
 *   - S2/kosmetisk som tak. Ett förstorat utsnitt räcker för att se ATT ytan är märkt, inte för att
 *     avgöra att möbeln är trasig — den bedömningen hör till första besiktningen, som ser hela delen.
 *
 * Rutan räknas om från utsnittets koordinater till bildens, så märket kan visas i samma bildruta som
 * fyndet det hittades bredvid. Överlappar det fyndets ruta fångas det som dubblett i dedup.ts pass 1.
 */
function collectExtraMarks(
  numbered: NumberedCrop[],
  verdictByIndex: ReadonlyMap<number, RawReview>,
  images: CapturedImage[],
): Damage[] {
  const added: Damage[] = [];

  for (const { damage: parent, rect, index } of numbered) {
    if (added.length >= MAX_ADDED_TOTAL) break;
    const review = verdictByIndex.get(index);
    if (!review || review.verdict !== "KEEP" || !rect) continue;
    const imageId = parent.evidence[0]?.imageId;
    const imageIndex = images.findIndex((im) => im.id === imageId);
    if (imageIndex < 0) continue;

    for (const m of (review.extra_marks ?? []).slice(0, MAX_ADDED_PER_CROP)) {
      if (added.length >= MAX_ADDED_TOTAL) break;
      if (!Number.isFinite(m.confidence) || m.confidence < MIN_ADDED_CONFIDENCE) continue;
      if (![m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v))) continue;

      const box = markFromCrop(rect, { x: m.x, y: m.y, w: m.w, h: m.h });
      const raw: RawDefect = {
        type: m.type,
        // Delen ärvs: utsnittet är taget ur fyndets ruta, så märket sitter på samma möbeldel.
        part: parent.part,
        semantic_location: m.semantic_location || parent.semanticLocation,
        severity: m.severity === "S1" ? "S1" : "S2",
        impact: "cosmetic",
        description: m.description,
        confidence: m.confidence,
        evidence: [{ image_index: imageIndex, mark_kind: "box", x: box.x, y: box.y, w: box.w, h: box.h }],
      };
      added.push({
        ...mapRawDefect(raw, images, `add_${index}`),
        verification: "CONFIRMED",
        verificationReason: "Hittad av andra besiktaren.",
      });
    }
  }

  return added;
}

/**
 * A candidate that never reached the reviewer keeps its standing. It must never inherit another crop's
 * verdict, and it must not be dropped either: failing to CROP a finding says nothing about whether the
 * damage is real, and UNCERTAIN would remove it from the grade for a purely technical reason.
 */
function markUncroppable(d: Damage): Damage {
  return { ...d, verification: "CONFIRMED", verificationReason: "Kunde inte beskäras — inte granskad, fyndet står kvar." };
}
