/**
 * Bilderna in genom EN dörr: avkoda, räta upp, skala, koda om — och bestäm vilka som får följa med.
 *
 * Förut skrevs klientens bytes ner på disk som de var. Det gick så länge klienten var en
 * videoruta som själv hade skalats till 1280 px, men en uppladdad mobilbild är 3-8 MB, kan bära sin
 * vridning i EXIF (som `getImageDimensions` inte läser, så bredd och höjd kunde vara omkastade),
 * kan vara en PNG som sparades som `.png` men lästes som `image/jpeg` av Gemini-anropet
 * (imageUtils.ts), och bär GPS-position i metadata. Allt det löses på ett ställe här, innan jobbet
 * ens skapas.
 *
 * VARFÖR INNAN `createJob`: ett avvisat anrop ska inte lämna en jobbkatalog efter sig.
 *
 * OMSLAGET KOMMER FÖRST OCH KAPAS ALDRIG. Det är ett fysiskt foto som alla andra och går in i
 * besiktningen (se run.ts), så listan behöver bara EN ordning: omslaget på index 0, sedan resten i den
 * ordning klienten skickade dem. Förut låg omslaget sist, och när fler än taket kom in var det just
 * omslaget som tyst föll bort.
 *
 * DUBBLETTER RÄKNAS INTE. Samma foto fem gånger är inte fem bilder av möbeln, och minimikravet finns
 * för att besiktningen ska ha olika håll att titta från. Jämförelsen sker på de normaliserade
 * bytesen, så samma bild omkodad av klienten på samma sätt faller bort men två olika tagningar inte.
 */

import sharp from "sharp";
import { createHash } from "node:crypto";

/** Längsta sidan. 2048 px ger ett utsnitt på en skada nog att läsa (`cropEvidence` skalar upp till 1024 px). */
export const MAX_LONG_EDGE_PX = 2048;

/**
 * Ungefärligt tak per bild efter omkodning. Tio bilder à ≈1 MB är ≈13 MB som base64 — under Geminis
 * gräns för en inline-förfrågan, som annars är det som tar slut först när bilderna är stora.
 */
export const MAX_IMAGE_BYTES = 1_000_000;

const QUALITY_STEPS = [88, 82, 76, 70, 62];

/** Bara rasterformat. En SVG eller PDF som tar sig hit ska inte renderas av serverns bildbibliotek. */
const RASTER_FORMATS = new Set(["jpeg", "png", "webp", "heif", "avif", "tiff", "gif"]);

/** Samma regel som förr (`image/\w+`): inget annat än en vanlig bild-data-URL släpps in. */
const DATA_URL = /^data:(image\/\w+);base64,(.+)$/;

const SHARP_OPTIONS = { failOn: "error", limitInputPixels: 120_000_000 } as const;

/** Vad klienten skickar per bild. */
export interface UploadInput {
  dataUrl: string;
  viewLabel?: string | null;
  source?: "video" | "manual";
  role?: "cover";
}

export interface NormalisedImage {
  buffer: Buffer;
  width: number;
  height: number;
  /** sha256 över de normaliserade bytesen — nyckeln för dubblettkontrollen. */
  hash: string;
}

export interface PreparedImage extends NormalisedImage {
  viewLabel: string | null;
  source: "video" | "manual";
  role?: "cover";
}

export interface PrepareOutcome {
  images: PreparedImage[];
  dropped: { invalid: number; duplicate: number; overCap: number };
  /** Satt när `min` inte nåddes. Anroparen avgör om det är ett fel — `images` är ändå ifyllt. */
  error?: { code: "too_few_images"; min: number; got: number };
}

/**
 * Räta upp (EXIF), skala ner till `MAX_LONG_EDGE_PX` utan att förstora, och koda om som JPEG.
 *
 * Omkodningen släcker metadata, GPS-position inräknad. Kvaliteten stegas ned tills bilden ryms under
 * `MAX_IMAGE_BYTES`; ryms den inte ens vid lägsta steget behålls den ändå — en stor bild är bättre
 * än en bild som försvann. Returnerar null för det som inte går att läsa som en rasterbild.
 */
