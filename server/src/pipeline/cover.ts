/**
 * Vilken bildruta som är annonsens ansikte utåt.
 *
 * `images[0]` dög inte. Bildrutorna ligger i filmningsordning, och den första sextondelen av en
 * inspelning är ofta kameran innan den exponerat — mätt över 28 sparade jobb var första bilden HELT
 * svart (medelluminans 0, standardavvikelse 0) i fyra av dem. Den bilden gick vidare som omslag till
 * Tradera, som miniatyr på startsidan och som typunderlag till prismotorn.
 *
 * Två signaler, i den ordningen:
 *
 * 1. DUGLIGHET, mätt här med sharp. Svart, utbränd eller helt platt bildruta diskvalificeras. Det är
 *    aritmetik på pixlar och kan inte ha fel om det den mäter.
 * 2. VY, från inspektionsanropet, som ändå ser alla bildrutor och får peka ut den som visar möbeln
 *    framifrån. Gratis — inget extra anrop, ingen extra latens.
 *
 * Ordningen är inte godtycklig: en modell som pekar ut en svart bildruta ska köras över, medan en
 * mätning aldrig kan veta vilket håll möbeln står åt. Ingendera signalen räcker ensam.
 */

import path from "node:path";
import sharp from "sharp";
import { jobDir, persist } from "../jobStore.js";
import type { CapturedImage, ConditionJob } from "../types.js";

/** Under detta är bildrutan för mörk att visa någon. En helsvart bildruta mäter 0. */
const MIN_MEAN_LUMINANCE = 25;
/** Över detta är den utbränd. */
const MAX_MEAN_LUMINANCE = 235;
/** En bildruta utan variation visar ingenting, hur välexponerad den än är. */
const MIN_STDEV = 8;

interface Measured {
  image: CapturedImage;
  usable: boolean;
}

/**
 * Mätningen per fil, sparad över anrop.
 *
 * Bildrutorna på disk ändras aldrig efter att jobbet skapats, så svaret är konstant — och utan cachen
 * hade varje pollning av publiceringsstatusen (var 2,5:e sekund) kört om sharp på sex bilder för att
 * räkna ut samma sak igen.
 */
const measurements = new Map<string, boolean>();

async function measure(image: CapturedImage, originalsDir: string): Promise<Measured> {
  const abs = path.join(originalsDir, image.path);
  const cached = measurements.get(abs);
  if (cached !== undefined) return { image, usable: cached };
  try {
    const stats = await sharp(abs).greyscale().stats();
    const { mean, stdev } = stats.channels[0];
    const usable = mean >= MIN_MEAN_LUMINANCE && mean <= MAX_MEAN_LUMINANCE && stdev >= MIN_STDEV;
    measurements.set(abs, usable);
    return { image, usable };
  } catch {
    // En bild vi inte kan läsa kan vi inte heller underkänna på mätning. Låt vyvalet råda.
    return { image, usable: true };
  }
}

/**
 * Bilderna som duger att visa för en köpare, omslaget först.
 *
 * En helsvart bildruta ska inte bara flyttas ned i annonsen — den ska inte med alls. Att den var bra
 * nog för besiktningen är en annan fråga: där är den bara en bildruta som inte gav något, här är den
 * ett foto en köpare ser.
 *
 * Duger ingen behålls listan orörd. En annons utan bilder är sämre än en med en dålig.
 */
export async function presentableImages(
  images: CapturedImage[],
  originalsDir: string,
  coverImageId: string | null,
): Promise<CapturedImage[]> {
  const measured = await Promise.all(images.map((img) => measure(img, originalsDir)));
  const usable = measured.filter((m) => m.usable).map((m) => m.image);
  return coverFirst(usable.length > 0 ? usable : images, coverImageId);
}

/**
 * Väljer omslagsbild. `suggestedIndex` är inspektionens vy-val och används bara om bildrutan duger.
 *
 * Faller tillbaka på första DUGLIGA bildrutan i filmningsordning, och först om ingen duger på
 * `images[0]` — då finns inget bättre att säga, och ett omslag måste det bli.
 */
export async function pickCoverImageId(
  images: CapturedImage[],
  originalsDir: string,
  suggestedIndex: number | null,
): Promise<string | null> {
  if (images.length === 0) return null;
  const measured = await Promise.all(images.map((img) => measure(img, originalsDir)));

  if (suggestedIndex !== null && suggestedIndex >= 0 && suggestedIndex < measured.length) {
    const suggested = measured[suggestedIndex];
    if (suggested.usable) return suggested.image.id;
  }
  return (measured.find((m) => m.usable) ?? measured[0]).image.id;
}

/**
 * Jobbets omslagsbild, räknad högst en gång per jobb.
 *
 * Finns för att jobb som redan ligger på disk saknar fältet helt — de skapades när omslaget var
 * `images[0]` och har kvar sin svarta första bildruta. I stället för att lämna dem trasiga räknas
 * valet fram vid första efterfrågan och skrivs in i jobbet. Ingen vy-signal finns att hämta för dem,
 * så de får duglighetsspärren ensam: det tar bort det svarta, vilket är hela felet de bär på.
 */
export async function resolveCoverImageId(job: ConditionJob): Promise<string | null> {
  const result = job.result;
  if (!result) return null;
  if (result.coverImageId) return result.coverImageId;

  const coverImageId = await pickCoverImageId(result.images, path.join(jobDir(job.id), "originals"), null);
  if (!coverImageId) return null;
  result.coverImageId = coverImageId;
  await persist(job);
  return coverImageId;
}

/** Bilderna med omslaget först. Resten behåller filmningsordningen. */
export function coverFirst(images: CapturedImage[], coverImageId: string | null): CapturedImage[] {
  if (!coverImageId) return images;
  const cover = images.find((i) => i.id === coverImageId);
  if (!cover) return images;
  return [cover, ...images.filter((i) => i.id !== coverImageId)];
}
