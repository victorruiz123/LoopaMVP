// Deterministic dimension extraction from the grounded research prose
// (functions/api/seller/generate.ts).
//
// The research prompt ends with a strict block — "MÅTT: bredd | 81 cm", one row per line — because
// dimensions buried in prose were the most common reason they never reached the listing. The
// structuring call is then TOLD those rows must become attributes. That instruction is model
// judgement, and model judgement is exactly what this format was introduced to stop depending on:
// measured over 78 real listings, six of the 52 that had sources still came back without a single
// dimension.
//
// So the rows are parsed here instead, in plain code, and merged into the attributes the structuring
// call returned. Same philosophy as seller-candidates.ts: what the seller ends up seeing is decided
// by code, never a second time by the model.

import type { ProductAttribute } from '../../../src/features/generator/schema'
import { typicalDimensions } from './seller-typical-dimensions'

/** The canonical row a label belongs to, so "sitthöjd" and "seat height" are the same line. */
const CANONICAL: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'sitthojd', label: 'Sitthöjd', re: /^(sitth|sitsh|seat ?h)/i },
  { key: 'sittdjup', label: 'Sittdjup', re: /^(sittd|sitsd|seat ?d)/i },
  { key: 'bredd', label: 'Bredd', re: /^(bredd|width)/i },
  { key: 'djup', label: 'Djup', re: /^(djup|depth)/i },
  { key: 'hojd', label: 'Höjd', re: /^(höjd|hojd|height)/i },
  { key: 'langd', label: 'Längd', re: /^(längd|langd|length)/i },
  { key: 'diameter', label: 'Diameter', re: /^(diameter|ø)/i },
  { key: 'vikt', label: 'Vikt', re: /^(vikt|weight)/i },
]

/**
 * Måttraderna, i sina två former.
 *
 * "MÅTT:" är belagda mått för DEN HÄR produkten. "LIKNANDE:" är sökningens uppskattning utifrån
 * närmaste jämförbara modell, och den skrivs bara när inga riktiga mått gick att hitta — en annons
 * utan ett enda tal går inte att svara "passar den i hallen?" på. De två hålls isär hela vägen:
 * uppskattningen bär `estimated: true` och räknas aldrig som belägg.
 */
const MÅTT_ROW = /^\s*(?:[-*\d.)\s]*)(MÅTT|LIKNANDE):\s*(.+)$/gim
/** A value is a number with a unit. Anything else on that line is prose, not a measurement. */
const MEASUREMENT = /\d{1,4}(?:[.,]\d{1,2})?\s*(?:cm|mm|centimeter|millimeter|m|kg|g|tum|")/i
const URL_IN_TEXT = /https?:\/\/\S+/gi
const MAX_ROWS = 8

function canonical(rawLabel: string): { key: string; label: string } | null {
  const label = rawLabel.replace(/[^\wåäöÅÄÖ /-]/g, ' ').trim()
  if (!label || label.length > 24) return null
  const hit = CANONICAL.find((c) => c.re.test(label))
  return hit ? { key: hit.key, label: hit.label } : null
}

/**
 * The "MÅTT:" rows the research call wrote, as attributes.
 *
 * Tolerant about the separator (the model writes "MÅTT: bredd | 81 cm" and, now and then, "MÅTT:
 * bredd 81 cm") and strict about everything else: an unknown label is dropped rather than guessed at,
 * a value without a unit is not a measurement, and "MÅTT: INGA" — the answer the prompt asks for when
 * nothing was found — yields nothing.
 */
export function parseDimensionRows(researchText: string): ProductAttribute[] {
  const out: ProductAttribute[] = []
  if (!researchText) return out
  MÅTT_ROW.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MÅTT_ROW.exec(researchText)) !== null && out.length < MAX_ROWS) {
    const estimated = m[1].toUpperCase() === 'LIKNANDE'
    const content = m[2].trim()
    if (/^(inga|ingen|none|-|okänd)/i.test(content)) continue
    const pipe = content.indexOf('|')
    const split = pipe >= 0 ? [content.slice(0, pipe), content.slice(pipe + 1)] : content.match(/^([^\d]{2,24}?)[\s:]*(\d.*)$/)?.slice(1)
    if (!split) continue
    const row = canonical(split[0] ?? '')
    let value = (split[1] ?? '')
      .replace(URL_IN_TEXT, ' ')
      .replace(/\(\s*källa:?[^)]*\)?/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[\s.,;|]+$/, '')
      .trim()
      .slice(0, 40)
    if (!row || !MEASUREMENT.test(value)) continue
    // Ett belagt mått vinner över en uppskattning av samma rad, oavsett vilken som stod först i
    // texten: sökningen skriver LIKNANDE-raderna sist, men ordningen är dess val och inte ett löfte.
    const existing = out.findIndex((a) => a.key === row.key)
    if (existing >= 0) {
      if (estimated || !out[existing].estimated) continue
      out.splice(existing, 1)
    }
    // "ca" i värdet självt, så uppskattningen syns även där flaggan inte följer med — i annonstexten
    // hos Blocket, i en kopierad rad, i chatten.
    if (estimated && !/^ca\b/i.test(value)) value = `ca ${value}`
    // No sourceUrl: the row itself carries no address, and inventing one would be the very thing the
    // whole verified-citation rule exists to prevent. The sources list still stands behind it.
    out.push({ key: row.key, label: row.label, value, sourceUrl: null, ...(estimated ? { estimated: true } : {}) })
  }
  return out
}

