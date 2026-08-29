// Cloudflare Pages Function: POST /api/seller/generate
//
// The consumer seller product's final generation step (loopa.nu/). Split out
// of /api/generate-listing because seller mode is LATENCY-SENSITIVE and must
// not inherit the professional /secondhand research workflow's timeouts.
//
// ─── Why this endpoint exists (measured, not assumed) ────────────────────
//
// The previous seller path reused the professional pipeline: a grounded
// research call, then a structuring call, each with its own sequential
// primary→fallback model chain (60s and 25s per-attempt timeouts). Measured
// locally against a real 5-photo seller submission:
//
//   run A: 129.1s → succeeded
//   run B: 141.4s → HTTP 500, generic error screen
//
// 141.4s lands within 0.1s of that architecture's theoretical worst case
// (90s research budget + 1.5s jitter + 25s + 1.5s + 25s = 141.5s) — every one
// of the four Gemini attempts ran to its full timeout and the seller then got
// "Något gick fel". Both defects are fixed here: the sequential fallback
// chains are gone (see MODEL, below), and this endpoint cannot return a
// generic error for a valid submission (see NEVER FAILS, below).
//
// ─── MODEL: benchmarked, not guessed ─────────────────────────────────────
//
// Grounded (googleSearch) latency, measured per model and image count on the
// same real seller photos via scripts/bench-gemini-matrix*.mjs:
//
//   gemini-3.7-flash      grounded 3 img   >90s   (aborted)
//   gemini-3.7-flash      grounded 5 img  >120s   (aborted)
//   gemini-3.6-flash      grounded 3 img   48.7s
//   gemini-3.6-flash      grounded 2 img   19.4s
//   gemini-3.5-flash-lite grounded 5 img    8.0s  ✓ dims + price + 5 sources
//   gemini-3.5-flash-lite grounded 3 img    6.2s  ✓ dims + price + 3 sources
//   gemini-3.5-flash-lite grounded 2 img    3.6s  ✓ dims + price + 3 sources
//
// Every flash-lite run correctly identified the exact model ("IKEA
// SÖDERHAMN") with real dimensions, a real retail price and real grounding
// chunks — the same identification the 129s pipeline produced. The heavy
// research models cannot meet a 30s ceiling for this task today, so this path
// runs SELLER_MODEL for both calls. The professional pipeline is unchanged:
// generate-listing.ts still runs gemini-3.7-flash → gemini-3.6-flash.
//
// Note also that grounded latency scales steeply with image payload — hence
// RESEARCH_IMAGE_CAP.
//
// ─── Why TWO calls and not one ───────────────────────────────────────────
//
// The Listing Genie single-call shape (one grounded call that returns the
// structured result directly) was implemented and benchmarked first. It does
// not survive contact with this model: asking for JSON output in the same
// request makes Gemini skip googleSearch entirely. Measured, three prompt
// shapes, scripts/bench-grounding-activation.mjs + bench-grounding-hybrid.mjs:
//
//   free-text research prompt        → 2-5 groundingChunks, real search queries
//   JSON-contract prompt             → 0 chunks, 0 search queries
//   research-first, JSON appended    → 0 chunks, 0 queries, all fields null
//
// Worse than slow: with the JSON prompt the model answered from memory and
// invented a different retail price on each run (4095 / 5495 / 6395 kr) while
// still populating `sourceUrl` fields with URLs it had never seen. A pipeline
// whose "research" is fabricated recall with fabricated citations is not
// acceptable, so the research stage stays a separate free-text grounded call.
//
// That second call is NOT what made the old pipeline slow — the sequential
// primary→fallback model chains were (see the 141.5s arithmetic above). At
// SELLER_MODEL speed the two calls together land around 11-13s, inside the
// 15s target, with real citations.
//
// ─── Pipeline ────────────────────────────────────────────────────────────
//
// TWO PHASES across at most two HTTP requests. Identity ambiguity is resolved
// by the SELLER, not by extra AI calls: human disambiguation is cheap, model
// latency is expensive. The endpoint never spends time forcing a choice
// between visually similar models when the seller can simply pick one.
//
// Phase 1 — request WITHOUT `resolution`:
//   t=0    IDENTIFY+RESEARCH — one grounded free-text call. Lists 0-4 REAL
//          candidate products as strict "KANDIDAT:" lines (parsed
//          deterministically in _shared/seller-candidates.ts — never invented
//          to fill slots) and hunts the actual specs (dimensions, material,
//          nypris) for its top candidate, manufacturer product page first.
//          → one dominant candidate: auto-continue to STRUCTURE. No interrupt.
//          → 2-4 plausible candidates, or an explicit "none": return
//            kind:"needs_selection" IMMEDIATELY (no structure call) — the
//            seller chooses, or types a model, or continues without one.
//          → research failed/ungrounded/format-noncompliant: continue to
//            STRUCTURE with what exists. A failure NEVER interrupts the seller.
//
// Phase 2 — request WITH `resolution` (seller_selected | manual | unknown):
//   t=0    SPEC RESEARCH — grounded call laser-focused on the resolved model.
//          Identification is OVER; the only job is extracting real specs from
//          the best source. `unknown` instead runs a category-level secondhand
//          price search and never forces a model name.
//   t≈6s   STRUCTURE — the seller-resolved identity is treated as truth (the
//          same rule as the typed brand), enforced deterministically in
//          normalizeIdentity, not just requested in the prompt.
//
//   fail   ONE bounded retry with fewer images, only if the deadline allows.
//          Then a deterministic EMERGENCY result built from session data.
//
// ─── NEVER FAILS ─────────────────────────────────────────────────────────
//
// Once a submission is VALID (brand + 1-10 images), this endpoint always
// answers HTTP 200 / ok:true with the best result it can assemble. Grounded
// search timing out, Gemini being degraded, specs being unfindable, the exact
// model being unprovable — none of those are errors, they are degradation
// levels (status full → partial → fallback) plus an explicit missingFields
// list. HTTP 4xx/5xx is reserved for invalid requests and unconfigured keys.
//
// Nothing is ever invented to fill a gap: an unverifiable dimension becomes a
// missingField, never a plausible-looking number.
//
// SELLER MODE GENERATES NO SEO. No metaTitle/metaDescription/JSON-LD is asked
// of any model here; the `seo` fields required by the shared result type are
// derived deterministically from the listing text at zero token cost, and
// jsonLd is always null.

