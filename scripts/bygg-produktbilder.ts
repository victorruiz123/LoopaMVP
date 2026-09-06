/**
 * Bygger produktbilder för jobb som redan ligger inne.
 *
 * ERSÄTTER scripts/butik-cutouts.ts, som byggde omslag med den gamla kedjan (Pixian-mask eller
 * U2Net i 320 px, hård tröskel, suddad kant). Den filen är borttagen med flit och inte kvarlämnad:
 * den skrev till samma cover/cover.jpg som det här skriptet, så att låta den ligga kvar hade varit
 * att lämna en genväg som tyst byter en bra produktbild mot en sämre.
 *
 *   npx tsx scripts/bygg-produktbilder.ts               # allt som ligger LIVE i butiken
 *   npx tsx scripts/bygg-produktbilder.ts --alla        # varje besiktigat jobb
 *   npx tsx scripts/bygg-produktbilder.ts --om          # gör om även de som redan har en
 *   npx tsx scripts/bygg-produktbilder.ts --gammal      # gör om bara de som är byggda av den gamla kedjan
 *   npx tsx scripts/bygg-produktbilder.ts --antal 5     # tak: bygg högst fem och stanna
 *   npx tsx scripts/bygg-produktbilder.ts --granska     # bygg inget, lista bara vad som flaggats
 *
 * `--gammal` finns för övergången: lagret bär omslag gjorda av `pixian` och `u2net`, och de ska
 * göras om utan att de nya räknas om i onödan. Fältet som skiljer dem är `provider`.
 *
 * KÖR SEKVENTIELLT, och det är inte försiktighet — det är aritmetik. BiRefNet tar en dryg minut per
 * bild på processor och håller ett par gigabyte medan den räknar. Tjugo parallella är tjugo gånger
 * minnet för att bli klara lika fort som en tråd med tjugo uppgifter, på en burk som delar minne med
 * prismotorn. Räkna med ungefär två minuter per jobb: urvalet över sex bildrutor plus bygget.
 *
 * TAKET (`--antal`) finns för att man ska kunna se hur resultatet ser ut på fem möbler innan man
 * lägger en timme på hela lagret.
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

const { listJobs, jobDir, persist } = await import("../server/src/jobStore.js");
const { byggOmslag, omslagsmodell } = await import("../server/src/pipeline/bild/omslag.js");
const { tillgangligModell, slappModeller } = await import("../server/src/pipeline/bild/segmentera.js");
const { store } = await import("../server/src/butik/store.js");
const { invalidate } = await import("../server/src/butik/inventory.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");

const argv = process.argv.slice(2);
const args = new Set(argv);
const onlyLive = !args.has("--alla");
const redoOld = args.has("--gammal");
const redo = args.has("--om") || redoOld;
const baraGranska = args.has("--granska");

const takIndex = argv.indexOf("--antal");
const tak = takIndex >= 0 ? Number(argv[takIndex + 1]) : Infinity;
if (Number.isNaN(tak) || tak <= 0) {
  console.error("--antal vill ha ett positivt tal: --antal 5");
  process.exit(1);
}

/** Namnen den gamla kedjan skrev i `provider`. Allt annat är ett namn ur modellregistret. */
const GAMLA = new Set(["pixian", "u2net", null]);

const live = new Set((await store().all()).filter((r) => r.state === "live").map((r) => r.id));
const jobs = await listJobs();

/**
 * Granskningsläget bygger ingenting — det läser vad som redan står i jobben.
 *
 * Finns för att `needsReview` annars bara syns i loggen när bilden byggdes, alltså en gång och sedan
 * aldrig. Den som ska titta på de tveksamma omslagen behöver en lista, inte en genomsökning av
 * gamla terminalfönster.
 */