export async function normaliseImage(input: Buffer): Promise<NormalisedImage | null> {
  try {
    const meta = await sharp(input, SHARP_OPTIONS).metadata();
    if (!meta.format || !RASTER_FORMATS.has(meta.format)) return null;

    let best: { data: Buffer; width: number; height: number } | null = null;
    for (const quality of QUALITY_STEPS) {
      const { data, info } = await sharp(input, SHARP_OPTIONS)
        .rotate()
        // En genomskinlig PNG blir annars svart i en JPEG.
        .flatten({ background: "#ffffff" })
        .resize({ width: MAX_LONG_EDGE_PX, height: MAX_LONG_EDGE_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      best = { data, width: info.width, height: info.height };
      if (data.length <= MAX_IMAGE_BYTES) break;
    }
    if (!best || best.width <= 0 || best.height <= 0) return null;
    return {
      buffer: best.data,
      width: best.width,
      height: best.height,
      hash: createHash("sha256").update(best.data).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Etiketten följer med in i besiktningsprompten ("Bild 2: foto (Vänster sida)"), så den är
 * indata till en modell och ska hållas kort och på en rad. Klienten sätter den ur sin egen
 * stegtabell; allt annat är en klient vi inte kontrollerar.
 */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return cleaned || null;
}

function decode(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  const buf = Buffer.from(match[2], "base64");
  return buf.length > 0 ? buf : null;
}

/** Hur många bilder som avkodas samtidigt. Sharp kör i trådpoolen, så fler hade bara trängts. */
const BATCH = 4;

/**
 * Avgör vilka uppladdade bilder som blir jobbets bilder, och i vilken ordning.
 *
 * Ordningen: omslaget (om det finns och går att läsa) först, resten i den ordning de kom. Tar slut på
 * plats (`max`) är det de sista som faller bort — aldrig omslaget. Bara EN bild kan bära rollen
 * `cover`; en klient som skickar flera får den första, och de andra räknas som vanliga bilder.
 *
 * Kastar aldrig för dåligt innehåll: en bild som inte går att läsa räknas bara som ogiltig. Det är
 * anroparen som avgör om det som blev kvar räcker (`error` när `min` inte nås).
 */
export async function prepareUploads(
  inputs: UploadInput[],
  opts: { max: number; min?: number },
): Promise<PrepareOutcome> {
  const list = Array.isArray(inputs) ? inputs : [];
  const coverAt = list.findIndex((i) => i?.role === "cover");
  const candidates: Array<{ input: UploadInput; isCover: boolean }> = [];
  if (coverAt >= 0) candidates.push({ input: list[coverAt], isCover: true });
  list.forEach((input, i) => {
    if (i !== coverAt) candidates.push({ input, isCover: false });
  });

  const images: PreparedImage[] = [];
  const seen = new Set<string>();
  const dropped = { invalid: 0, duplicate: 0, overCap: 0 };

  let examined = 0;
  for (let start = 0; start < candidates.length && images.length < opts.max; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    examined += batch.length;
    const normalised = await Promise.all(
      batch.map(async ({ input }) => {
        const bytes = decode(input?.dataUrl);
        return bytes ? normaliseImage(bytes) : null;
      }),
    );
    for (let k = 0; k < batch.length; k++) {
      const n = normalised[k];
      if (!n) {
        dropped.invalid++;
        continue;
      }
      if (seen.has(n.hash)) {
        dropped.duplicate++;
        continue;
      }
      if (images.length >= opts.max) {
        dropped.overCap++;
        continue;
      }
      seen.add(n.hash);
      const { input, isCover } = batch[k];
      images.push({
        ...n,
        viewLabel: cleanLabel(input.viewLabel),
        source: input.source === "video" ? "video" : "manual",
        ...(isCover ? { role: "cover" as const } : {}),
      });
    }
  }
  // Det som aldrig ens avkodades eftersom taket redan var nått.
  dropped.overCap += candidates.length - examined;

  const outcome: PrepareOutcome = { images, dropped };
  if (opts.min && images.length < opts.min) {
    outcome.error = { code: "too_few_images", min: opts.min, got: images.length };
  }
  return outcome;
}