import {
  LISTING_RESPONSE_SCHEMA_SELLER,
  type ConditionAssessment,
  type GeneratedListingResult,
  type PricingAssessment,
  type PricingBasis,
  type ProductAttribute,
  type ProductIdentity,
  type SellerMissingField,
  type SellerResultStatus,
  type SourceRef,
  type UploadedImage,
} from '../../../src/features/generator/schema'
import type { SellerResolution } from '../../../src/features/seller/types'
import { callGeminiModel, extractText, type GeminiEnv } from '../_shared/gemini'
import {
  extractSources,
  isPlausibleRetailPriceSek,
  isSecondhandMarketplaceUrl,
  numOrNull,
  parseJsonLoose,
  slugify,
} from '../_shared/listing-guards'
import { parseCandidates, pickAutoCandidate } from '../_shared/seller-candidates'

/**
 * Identity the downstream stages treat as SETTLED. Once this exists, no stage
 * spends effort on re-identification — research targets exactly this product
 * and structuring applies its sourced specs. `source` records how it was
 * settled: seller_selected/manual outrank everything (seller truth, same rule
 * as the typed brand); auto is the phase-1 dominant candidate.
 */
interface ResolvedProduct {
  model: string
  variant: string | null
  productType: string | null
  source: 'auto' | 'seller_selected' | 'manual'
}

type Env = GeminiEnv

// ─── Latency budget ──────────────────────────────────────────────────────
//
// ONE overall deadline governs the request; every Gemini attempt is bounded by
// its own budget AND by the overall AbortController, so nothing in flight can
// outlive the deadline. Worst case by construction: 9 + 10 + 5 = 24s, hard
// stopped at 26s. No seller code path can intentionally reach 30s.

/** Hard orchestration ceiling. Everything in flight is aborted and the best available result is returned. Deliberately below the 30s product limit. */
/**
 * Budgetarna är env-styrbara sedan Loopa Condition började anropa den här handlern.
 *
 * Standardvärdena är oförändrade och gäller loopa.nu, där research ÄR kritiska vägen och säljaren
 * väntar på den. I Loopa Condition kör identifieringen parallellt med skickbedömningen, som ändå tar
 * 20-40 s — där kostar en större researchbudget ingenting alls på kritiska vägen.
 *
 * Varför det spelar roll: 9 s mot en uppmätt latens på 6,2 s för tre bilder är knappt någon marginal,
 * och när sökningen faller finns INGA kandidater att erbjuda — de läses enbart ur grundad text. En
 * timeout här är alltså skillnaden mellan fyra modellförslag och "vi kunde inte peka ut någon modell".
 */
const envInt = (name: string, fallback: number) => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const OVERALL_DEADLINE_MS = envInt('SELLER_OVERALL_DEADLINE_MS', 26_000)
/** Grounded research. Measured 3.6-8.0s at this image cap; best-effort, never fatal. */
const RESEARCH_BUDGET_MS = envInt('SELLER_RESEARCH_BUDGET_MS', 9_000)
/** One retry, and ONLY when the first attempt came back ungrounded (fast and cheap) rather than failing. */
const RESEARCH_RETRY_BUDGET_MS = envInt('SELLER_RESEARCH_RETRY_BUDGET_MS', 7_000)
/** Structuring. Measured ~2.9-3.2s. This call IS the listing, so it gets a generous ceiling. */
const STRUCTURE_BUDGET_MS = 10_000
/** Realistic time to keep in reserve for structuring when deciding whether a research retry still fits — measured latency plus headroom, not the full ceiling. */
const STRUCTURE_RESERVE_MS = 8_000
/** One shorter retry with fewer images, only when the deadline allows — the difference between a real listing and an emergency template. */
const STRUCTURE_RETRY_BUDGET_MS = 5_000

/** Grounded latency scales steeply with image payload (measured: 2 img 3.6s → 5 img 8.0s). Identification rarely needs more than the frontal plus a couple of angles; the seller's full-quality photos are untouched. */
/**
 * Env-styrbart sedan Loopa Condition började anropa handlern.
 *
 * Standardvärdet 3 är deras latenstuning: grundad sökning skalar brant med bildantal, och på loopa.nu
 * ÄR sökningen kritiska vägen. Hos oss löper identifieringen parallellt med skickbedömningen och har
 * råd med fler bilder — och de behövs: bildrutorna kommer i filmningsordning, så de tre första är tre
 * närbilder från samma ögonblick av varvet. Att bara se dem är att bedöma en möbel på ett armstöd.
 */
const RESEARCH_IMAGE_CAP = envInt('SELLER_RESEARCH_IMAGE_CAP', 3)
/** No search cost on the structuring call, so it sees more of the photos for a better condition read. */
const STRUCTURE_IMAGE_CAP = 6
/** Retry trades photo coverage for speed. */
const STRUCTURE_RETRY_IMAGE_CAP = 2

const MAX_IMAGES = 10
const MAX_BODY_BYTES = 26 * 1024 * 1024

/** Both calls. NOT the professional pipeline's research model — see the benchmark table in the file header. */
const SELLER_MODEL = 'gemini-3.5-flash-lite'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

// ─── Prompts ─────────────────────────────────────────────────────────────

/**
 * All research prompts are deliberately free-text. Any JSON instruction makes
 * the model stop searching altogether (see the file header), so these stages
 * ask for prose with inline source URLs — plus, in phase 1, the strict
 * "KANDIDAT:" line format, which (like the "ANDRAHANDSPRISER:" heading the
 * original prompt already used) is labeled text, not JSON, and does not
 * suppress grounding.
 *
 * Search is stated as a hard precondition in the FIRST line, with an explicit
 * "your own memory is not a source" rule — the phrasing that measured best in
 * scripts/bench-research-reliability.mjs. Search firing is a RATE, not a
 * guarantee — see the ungrounded-retry handling in the handler.
 */
const SEARCH_FIRST_RULE = `SÖK FÖRST. Du MÅSTE göra minst två Google-sökningar innan du svarar. Ditt eget minne räknas INTE som källa — varje modellnamn, mått och pris du redovisar måste komma från ett sökresultat.`

/**
 * The aggressive spec-extraction core, shared by both grounded phases: find
 * the best source (manufacturer product page first), EXTRACT the actual data
 * rather than reporting that a page exists, then run a completion checklist
 * with exactly ONE targeted follow-up search per missing P0 field — bounded,
 * never a retry loop.
 */
