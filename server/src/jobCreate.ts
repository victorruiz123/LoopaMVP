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
import { createJob, findJobByClientKey, getJob, jobDir, persist, watchJobDeadline } from "./jobStore.js";
import { runConditionGrading } from "./pipeline/run.js";
import { finalizeWithModel, runIdentify } from "./pipeline/identify.js";
import { initialTasks, setTask } from "./pipeline/tasks.js";
import { newJobCost } from "./cost/ledger.js";
import { prepareUploads, type UploadInput } from "./imageIngest.js";
import { JOB_DEADLINE_MS, MAX_IMAGES_PER_JOB } from "./config.js";
import type { CapturedImage, FurnitureIdentity } from "./types.js";

export interface CreateJobBody {
  productContext?: string | null;
  /** Brand + model as the seller typed them. Optional: grading works without them, pricing does not. */
  brand?: string | null;
  model?: string | null;
  /**
   * Säljarens foton, i guidens ordning. Servern väljer inte bland dem — men den normaliserar dem,
   * släpper dubbletter och lägger omslaget (`role: "cover"`) först. Se `prepareUploads`.
   */
  images: UploadInput[];
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
  /** Klientens nyckel för den här uppladdningen. Samma nyckel från samma ägare ger tillbaka samma jobb — se findJobByClientKey. */
  clientKey?: string | null;
  /** PROTOTYP: identifieringen görs av appens webbvy mot Googles AI-läge och skickas in efteråt. Servern söker då inte själv. */
  externalIdentify?: boolean;
  /**
   * PROTOTYP, bara tillsammans med externalIdentify: testläget som bara prövar identifieringen och måttsökningen. Ingen skickbedömning (ingen besiktning, inget omslagsurklipp)
   * och inget pris — två betalda spår mindre per körning. Se handleCreateJob och appens flagga onlyIdentifySpecs.
   */
  identifyOnly?: boolean;
  /**
   * Skicktestet (web/skicktest.html): kör BARA besiktningen. Ingen identifiering, inga mått, ingen annonstext,
   * inget pris och inget omslagsurklipp — märke och modell i kroppen ignoreras. Se `ConditionJob.conditionOnly`.
   *
   * Motsatsen till `identifyOnly`, och går inte att kombinera med den: ett jobb utan besiktning och utan
   * identifiering gör ingenting.
   */
  conditionOnly?: boolean;
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
  /**
   * SIST av samma skäl som `ownerEmail`: argumenten skickas positionellt.
   *
   * `minImages` är minsta antal olika, läsbara bilder. Sätts bara av säljarens väg när skickbedömning
   * ska köras — se MIN_PHOTOS_FOR_GRADING. Räknas EFTER normalisering, så ogiltiga bilder och
   * dubbletter räknas inte.
   */
  opts: { minImages?: number; conditionOnly?: boolean } = {},
): Promise<
  | { jobId: string; imageCount: number; dropped?: number }
  | { error: string; code?: "too_few_images"; min?: number; got?: number }
