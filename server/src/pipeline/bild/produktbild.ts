/**
 * Produktbildssystemet, utifrån sett. Ett foto in — en produktbild, en mask och en dom ut.
 *
 * KEDJAN, och varje steg är ett eget kort dokumenterat modul:
 *
 *   originalbild (rörs aldrig)
 *     -> laddaArbetsbild   segmentera.ts   nedskalning, EXIF, råa RGB
 *     -> kartaFor          segmentera.ts   modellen svarar: hur mycket möbel per pixel
 *     -> forfina           kant.ts         snäpp mot bildens kanter, öar bort, rummets färg ur kanten
 *     -> ramFor            komposition.ts  möbelns egen ram
 *     -> bedom             kvalitet.ts     sju mått, varav två invarianter
 *     -> komponera         komposition.ts  beskärning, skala, vit duk, kontaktskugga
 *
 * INGEN GENERATIV MODELL NÅGONSTANS I DEN KEDJAN. Det som frågas en modell är EN sak: vilka pixlar
 * som är möbel. Färgerna, formen, materialet, slitaget och skadorna kommer från säljarens egen fil
 * och går orörda igenom — det kontrolleras dessutom mätbart i varje körning (`fargdrift` och
 * `inreOrord` i kvalitet.ts), inte bara i den här kommentaren.
 *
 * Att skilja de två sakerna åt är hela produkten. Loopas kort räknar upp varje skråma; att skicka
 * möbeln genom en bildmodell och visa det som kom tillbaka vore samma lögn i bildform, hur mycket
 * finare den än blev.
 */

import sharp from "sharp";
import { laddaArbetsbild, kartaFor, tillgangligModell } from "./segmentera.js";
import type { Modell } from "./modeller.js";
import { forfina } from "./kant.js";
import { komponera, ramFor, tillTransparent, RUTA } from "./komposition.js";
import { bedom, type Kvalitet } from "./kvalitet.js";

export interface Produktbild {
  /** Möbeln mot rent vitt, RUTA×RUTA, jpeg. Det som visas som omslag. */
  processedImage: Buffer;
  /** Möbeln utan bakgrund, png med alfa, beskuren till möbelns ram. Går mot vilken botten som helst. */
  transparent: Buffer;
  /** Silhuetten som gråskale-png i arbetsstorlek. Sparas för att kunna granska ett urklipp i efterhand. */
  mask: Buffer;
  qualityScore: number;
  needsReview: boolean;
  metadata: Metadata;
}

export interface Metadata {
  /** Vilken modell som FAKTISKT kördes — inte vilken som var vald. Se RESERVKEDJA. */
  modell: string;
  modellSida: number;
  arbetsbredd: number;
  arbetshojd: number;
  originalbredd: number;
  originalhojd: number;
  rutstorlek: number;
  ms: number;
  kvalitet: Kvalitet;
  skapad: string;
}

/**
 * En bild in, en produktbild ut. Null bara när ingen modell finns eller filen inte går att läsa.
 *
 * NULL ÄR ETT FULLGOTT UTFALL och ska behandlas så av anroparen: kortet har säljarens bildruta kvar
 * att visa, och en bildruta med rummet i är oändligt mycket bättre än ett urklipp där soffan saknar
 * ett ben. Samma sak gäller `needsReview` — bilden byggs och sparas, men den ska inte publiceras
 * automatiskt.
 *
 * ORIGINALET RÖRS ALDRIG. Funktionen läser filen och skriver ingenting; allt arbete sker på en
 * nedskalad kopia i minnet. Det är en förutsättning för att kortet alltid ska kunna visa köparen
 * vad säljaren faktiskt fotograferade.
 */
export async function bearbetaMobelbild(src: string | Buffer): Promise<Produktbild | null> {
  const t0 = Date.now();
  const modell = await tillgangligModell();
  if (!modell) {
    console.info("[produktbild] ingen modellfil på disk — se scripts/fetch-models.sh");
    return null;
  }
  return await medModell(src, modell, t0);
}

/**
 * Samma sak, med en utpekad modell. För benchmarken, som kör fyra om vartannat över samma bilder.
 *
 * Bruten ut och exporterad med flit: en jämförelse som går genom en annan kodväg än driften jämför
 * inte det som driftar. Allt utom modellvalet är identiskt.
 */
