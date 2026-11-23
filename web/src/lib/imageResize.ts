/**
 * Bilder in i webbläsaren: avkoda, räta upp och skala ner till något servern tar emot.
 *
 * Fotoguiden tar emot bilder från två håll — kameran i sidan och filväljaren — och båda ska ge samma sak:
 * en JPEG med längsta sidan 2048 px, upprätt, i en data-URL. En mobilbild är 3–8 MB och kan bära sin
 * vridning i EXIF; skickas den som den är blir uppladdningen tung och en stående bild kommer fram liggande.
 *
 * Förut gjordes det här i CaptureScreen (`fileToResizedDataUrl`), utan felhantering i två av tre anrop: en
 * HEIC som webbläsaren inte kunde läsa gav ett oväntat avbrott utan ett ord till säljaren. Här kastas ett
 * `ImageReadError` som anroparen kan säga något begripligt om.
 */

/** Längsta sidan. 2048 px ger ett utsnitt på en skada nog att läsa — servern skalar inte upp. */
export const GUIDE_LONG_EDGE = 2048;
export const GUIDE_JPEG_QUALITY = 0.85;

/** Måtten efter nedskalning till längsta sidan `maxEdge`, med bevarade proportioner. Förstorar aldrig. */
export function fitLongEdge(width: number, height: number, maxEdge = GUIDE_LONG_EDGE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Filen gick inte att läsa som en bild — fel typ, skadad, eller ett format webbläsaren inte kan (till exempel HEIC i Chrome). */
export class ImageReadError extends Error {
  constructor(message = "Bilden gick inte att läsa") {
    super(message);
    this.name = "ImageReadError";
  }
}

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Avkodar en bild med rätt vridning. Tre försök, i den ordning de är minst krångliga:
 *   1. createImageBitmap med `imageOrientation: "from-image"` — EXIF-vridningen bakas in.
 *   2. createImageBitmap utan val — äldre Safari kastar på värdet ovan, men räknar vridningen ändå.
 *   3. ett `<img>`-element — webbläsarna räknar EXIF-vridningen på bilder sedan 2020.
 */
async function decode(blob: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    for (const options of [{ imageOrientation: "from-image" as const }, undefined]) {
      try {
        const bmp = await (options ? createImageBitmap(blob, options) : createImageBitmap(blob));
        return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
      } catch {
        // Nästa försök.
      }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new ImageReadError();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageReadError();
  }
}

function drawToDataUrl(source: CanvasImageSource, srcWidth: number, srcHeight: number): string {
  const { width, height } = fitLongEdge(srcWidth, srcHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageReadError("Bilden gick inte att bearbeta");
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", GUIDE_JPEG_QUALITY);
}

/** En fil eller blob (filväljaren, eller ett foto ur ImageCapture) som en JPEG-data-URL, upprätt och nedskalad. */
export async function fileToDataUrl(file: Blob): Promise<string> {
  const drawable = await decode(file);
  try {
    return drawToDataUrl(drawable.source, drawable.width, drawable.height);
  } finally {
    // Bitmappen håller bildens fulla pixelminne tills den släpps — på en telefon med tio foton är det skillnaden
    // mellan att fortsätta och att fliken kastas.
    drawable.release();
  }
}

/** Bildrutan som visas i kameran just nu. Null när kameran ännu inte har någon att ge. */
export function videoToDataUrl(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  return drawToDataUrl(video, video.videoWidth, video.videoHeight);
}