> {
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { error: "At least one image is required" };
  }
  // Ett skicktest utan besiktning har ingenting att köra.
  if (opts.conditionOnly && skipGrading) return { error: "conditionOnly kan inte kombineras med skipGrading" };
  const clientKey = body.clientKey?.trim().slice(0, 80) || null;
  if (clientKey) {
    const existing = findJobByClientKey(ownerId, clientKey);
    if (existing) {
      console.info(`[jobb] ${existing.id.slice(0, 8)} uppladdningen skickades om med samma nyckel — jobbet återanvänds, inget nytt betalt arbete startas`);
      return { jobId: existing.id, imageCount: existing.images?.length ?? 0 };
    }
  }

  // Bilderna avgörs INNAN jobbet skapas: ett avvisat anrop ska inte lämna en jobbkatalog efter sig.
  const prepared = await prepareUploads(body.images, { max: MAX_IMAGES_PER_JOB, min: opts.minImages ?? 0 });
  if (prepared.images.length === 0) return { error: "No valid images were decoded" };
  if (prepared.error) {
    const { min, got } = prepared.error;
    return { error: `Minst ${min} bilder krävs för en skickbedömning (fick ${got}).`, code: prepared.error.code, min, got };
  }
  const droppedCount = prepared.dropped.invalid + prepared.dropped.duplicate + prepared.dropped.overCap;
  if (droppedCount > 0) {
    const d = prepared.dropped;
    console.info(`[jobb] ${droppedCount} av ${body.images.length} bilder följde inte med: ${d.invalid} oläsliga, ${d.duplicate} dubbletter, ${d.overCap} över taket (${MAX_IMAGES_PER_JOB})`);
  }

  // Ett skicktest har ingen identitet, hur kroppen än ser ut: ingen identifiering, inget pris och ingen annons
  // hänger utan den — och det är just det som garanterar att bara besiktningen körs.
  const identity = opts.conditionOnly ? null : readIdentity(body);
  const job = await createJob(body.productContext ?? null, identity, ownerId, ownerEmail);
  if (clientKey) job.clientKey = clientKey;
  // Märkningen sätts före allt annat skrivande, så att inget mellanläge finns där jobbet är
  // besiktigat men ännu inte känt som privat.
  if (dealId || adDerived || opts.conditionOnly) {
    if (dealId) job.dealId = dealId;
    if (adDerived) job.adDerived = true;
    if (opts.conditionOnly) job.conditionOnly = true;
    await persist(job);
  }
  const dir = jobDir(job.id);
  const originalsDir = path.join(dir, "originals");
  await mkdir(originalsDir, { recursive: true });

  // Alltid `.jpg`: `prepareUploads` har kodat om allt som JPEG, och Gemini-anropet läser filen som
  // `image/jpeg` (imageUtils.ts) — en `.png` med PNG-bytes hade skickats under fel mimetyp.
  const images: CapturedImage[] = [];
  for (let i = 0; i < prepared.images.length; i++) {
    const p = prepared.images[i];
    const filename = `img_${i}.jpg`;
    await writeFile(path.join(originalsDir, filename), p.buffer);
    images.push({
      id: randomUUID(),
      viewLabel: p.viewLabel,
      source: p.source,
      // Bara "cover" släpps in, och bara på EN bild (prepareUploads). Fältet styr vad som blir
      // annonsens ansikte, så en klient ska inte kunna hitta på en roll som ingen kod nedströms känner igen.
      ...(p.role ? { role: p.role } : {}),
      width: p.width,
      height: p.height,
      path: filename,
      capturedAt: new Date().toISOString(),
    });
  }

  job.images = images;
  // Kostnadsboken och uppgifternas startlägen skrivs INNAN något startar: det som körs direkt (skick, modellförslag) märks som körande, det som väntar på
  // en bekräftad modell (specar, pris) som väntande. Ingen uppgift låtsas vara oberoende av det den beror på — se pipeline/tasks.ts.
  job.cost = newJobCost();
  job.tasks = initialTasks({
    skipGrading,
    identify: identity?.brand && !identity.model ? "run" : identity?.model ? "resolved" : "none",
    conditionOnly: opts.conditionOnly,
  });
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
    // Ett skicktest bygger heller inget omslagsurklipp: flera körningar med den stora bildmodellen, och det
    // är just det slags kostnad ett rent besiktningstest ska slippa.
    void runConditionGrading(job.id, images, body.productContext ?? null, identity, { skipCover: opts.conditionOnly });
  } else {
    // Utan besiktning blir jobbet aldrig "done" av sig självt — inget spår sätter det. Identiteten
    // driver resten, och klienten läser den direkt (se analysisStatus).
    job.progress = { stage: "identifying" as never, message: "Letar efter modellen…" };
    await persist(job);
  }
  if (identity?.brand && !identity.model) {
    job.identityStatus = "identifying";
    if (body.externalIdentify) {
      // Inget eget modellsökande anrop: svaret kommer från klienten (externalIdentify.ts). Uppgiften står som pågående tills det kommer.
      job.externalIdentify = true;
      await persist(job);
      await setTask(job.id, "identify", "running", { restart: true });
    } else {
      await persist(job);
      void runIdentify(job.id, identity.brand, images);
    }
  } else if (identity?.model) {
    // Säljaren angav modellen själv — hoppa identifieringen, gå direkt till annons och pris.
    job.identityStatus = "resolved";
    await persist(job);
    void finalizeWithModel(job.id, { kind: "manual", manualModel: identity.model });
  }
  return { jobId: job.id, imageCount: images.length, ...(droppedCount > 0 ? { dropped: droppedCount } : {}) };
}

/**
 * Price for a brand + model, with no job and no photos behind it.
 *
 * The price engine never needed the walkaround: it searches an ad corpus on the name, and the damage
 * list is a deduction applied afterwards. So this answer exists the moment the seller has typed the
 * two fields — which is why the app asks for it while they are still filming, and why the price is on
 * screen before the inspection has finished its first Gemini call.
 */
