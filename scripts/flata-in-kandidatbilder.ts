/**
 * Flätar in ett medfört kandidatbildsregister i det som redan står på maskinen.
 *
 *   npx tsx scripts/flata-in-kandidatbilder.ts <register.json>
 *   npx tsx scripts/flata-in-kandidatbilder.ts inkommande/register.json --torr
 *
 * VARFÖR DET INTE RÄCKER ATT KOPIERA FILEN. `server/data/kandidatbilder` ligger utanför
 * versionshanteringen, så förvärmningen körs på en dator och resultatet bärs över till driften. Men
 * driftens egen katalog är inte tom: varje säljare som mött en modell ingen sett förut har fyllt på
 * den, och de posterna finns ingen annanstans. Ett `scp register.json` hade tagit bort dem — tyst,
 * och först nästa gång någon skannade just den möbeln hade det märkts, som en väntan som kom
 * tillbaka.
 *
 * JPG-FILERNA är ofarliga att kopiera rakt av: namnet är en sha1-summa av källadressen, så samma
 * namn betyder samma bild och en överskrivning är en kopia av det som redan låg där. Det är REGISTRET
 * som är en enda fil med allas poster i, och bara den behöver flätas.
 *
 * EN POST SOM SAKNAR SIN FIL HOPPAS ÖVER. Registret pekar på disk, och en post vars bild inte kom
 * med är värre än ingen post alls: väljaren hade visat en trasig ruta i stället för att leta upp en
 * bild som kunde ha funnits. Samma krav som `registreradKandidatbild` ställer vid uppslaget.
 *
 * DET SOM REDAN STÅR VINNER. Två register kan ha samma modell under olika bilder, och den som ligger
 * på maskinen är den som säljare faktiskt har sett. En förvärmning ska fylla luckor, inte byta ut
 * det som fungerar.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { kandidatbilderDir, registreradKandidatbild, registreraKandidatbilder } from "../server/src/kandidatbild.js";

async function main() {
  const [fil, ...flaggor] = process.argv.slice(2);
  const torr = flaggor.includes("--torr");
  if (!fil) {
    console.error("Ange vilket register som ska flätas in: npx tsx scripts/flata-in-kandidatbilder.ts <register.json>");
    process.exit(1);
  }

  let inkommande: Record<string, string>;
  try {
    const rå: unknown = JSON.parse(await readFile(fil, "utf8"));
    inkommande = Object.fromEntries(
      Object.entries(rå as Record<string, unknown>).filter((p): p is [string, string] => typeof p[1] === "string"),
    );
  } catch (err) {
    console.error(`Kunde inte läsa ${fil}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const dir = kandidatbilderDir();
  console.log(`Flätar in ${Object.keys(inkommande).length} poster i ${dir}`);

  const attSkriva: Array<{ brand: string; model: string; url: string }> = [];
  let fanns = 0;
  let utanFil = 0;
  let trasigNyckel = 0;

  for (const [nyckel, url] of Object.entries(inkommande)) {
    // Nyckeln är `märke|modell`, skriven av kandidatbild.ts. Ett tomt märke är tillåtet, en saknad
    // lodrät linje är det inte — då är filen inte ett register.
    const delar = nyckel.split("|");
    if (delar.length !== 2 || !delar[1]) {
      trasigNyckel++;
      continue;
    }
    const [brand, model] = delar;

    if (!existsSync(path.join(dir, path.basename(url)))) {
      utanFil++;
      continue;
    }
    if (await registreradKandidatbild(brand, model)) {
      fanns++;
      continue;
    }
    attSkriva.push({ brand, model, url });
  }

  console.log(
    `  ${attSkriva.length} nya, ${fanns} fanns redan, ${utanFil} utan bildfil på plats` +
      (trasigNyckel ? `, ${trasigNyckel} otolkbara nycklar` : ""),
  );

  if (torr) return console.log("Torrkörning — ingenting skrevs.");
  // I klumpar: registret skrivs om till disk vid varje anrop.
  for (let i = 0; i < attSkriva.length; i += 200) await registreraKandidatbilder(attSkriva.slice(i, i + 200));
  console.log(attSkriva.length ? "Inflätat." : "Inget att fläta in.");
}

void main();