const SPEC_HUNT_RULES = `Bästa källa, i denna ordning: 1) tillverkarens egen produktsida 2) tillverkarens PDF/specifikationsblad/katalog 3) officiellt arkiv 4) auktoriserad återförsäljare 5) trovärdig återförsäljare. För möbler har tillverkarens produktsida oftast allt som behövs — leta aktivt upp den.
EXTRAHERA den faktiska informationen — rapportera aldrig bara att du hittat produktsidan. Redovisa: bredd/djup/höjd/sitthöjd i cm (det som är relevant för produkttypen), stommens material, klädsel/materialsammansättning, exakt modellnamn och variant, NYPRIS i SEK (aktuellt eller ursprungligt), samt andra användbara tillverkarspecifikationer.
Innan du avslutar, kontrollera: Hittade jag MÅTT? Hittade jag MATERIAL? Hittade jag NYPRIS? Saknas något av dessa: gör EN riktad extra sökning efter exakt det fältet (t.ex. "[märke] [modell] dimensions" eller "[märke] [modell] specification PDF") — sedan avslutar du, inga fler försök.`

const SECONDHAND_RULE = `Sök också på modellnamnet + "begagnad"/"blocket"/"tradera" och redovisa faktiska BEGAGNATPRISER i Sverige i ett eget avsnitt med rubriken "ANDRAHANDSPRISER:". Dessa källor gäller ENDAST andrahandsvärde — använd dem aldrig som belägg för nypris.`

const HONESTY_RULE = `Svara kort på svenska i löptext. Ange källans URL direkt efter varje faktauppgift, t.ex. "(källa: https://…)". Skriv endast URL:er du faktiskt sett i sökresultaten. Hitta ALDRIG på modellnamn, mått eller priser — skriv hellre "kunde inte bekräftas"; ofullständig research är INTE ett fel.`

/**
 * Phase 1: candidate identification + spec research in ONE grounded call.
 * Explicitly told NOT to burn time separating look-alike models — plausible
 * alternatives are listed as candidates and the seller resolves them. Spec
 * extraction for the top candidate is framed as the main job so the dominant-
 * candidate case gets its specs from this same call, with no extra latency.
 */
function buildIdentifyResearchPrompt(brand: string, sellerNote: string): string {
  return `${SEARCH_FIRST_RULE}

Säljaren är en privatperson som säljer en begagnad produkt. Bilderna är säljarens egna.
- Varumärke: "${brand}"
${sellerNote ? `- Säljaren berättar: "${sellerNote}"` : '- (inget mer angivet)'}

Ingen kategori och ingen modell är angiven. Avgör själv från bilderna vad det är för produkt.

DEL 1 — KANDIDATER (snabbt):
Avgör vilka VERKLIGA produkter/modeller från varumärket bilderna troligen visar. Sök på varumärket + det du ser i bilderna. Fastna ALDRIG i att välja mellan snarlika modeller — är flera rimliga listar du dem och går vidare; säljaren väljer sedan själv.
Skriv varje kandidat EXAKT så här, en per rad (sikta på 3-4, max 4):
KANDIDAT: märke | modellnamn | variant eller - | produkttyp | STARK eller TROLIG eller MÖJLIG | kort synlig detalj som skiljer den från de andra | produktsidans URL
Lämna ALLTID exakt 4 kandidater, ordnade efter hur väl de stämmer med bilderna — starkast först.
De platser som blir över när färre än fyra verkligen stämmer fyller du med varumärkets modeller i samma produktkategori som LIKNAR den på bilderna mest, märkta MÖJLIG. Säljaren ser sin egen möbel och avfärdar en felaktig kandidat på en sekund, men kan aldrig välja en modell du inte visade.
Sista fältet är URL:en till den produktsida där du såg JUST den modellen — en enda adress, ordagrant ur sökresultatet, ingen text runt den. Har du ingen sida för modellen skriver du -. Lägg ALDRIG källan i detaljfältet i stället; detaljfältet är bara den synliga skillnaden.
Regler: endast verkliga modellnamn du sett i sökresultaten eller säkert vet finns i varumärkets sortiment — hitta ALDRIG på ett modellnamn, och ta aldrig med en modell ur en annan produktkategori bara för att fylla en plats. Hittar du inte fyra verkliga modeller lämnar du färre. Finns ingen trovärdig kandidat alls, skriv exakt: KANDIDAT: INGEN

DEL 2 — SPECIFIKATIONER (viktigast):
Ditt huvudjobb är att hitta produktens VERKLIGA specifikationer online — identifieringen är bara porten dit. Utgå från din främsta kandidat och sök t.ex. "[märke] [modell] mått", "[märke] [modell] material", "[märke] [modell] pris".
${SPEC_HUNT_RULES}

${SECONDHAND_RULE}

Använd bilderna för att verifiera att träffarna faktiskt ser ut som produkten (form, variant, färg, underrede).

${HONESTY_RULE}`
}

/**
 * Phase 2 with a settled identity: identification is OVER, the ONLY job is
 * spec extraction for exactly this product. When the seller selected or typed
 * the model, that is said outright so the model does not spend grounded
 * latency doubting a human decision.
 */
function buildSpecResearchPrompt(brand: string, sellerNote: string, resolved: ResolvedProduct): string {
  const confirmedLine =
    resolved.source === 'seller_selected'
      ? 'SÄLJAREN HAR SJÄLV BEKRÄFTAT MODELLEN i ett urvalssteg — identiteten är avgjord.'
      : resolved.source === 'manual'
        ? 'SÄLJAREN HAR SJÄLV UPPGETT MODELLEN — säljarens egen uppgift är sanning.'
        : 'Modellen är identifierad med hög sannolikhet.'
  const facts = [
    `- Varumärke: "${brand}"`,
    `- Modell: "${resolved.model}"`,
    resolved.variant ? `- Variant: "${resolved.variant}"` : null,
    resolved.productType ? `- Produkttyp: ${resolved.productType}` : null,
    sellerNote ? `- Säljaren berättar: "${sellerNote}"` : null,
  ].filter(Boolean)
  return `${SEARCH_FIRST_RULE}

Produkten är REDAN identifierad. ${confirmedLine} Lägg INGEN tid på att om-identifiera produkten.
${facts.join('\n')}

DITT ENDA JOBB är att hitta denna produkts VERKLIGA specifikationer online.
Sök t.ex.: "${brand} ${resolved.model}", "${brand} ${resolved.model} mått", "${brand} ${resolved.model} dimensions", "${brand} ${resolved.model} material", "${brand} ${resolved.model} pris".
${SPEC_HUNT_RULES}

${SECONDHAND_RULE}

Jämför till sist mot bilderna: om bilderna UPPENBART visar en helt annan produkt än modellen ovan, skriv "VARNING: bilderna motsäger modellen" och förklara kort varför. Annars utgår du från att modellen stämmer.

${HONESTY_RULE}`
}

/**
 * Phase 2 without a model (seller chose "Ingen av dessa" and doesn't know):
 * vintage/obscure/custom products. Never forces a model name — the useful,
 * findable facts here are category-level secondhand price levels, which keep
 * pricing defensible even when every model-specific spec stays missing.
 */
