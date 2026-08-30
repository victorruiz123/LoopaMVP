// Deterministic candidate extraction for the seller identification stage
// (functions/api/seller/generate.ts).
//
// The grounded identify call answers in free text (any JSON instruction kills
// googleSearch — see seller/generate.ts's file header) but is told to list the
// plausible products it found as strict "KANDIDAT: …" lines. This module turns
// those lines into typed candidates and applies the auto-continue rule, all in
// plain code: which candidates exist and whether the seller is interrupted is
// never left to model judgement a second time.
//
// Philosophy (the whole point of the candidate flow): ambiguity between REAL
// products is handed to the seller instead of being discarded or fought over
// with more AI calls. Human disambiguation is cheap; model latency is
// expensive.

import { MAX_SELLER_CANDIDATES, type SellerCandidateConfidence, type SellerProductCandidate } from '../../../src/features/seller/types'

export interface ParsedCandidates {
  /** 0-4 plausible products, best first. */
  candidates: SellerProductCandidate[]
  /**
   * True when the model explicitly wrote "KANDIDAT: INGEN" — a deliberate
   * "no credible candidate exists" answer. Distinguished from format
   * non-compliance (no KANDIDAT marker at all), which must NOT interrupt the
   * seller with a selection screen it never earned.
   */
  explicitNone: boolean
  /** True when at least one KANDIDAT marker (a real line or INGEN) was present. */
  sawMarker: boolean
}

const CONFIDENCE_RANK: Record<SellerCandidateConfidence, number> = { strong: 3, likely: 2, possible: 1 }

function parseConfidence(raw: string | undefined): SellerCandidateConfidence {
  const v = (raw || '').trim().toUpperCase()
  if (v.startsWith('STARK') || v.startsWith('STRONG')) return 'strong'
  if (v.startsWith('TROLIG') || v.startsWith('LIKELY')) return 'likely'
  return 'possible'
}

function cleanField(raw: string | undefined, maxLen: number): string | null {
  const v = (raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!v || v === '-' || v === '–' || /^(okänd|okänt|ingen|null|n\/a)$/i.test(v)) return null
  return v.slice(0, maxLen)
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()\[\]|]+/i
const URL_IN_TEXT_G = new RegExp(URL_IN_TEXT.source, 'gi')

/**
 * Produktsidan för kandidaten, var på raden modellen än råkade lägga den.
 *
 * Sista fältet är platsen formatet ber om, men modellen citerar lika gärna källan inuti detaljen
 * ("… hög rygg (källa: https://…)") — den blir tillsagd i HONESTY_RULE att göra just det efter varje
 * faktauppgift. Läser man bara fältet blir `sourceUrl` i praktiken alltid null, och då står
 * bildhämtningen ensam på den grundade sökningens 4-6 träffar, som sällan täcker alla kandidaterna.
 * Det var därför en kandidat fick bild och nästa inte, olika varje körning.
 */
function extractSourceUrl(parts: string[]): string | null {
  for (const raw of [parts[6], ...parts]) {
    const hit = (raw || '').match(URL_IN_TEXT)?.[0]
    if (!hit) continue
    // Adressen står ofta sist i en mening eller inuti en parentes.
    const url = hit.replace(/[.,;:)\]]+$/, '')
    if (url.length <= 300) return url
  }
  return null
}

/**
 * Detaljen, utan källhänvisningen.
 *
 * URL:en tas bort INNAN längdkapningen. Annars åt en citerad adress upp de 120 tecknen och säljaren
 * fick läsa en avhuggen länk i stället för det som skiljer modellerna åt.
 */
function cleanDetail(raw: string | undefined): string | null {
  const stripped = (raw || '')
    .replace(/\(\s*källa:?[^)]*\)?/gi, ' ')
    .replace(URL_IN_TEXT_G, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s|,;:–-]+$/, '')
    .trim()
  return cleanField(stripped, 120)
}

/**
 * Namnet, i den form två körningar går att jämföra i: gemener, och allt som inte är bokstav eller
 * siffra blir mellanslag. "SÖDERHAMN 3-sits" och "Söderhamn 3 sits" är samma förslag.
 */
