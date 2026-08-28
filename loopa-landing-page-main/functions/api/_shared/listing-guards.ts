// Deterministic guardrails shared by every listing-producing endpoint
// (functions/api/generate-listing.ts — professional /secondhand — and
// functions/api/seller/generate.ts — the consumer seller fast path).
//
// Plain-code checks around the LLM: a hallucinating model can't talk its way
// around a check that never asks it anything. Extracted here so the rules that
// matter most for trust — "a marketplace price is never evidence of nypris",
// "a retail price outside these bounds is nonsense", "source tiers are derived
// from the URL, never model-claimed" — are defined ONCE and cannot drift
// between the professional pipeline and the seller pipeline.
//
// Consistent with the Listing Genie reference's own evidence rules
// (marketplaces are valid evidence for RESALE value but never for original
// retail price; sources must be real, parseable URLs), enforced server-side
// rather than by prompt alone.

import type { SourceRef } from '../../../src/features/generator/schema'

/** Marketplaces/auctions show SECONDHAND prices, never original retail ("nypris") — a source here must never be trusted for retailPriceSek. */
const SECONDHAND_MARKETPLACE_DOMAINS = [
  'tradera.com', 'blocket.se', 'sellpy.se', 'sellpy.com', 'vinted.', 'shpock.com',
  'ebay.', 'lauritz.com', 'bukowskis.com', 'barnebys.', 'auctionet.com',
  'stockholmsauktionsverk.se', 'catawiki.com', 'facebook.com/marketplace', 'marketplace.facebook.com',
  'dba.dk', 'finn.no', 'chairish.com', 'pamono.com', '1stdibs.com',
]

/** Small, deliberately short lists — good enough to flag trust tier without maintaining a large domain database Loopa doesn't otherwise need. */
const MANUFACTURER_DOMAINS = [
  'ikea.com', 'ikea.se', 'string.se', 'stringfurniture.com', 'hay.dk', 'hay.com', 'muuto.com',
  'bolia.com', 'swedese.se', 'fogia.se', 'norrgavel.se', 'boconcept.com', 'kinnarps.se', 'kinnarps.com',
]
const RETAILER_DOMAINS = [
  'mio.se', 'svenssons.se', 'rum21.se', 'royaldesign.se', 'nordicnest.se', 'trademax.se', 'furniturebox.se',
]

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Gemini's groundingChunks never expose the real publisher URL — `web.uri` is
 * always an opaque `vertexaisearch.cloud.google.com/grounding-api-redirect/...`
 * wrapper (confirmed live: real domains like ikea.com/swedese.se only ever
 * showed up in `web.title`, never in the URL). So every domain check here
 * matches against the URL AND the title, since the title is often the only
 * place the actual source domain appears.
 */
export function isSecondhandMarketplaceUrl(url: string, title?: string): boolean {
  const lower = `${hostnameOf(url)} ${url} ${title || ''}`.toLowerCase()
  return SECONDHAND_MARKETPLACE_DOMAINS.some((d) => lower.includes(d))
}

/** 1 = manufacturer/official brand site, 2 = known retailer, 3 = other/unclassified. Deterministic from the URL+title, never model-generated. See isSecondhandMarketplaceUrl's note on why both are checked. */
export function sourceQualityTier(url: string, title?: string): 1 | 2 | 3 {
  const combined = `${hostnameOf(url)} ${title || ''}`.toLowerCase()
  if (MANUFACTURER_DOMAINS.some((d) => combined.includes(d))) return 1
  if (RETAILER_DOMAINS.some((d) => combined.includes(d))) return 2
  return 3
}

/** Cheap sanity bound against an obviously hallucinated retail price. Deliberately generous: it exists to catch nonsense, not to second-guess a real number. */
export function isPlausibleRetailPriceSek(value: number | null): boolean {
  if (value === null) return true
  return value >= 50 && value <= 300_000
}

/** Source URLs are taken directly from groundingMetadata — never re-typed by the model. */
export function extractSources(res: any, limit = 6): SourceRef[] {
  const chunks = res?.candidates?.[0]?.groundingMetadata?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const seen = new Set<string>()
  const out: SourceRef[] = []
  for (const c of chunks) {
    const uri = c?.web?.uri
    const title = c?.web?.title
    if (typeof uri === 'string' && uri && !seen.has(uri)) {
      seen.add(uri)
      const displayTitle = typeof title === 'string' && title ? title : uri
      out.push({ title: displayTitle, url: uri, qualityTier: sourceQualityTier(uri, displayTitle) })
    }
  }
  return out.slice(0, limit)
}

export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g')

export function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.slice(0, 80) || 'produkt'
}

/**
 * Tolerant JSON extraction for grounded calls.
 *
 * Grounding (googleSearch) and `responseSchema` cannot be combined reliably in
 * one Gemini request — that incompatibility is the ONLY reason the professional
 * pipeline splits research and structuring into two sequential calls. The
 * seller fast path removes that second call by asking for JSON in free text
 * instead and parsing it here: strip an optional code fence, then take the
 * outermost {...} span. Same approach the Listing Genie reference uses.
 *
 * Returns null when nothing parseable is present — callers treat that as "this
 * attempt produced no usable result", never as a fatal error.
 */
export function parseJsonLoose(text: string): any | null {
  if (!text) return null
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}
