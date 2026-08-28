import { callSellerGenerate, type Resolution } from "../listing.js";
import { getJob, getJobSync, jobDir, persist } from "../jobStore.js";
import { estimatePrice } from "../pricing.js";
import type { CapturedImage, ModelCandidate } from "../types.js";

/** Hur länge prissättningen väntar på att skickbedömningen ska bli klar. */
const CONDITION_WAIT_MS = 180_000;

/**
 * Fas 1: vilken modell är det här?
 *
 * Körs parallellt med skickbedömningen så fort bilderna finns. Besiktningen behöver inte modellen och
 * identifieringen behöver inte betyget — de två spåren delar bara bildrutorna, så att kedja dem hade
 * lagt 6-11 sekunder ovanpå i stället för bredvid.
 *
 * Svarar generatorn med kandidater stannar flödet och väntar på säljaren. Kunde den avgöra modellen
 * själv (stark toppkandidat utan verklig konkurrens) hoppas valskärmen över helt — den finns för
 * VERKLIG tvetydighet, inte för varje möbel.
 */
export async function runIdentify(jobId: string, brand: string, images: CapturedImage[]): Promise<void> {
  const dir = jobDir(jobId);
  const startedAt = Date.now();
  const call = await callSellerGenerate(brand, images, dir);
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;

  if (call.kind === "needs_selection") {
    job.identityStatus = "needs_selection";
    job.candidates = call.candidates;
    console.info(`[identify] ${jobId.slice(0, 8)} needs_selection candidates=${call.candidates.length} ms=${Date.now() - startedAt}`);
  } else if (call.kind === "ok") {
    /**
     * Generatorn kom fram till ett svar utan att kunna erbjuda kandidater — i praktiken när den
     * grundade sökningen föll, för kandidater läses ENBART ur grundad text.
     *
     * Vi accepterar det inte som fastställt. Ett modellnamn den inte kunde belägga mot en källa är en
     * gissning, och att visa en gissning som "din modell" är sämre än att fråga. Har den ändå fått
     * fram något namn erbjuds det som en kandidat; annars får säljaren skriva själv.
     */
    const r = call.listing.result;
    const guessed = r?.identity.exactProduct?.trim();
    job.identityStatus = "needs_selection";
    job.candidates = guessed
      ? [{
          brand: r!.identity.brand ?? brand,
          model: guessed,
          variant: r!.identity.variant,
          productType: r!.identity.category,
          confidence: r!.identity.confidence === "high" ? "strong" : r!.identity.confidence === "medium" ? "likely" : "possible",
          distinguishingDetail: r!.identity.uncertaintyNote,
        }]
      : [];
    console.info(`[identify] ${jobId.slice(0, 8)} no-candidates (research föll) guessed=${guessed ?? "-"} ms=${Date.now() - startedAt}`);
  } else {
    job.identityStatus = "unavailable";
    job.identityError = call.reason;
    console.warn(`[identify] ${jobId.slice(0, 8)} unavailable — ${call.reason}`);
  }
  await persist(job);
}

/**
 * Fas 2: säljaren har valt. Bygg annonsen på den modellen, och prissätt.
 *
 * Priset ligger sist med flit. Prismotorn söker på modellnamnet och drar av för skadorna, så den
 * behöver BÅDA de andra spåren klara — det är den enda punkt i flödet där de möts.
 */
export async function finalizeWithModel(jobId: string, resolution: Resolution): Promise<void> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;
  const images = job.images ?? job.result?.images ?? [];
  const dir = jobDir(jobId);
  const startedAt = Date.now();

  const model =
    resolution.kind === "seller_selected" ? resolution.selected.model : resolution.kind === "manual" ? resolution.manualModel : "";
  const brand = job.identity?.brand ?? (resolution.kind === "seller_selected" ? resolution.selected.brand : null);
  job.identity = { brand, model };
  job.selected = resolution.kind === "seller_selected" ? resolution.selected : null;
  job.identityStatus = "resolved";
  await persist(job);

  /**
   * Annonsen och priset körs PARALLELLT.
   *
   * De behöver inte varandra: annonsen byggs på modellen och bilderna, priset på modellen och
   * skadelistan. Kedjade betydde det att prissättningen inte ens började förrän annonsen var klar —
   * alltså stod den still i 13-20 sekunder medan säljaren läste specifikationerna, för att sedan ta
   * sina 10 sekunder när de klickade vidare. Nu löper de bredvid varandra, och priset är oftast
   * färdigt innan säljaren lämnar specifikationsskärmen.
   */
  const listingPromise = callSellerGenerate({ brand, model }, images, dir, resolution).then((call) =>
    call.kind === "ok"
      ? call.listing
      : {
          status: "unavailable" as const,
          unavailableReason: call.kind === "unavailable" ? call.reason : "Oväntat kandidatsvar i fas 2.",
          result: null,
          latencyMs: Date.now() - startedAt,
        },
  );

  const pricePromise = (async () => {
    // Priset behöver skadelistan. Skickbedömningen kör i sitt eget spår och kan mycket väl vara klar.
    const ready = await waitForCondition(jobId);
    if (!ready?.result) return null;
    return estimatePrice({ brand, model }, ready.result.damages, ready.result.grade?.canonicalCondition ?? null, null);
  })();

  // Publicera annonsen så fort DEN är klar — säljaren ska inte vänta in priset för att se
  // specifikationerna.
  const listing = await listingPromise;
  console.info(`[identify] ${jobId.slice(0, 8)} listing=${listing.status} ms=${Date.now() - startedAt}`);
  const afterListing = getJobSync(jobId) ?? (await getJob(jobId));
  if (afterListing) {
    afterListing.identity = { brand, model };
    if (afterListing.result) afterListing.result.listing = listing;
    else afterListing.pendingListing = listing;
    await persist(afterListing);
  }

  const price = await pricePromise;
  const target = getJobSync(jobId) ?? (await getJob(jobId));
  if (!target?.result) return;
  target.result.price = price;
  target.result.identity = { brand, model };
  target.result.listing = listing;
  await persist(target);
  console.info(`[identify] ${jobId.slice(0, 8)} price=${price?.status ?? "none"} total_ms=${Date.now() - startedAt}`);
}

async function waitForCondition(jobId: string) {
  const until = Date.now() + CONDITION_WAIT_MS;
  while (Date.now() < until) {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return null;
    if (job.progress.stage === "error") return null;
    if (job.result && !job.result.reviewPending) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
