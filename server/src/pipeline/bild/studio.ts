/**
 * Studiobakgrunden: den enda bilden i systemet som är RITAD, och den innehåller ingen möbel.
 *
 * Omslaget låg mot rent vitt. Vitt är ärligt och tomt — men det är också det som gör att ett Loopa-
 * kort ser ut som ett urklipp bredvid en möbelkatalog, som fotograferar mot golv och vägg. Den här
 * modulen är golvet och väggen: ett tomt rum, genererat en gång, som möbeln komponeras in i av
 * samma aritmetik som lade den mot vitt.
 *
 * EN FIL, INTE ETT ANROP PER JOBB. Löftet till köparen är att omslagen ser ut att vara tagna i
 * SAMMA studio. Samma prompt två gånger ger två olika rum — annan golvton, annan horisont, annat
 * ljus — och ett rutnät där varje ruta har sin egen studio läser som en samling stockbilder i
 * stället för som en butik. Bakgrunden genereras därför en gång, granskas av ett mänskligt öga,
 * checkas in, och komponeras därefter in utan att någon modell är inblandad. Två annonser byggda
 * ett halvår isär får bit för bit samma botten.
 *
 * KEDJANS HUVUDLÖFTE ÄR ORÖRT. README:n i den här mappen säger att ingen generativ modell rör
 * möbelns pixlar, och det är fortfarande sant. Modellen ritar ett TOMT RUM. Möbeln läggs ovanpå som
 * säljarens egna pixlar med sin egen alfakanal, av samma kod som lade den mot vitt — skillnaden är
 * vad som ligger BAKOM urklippet, aldrig vad som är i det. `fargdrift` och `inreOrord` mäts
 * oförändrat i varje körning och gäller lika hårt.
 *
 * BARA OMSLAGET. Galleriets övriga bilder ligger mot rent vitt (se omslag.ts). Studion är annonsens
 * ansikte; att lägga alla vinklar i samma rum hade gjort bläddringen till en serie nästan-identiska
 * rum där möbeln råkar stå olika — och den vita botten är dessutom det som gör att man ser att det
 * är samma urklippta möbel från ett annat håll.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { RUTA } from "./komposition.js";

const HAR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Var bakgrunden bor: `server/assets/`, inte `server/data/`.
 *
 * Skillnaden är versionshantering. `data/` är driftdata och ligger utanför git; en incheckad
 * bakgrund följer med `git pull` i utrullningen (deploy/rulla-ut.sh) och är därmed samma fil på
 * varje maskin. En bakgrund som bara finns på en dator hade gett produktionen vitt och utvecklarens
 * skärm en studio, vilket är den sortens skillnad ingen upptäcker förrän en kund frågar.
 */
export const STUDIO_KATALOG = path.resolve(HAR, "..", "..", "..", "assets", "studio");
export const STUDIO_FIL = path.join(STUDIO_KATALOG, "studio-golv-vagg.jpg");
export const STUDIO_BESKRIVNING = path.join(STUDIO_KATALOG, "studio-golv-vagg.json");

/** Namnet som skrivs i `CoverCutout.backdrop`, så ett omslag går att härleda till sin botten. */
export const STUDIO_NAMN = "studio-golv-vagg";

/**
 * Fogens höjd mellan vägg och golv, som andel av rutan uppifrån.
 *
 * INTE ETT FRITT VAL. Möbelns nederkant hamnar alltid på samma höjd i rutan — `MARGINAL_UNDER` i
 * komposition.ts, alltså 92,5 % ned — och det är just det som gör rutnätet till en hylla där alla
 * möbler står på samma golv. Ligger fogen under den linjen står möbeln på väggen.
 *
 * 0,62 och inte 0,85: en fog strax ovanför möbelns fötter ger en golvremsa så smal att den läser
 * som en list. Golvet ska synas som ett PLAN — då ser en soffa ut att stå på något, i stället för
 * framför en tapetskarv. Uppåt finns motsvarande gräns: en fog över mitten lämnar mindre vägg än
 * golv, och en hög garderob skär då genom nästan hela bilden.
 */
export const HORISONT = 0.62;
/** Hur mycket fogen får ligga fel innan ett förslag underkänns. */
export const HORISONT_TOLERANS = 0.06;

/**
 * Bakgrunden som rå RGB i rutans storlek, redo att komponeras på. Null när filen inte finns.
 *
 * NULL ÄR ETT FULLGOTT UTFALL, och det är hela reservvägen: utan fil bygger komposition.ts mot rent
 * vitt precis som förut. En saknad bakgrund ger alltså ett tråkigare omslag, aldrig ett uteblivet.
 *
 * Läses en gång och hålls kvar. Filen ändras inte medan servern kör, och omslagsbygget skulle
 * annars läsa och avkoda samma 1600×1600-jpeg en gång per jobb.
 */
let cachad: Promise<Buffer | null> | null = null;

