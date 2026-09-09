/**
 * Att skapa ett besiktningsjobb — EN väg in, för alla som behöver en.
 *
 * Bruten ur server.ts när Trygg affär behövde starta samma pipeline som säljflödet. Alternativet var
 * att affärsmodulen importerade server.ts, som redan importerar affärsmodulen: en cirkel som
 * fungerar i ESM tills någon flyttar en rad.
 *
 * ATT DET ÄR SAMMA FUNKTION ÄR POÄNGEN, inte en följd av utbrytningen. En köpare som klistrar in en
 * annons ska få mått, egenskaper, annonstext och pris räknade på exakt samma sätt som en säljare som
 * filmat sin möbel — två vägar in i en pipeline blir två pipelines så fort någon rättar en bugg i
 * den ena.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createJob, getJob, jobDir, persist, watchJobDeadline } from "./jobStore.js";
import { runConditionGrading } from "./pipeline/run.js";
import { finalizeWithModel, runIdentify } from "./pipeline/identify.js";
import { getImageDimensions } from "./imageUtils.js";
import { JOB_DEADLINE_MS, MAX_IMAGES_PER_JOB } from "./config.js";
import type { CapturedImage, FurnitureIdentity } from "./types.js";

export interface CreateJobBody {
  productContext?: string | null;
  /** Brand + model as the seller typed them. Optional: grading works without them, pricing does not. */
  brand?: string | null;
  model?: string | null;
  /** Already curated by the client: selected video frames + any manual photos. No server-side selection. */
  images: Array<{ dataUrl: string; viewLabel?: string | null; source?: "video" | "manual"; role?: "cover" }>;
  /**
   * Affären skanningen tillhör (Trygg affär). Utelämnas för vanliga säljarjobb.
   *
   * SÄTTS VID SKAPANDET och aldrig senare, av samma skäl som `ownerId`: fältet är det som håller
   * jobbet utanför Butik och utanför det publika kortet (se ConditionJob.dealId), och ett jobb som
   * får sin märkning i efterhand har hunnit vara publikt däremellan.
   *
   * Anroparen måste vara affärens SÄLJARE. Kontrolleras i handleCreateJob — en köpare ska inte kunna
   * skanna åt sin motpart, och en främling ska inte kunna knyta en skanning till någon annans affär.
   */
  dealId?: string | null;
}

/**
 * Märket räcker för att starta. Modellen letar systemet upp ur bilderna.
 *
 * Tidigare krävdes modellnamnet, skrivet för hand, innan något kunde börja — och identifieringen låg
 * sist i flödet, där den ibland kom fram till att säljaren angett fel möbel efter att skick och pris
 * redan räknats på den. Nu är ordningen den omvända: märke in, bilder in, modell fram, sedan resten.
 */
export function readIdentity(body: { brand?: string | null; model?: string | null }): FurnitureIdentity | null {
  const brand = body.brand?.trim() || null;
  const model = body.model?.trim() || "";
  if (!brand && !model) return null;
  return { brand, model };
}

/**
 * The one place a finished report is recomputed after the seller changes the findings. Grade and price
 * are refreshed together, from the same damage list, so the two halves of the report cannot drift
 * apart — the failure mode where a rejected damage disappears from the grade but is still deducted
 * from the price.
 */