function buildUnknownResearchPrompt(brand: string, sellerNote: string, productHint: string | null): string {
  return `${SEARCH_FIRST_RULE}

Produktens exakta modell är OKÄND och säljaren vet den inte. Försök INTE tvinga fram ett exakt modellnamn — det är inte uppgiften.
- Varumärke: "${brand}"
${productHint ? `- Produkttyp (ungefärlig): ${productHint}` : ''}
${sellerNote ? `- Säljaren berättar: "${sellerNote}"` : '- (inget mer angivet)'}

Ditt jobb:
1. Sök på varumärket + produkttypen + "begagnad"/"blocket"/"tradera" och redovisa faktiska PRISNIVÅER för liknande begagnade produkter i Sverige i ett eget avsnitt med rubriken "ANDRAHANDSPRISER:".
2. Redovisa endast fakta som stöds av källor OCH säkert gäller just produkten på bilderna (t.ex. varumärkets typiska material). Modellspecifika mått eller nypris får ALDRIG lånas från en gissad modell.

${HONESTY_RULE}`
}

/**
 * The identity block injected into the structuring prompt when the identity
 * was resolved (auto candidate, seller selection, manual entry) or is
 * explicitly unknown. This is where IDENTITY CONFIDENCE is separated from
 * FIELD EVIDENCE: a seller-confirmed model plus a sourced spec is strong
 * support — "identity not mathematically verified, therefore drop all specs"
 * is exactly the behavior this block removes.
 */
function buildResolvedBlock(resolved: ResolvedProduct | null, explicitUnknown: boolean): string {
  if (resolved) {
    const label = [resolved.model, resolved.variant].filter(Boolean).join(', ')
    if (resolved.source === 'seller_selected' || resolved.source === 'manual') {
      const how = resolved.source === 'seller_selected' ? 'själv VALT modellen i ett urvalssteg' : 'själv UPPGETT modellen'
      return `PRODUKTIDENTITET — BEKRÄFTAD AV SÄLJAREN (säljaren har ${how}): "${label}".
Detta är stark evidens, samma regel som varumärket: ifrågasätt INTE identiteten. Sätt identity.exactProduct till "${resolved.model}" och identity.confidence till "high". Specifikationer i researchen som gäller denna modell (mått, material, nypris) är därmed starkt underbyggda — använd dem som attribut. ENDAST om bilderna UPPENBART visar en helt annan produkt: sätt identity.uncertain=true med en kort uncertaintyNote och använd inte modellens specifikationer.

`
    }
    return `PRODUKTIDENTITET — TROLIGASTE PRODUKT (auto-identifierad, ingen meningsfull konkurrerande kandidat): "${label}".
Om research och bilder stödjer den utan tydlig motsägelse: sätt identity.exactProduct till "${resolved.model}" (confidence "high" när researchen tydligt bekräftar den, annars "medium") och använd researchens specifikationer för modellen som attribut. Vid tydlig motsägelse: sätt identity.uncertain=true och lämna modellspecifika fält null.

`
  }
  if (explicitUnknown) {
    return `PRODUKTIDENTITET — OKÄND MODELL: säljaren vet inte modellen och ingen kunde fastställas. Detta är INTE ett fel och får INTE ge en sämre annons än nödvändigt: skapa en stark, säljande annons utifrån bilderna, varumärket och produkttypen — beskriv det som faktiskt syns (typ, färg, material där det rimligen kan avgöras, skick). Sätt identity.exactProduct=null. Hitta ALDRIG på modellnamn, mått eller nypris.

`
  }
  return ''
}

/**
 * Structuring — no tools, so a strict responseSchema works here. Turns the
 * research prose plus the seller's photos into the final result. Condition is
 * judged ONLY from the photos, never from research text.
 */
function buildStructurePrompt(brand: string, sellerNote: string, research: string, resolvedBlock: string): string {
  return `Du hjälper en privatperson skapa en säljannons via Loopa.

SÄLJARENS UPPGIFTER (sanning — får aldrig ersättas av svagare AI-gissningar):
- Varumärke: "${brand}"
${sellerNote ? `- Säljaren berättar: "${sellerNote}"` : '- (inget mer angivet)'}

${resolvedBlock}RESEARCH FRÅN WEBBKÄLLOR — använd ENDAST detta som underlag för modellnamn, mått, material och nypris. Hitta aldrig på uppgifter som inte står här. Använd ALDRIG en begagnat-/auktionssajt (Tradera, Blocket, Sellpy, Vinted, eBay) som belägg för nypris:
"""
${research || '(ingen research kunde hämtas — basera allt på bilderna och säljarens uppgifter, och lämna researchade fält null. Gissa ALDRIG mått, material, modellnamn eller nypris.)'}
"""

SÄLJARENS EGNA BILDER är bifogade. Använd ENDAST bilderna — aldrig research-texten — för att bedöma SKICK: repor, fläckar, nagg, slitage, missfärgning, skador. Sätt condition.uncertain=true om bilderna inte räcker för en säker bedömning, och påstå aldrig en defekt du inte kan se.

identity (om inget annat anges under PRODUKTIDENTITET ovan): sätt confidence "high" endast om både bilder och research tydligt pekar på en specifik produkt, "medium" om produkttypen är säker men exakt modell är en rimlig men inte helt säker läsning, "low" om ingen specifik produkt kan bekräftas. Sätt exactProduct till null hellre än att gissa en modell. Sätt uncertain=true med en kort, konkret uncertaintyNote när identiteten är osäker.

attributes: fyll med de specifikationer som FAKTISKT stöds av researchen eller är direkt synliga på bilderna — anpassa efter produkttypen (möbel: mått/material; plagg: storlek/material; elektronik: modellnummer/lagring). Varje attribut har en kort "key", en läsbar svensk "label" och ett "value". Sätt "sourceUrl" ENDAST till en URL som ordagrant står i researchen ovan, annars null. Hoppa över ett attribut helt hellre än att gissa dess värde.

pricing.suggestedPriceSek: du MÅSTE föreslå ett pris så snart du kan avgöra vad för slags produkt det är. Ett prisförslag är det viktigaste säljaren får av oss — en annons utan pris är nästan värdelös. Utgå i denna ordning:
1. researchens "ANDRAHANDSPRISER:" (faktiskt observerade begagnatpriser)
2. nypris justerat för skicket
3. en uppskattning utifrån märke, produkttyp och synligt skick — detta är ALLTID bättre än inget pris. Skriv då i rationale att det är en uppskattning utan prisunderlag.
Sätt alltid priceRangeMinSek/priceRangeMaxSek och en kort rationale. Sätt available=false och lämna prisfälten null ENDAST om du inte ens kan avgöra vad för slags produkt bilderna visar.

listing: en tydlig, säljande men ärlig svensk annons i en vanlig konsuments ton — inte webshop-copy. Titel och beskrivning MÅSTE alltid fyllas i, även när nästan inget kunde fastställas: beskriv då det som faktiskt syns och hänvisa till bilderna.

missingNotes: kort lista över vad som är osäkert eller saknas.`
}

