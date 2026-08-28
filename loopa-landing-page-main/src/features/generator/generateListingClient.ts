// Browser client for POST /api/generate-listing. Same-origin fetch, no
// secrets in the client bundle — the Gemini key lives only in the Cloudflare
// Pages Function.

import type { GenerateListingFailure, GenerateListingRequest, GenerateListingResponse, GeneratedListingResult, GenerationMode, UploadedImage } from './schema'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const commaIdx = result.indexOf(',')
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

// Downscale before upload: max edge 1024px, JPEG quality 0.82 — plenty for
// Gemini at these sizes, and it cuts payload and model latency dramatically
// versus raw camera files (parameters verified in the Listing Genie reference).
const MAX_IMAGE_EDGE = 1024
const JPEG_QUALITY = 0.82

async function fileToCompressedImage(file: File): Promise<UploadedImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const commaIdx = dataUrl.indexOf(',')
    if (commaIdx < 0) throw new Error('toDataURL produced no data')
    return { mimeType: 'image/jpeg', dataBase64: dataUrl.slice(commaIdx + 1) }
  } finally {
    bitmap.close()
  }
}

/** Converts each file independently and drops any that fail, rather than failing the whole upload over one bad file. Compression failures (e.g. undecodable formats) fall back to the raw file rather than dropping it. */
export async function filesToUploadedImages(files: File[]): Promise<{ images: UploadedImage[]; failedCount: number }> {
  const settled = await Promise.allSettled(
    files.map(async (f) => {
      try {
        return await fileToCompressedImage(f)
      } catch {
        return { mimeType: f.type || 'image/jpeg', dataBase64: await fileToBase64(f) }
      }
    }),
  )
  const images = settled.filter((r): r is PromiseFulfilledResult<UploadedImage> => r.status === 'fulfilled').map((r) => r.value)
  const failedCount = settled.length - images.length
  return { images, failedCount }
}

export class GenerateListingError extends Error {}

export async function generateListing(
  input: {
    mode: GenerationMode
    brand?: string
    model?: string
    styleCode?: string
    size?: string
    sellerNote?: string
    images: UploadedImage[]
    websiteUrl?: string
  },
  messages?: { unexpectedServer: (status: number) => string; genericFailed: (status: number) => string },
): Promise<GeneratedListingResult> {
  const body: GenerateListingRequest = input
  const res = await fetch('/api/generate-listing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  let parsed: GenerateListingResponse
  try {
    parsed = await res.json()
  } catch {
    throw new GenerateListingError(messages ? messages.unexpectedServer(res.status) : `Servern svarade oväntat (${res.status}).`)
  }

  if (isFailure(parsed)) {
    throw new GenerateListingError(parsed.error || (messages ? messages.genericFailed(res.status) : `Något gick fel (${res.status}).`))
  }
  return parsed.result
}

function isFailure(r: GenerateListingResponse): r is GenerateListingFailure {
  return r.ok === false
}