const COMBINED = /(mått|matt|dimension|storlek|size)/i
const TRIPLE_VALUE = /\d+\s*[x×*]\s*\d+\s*[x×*]\s*\d+/i

/** Which canonical rows an attribute already occupies — a combined "Mått" field covers all three. */
function rowsCovered(attribute: ProductAttribute): string[] {
  const head = `${attribute.key} ${attribute.label}`
  const direct = CANONICAL.find((c) => c.re.test(attribute.label.trim()) || c.re.test(attribute.key.trim()))
  if (direct) return [direct.key]
  if (!COMBINED.test(head)) return []
  if (TRIPLE_VALUE.test(attribute.value)) return ['bredd', 'djup', 'hojd']
  return CANONICAL.filter((c) => c.re.test(attribute.value.trim())).map((c) => c.key)
}

/**
 * Adds the parsed rows the structuring call left out. Never replaces a MEASURED attribute it kept: one
 * that survived structuring may carry a verified sourceUrl, and the row here never can. An estimate is
 * the one thing that does give way — ett belagt mått är alltid bättre än en uppskattning av samma rad.
 */
export function mergeDimensionRows(attributes: ProductAttribute[], rows: ProductAttribute[]): ProductAttribute[] {
  if (rows.length === 0) return attributes
  const taken = new Set(attributes.filter((a) => !a.estimated).flatMap(rowsCovered))
  const missing = rows.filter((r) => !taken.has(r.key) && taken.add(r.key))
  if (missing.length === 0) return attributes
  // En uppskattning som fått sitt riktiga mått ska bort, inte stå kvar bredvid det.
  const measured = new Set(missing.filter((r) => !r.estimated).map((r) => r.key))
  const kept = attributes.filter((a) => !(a.estimated && rowsCovered(a).some((k) => measured.has(k))))
  return [...kept, ...missing]
}

/** De mått en möbel mäts i. Sitthöjden räknas inte: en stol med bara sitthöjd saknar fortfarande sina mått. */
const MAIN_ROWS = ['bredd', 'djup', 'hojd', 'langd', 'diameter']

/**
 * Annonsen får aldrig gå ut utan mått.
 *
 * Har varken struktureringen, MÅTT-raderna eller LIKNANDE-raderna gett ett enda mått fylls de på med
 * typiska mått för möbeltypen — märkta som uppskattade, aldrig som belägg. Se
 * seller-typical-dimensions.ts för varför, och för vad "uppskattad" betyder i resten av kedjan.
 *
 * `basis` är null när inget behövde fyllas på; då fanns måtten redan.
 */
export function ensureDimensions(
  attributes: ProductAttribute[],
  context: Array<string | null | undefined>,
): { attributes: ProductAttribute[]; basis: string | null } {
  const covered = new Set(attributes.flatMap(rowsCovered))
  if (MAIN_ROWS.some((row) => covered.has(row))) return { attributes, basis: null }
  const typical = typicalDimensions(context)
  const missing = typical.attributes.filter((a) => !covered.has(a.key))
  if (missing.length === 0) return { attributes, basis: null }
  return { attributes: [...attributes, ...missing], basis: typical.basis }
}
