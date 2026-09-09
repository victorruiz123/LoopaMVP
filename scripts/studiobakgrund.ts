/**
 * Studiobakgrunden: läser argumenten och lämnar över.
 *
 *   npx tsx scripts/studiobakgrund.ts            # bygg, om den inte redan finns
 *   npx tsx scripts/studiobakgrund.ts --om       # gör om, skriv över
 *   npx tsx scripts/studiobakgrund.ts --prov     # skriv förslag till bench/studio, ändra ingenting
 *   npx tsx scripts/studiobakgrund.ts --prov --antal 6
 *   npx tsx scripts/studiobakgrund.ts --valj bench/studio/forslag-1.jpg   # installera ett granskat förslag
 *
 * VÄGEN SOM ANVÄNDS ÄR --prov OCH SEDAN --valj. Det som skiljer två godkända rum åt är sådant ingen
 * mätning fångar — om golvet läser som ett plan, om ljuspoolen hamnar bakom möbeln, om väggens ton
 * klär trä — och bakgrunden hamnar under varenda annons i butiken. Fogens höjd kontrolleras ändå i
 * båda lägena, för den ena egenskap som ÄR mätbar ska inte tappas bort för att ett öga var med.
 *
 * Allt arbete ligger i server/src/pipeline/bild/studio.ts och studiogenerering.ts — dels för att ett
 * skript här inte kan importera sharp (den bor i server/node_modules), dels för att bakgrunden då
 * mäts och normaliseras av exakt samma kod som driften läser den med.
 *
 * Bakgrunden är EN incheckad fil och inte ett anrop per jobb. Se studio.ts för varför.
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

import path from "node:path";
import { fileURLToPath } from "node:url";

const { byggStudiobakgrund, provaStudiobakgrunder, valjStudiobakgrund } = await import(
  "../server/src/pipeline/bild/studiogenerering.js"
);
const { STUDIO_BESKRIVNING, STUDIO_FIL } = await import("../server/src/pipeline/bild/studio.js");

const argv = process.argv.slice(2);
const args = new Set(argv);

const antalIndex = argv.indexOf("--antal");
const antal = antalIndex >= 0 ? Number(argv[antalIndex + 1]) : 4;
if (!Number.isInteger(antal) || antal <= 0) {
  console.error("--antal vill ha ett positivt heltal: --antal 4");
  process.exit(1);
}

if (args.has("--prov")) {
  const ut = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bench", "studio");
  await provaStudiobakgrunder(ut, antal);
  console.log("\nTitta på dem och installera det bästa:");
  console.log("  npx tsx scripts/studiobakgrund.ts --valj bench/studio/forslag-1.jpg");
  process.exit(0);
}

const valjIndex = argv.indexOf("--valj");
const vald = valjIndex >= 0 ? argv[valjIndex + 1] : null;
if (valjIndex >= 0 && !vald) {
  console.error("--valj vill ha en sökväg: --valj bench/studio/forslag-1.jpg");
  process.exit(1);
}

const utfall = vald
  ? await valjStudiobakgrund(path.resolve(vald))
  : await byggStudiobakgrund(args.has("--om"));

if (utfall.fel === "finns redan") {
  console.log(`Finns redan: ${STUDIO_FIL}\nKör med --om för att göra om den.`);
  process.exit(0);
}
if (!utfall.skrivet) {
  console.error(`\n${utfall.fel}. Ingenting skrivet.`);
  console.error("Kör med --prov för att se vad modellen faktiskt ger.");
  process.exit(1);
}

console.log(`\nSkrivet: ${STUDIO_FIL}`);
console.log(`         ${STUDIO_BESKRIVNING}`);
console.log("Checka in båda — bakgrunden är en del av produkten, inte en lokal fil.");