export async function medModell(
  src: string | Buffer,
  modell: Modell,
  t0 = Date.now(),
): Promise<Produktbild | null> {
  const bild = await laddaArbetsbild(src);
  if (!bild) return null;

  const karta = await kartaFor(bild, modell);
  if (!karta) return null;

  /**
   * ORIGINALPIXLARNA SPARAS UNDAN INNAN FÖRFININGEN.
   *
   * Kostar en kopia på några megabyte, och är det enda sättet att faktiskt KONTROLLERA att möbelns
   * yta kommit igenom orörd i stället för att lita på att koden ovanför gör som den säger. Se
   * `fargkontroll` i kvalitet.ts. Ett löfte som bara hålls av att koden är rätt är ett löfte tills
   * någon ändrar i koden.
   */
  const orginalRgb = Buffer.from(bild.rgb);
  // Modellens svar undan på samma sätt: benförlusten mäts som skillnaden mot den, och den skillnaden
  // är förfiningens eget arbete — annars är det steget det enda ingen kontrollerar.
  const raKarta = Float32Array.from(karta.data);

  const alfa = forfina(bild, karta);
  const ram = ramFor(alfa, bild.bredd, bild.hojd);
  const kvalitet = bedom(raKarta, alfa, orginalRgb, bild.rgb, bild.bredd, bild.hojd, ram);

  if (!ram) {
    console.info(`[produktbild] ${modell.namn}: ingen silhuett`);
    return null;
  }

  const processedImage = await komponera(bild.rgb, alfa, bild.bredd, bild.hojd, ram);
  if (!processedImage) return null;
  const transparent = await tillTransparent(bild.rgb, alfa, bild.bredd, bild.hojd, ram);

  const maskBytes = Buffer.alloc(alfa.length);
  for (let i = 0; i < alfa.length; i++) maskBytes[i] = Math.round(alfa[i] * 255);
  const mask = await sharp(maskBytes, { raw: { width: bild.bredd, height: bild.hojd, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toBuffer();

  const ms = Date.now() - t0;
  const metadata: Metadata = {
    modell: modell.namn,
    modellSida: modell.sida,
    arbetsbredd: bild.bredd,
    arbetshojd: bild.hojd,
    originalbredd: bild.originalBredd,
    originalhojd: bild.originalHojd,
    rutstorlek: RUTA,
    ms,
    kvalitet,
    skapad: new Date().toISOString(),
  };

  if (kvalitet.behoverGranskning) {
    console.info(
      `[produktbild] ${modell.namn} ${ms} ms poäng=${kvalitet.poang.toFixed(2)} GRANSKNING: ` +
        kvalitet.anmarkningar.map((a) => a.kod).join(", "),
    );
  }

  return {
    processedImage,
    transparent,
    mask,
    qualityScore: kvalitet.poang,
    needsReview: kvalitet.behoverGranskning,
    metadata,
  };
}

/** Engelskt namn på samma funktion, som gränssnittet är efterfrågat. Samma kod, ingen egen väg. */
export const processFurnitureImage = bearbetaMobelbild;

export interface Flerbild {
  /** Index i indatalistan. */
  index: number;
  kalla: string;
  bild: Produktbild | null;
  /** Hur väl bilden duger som HUVUDBILD. Se `huvudbildspoang`. */
  huvudbildspoang: number;
}

/**
 * Flera bilder av samma möbel: en produktbild var, plus vilken som ska vara huvudbild.
 *
 * Sekventiellt och inte parallellt. Modellen är samma session och tar 1–2 GB medan den räknar; att
 * köra sex bildrutor samtidigt är sex gånger minnet för att bli klar lika fort som en tråd med sex
 * uppgifter. På en burk som delar minne med prismotorn är det skillnaden mellan långsamt och nere.
 */
export async function bearbetaMobelbilder(kallor: string[]): Promise<{
  bilder: Flerbild[];
  huvudbildIndex: number | null;
}> {
  const bilder: Flerbild[] = [];
  for (let i = 0; i < kallor.length; i++) {
    const bild = await bearbetaMobelbild(kallor[i]).catch(() => null);
    bilder.push({ index: i, kalla: kallor[i], bild, huvudbildspoang: await huvudbildspoang(kallor[i], bild) });
  }
  const kandidater = bilder.filter((b) => b.bild && !b.bild.needsReview);
  const valbara = kandidater.length > 0 ? kandidater : bilder.filter((b) => b.bild);
  if (valbara.length === 0) return { bilder, huvudbildIndex: null };
  valbara.sort((a, b) => b.huvudbildspoang - a.huvudbildspoang);
  return { bilder, huvudbildIndex: valbara[0].index };
}

/**
 * Hur väl en bildruta duger som HUVUDBILD — en annan fråga än om urklippet blev bra.
 *
 * Den gamla vägen valde omslagsruta efter vad som visade SKICKET bäst, vilket ofta är en närbild på
 * ett armstöd. Det är rätt fråga för skickrapporten och fel för ett omslag: närbilden säger allt om
 * nötningen och ingenting om vilken möbel som säljs.
 *
 * Fem signaler, alla mätta och ingen frågad:
 *
 * 1. KVALITETSPOÄNGEN bär redan "hela möbeln syns", "inte beskuren" och "tydlig produkt".
 * 2. STORLEK I BILD — bästa täckningen ligger runt en tredjedel. En möbel som fyller femton procent
 *    är fotograferad på avstånd; en som fyller nittio är en närbild PÅ möbeln, inte en bild AV den.
 * 3. LJUSET, mätt på bildrutan. En mörk eller utbränd bild blir en mörk eller utbränd produktbild —
 *    urklippet räddar bakgrunden, inte exponeringen.
 * 4. UPPLÖSNING. En liten fil skalas upp till 1600 och blir grynig.
 * 5. FRAGMENT — lösa bitar betyder att något stod framför möbeln, en person eller en låda.
 */
async function huvudbildspoang(kalla: string, bild: Produktbild | null): Promise<number> {
  if (!bild) return 0;
  const k = bild.metadata.kvalitet;

  const idealTackning = 0.34;
  const storlek = 1 - Math.min(1, Math.abs(k.matt.tackning - idealTackning) / idealTackning);

  let ljus = 0.5;
  try {
    const { channels } = await sharp(kalla).greyscale().stats();
    const { mean, stdev } = channels[0];
    // Mitten av spannet är bäst; svart och utbränt är lika oanvändbart. Variationen säger att det
    // finns något att se — en helt platt bildruta är en vägg.
    const exponering = 1 - Math.min(1, Math.abs(mean - 128) / 128);
    const variation = Math.min(1, stdev / 45);
    ljus = exponering * 0.6 + variation * 0.4;
  } catch {
    // En bildruta vi inte kan mäta får medelbetyg på ljus i stället för att falla ur helt.
  }

  const pixlar = bild.metadata.originalbredd * bild.metadata.originalhojd;
  const upplosning = Math.min(1, pixlar / (1600 * 1200));
  const rent = 1 - Math.min(1, k.matt.fragment * 2);

  return k.poang * 0.4 + storlek * 0.2 + ljus * 0.2 + upplosning * 0.1 + rent * 0.1;
}