// ─── Call bodies ─────────────────────────────────────────────────────────

/** Images first, prompt last — the ordering verified in the Listing Genie reference for grounded-with-images calls. */
function buildResearchBody(prompt: string, images: UploadedImage[]) {
  return {
    contents: [
      {
        role: 'user',
        parts: [...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } })), { text: prompt }],
      },
    ],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
  }
}

function buildStructureBody(prompt: string, images: UploadedImage[]) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } }))],
      },
    ],
    generationConfig: {
      // Low variance for identification, enough room for readable listing prose.
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: LISTING_RESPONSE_SCHEMA_SELLER,
    },
  }
}

// ─── Normalization ───────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function normalizeIdentity(parsed: any, brand: string, resolved: ResolvedProduct | null): ProductIdentity {
  const confidence = parsed?.identity?.confidence
  const identity: ProductIdentity = {
    // The seller typed the brand — it is truth and outranks a weaker model guess.
    brand: str(parsed?.identity?.brand) ?? brand,
    exactProduct: str(parsed?.identity?.exactProduct),
    variant: str(parsed?.identity?.variant),
    category: str(parsed?.identity?.category),
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'low',
    uncertain: !!parsed?.identity?.uncertain,
    uncertaintyNote: str(parsed?.identity?.uncertaintyNote),
  }
  // A seller-resolved model is truth, same rule as the brand — enforced here
  // deterministically, not just requested in the prompt, so a conservatively
  // tuned model can no longer throw away an identity the human already
  // confirmed. The model keeps ONE veto: an explicit uncertain flag for an
  // obvious photo contradiction survives (and keeps its own confidence), but
  // it never erases the seller's statement of what the product is.
  if (resolved && (resolved.source === 'seller_selected' || resolved.source === 'manual')) {
    return {
      ...identity,
      exactProduct: identity.exactProduct ?? resolved.model,
      variant: identity.variant ?? resolved.variant,
      confidence: identity.uncertain ? identity.confidence : 'high',
    }
  }
  // Auto-selected dominant candidate: fill the model in only when structuring
  // agreed enough not to flag uncertainty yet still left the field empty.
  if (resolved && resolved.source === 'auto' && !identity.exactProduct && !identity.uncertain) {
    return { ...identity, exactProduct: resolved.model, variant: identity.variant ?? resolved.variant }
  }
  return identity
}

/**
 * `sourceUrl` is only kept when the research text actually contains that URL.
 * Measured necessity, not paranoia: with no research to draw on, the model was
 * observed populating sourceUrl with plausible URLs it had never seen.
 */
function normalizeAttributes(parsed: any, researchText: string): ProductAttribute[] {
  if (!Array.isArray(parsed?.attributes)) return []
  return parsed.attributes
    .filter((a: any) => a && typeof a.key === 'string' && typeof a.label === 'string' && typeof a.value === 'string' && a.value.trim() !== '')
    .map((a: any) => {
      const url = typeof a.sourceUrl === 'string' ? a.sourceUrl.trim() : ''
      const cited = /^https?:\/\/\S+$/i.test(url) && researchText.includes(url)
      return { key: a.key, label: a.label, value: a.value.trim(), sourceUrl: cited ? url : null }
    })
}

function normalizeCondition(parsed: any): ConditionAssessment {
  return {
    grade: str(parsed?.condition?.grade),
    label: str(parsed?.condition?.label),
    defects: Array.isArray(parsed?.condition?.defects) ? parsed.condition.defects.filter((d: unknown) => typeof d === 'string' && d.trim()) : [],
    reasoning: typeof parsed?.condition?.reasoning === 'string' ? parsed.condition.reasoning : '',
    uncertain: !!parsed?.condition?.uncertain,
    uncertaintyNote: str(parsed?.condition?.uncertaintyNote),
  }
}

/**
 * Pricing normalization plus the deterministic price guardrails. `basis` is
 * derived server-side, never taken from the model: a run with no research must
 * not be able to label its own guess "comparables".
 */
function normalizePricing(parsed: any, sources: SourceRef[], researchOk: boolean, researchText: string, guardNotes: string[]): PricingAssessment {
  let retailPriceSek = numOrNull(parsed?.pricing?.retailPriceSek)
  let suggestedPriceSek = numOrNull(parsed?.pricing?.suggestedPriceSek)

  if (!isPlausibleRetailPriceSek(retailPriceSek)) {
    guardNotes.push('Ett orimligt nypris upptäcktes och ignorerades.')
    retailPriceSek = null
  }
  if (!isPlausibleRetailPriceSek(suggestedPriceSek)) {
    guardNotes.push('Ett orimligt prisförslag upptäcktes och ignorerades.')
    suggestedPriceSek = null
  }
  // Without research there is nothing that could have established a retail
  // price — a number here would be recall, not evidence.
  if (retailPriceSek !== null && !researchOk) {
    guardNotes.push('Nypris kunde inte bekräftas mot en källa och ignorerades.')
    retailPriceSek = null
  }
  // A marketplace listing is evidence of RESALE value, never of nypris.
  if (retailPriceSek !== null && sources.length > 0 && sources.every((s) => isSecondhandMarketplaceUrl(s.url, s.title))) {
    guardNotes.push('Nypris kunde inte bekräftas från en tillförlitlig källa och ignorerades.')
    retailPriceSek = null
  }

  const hasPrice = suggestedPriceSek !== null
  let basis: PricingBasis
  if (!hasPrice) {
    basis = 'none'
  } else if (researchOk && /ANDRAHANDSPRISER/i.test(researchText) && sources.length > 0) {
    basis = 'comparables'
  } else if (retailPriceSek !== null) {
    basis = 'retail'
  } else {
    basis = 'estimate'
  }

  return {
    available: hasPrice,
    retailPriceSek,
    suggestedPriceSek,
    priceRangeMinSek: numOrNull(parsed?.pricing?.priceRangeMinSek),
    priceRangeMaxSek: numOrNull(parsed?.pricing?.priceRangeMaxSek),
    rationale: str(parsed?.pricing?.rationale),
    basis,
  }
}

// ─── Missing-field derivation ────────────────────────────────────────────

