// Browser client for POST /api/seller/generate — the consumer seller
// product's final generation step.
//
// Separate from generateListingClient.ts (which drives the professional
// /secondhand generator) because the seller endpoint has a different
// contract: a valid submission ALWAYS returns HTTP 200 with a usable outcome.
// That outcome is either the finished result (kind "result", degraded through
// `status` "full" | "partial" | "fallback" and an explicit `missingFields`
// list rather than through errors) or a candidate-selection pause (kind
// "needs_selection" — 0-4 plausible products the seller resolves, after which
// this client is called again with a `resolution`). See
// functions/api/seller/generate.ts.
//
// SellerGenerateError therefore signals only genuine transport/protocol
// failures — the request never reached the endpoint, or the response wasn't
// JSON. Missing specs, failed grounded search and unprovable models are NOT
// errors here and must never surface as one.

import type { GeneratedListingResult, UploadedImage } from '../generator/schema'
import type { SellerProductCandidate, SellerResolution } from './types'

export class SellerGenerateError extends Error {}

/** What a valid submission comes back as: a finished listing, or a pause for the seller to resolve the product identity. */
export type SellerGenerateOutcome =
  | { kind: 'result'; result: GeneratedListingResult }
  | { kind: 'needs_selection'; candidates: SellerProductCandidate[] }

interface SellerGenerateResponse {
  ok: boolean
  kind?: 'result' | 'needs_selection'
  result?: GeneratedListingResult
  candidates?: SellerProductCandidate[]
  error?: string
}

/**
 * Client-side ceiling. The server enforces its own 26s orchestration deadline
 * and returns a fallback result rather than hanging, so this only exists to
 * bound a genuinely dead connection — it is deliberately a little looser than
 * the server deadline so a healthy slow-but-arriving response is never cut off
 * by the client first.
 */
const CLIENT_TIMEOUT_MS = 32_000

export async function generateSellerListing(input: {
  brand: string
  sellerNote?: string
  /** Optional product type already inferred earlier in the session (ShotPlan). Used only to make a last-resort emergency listing less generic — never presented as a verified fact. */
  productHint?: string | null
  images: UploadedImage[]
  /** Absent on the first request. Present on the follow-up request after the candidate step paused the flow (seller_selected | manual | unknown) — the server then always answers kind "result". */
  resolution?: SellerResolution | null
}): Promise<SellerGenerateOutcome> {
  let res: Response
  try {
    res = await fetch('/api/seller/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: input.brand,
        sellerNote: input.sellerNote || undefined,
        productHint: input.productHint || undefined,
        images: input.images,
        resolution: input.resolution || undefined,
      }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    })
  } catch {
    throw new SellerGenerateError('Vi kunde inte nå Loopa just nu. Kontrollera din uppkoppling och försök igen.')
  }

  let parsed: SellerGenerateResponse
  try {
    parsed = await res.json()
  } catch {
    throw new SellerGenerateError(`Servern svarade oväntat (${res.status}).`)
  }

  if (parsed.ok === false) throw new SellerGenerateError(parsed.error || `Något gick fel (${res.status}).`)
  if (parsed.kind === 'needs_selection') {
    return { kind: 'needs_selection', candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] }
  }
  if (!parsed.result) throw new SellerGenerateError(`Servern svarade oväntat (${res.status}).`)
  return { kind: 'result', result: parsed.result }
}
