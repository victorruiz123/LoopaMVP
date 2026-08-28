// Browser client for POST /api/seller/shot-plan (adaptive ShotPlan generation).

import type { UploadedImage } from '../generator/schema'
import type { ShotPlan } from './types'

export class ShotPlanError extends Error {}

export async function fetchShotPlan(input: { image: UploadedImage; brand: string; sellerNote: string }): Promise<ShotPlan> {
  const res = await fetch('/api/seller/shot-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  let parsed: { ok: boolean; result?: ShotPlan; error?: string }
  try {
    parsed = await res.json()
  } catch {
    throw new ShotPlanError(`Servern svarade oväntat (${res.status}).`)
  }
  if (!parsed.ok || !parsed.result) {
    throw new ShotPlanError(parsed.error || `Något gick fel (${res.status}).`)
  }
  return parsed.result
}