const DIMENSION_HINT = /(mått|bredd|djup|höjd|längd|diameter|dimension|width|depth|height|storlek|size)/i
const MATERIAL_HINT = /(material|tyg|klädsel|träslag|läder|metall|fabric|ytbehandling)/i

function hasAttributeMatching(attributes: ProductAttribute[], re: RegExp): boolean {
  return attributes.some((a) => re.test(a.key) || re.test(a.label))
}

/**
 * Derived in plain code from the assembled result, NOT from the model's own
 * account of what it was missing — a model that hallucinated a dimension would
 * also happily leave it off its own missing list. This just looks at what is
 * actually present.
 */
function deriveMissingFields(
  identity: ProductIdentity,
  attributes: ProductAttribute[],
  pricing: PricingAssessment,
  condition: ConditionAssessment,
): SellerMissingField[] {
  const missing: SellerMissingField[] = []
  if (!hasAttributeMatching(attributes, DIMENSION_HINT)) missing.push('dimensions')
  if (!hasAttributeMatching(attributes, MATERIAL_HINT)) missing.push('material')
  if (pricing.retailPriceSek === null) missing.push('newPrice')
  if (!identity.exactProduct) missing.push('model')
  if (!identity.variant) missing.push('variant')
  if (!pricing.available || pricing.suggestedPriceSek === null) missing.push('price')
  if (!condition.label && !condition.grade) missing.push('condition')
  return missing
}

/** `variant` and `condition` are excluded on purpose: plenty of products legitimately have no variant, and condition always has truthful fallback wording — neither should downgrade an otherwise complete result. */
const STATUS_CRITICAL_FIELDS: SellerMissingField[] = ['dimensions', 'material', 'newPrice', 'model', 'price']

function deriveStatus(researchOk: boolean, missingFields: SellerMissingField[]): SellerResultStatus {
  if (!researchOk) return 'fallback'
  return missingFields.some((f) => STATUS_CRITICAL_FIELDS.includes(f)) ? 'partial' : 'full'
}

// ─── Emergency result ────────────────────────────────────────────────────

/**
 * Last resort: the structuring call failed every allowed attempt. Built
 * deterministically from what the SellerSession already knows — the typed
 * brand, the seller's own note, an optional ShotPlan product hint. No model is
 * consulted and nothing is invented; the wording stays truthful about knowing
 * only what the photos show. The seller still reaches a usable RESULT screen.
 */
function buildEmergencyResult(
  brand: string,
  sellerNote: string,
  productHint: string | null,
  resolvedModel: string | null,
  warnings: string[],
): GeneratedListingResult {
  const title = [brand, resolvedModel ?? productHint].filter(Boolean).join(' ') || brand
  const description = [
    `${title} säljes i begagnat skick.`,
    sellerNote ? `Säljaren uppger: ${sellerNote}.` : '',
    'Se bilderna för skick och detaljer.',
  ]
    .filter(Boolean)
    .join(' ')

  const listing = { title, description, conditionText: 'Begagnat skick. Se bilder för detaljer.' }

  return {
    mode: 'seller',
    identity: {
      brand,
      // A seller-resolved model survives even the emergency path — the seller
      // told us what it is; only the AI enrichment around it failed.
      exactProduct: resolvedModel,
      variant: null,
      category: productHint,
      confidence: resolvedModel ? 'medium' : 'low',
      uncertain: true,
      uncertaintyNote: 'Produkten kunde inte verifieras automatiskt just nu.',
    },
    attributes: [],
    condition: {
      grade: null,
      label: 'Begagnat skick',
      defects: [],
      reasoning: 'Skicket har inte kunnat bedömas automatiskt. Se bilderna.',
      uncertain: true,
      uncertaintyNote: null,
    },
    pricing: {
      available: false,
      retailPriceSek: null,
      suggestedPriceSek: null,
      priceRangeMinSek: null,
      priceRangeMaxSek: null,
      rationale: null,
      basis: 'none',
    },
    listing,
    seo: { metaTitle: listing.title, metaDescription: listing.description.slice(0, 155), imageAlt: listing.title },
    sources: [],
    missingNotes: [],
    status: 'fallback',
    missingFields: ['dimensions', 'material', 'newPrice', ...(resolvedModel ? [] : (['model'] as SellerMissingField[])), 'variant', 'price'],
    warnings,
    researchUnavailable: true,
    slug: slugify(title),
    jsonLd: null,
    websiteAdaptation: null,
  }
}

// ─── Assembly ────────────────────────────────────────────────────────────

function assembleResult(
  parsed: any,
  research: { text: string; sources: SourceRef[]; ok: boolean },
  brand: string,
  sellerNote: string,
  productHint: string | null,
  resolved: ResolvedProduct | null,
  warnings: string[],
): GeneratedListingResult {
  const guardNotes: string[] = []
  const identity = normalizeIdentity(parsed, brand, resolved)
  const attributes = normalizeAttributes(parsed, research.text)
  let condition = normalizeCondition(parsed)
  const pricing = normalizePricing(parsed, research.sources, research.ok, research.text, guardNotes)

  // Condition degrades gracefully rather than failing the listing: truthful
  // minimal wording when the model produced nothing usable. Never claims a
  // defect that wasn't observed.
  if (!condition.label && !condition.grade) {
    condition = { ...condition, label: 'Begagnat skick', reasoning: condition.reasoning || 'Se bilderna för detaljer.', uncertain: true }
  }

  const fallbackTitle = [identity.brand, identity.exactProduct || identity.category || productHint].filter(Boolean).join(' ').trim() || brand
  const listing = {
    title: str(parsed?.listing?.title) ?? fallbackTitle,
    description:
      str(parsed?.listing?.description) ??
      [`${fallbackTitle} säljes i begagnat skick.`, sellerNote ? `Säljaren uppger: ${sellerNote}.` : '', 'Se bilderna för skick och detaljer.']
        .filter(Boolean)
        .join(' '),
    conditionText: str(parsed?.listing?.conditionText) ?? 'Begagnat skick. Se bilder för detaljer.',
  }

  const missingFields = deriveMissingFields(identity, attributes, pricing, condition)
  const missingNotes = [
    ...(Array.isArray(parsed?.missingNotes) ? parsed.missingNotes.filter((m: unknown) => typeof m === 'string' && m.trim()) : []),
    ...guardNotes,
  ]

  return {
    mode: 'seller',
    identity,
    attributes,
    condition,
    pricing,
    listing,
    // Derived deterministically at zero token cost — NO SEO is generated by any
    // model in seller mode, and the consumer UI never reads these.
    seo: { metaTitle: listing.title, metaDescription: listing.description.slice(0, 155), imageAlt: listing.title },
    sources: research.sources,
    missingNotes,
    status: deriveStatus(research.ok, missingFields),
    missingFields,
    warnings,
    researchUnavailable: !research.ok,
    slug: slugify(listing.title),
    jsonLd: null,
    websiteAdaptation: null,
  }
}