if (baraGranska) {
  const rader = jobs
    .map((job) => ({ job, c: job.result?.coverCutout ?? job.coverCutout ?? null }))
    .filter((r) => r.c && (!onlyLive || live.has(loopaIdFor(r.job.id))));
  const flaggade = rader.filter((r) => r.c!.needsReview);
  const gamla = rader.filter((r) => GAMLA.has(r.c!.provider ?? null));
  console.log(`${rader.length} omslag${onlyLive ? " i butiken" : ""}: ${flaggade.length} flaggade, ${gamla.length} från den gamla kedjan.\n`);
  for (const r of flaggade.sort((a, b) => (a.c!.qualityScore ?? 0) - (b.c!.qualityScore ?? 0))) {
    console.log(
      `  ${loopaIdFor(r.job.id)}  poäng=${(r.c!.qualityScore ?? 0).toFixed(2)}  ${r.c!.provider}  ` +
        `${(r.c!.anmarkningar ?? []).join(", ")}`,
    );
    console.log(`    ${jobDir(r.job.id)}/cover/cover.jpg`);
  }
  if (flaggade.length === 0) console.log("  Inget flaggat.");
  process.exit(0);
}

const modell = await tillgangligModell();
if (!modell) {
  console.error(
    "Ingen segmenteringsmodell på disk. Kör ./scripts/fetch-models.sh --alla för\n" +
      "birefnet-general (973 MB), eller sätt PRODUKTBILD_MODELL till en mindre.",
  );
  process.exit(1);
}
console.log(`Modell: ${modell.namn} (${modell.megabyte} MB, ${modell.sida} px). Vald: ${omslagsmodell()}.`);
console.log(`Räkna med ~2 min per jobb. ${tak === Infinity ? "" : `Tak: ${tak}.`}\n`);

let done = 0;
let skipped = 0;
let failed = 0;
let flaggade = 0;
const started = Date.now();

for (const job of jobs) {
  if (!job.result) continue;
  if (onlyLive && !live.has(loopaIdFor(job.id))) continue;
  const existing = job.result.coverCutout || job.coverCutout;
  if (existing && !redo) { skipped += 1; continue; }
  // `--gammal` tar bara om det som den gamla kedjan gjorde. Att bygga om ett färskt omslag ger
  // samma bild och kostar en minut.
  if (existing && redoOld && !GAMLA.has(existing.provider ?? null)) { skipped += 1; continue; }

  const images = job.result.images ?? job.images ?? [];
  if (images.length === 0) { skipped += 1; continue; }

  try {
    /**
     * Bildrutan väljs på nytt här, inte hämtas ur jobbet.
     *
     * `coverImageId` pekar ut den ruta som visar SKICKET bäst, och det är rätt för skickrapporten.
     * Ett omslag ska visa MÖBELN. Mätt på LP-0VHB-A0NT fick jobbets egna val 0,13 i
     * produktbildspoäng medan en annan ruta i samma varv fick 0,83 — soffan hel i bild i stället
     * för ett armstöd. byggOmslag gör om det valet med den lilla modellen och skickar det
     * `coverImageId` som reserv.
     */
    const cutout = await byggOmslag(job.id, jobDir(job.id), images, job.result.coverImageId ?? null);
    if (!cutout) { failed += 1; continue; }
    job.coverCutout = cutout;
    job.result.coverCutout = cutout;
    await persist(job);
    done += 1;
    if (cutout.needsReview) flaggade += 1;
    console.log(
      `  ${loopaIdFor(job.id)}  poäng=${(cutout.qualityScore ?? 0).toFixed(2)}  ` +
        `${cutout.needsReview ? `GRANSKA (${(cutout.anmarkningar ?? []).join(", ")})` : "godkänd"}`,
    );
    if (done >= tak) {
      console.log(`\nTaket på ${tak} nått — stannar här.`);
      break;
    }
  } catch (err) {
    failed += 1;
    console.warn(`  ${loopaIdFor(job.id)}: ${err instanceof Error ? err.message : err}`);
  }
}

await slappModeller();
invalidate();
console.log(
  `\nKlart på ${Math.round((Date.now() - started) / 1000)}s: ${done} produktbilder byggda ` +
    `(${flaggade} flaggade för granskning), ${failed} föll, ${skipped} hoppade över.`,
);
if (flaggade) {
  console.log(
    `\nDe ${flaggade} flaggade ligger på disk men går INTE ut publikt — kortet visar katalogbilden\n` +
      "eller säljarens bildruta i stället. Lista dem med --granska.",
  );
}
if (failed) console.log("De som föll visar katalogbilden som förut — inget är sönder.");