export async function createConditionJob(
  body: CreateJobBody,
  ownerId: string | null = null,
  dealId: string | null = null,
  adDerived = false,
  /**
   * Hoppa över skickbedömningen och kör bara identifieringen, måtten, annonsen och priset.
   *
   * För köparens analys av någon annans annons. Ett betyg kräver ett filmat varv med kända vinklar;
   * annonsbilder är valda av säljaren, ofta just för att slitaget inte syns. Att ändå sätta ett
   * betyg vore att låna besiktningens auktoritet till en gissning — och det är precis den
   * förväxlingen som gör säljarens verifierade kort värdelöst.
   *
   * Allt ANNAT kör som vanligt: modellförslagen, måtten, egenskaperna och marknadspriset är lika
   * giltiga från en produktbild som från en filmning, för de handlar om vilken möbel det ÄR.
   */
  skipGrading = false,
  /**
   * Säljarens e-post, sparad på jobbet så att vi kan höra av oss när möbeln säljs. SIST i listan
   * med flit: `affar/analysis.ts` skickar sina argument positionellt, och en ny parameter i mitten
   * hade tyst gjort en `true` till en adress.
   */
  ownerEmail: string | null = null,
): Promise<{ jobId: string; imageCount: number } | { error: string }> {
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { error: "At least one image is required" };
  }
  const identity = readIdentity(body);
  const job = await createJob(body.productContext ?? null, identity, ownerId, ownerEmail);
  // Märkningen sätts före allt annat skrivande, så att inget mellanläge finns där jobbet är
  // besiktigat men ännu inte känt som privat.
  if (dealId || adDerived) {
    if (dealId) job.dealId = dealId;
    if (adDerived) job.adDerived = true;
    await persist(job);
  }
  const dir = jobDir(job.id);
  const originalsDir = path.join(dir, "originals");
  await mkdir(originalsDir, { recursive: true });

  const limited = body.images.slice(0, MAX_IMAGES_PER_JOB);
  const images: CapturedImage[] = [];
  for (let i = 0; i < limited.length; i++) {
    const { dataUrl, viewLabel, source, role } = limited[i];
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    const [, mimeType, base64] = match;
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const filename = `img_${i}.${ext}`;
    const abs = path.join(originalsDir, filename);
    await writeFile(abs, Buffer.from(base64, "base64"));
    const { width, height } = await getImageDimensions(abs);
    images.push({
      id: randomUUID(),
      viewLabel: viewLabel ?? null,
      source: source ?? "manual",
      // Bara "cover" släpps in. Fältet styr vad som blir annonsens ansikte och vad besiktningen får
      // se, så en klient ska inte kunna hitta på en tredje roll som ingen kod nedströms känner igen.
      ...(role === "cover" ? { role: "cover" as const } : {}),
      width,
      height,
      path: filename,
      capturedAt: new Date().toISOString(),
    });
  }

  if (images.length === 0) return { error: "No valid images were decoded" };

  job.images = images;
  await persist(job);

  // EN klocka för hela jobbet, startad här. Den enda gräns som binder oavsett fas och oavsett hur
  // många omförsök som pågår i något av spåren.
  const stopDeadline = watchJobDeadline(job.id, JOB_DEADLINE_MS);
  void (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = await getJob(job.id);
      if (!current || current.progress.stage === "done" || current.progress.stage === "error") break;
    }
    stopDeadline();
  })();

  // Två spår, parallellt. Besiktningen behöver inte modellen och identifieringen behöver inte
  // betyget — de delar bara bildrutorna. Kedjade hade de lagt sina tider ovanpå varandra.
  if (!skipGrading) {
    void runConditionGrading(job.id, images, body.productContext ?? null, identity);
  } else {
    // Utan besiktning blir jobbet aldrig "done" av sig självt — inget spår sätter det. Identiteten
    // driver resten, och klienten läser den direkt (se analysisStatus).
    job.progress = { stage: "identifying" as never, message: "Letar efter modellen…" };
    await persist(job);
  }
  if (identity?.brand && !identity.model) {
    job.identityStatus = "identifying";
    await persist(job);
    void runIdentify(job.id, identity.brand, images);
  } else if (identity?.model) {
    // Säljaren angav modellen själv — hoppa identifieringen, gå direkt till annons och pris.
    job.identityStatus = "resolved";
    await persist(job);
    void finalizeWithModel(job.id, { kind: "manual", manualModel: identity.model });
  }
  return { jobId: job.id, imageCount: images.length };
}

/**
 * Price for a brand + model, with no job and no photos behind it.
 *
 * The price engine never needed the walkaround: it searches an ad corpus on the name, and the damage
 * list is a deduction applied afterwards. So this answer exists the moment the seller has typed the
 * two fields — which is why the app asks for it while they are still filming, and why the price is on
 * screen before the inspection has finished its first Gemini call.
 */
