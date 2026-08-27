import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { ImagePart } from "./gemini.js";
import type { EvidenceMark } from "./types.js";

export interface NormalizedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export async function loadImageAsBase64(absPath: string, mimeType = "image/jpeg"): Promise<ImagePart> {
  const buf = await readFile(absPath);
  return { mimeType, base64: buf.toString("base64") };
}

export async function getImageDimensions(absPath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(absPath).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Crop an arbitrary normalized [0,1] rect from the ORIGINAL image and write it to outPath. */
export async function cropRegion(
  absPath: string,
  rect: NormalizedRect,
  outPath: string,
  opts: { resizeToWidth?: number } = {},
): Promise<void> {
  const meta = await sharp(absPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(`Could not read dimensions for ${absPath}`);

  const x0 = clamp01(Math.min(rect.x0, rect.x1));
  const y0 = clamp01(Math.min(rect.y0, rect.y1));
  const x1 = clamp01(Math.max(rect.x0, rect.x1));
  const y1 = clamp01(Math.max(rect.y0, rect.y1));

  const left = Math.min(Math.round(x0 * width), width - 1);
  const top = Math.min(Math.round(y0 * height), height - 1);
  const cropWidth = Math.max(8, Math.min(Math.round((x1 - x0) * width), width - left));
  const cropHeight = Math.max(8, Math.min(Math.round((y1 - y0) * height), height - top));

  let pipeline = sharp(absPath).extract({ left, top, width: cropWidth, height: cropHeight });
  if (opts.resizeToWidth) {
    pipeline = pipeline.resize({ width: opts.resizeToWidth, withoutEnlargement: false, fit: "inside" });
  }
  await pipeline.jpeg({ quality: 92 }).toFile(outPath);
}

/**
 * Crop a padded region around a normalized mark from the ORIGINAL image and write it to outPath.
 * Padding widens the crop so the verification pass sees surrounding context, not just the raw box.
 */
export async function cropEvidence(absPath: string, mark: EvidenceMark, outPath: string, paddingFrac = 0.15): Promise<void> {
  let x0: number, y0: number, x1: number, y1: number;
  if (mark.kind === "box") {
    x0 = mark.x;
    y0 = mark.y;
    x1 = mark.x + (mark.w ?? 0.1);
    y1 = mark.y + (mark.h ?? 0.1);
  } else {
    x0 = Math.min(mark.x, mark.x2 ?? mark.x);
    y0 = Math.min(mark.y, mark.y2 ?? mark.y);
    x1 = Math.max(mark.x, mark.x2 ?? mark.x);
    y1 = Math.max(mark.y, mark.y2 ?? mark.y);
  }
  const padX = (x1 - x0) * paddingFrac + 0.03;
  const padY = (y1 - y0) * paddingFrac + 0.03;
  await cropRegion(
    absPath,
    { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY },
    outPath,
    { resizeToWidth: 1024 },
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