export function studiobotten(): Promise<Buffer | null> {
  if (!cachad) cachad = las();
  return cachad;
}

async function las(): Promise<Buffer | null> {
  if (!existsSync(STUDIO_FIL)) {
    console.info(`[studio] ingen bakgrund på disk (${STUDIO_FIL}) — omslaget byggs mot vitt`);
    return null;
  }
  try {
    // Rå RGB och exakt rutstorlek: komposition.ts lägger möbeln på en duk av given form, och en
    // bakgrund som råkar vara 1024 px hade tyst skalats av sharp med ett annat resultat än det
    // granskade. `cover` snarare än `fill` för att hellre beskära en felaktig storlek än sträcka
    // den — en sträckt fog är inte längre vågrät.
    return await sharp(STUDIO_FIL)
      .resize(RUTA, RUTA, { fit: "cover", position: "centre" })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch (err) {
    console.warn(`[studio] bakgrunden gick inte att läsa: ${(err as Error).message}`);
    return null;
  }
}

/** Glömmer den lästa bakgrunden. För skriptet, som skriver en ny fil i samma process. */
export function slappStudio(): void {
  cachad = null;
}

/**
 * Var fogen FAKTISKT hamnade i en bild, som andel uppifrån. Null när ingen tydlig fog finns.
 *
 * MÄTT, INTE TRODD. Prompten ber om en höjd och bildmodeller följer sådana ungefär. Måttet är
 * enkelt med flit: bilden är per konstruktion ljus vägg över mörkare golv, så fogen är den rad där
 * radmedelvärdet faller snabbast. Ett rum utan fog — en jämn svepvägg — ger ingen tydlig topp, och
 * då är svaret null i stället för en gissning.
 *
 * Bara mellersta partiet prövas: en vinjett gör översta och nedersta raderna mörkare av sig själva,
 * och det fallet är inte en fog.
 */
export async function fogen(bild: Buffer): Promise<number | null> {
  const { data, info } = await sharp(bild)
    .resize(64, RUTA, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rad = new Float64Array(info.height);
  for (let y = 0; y < info.height; y++) {
    let sum = 0;
    for (let x = 0; x < info.width; x++) sum += data[y * info.width + x];
    rad[y] = sum / info.width;
  }

  const fonster = Math.max(1, Math.round(info.height * 0.02));
  let bastY = -1;
  let bastFall = 0;
  for (let y = Math.round(info.height * 0.3); y < Math.round(info.height * 0.85); y++) {
    const fall = rad[y - fonster] - rad[y + fonster];
    if (fall > bastFall) {
      bastFall = fall;
      bastY = y;
    }
  }
  // Under fyra gråsteg är skillnaden brus, inte en fog.
  if (bastY < 0 || bastFall < 4) return null;
  return bastY / info.height;
}

/**
 * Prompten, ordagrant och versionerad tillsammans med bilden.
 *
 * Sparas i sidofilen med flit: en bakgrund som ska gå att göra om likadan om ett år är en bakgrund
 * vars prompt ligger bredvid den. Utan den är enda vägen tillbaka att gissa.
 *
 * TRE SAKER SOM MÅSTE STÅ UT, för de är de tre modellen gör fel om de inte gör det: den vill
 * MÖBLERA ett tomt rum, den vill visa att det är en studio genom att rita in stativ och softboxar,
 * och den vill lägga en riktad slagskugga i bakgrunden. Den sista är värst — den pekar åt ett annat
 * håll än kontaktskuggan vi själva ritar under möbeln, och två skuggor åt olika håll är det första
 * ett öga läser som falskt.
 */
export const PROMPT = [
  "A completely empty professional furniture photography studio, photographed straight on.",
  "A pale warm grey wall fills the upper part of the frame and a slightly darker, smooth matte floor",
  `fills the lower part. The seam where the wall meets the floor is a soft horizontal line about ${Math.round(HORISONT * 100)}%`,
  "of the way down the image, perfectly level and running the full width.",
  "Even, soft, diffuse studio lighting with a gentle pool of light in the centre and a very subtle",
  "vignette in the corners. A faint, soft reflection on the floor in front of the wall.",
  "No furniture. No objects. No people. No plants. No lamps, light stands, softboxes, tripods, cables",
  "or equipment of any kind. No text, no watermark, no logo. No hard directional shadows.",
  "Nothing casting a shadow. Neutral colour, no colour cast, muted and understated.",
  "Photorealistic, shot on a full-frame camera with a 50mm lens at eye level, square 1:1 composition,",
  "high resolution.",
].join(" ");

/** Exakt rutstorlek, ingen alfa, jpeg utan färgunderabtastning — samma behandling som omslaget. */
export async function normalisera(bild: Buffer): Promise<Buffer> {
  return await sharp(bild)
    .resize(RUTA, RUTA, { fit: "cover", position: "centre" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
