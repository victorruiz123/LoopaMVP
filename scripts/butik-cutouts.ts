/**
 * Bygger omslagsurklipp för jobb som saknar ett.
 *
 * Behövs för att urklippet kom sent: de 172 besiktigade jobben filmades innan funktionen fanns, och
 * pipelinen bygger bara omslag för NYA körningar. Utan det här skriptet skulle butiken visa
 * tillverkarens katalogbild på gammalt lager i evighet — en ny soffa ovanför priset på en tio år
 * gammal, vilket är precis vad urklippet finns för att slippa.
 *
 *   npx tsx scripts/butik-cutouts.ts            # allt som ligger LIVE i butiken
 *   npx tsx scripts/butik-cutouts.ts --alla     # varje besiktigat jobb
 *   npx tsx scripts/butik-cutouts.ts --om       # gör om även de som redan har ett
 *
 * Kör SEKVENTIELLT med flit: varje urklipp är ett Gemini-anrop plus en lokal modellkörning, och
 * tjugo parallella av varje är ett bra sätt att bli strypt av det ena och svälta det andra.
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

const { listJobs, jobDir, persist } = await import("../server/src/jobStore.js");
const { buildCover, pickCoverFrame } = await import("../server/src/pipeline/cutout.js");
const { releaseSegmenter, segmenterAvailable } = await import("../server/src/pipeline/segment.js");
const { store } = await import("../server/src/butik/store.js");
const { invalidate } = await import("../server/src/butik/inventory.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const args = new Set(process.argv.slice(2));
const onlyLive = !args.has("--alla");
const redo = args.has("--om");

if (!(await segmenterAvailable())) {
  console.error("Ingen segmenteringsmodell hittades. Kör ./scripts/fetch-models.sh först.");
  process.exit(1);
}

const live = new Set((await store().all()).filter((r) => r.state === "live").map((r) => r.id));
const jobs = await listJobs();

let done = 0;
let skipped = 0;
let failed = 0;
let tooPoor = 0;
const started = Date.now();

for (const job of jobs) {
  if (!job.result) continue;
  if (onlyLive && !live.has(loopaIdFor(job.id))) continue;
  if (!redo && (job.result.coverCutout || job.coverCutout)) { skipped += 1; continue; }

  const images = job.result.images ?? job.images ?? [];
  if (images.length === 0) { skipped += 1; continue; }
  /**
   * Bildrutan väljs på nytt här, inte hämtas ur jobbet.
   *
   * `coverImageId` pekar ut den ruta som visar SKICKET bäst, och det är rätt för skickrapporten.
   * Ett omslag ska visa MÖBELN. Mätt på LP-0VHB-A0NT fick jobbets egna val 0,13 i produktbildspoäng
   * medan en annan ruta i samma varv fick 0,83 — soffan hel i bild i stället för ett armstöd.
   *
   * Faller valet används jobbets ruta, som förut.
   */
  const image = await pickCoverFrame(jobDir(job.id), images);
  if (!image) { tooPoor += 1; continue; }

  try {
    const cutout = await buildCover(job.id, jobDir(job.id), image.id, image.path);
    if (!cutout) { failed += 1; continue; }
    job.coverCutout = cutout;
    job.result.coverCutout = cutout;
    await persist(job);
    done += 1;
    process.stdout.write(`\r${done} urklipp klara (${failed} föll, ${skipped} hoppade över)…`);
  } catch (err) {
    failed += 1;
    console.warn(`\n${loopaIdFor(job.id)}: ${err instanceof Error ? err.message : err}`);
  }
}

await releaseSegmenter();
invalidate();
console.log(
  `\n\nKlart på ${Math.round((Date.now() - started) / 1000)}s: ${done} urklipp byggda, ` +
    `${tooPoor} utan bildruta som duger som produktbild, ${failed} föll, ${skipped} hoppade över.`,
);
if (failed || tooPoor) {
  console.log("De utan urklipp visar katalogbilden som förut — inget är sönder.");
}
