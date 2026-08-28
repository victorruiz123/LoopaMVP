// Browser client for POST /api/seller/review-photo (ImageReviewEngine).

import type { UploadedImage } from '../generator/schema'
import type { ImageReviewResult } from './types'

export class ReviewPhotoError extends Error {}

/**
 * A review-specific lightweight derivative — NOT the same compression used
 * for the final accepted photo (see generateListingClient.ts's
 * fileToCompressedImage, which targets 1024px for listing/research quality).
 * The review model only needs enough detail to judge angle/framing/blur, so
 * this targets a much smaller ~640px edge — smaller upload, faster Gemini
 * call, faster perceived review. The seller's original file is untouched;
 * this derivative is discarded right after the review call.
 */
const REVIEW_MAX_EDGE = 640
const REVIEW_JPEG_QUALITY = 0.8

export async function createReviewThumbnail(file: File): Promise<UploadedImage> {
  try {
    const bitmap = await createImageBitmap(file)
    try {
      const scale = Math.min(1, REVIEW_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d context unavailable')
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', REVIEW_JPEG_QUALITY)
      const commaIdx = dataUrl.indexOf(',')
      if (commaIdx < 0) throw new Error('toDataURL produced no data')
      return { mimeType: 'image/jpeg', dataBase64: dataUrl.slice(commaIdx + 1) }
    } finally {
      bitmap.close()
    }
  } catch {
    // Fall back to the raw file rather than blocking review over a decode
    // quirk — larger upload, but the review call still works.
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        const commaIdx = result.indexOf(',')
        resolve({ mimeType: file.type || 'image/jpeg', dataBase64: commaIdx >= 0 ? result.slice(commaIdx + 1) : result })
      }
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsDataURL(file)
    })
  }
}

export async function reviewPhoto(input: { image: UploadedImage; shotTitle: string; shotInstruction: string }): Promise<ImageReviewResult> {
  const res = await fetch('/api/seller/review-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  let parsed: { ok: boolean; result?: ImageReviewResult; error?: string }
  try {
    parsed = await res.json()
  } catch {
    throw new ReviewPhotoError(`Servern svarade oväntat (${res.status}).`)
  }
  if (!parsed.ok || !parsed.result) {
    throw new ReviewPhotoError(parsed.error || `Något gick fel (${res.status}).`)
  }
  return parsed.result
}