// ─── Validation ──────────────────────────────────────────────────────────

function validateImages(raw: unknown): UploadedImage[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IMAGES) return null
  const images: UploadedImage[] = []
  for (const img of raw) {
    if (typeof img !== 'object' || img === null) return null
    const r = img as Record<string, unknown>
    if (typeof r.mimeType !== 'string' || !r.mimeType.startsWith('image/')) return null
    if (typeof r.dataBase64 !== 'string' || !r.dataBase64) return null
    images.push({ mimeType: r.mimeType, dataBase64: r.dataBase64 })
  }
  return images
}

/**
 * Validates the optional resolution field. Returns null when absent (phase 1),
 * 'invalid' for a malformed value (client bug — a 400, never a silent
 * reinterpretation that could loop the seller back into the selection screen),
 * and a normalized SellerResolution otherwise. A `manual` resolution with an
 * empty model collapses to `unknown` — "I don't know" typed as nothing.
 */
function validateResolution(raw: unknown): SellerResolution | null | 'invalid' {
  if (raw == null) return null
  if (typeof raw !== 'object') return 'invalid'
  const r = raw as Record<string, unknown>
  if (r.kind === 'unknown') return { kind: 'unknown' }
  if (r.kind === 'manual') {
    const model = typeof r.manualModel === 'string' ? r.manualModel.trim().slice(0, 120) : ''
    return model ? { kind: 'manual', manualModel: model } : { kind: 'unknown' }
  }
  if (r.kind === 'seller_selected') {
    const s = typeof r.selected === 'object' && r.selected !== null ? (r.selected as Record<string, unknown>) : null
    const model = s && typeof s.model === 'string' ? s.model.trim().slice(0, 120) : ''
    if (!s || !model) return 'invalid'
    const opt = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
    return {
      kind: 'seller_selected',
      selected: {
        brand: opt(s.brand, 120) ?? '',
        model,
        variant: opt(s.variant, 80),
        productType: opt(s.productType, 60),
        confidence: 'strong',
        distinguishingDetail: null,
      },
    }
  }
  return 'invalid'
}