const key = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Samma förslag, eller det ena en precisering av det andra?
 *
 * Prefixregeln finns för att modellen sällan skriver namnet likadant två gånger: den som avfärdades
 * som "SÖDERHAMN" kommer tillbaka som "SÖDERHAMN 3-sits" i nästa körning, och det är fortfarande
 * samma möbel säljaren just sagt nej till. Två VERKLIGT olika produkter i samma familj —
 * "Söderhamn 3-sits" mot "Söderhamn 4-sits" — delar däremot inget prefix och överlever.
 */
const samish = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `))

/**
 * Har säljaren redan sett och tackat nej till den här?
 *
 * Jämför både "märke modell" och modellnamnet ensamt: den avfärdade listan kommer in som hela namn
 * ("IKEA SÖDERHAMN"), medan en ny körning gärna stavar märket annorlunda eller utelämnar det.
 */
function alreadyRejected(candidate: SellerProductCandidate, excluded: string[]): boolean {
  const forms = [key(`${candidate.brand} ${candidate.model}`), key(candidate.model)]
  return excluded.some((raw) => {
    const e = key(raw)
    return forms.some((f) => samish(f, e))
  })
}

/**
 * Parses "KANDIDAT: märke | modell | variant | produkttyp | STARK/TROLIG/MÖJLIG | detalj"
 * lines out of the grounded research prose. Tolerant about everything except
 * what matters: a candidate without a model name is dropped, duplicates
 * (same brand+model) are collapsed, and the result is capped at
 * MAX_SELLER_CANDIDATES, best confidence first (stable within a tier, so the
 * model's own ordering is preserved as the tiebreak).
 *
 * `excluded` är de förslag säljaren redan avfärdat. De sållas bort HÄR, i kod, före taket på fyra —
 * prompten blir tillsagd samma sak, men en tillsägelse är modellens bedömning och det här är ett
 * löfte. Att sålla efter taket hade dessutom kunnat ge noll nya förslag ur en körning som lämnade
 * fyra rader varav två var nya.
 */
export function parseCandidates(text: string, fallbackBrand: string, excluded: string[] = []): ParsedCandidates {
  const out: SellerProductCandidate[] = []
  let explicitNone = false
  let sawMarker = false
  if (!text) return { candidates: out, explicitNone, sawMarker }

  const lineRe = /^\s*(?:[-*\d.)\s]*)KANDIDAT:\s*(.+)$/gim
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(text)) !== null) {
    sawMarker = true
    const content = m[1].trim()
    if (/^ingen\b/i.test(content) || /^inga\b/i.test(content) || /^none\b/i.test(content)) {
      explicitNone = true
      continue
    }
    const parts = content.split('|').map((p) => p.trim())
    const brand = cleanField(parts[0], 80) ?? fallbackBrand
    const model = cleanField(parts[1], 80)
    if (!model) continue
    const candidate: SellerProductCandidate = {
      brand,
      model,
      variant: cleanField(parts[2], 80),
      productType: cleanField(parts[3], 60),
      confidence: parseConfidence(parts[4]),
      distinguishingDetail: cleanDetail(parts[5]),
      // Additivt sjunde fält: produktsidan modellen säger sig ha sett. ALDRIG betrodd som sanning —
      // anroparen hämtar den och kontrollerar att sidans titel nämner modellen innan den används.
      sourceUrl: extractSourceUrl(parts),
    }
    if (excluded.length > 0 && alreadyRejected(candidate, excluded)) continue
    const dupKey = `${candidate.brand} ${candidate.model}`.toLowerCase()
    if (out.some((c) => `${c.brand} ${c.model}`.toLowerCase() === dupKey)) continue
    out.push(candidate)
  }

  out.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
  return { candidates: out.slice(0, MAX_SELLER_CANDIDATES), explicitNone, sawMarker }
}

/**
 * The auto-continue rule, in plain code. Auto-select when:
 *  - exactly ONE credible candidate exists (per spec: a single candidate
 *    normally auto-continues — a strong likely match needs no mathematical
 *    certainty when there is no competing candidate), or
 *  - the top candidate is STRONG and every competitor is merely POSSIBLE
 *    (clearly dominant, no meaningful competition).
 *
 * Anything else — 2-4 genuinely plausible products — returns null and the
 * seller chooses. The candidate UI is for REAL ambiguity, not every product.
 */
export function pickAutoCandidate(candidates: SellerProductCandidate[]): SellerProductCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  const [top, ...rest] = candidates
  if (top.confidence === 'strong' && rest.every((c) => c.confidence === 'possible')) return top
  return null
}