// ─── Handler ─────────────────────────────────────────────────────────────

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const startedAt = Date.now()
  const { request, env } = context

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: 'Requesten är för stor.' }, 413)

  let body: { brand?: string; sellerNote?: string; productHint?: string; images?: unknown; resolution?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  const images = validateImages(body.images)
  if (!images) return json({ ok: false, error: `images must be an array of 1-${MAX_IMAGES} {mimeType, dataBase64} objects` }, 400)

  const brand = (body.brand || '').trim().slice(0, 120)
  if (!brand) return json({ ok: false, error: 'brand is required' }, 400)
  const sellerNote = (body.sellerNote || '').trim().slice(0, 500)
  const productHint = (body.productHint || '').trim().slice(0, 80) || null

  const resolution = validateResolution(body.resolution)
  if (resolution === 'invalid') return json({ ok: false, error: 'invalid resolution' }, 400)

  if (!env.GEMINI_API_KEY) return json({ ok: false, error: 'AI-tjänsten är inte konfigurerad. Kontakta Loopa.' }, 503)

  // ── From here on the submission is VALID and MUST produce a result. ──
  // Every failure below is caught and degraded, never surfaced as an error.

  const warnings: string[] = []
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(() => deadline.abort(), OVERALL_DEADLINE_MS)

  let researchMs = 0
  let structureMs = 0
  let geminiCalls = 0
  let groundedCalls = 0
  let structureRetried = false
  let researchRetried = false

  const remainingMs = () => OVERALL_DEADLINE_MS - (Date.now() - startedAt)

  // ── Identity resolution state ──
  // Phase 2 (resolution present): settled up front from the seller's choice.
  // Phase 1: may become settled by a dominant candidate after research.
  let resolved: ResolvedProduct | null = null
  const explicitUnknown = resolution?.kind === 'unknown'
  if (resolution?.kind === 'seller_selected') {
    const s = resolution.selected
    resolved = { model: s.model, variant: s.variant, productType: s.productType, source: 'seller_selected' }
  } else if (resolution?.kind === 'manual') {
    resolved = { model: resolution.manualModel, variant: null, productType: productHint, source: 'manual' }
  }
  // A candidate may carry a corrected/canonical brand spelling — research
  // queries use it; the seller's typed brand remains truth in the result.
  const researchBrand = (resolution?.kind === 'seller_selected' && resolution.selected.brand) || brand

  const researchPrompt = resolved
    ? buildSpecResearchPrompt(researchBrand, sellerNote, resolved)
    : explicitUnknown
      ? buildUnknownResearchPrompt(brand, sellerNote, productHint)
      : buildIdentifyResearchPrompt(brand, sellerNote)

  let result: GeneratedListingResult
  try {
    // ── Stage 1: grounded research. BEST EFFORT — never fatal.
    const research = { text: '', sources: [] as SourceRef[], ok: false }
    const researchStart = Date.now()

    const runResearch = async (budgetMs: number): Promise<{ text: string; sources: SourceRef[] } | null> => {
      geminiCalls++
      groundedCalls++
      try {
        const res = await callGeminiModel(
          env,
          SELLER_MODEL,
          buildResearchBody(researchPrompt, images.slice(0, RESEARCH_IMAGE_CAP)),
          budgetMs,
          deadline.signal,
        )
        return { text: extractText(res), sources: extractSources(res) }
      } catch (err) {
        console.error(`[seller/generate] stage=research outcome=failed error=${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        return null
      }
    }

    const applyResearch = (out: { text: string; sources: SourceRef[] } | null): boolean => {
      // Grounding chunks are the only proof a search actually happened — every
      // successful grounded run in benchmarking returned 2-9 of them. Text with
      // ZERO chunks is parametric recall, and recall is exactly what invents
      // dimensions and retail prices. So it is DISCARDED rather than passed to
      // the structuring call: laundering it into source-less "specs" would be
      // worse than having no research at all.
      if (!out) return false
      if (out.text.length > 0 && out.sources.length > 0) {
        research.text = out.text
        research.sources = out.sources
        research.ok = true
        return true
      }
      return false
    }

    const first = await runResearch(RESEARCH_BUDGET_MS)
    if (!applyResearch(first)) {
      if (!first) warnings.push('research_failed')
      else warnings.push('research_ungrounded')

      // Search firing is a RATE, not a guarantee: a real benchmark run came
      // back with text but zero chunks, costing the seller both dimensions and
      // a model name. When the first attempt was merely UNGROUNDED (it returned
      // fast and cheap rather than failing), one bounded retry is worth it —
      // dimensions and price are the core value of the whole flow. A hard
      // FAILURE is not retried: it already burned its budget, and that time
      // belongs to the structuring call, which IS the listing.
      //
      // The guard reserves a REALISTIC structuring time rather than its
      // worst-case ceiling — structuring measures ~2.9-3.2s against a 10s
      // budget, and reserving the full ceiling made a real run skip this retry
      // by 121ms and ship without dimensions or a model name. Overrunning
      // remains impossible: structuring is separately clamped to the time left.
      const canRetry = !!first && remainingMs() > RESEARCH_RETRY_BUDGET_MS + STRUCTURE_RESERVE_MS
      if (canRetry) {
        researchRetried = true
        warnings.push('research_retried')
        applyResearch(await runResearch(RESEARCH_RETRY_BUDGET_MS))
      }
    }
    researchMs = Date.now() - researchStart

    // ── Phase 1 only: candidate decision, in plain code. ──
    // A dominant candidate auto-continues with the specs this same research
    // call already hunted (no extra latency, no interrupt). REAL ambiguity
    // (2-4 plausible products) or an explicit "no credible candidate" returns
    // to the seller IMMEDIATELY — no structure call, so this answer costs one
    // grounded call (~6-9s). Candidates are only ever read from GROUNDED text
    // (applyResearch discards ungrounded output), so an invented, search-free
    // model name cannot become a candidate. Failures never interrupt: a failed
    // or format-noncompliant research run just continues as before.
    if (!resolution && research.ok) {
      const { candidates, explicitNone } = parseCandidates(research.text, brand)
      // SELLER_ALWAYS_ASK: fråga säljaren även när en kandidat dominerar.
      //
      // Standardregeln hoppar över valet när toppkandidaten är STARK och konkurrenterna bara
      // MÖJLIGA — avbryt bara vid verklig tvetydighet. Loopa Condition kör med den avstängd: att
      // presentera EN modell som fastställd är fel när den är gissad, och en säljare som ser fyra
      // förslag och känner igen sin möbel kostar två sekunder. Med flaggan på räcker en kandidat för
      // att fråga; utan den krävs som förut två.
      const alwaysAsk = (env as { SELLER_ALWAYS_ASK?: string }).SELLER_ALWAYS_ASK === '1'
      const auto = alwaysAsk ? null : pickAutoCandidate(candidates)
      if (auto) {
        resolved = { model: auto.model, variant: auto.variant, productType: auto.productType, source: 'auto' }
      } else if (candidates.length >= (alwaysAsk ? 1 : 2) || explicitNone) {
        const totalServerMs = Date.now() - startedAt
        console.log(
          `[seller/generate] phase=identify outcome=needs_selection candidates=${candidates.length} research_ms=${researchMs} research_retry=${researchRetried} gemini_calls=${geminiCalls} total_ms=${totalServerMs}`,
        )
        return json(
          {
            ok: true,
            kind: 'needs_selection',
            candidates,
            // Källorna följer med: anroparen kan slå upp hur varje kandidat SER UT innan säljaren
            // väljer. Rent additivt — inget anrop till, ingen fas ändrad, ingen latens.
            sources: research.sources,
            timings: { researchMs, structureMs: 0, researchRetried, structureRetried: false, geminiCalls, groundedCalls, totalServerMs },
          },
          200,
        )
      }
    }

    // ── Stage 2: structuring. THIS is the listing. Runs regardless of whether
    // research succeeded — the prompt handles empty research explicitly.
    const structureStart = Date.now()
    const resolvedBlock = buildResolvedBlock(resolved, explicitUnknown)
    const runStructure = async (imageCap: number, budgetMs: number): Promise<any | null> => {
      geminiCalls++
      try {
        const res = await callGeminiModel(
          env,
          SELLER_MODEL,
          buildStructureBody(buildStructurePrompt(brand, sellerNote, research.text, resolvedBlock), images.slice(0, imageCap)),
          budgetMs,
          deadline.signal,
        )
        return parseJsonLoose(extractText(res))
      } catch (err) {
        console.error(`[seller/generate] stage=structure outcome=failed error=${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        return null
      }
    }

    let parsed = await runStructure(STRUCTURE_IMAGE_CAP, Math.min(STRUCTURE_BUDGET_MS, Math.max(1_000, remainingMs())))

    // One bounded retry with fewer images — only when the deadline genuinely
    // allows it. Cheaper and faster than the first attempt, and it is the
    // difference between a real listing and an emergency template.
    if (!parsed && remainingMs() > STRUCTURE_RETRY_BUDGET_MS + 1_000) {
      structureRetried = true
      warnings.push('structure_retried')
      parsed = await runStructure(STRUCTURE_RETRY_IMAGE_CAP, STRUCTURE_RETRY_BUDGET_MS)
    }
    structureMs = Date.now() - structureStart

    result = parsed
      ? assembleResult(parsed, research, brand, sellerNote, productHint, resolved, warnings)
      : buildEmergencyResult(brand, sellerNote, productHint, resolved?.model ?? null, [...warnings, 'structure_failed'])
  } catch (err) {
    // Belt and braces: assembly itself must never turn into a 500 for a valid
    // submission. Any unexpected throw still yields a usable seller result.
    console.error('[seller/generate] stage=assemble outcome=failed error=', err)
    result = buildEmergencyResult(brand, sellerNote, productHint, resolved?.model ?? null, [...warnings, 'assembly_failed'])
  } finally {
    clearTimeout(deadlineTimer)
  }

  const totalServerMs = Date.now() - startedAt
  const phase = resolution ? `resolve_${resolution.kind}` : resolved ? 'identify_auto' : 'identify'
  console.log(
    `[seller/generate] phase=${phase} status=${result.status} model=${result.identity.exactProduct ?? '-'} research_ms=${researchMs} structure_ms=${structureMs} research_retry=${researchRetried} structure_retry=${structureRetried} gemini_calls=${geminiCalls} images=${images.length} sources=${result.sources.length} missing=${(result.missingFields ?? []).join('|')} total_ms=${totalServerMs}`,
  )

  // ALWAYS 200 / ok:true for a valid submission — partial success IS success.
  return json(
    { ok: true, kind: 'result', result, timings: { researchMs, structureMs, researchRetried, structureRetried, geminiCalls, groundedCalls, totalServerMs } },
    200,
  )
}

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405)
