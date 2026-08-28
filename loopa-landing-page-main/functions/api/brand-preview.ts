// Cloudflare Pages Function: POST /api/brand-preview
//
// Real, per-brand, per-category product discovery for /brands. Given a
// brand's website URL and a category, this finds AT LEAST 6 distinct real
// products from that same brand, each with a real, product-only-preferring
// image, or it returns { ok: true, result: null } and the frontend shows
// the illustrative fallback instead of claiming a "personalized" success.
//
// ARCHITECTURE (deliberately minimal-subrequest — see incident notes):
// an earlier version of this file made ONE grounded search call PLUS up to
// two "waves" of page fetches PLUS one Gemini vision call per candidate
// product (to pick a person-free image) — up to ~60 Gemini calls and ~30+
// page/image fetches for a single request. That blew through Cloudflare's
// per-invocation subrequest limit ("Too many subrequests") and left several
// fetch() responses un-consumed/un-cancelled (the "stalled HTTP response"
// warning). This version makes ONLY:
//   - 1 Gemini call (2 if the primary model fails over to the fallback)
//   - up to CANDIDATE_FETCH_CAP (10) product-page HTTP fetches, at
//     FETCH_CONCURRENCY (2) concurrent, stopping the instant TARGET_PRODUCTS
//     (6) valid products have been assembled
//   - ZERO per-product/per-image Gemini calls and ZERO image-byte fetches —
//     image selection is fully deterministic (JSON-LD/og: image, generic-
//     asset and lifestyle-shot keyword filtering), no vision call at all.
// That's ~7-12 subrequests total for a successful run, comfortably under
// any Workers subrequest limit.
//
// Pipeline — FOUR independent, CHEAP discovery strategies feed one shared
// candidate pool, because no single strategy covers every ecommerce
// architecture (confirmed live: grounding alone works for some brands,
// sitemaps are required for others, and generic Shopify-style URL guesses
// only work for Shopify-style sites):
//
//   STRATEGY A — grounded Gemini search. ONE grounded Gemini call
//     (googleSearch tool) is instructed to visit several real product pages
//     in the requested category on the brand's own site, and to answer with
//     brand-level fields (name/tone/secondhand naming). Its FREE-TEXT answer
//     is only trusted for those 3 fields — product URLs are NEVER taken from
//     the model's prose, because models routinely GUESS plausible URL slugs
//     from pattern memory instead of citing what they actually found
//     (confirmed live: ~90% of free-text URLs 404'd in testing). Real
//     candidate URLs come only from groundingMetadata.groundingChunks[].
//     web.uri — the model's actual search citations. In practice grounding
//     frequently returns ZERO citations even when it correctly names the
//     brand (confirmed live across multiple real brands) — it is a bonus
//     signal, never the only source of candidates.
//   STRATEGY B — sitemap discovery. robots.txt is checked for a `Sitemap:`
//     directive (falling back to /sitemap.xml) since real sitemap locations
//     vary a lot (confirmed live: one large furniture retailer's sitemap
//     lives at a nonstandard path only discoverable via robots.txt). If the
//     fetched sitemap is a <sitemapindex>, one sub-sitemap is chosen —
//     preferring one whose own URL mentions "product", else the first
//     listed — and fetched. Entries are parsed as XML <loc> or, for sites
//     using plain-text sitemaps, one-URL-per-line. Candidates are then
//     same-domain-filtered, filtered against a small non-product path-
//     keyword denylist (contact/legal/blog/etc, confirmed necessary live:
//     sitemaps mix product and non-product pages together), and narrowed to
//     the single path-depth bucket with the most entries — empirically, on
//     every real sitemap inspected, the product catalog is always the
//     largest same-depth group by a wide margin. This entirely sidesteps
//     needing to guess a site's URL scheme. At most 3 extra HTTP fetches
//     (robots.txt, sitemap/index, chosen sub-sitemap).
//   STRATEGY C — collection/category page harvesting. A handful of
//     deterministic, zero-cost listing-page URL guesses (/collections/all,
//     /shop, etc.) are tried as a last-resort backstop for the (often
//     Shopify) sites where they happen to be real. Whenever ANY candidate
//     page (from any strategy) turns out to be a same-domain listing page
//     rather than a product page, real product-shaped links are harvested
//     straight from its HTML and pushed onto the SAME bounded work queue —
//     never a separate fetch "wave".
//   STRATEGY D — structured data extraction. Every candidate landed page is
//     independently verified using schema.org Product JSON-LD first, then
//     OpenGraph (og:title/og:image) as a fallback — a page needs a name AND
//     an image to count as a product; price/specs are a bonus, never
//     required (confirmed live: several real, official product pages have
//     accurate og:title/og:image but neither JSON-LD Product markup nor
//     og:type=product — rejecting those was a real bug, not caution).
//
// All four strategies feed ONE bounded work queue (FETCH_CONCURRENCY 2,
// hard-capped total page fetches), stopping the instant TARGET_PRODUCTS (6)
// is reached. The product image is picked deterministically from the page's
// own JSON-LD image list / og:image — generic assets (logo/icon/avatar/
// placeholder) are filtered out, and images whose URL hints at a lifestyle/
// on-model shot are deprioritized in favor of plain packshot images. No
// image bytes are fetched and no per-product/per-image AI call is made.
// Results are deduped by name, URL, and image. Below TARGET_PRODUCTS, the
// whole result is discarded (fails open) rather than returning a partial
// "personalized" storefront.
//
// Completely separate from /api/generate-listing — own file, own timeout,
// own reliability constants. Never touches /secondhand's generation path.
//
// Env vars (shared with generate-listing.ts, same names, same secret):
//   GEMINI_API_KEY, GEMINI_MODEL_PRIMARY, GEMINI_MODEL_FALLBACK, AI_GATEWAY_URL

interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODEL_PRIMARY?: string
  GEMINI_MODEL_FALLBACK?: string
  AI_GATEWAY_URL?: string
}

type Category = 'fashion' | 'furniture' | 'interior'

const CATEGORY_DETAIL_SV: Record<Category, string> = {
  fashion: 'mode/kläder (plagg, skor eller väskor)',
  furniture: 'möbler (t.ex. stolar, soffor, bord, hyllor)',
  interior:
    'inredning/heminredning — t.ex. lampor, speglar, vaser, mattor, ljushållare eller andra dekorationsföremål (INTE möbler eller bord)',
}

// Order confirmed live: gemini-3.7-flash has been observed frequently
// unavailable (repeated 25s timeouts and 503 "high demand" responses),
// while gemini-3.6-flash succeeds reliably. Trying the reliable model FIRST
// avoids burning a full GEMINI_TIMEOUT_MS on a doomed primary attempt.
const DEFAULT_PRIMARY_MODEL = 'gemini-3.6-flash'
const DEFAULT_FALLBACK_MODEL = 'gemini-3.7-flash'
// Grounding + thinking routinely takes 20-30s — this matches the proven
// timeout for grounded calls in generate-listing.ts.
const GEMINI_TIMEOUT_MS = 25_000
// A single 429 ("rate limit"/"quota exceeded") is frequently a transient
// per-minute throttle rather than a hard daily cap — one short backoff-and-
// retry on the SAME model clears most of these without falling through to
// (and burning quota on) the fallback model.
const RATE_LIMIT_RETRY_DELAY_MS = 1_500
const PAGE_FETCH_TIMEOUT_MS = 10_000
// Individual product pages usually have their JSON-LD/og: tags well within
// this, but listing/collection pages (which this endpoint also fetches, to
// harvest real product links) commonly have 100KB+ of head boilerplate
// before the product grid even starts — measured live on a real Shopify
// catalog page, the first product link didn't appear until byte ~120,000.
const PAGE_FETCH_BYTE_CAP = 900_000
const MAX_IMAGE_CANDIDATES_PER_PRODUCT = 3
// How many real, distinct, same-brand products a "personalized" storefront
// requires. Below this, the whole result is discarded — the frontend shows
// the illustrative fallback instead.
const TARGET_PRODUCTS = 6
// Ask the model to visit more pages than TARGET_PRODUCTS so grounding
// citation sparsity (often fewer citations than pages actually visited)
// still leaves enough candidates to clear the bar.
const DISCOVERY_VISIT_COUNT = 10
// Hard ceiling on total product-PAGE fetches for the whole request — the
// single most important number in this file. Never raise this without
// re-checking Cloudflare's Workers subrequest limit; this plus the 1-2
// Gemini calls plus the (at most 3) sitemap-stage fetches is the entire
// subrequest budget for one /brands lookup — target ~10-15 total.
const CANDIDATE_FETCH_CAP = 13
// A FEW deterministic listing-page guesses are mixed into the seed queue
// as a backstop when grounding citations are sparse — kept small because
// every seed competes for the same CANDIDATE_FETCH_CAP budget.
const GUESS_SEED_CAP = 3
const FETCH_CONCURRENCY = 2
const MAX_RETURNED_PRODUCTS = 8
// Sitemap discovery (Strategy B) — bounded to at most 3 HTTP fetches total
// (robots.txt, then the sitemap or sitemap index, then at most one chosen
// sub-sitemap): real sitemaps are often thousands of URLs, so this is text
// parsing, not per-URL fetching.
const SITEMAP_FETCH_BYTE_CAP = 2_000_000
// How many same-domain, non-denylisted candidates the sitemap stage hands
// off into the shared seed pool — trimmed further by CANDIDATE_FETCH_CAP
// once merged with grounding/guess candidates.
const SITEMAP_CANDIDATE_CAP = 15
// Path segments (case-insensitive, word-bounded) that show up across real
// sitemaps but are essentially never product pages — confirmed live across
// several real ecommerce sitemaps, which routinely mix product URLs with
// contact/legal/blog/inspiration/store-locator pages (one real furniture
// retailer's sitemap even mixed blog-style "painting tips"/"gift guide"
// articles into the SAME path-depth bucket as real products, with no
// og:type or other structured marker to tell them apart — only the path
// itself distinguishes them). Deliberately conservative (only excludes,
// never the primary selection signal — see scoreSitemapCandidates) so it
// can't accidentally hide a legitimately named product. "om-[a-z]+" is the
// general Swedish "about-X" convention (om-oss, om-swedese, om-mio, ...) as
// one pattern rather than enumerating every brand's own about-page slug.
// "kontakt\w*" (not the exact word) is deliberate — confirmed live that the
// exact-word form missed the real URL segment "kontakta-oss" ("contact us"),
// since Swedish inflects the verb ("kontakta") differently from the noun
// ("kontakt"); matching the stem instead of the exact word avoids having to
// separately enumerate every inflected form.
const NON_PRODUCT_PATH_HINT_RE =
  /\b(kontakt\w*|contact|about|om-[a-z]+|legal|privacy|integritet|cookie|terms|villkor|leverans|delivery|faq|fragor-och-svar|kundtjanst|kundservice|jobb|jobs|career|blogg|blog|stories|inspiration|samarbeten|tips|guide|press|butik|butiker|store|stores|showroom|retur|return|presentkort|gift-?card|login|auth|account|cart|checkout|search|sitemap|nyhetsbrev|newsletter|unsubscribe|hallbarhet|sustainability|designers|kampanj|repair|reparation|garanti|warranty)\b/i

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Every fetch() response must be fully consumed or explicitly cancelled — an un-drained body is exactly what triggers Cloudflare's "A stalled HTTP response was canceled" warning. Call this on any Response whose body we are deliberately NOT going to read. */
function cancelBody(res: Response) {
  res.body?.cancel().catch(() => {})
}

class CallError extends Error {
  retryable: boolean
  status: number | null
  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message)
    this.retryable = retryable
    this.status = status
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

/** One raw HTTP attempt against a single model. Retries ONCE, after a short fixed backoff, on a 429 from THIS SAME model — most 429s from Gemini are a transient per-minute throttle that clears within a couple seconds. The discarded first response's body is explicitly cancelled before retrying (never left hanging). Anything still failing after that retry is left to the caller's primary→fallback policy. */
async function callOnce(model: string, apiKey: string, gatewayUrl: string | undefined, body: unknown, stage: string): Promise<any> {
  const base = gatewayUrl
    ? `${gatewayUrl.replace(/\/$/, '')}/google-ai-studio/v1beta/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
      return await fetch(`${base}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let res = await attempt()
    if (res.status === 429) {
      console.log(`[brand-preview] stage=${stage} model=${model} status=429 action=retry_after_backoff delay_ms=${RATE_LIMIT_RETRY_DELAY_MS}`)
      cancelBody(res)
      await sleep(RATE_LIMIT_RETRY_DELAY_MS)
      res = await attempt()
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.log(`[brand-preview] stage=${stage} model=${model} status=${res.status} action=fail body=${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
      throw new CallError(`gemini ${model} ${res.status}: ${bodyText.slice(0, 600)}`, isRetryableStatus(res.status), res.status)
    }
    console.log(`[brand-preview] stage=${stage} model=${model} status=${res.status} action=ok`)
    return await res.json()
  } catch (err) {
    if (err instanceof CallError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      console.log(`[brand-preview] stage=${stage} model=${model} action=timeout timeout_ms=${GEMINI_TIMEOUT_MS}`)
      throw new CallError(`gemini ${model} timed out`, true)
    }
    console.log(`[brand-preview] stage=${stage} model=${model} action=network_error error=${err instanceof Error ? err.message : String(err)}`)
    throw new CallError(`gemini ${model} network error`, true)
  }
}

/** Same primary→fallback→give-up policy as generate-listing.ts, but a separate, independent implementation — no shared code, no shared failure surface. This request makes at most ONE of these calls, so no concurrency limiter is needed here anymore (see file header — that's the whole point of this architecture). */
async function callWithFallback(env: Env, body: unknown, stage: string): Promise<any> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
  const primary = env.GEMINI_MODEL_PRIMARY || DEFAULT_PRIMARY_MODEL
  const fallback = env.GEMINI_MODEL_FALLBACK || DEFAULT_FALLBACK_MODEL
  try {
    return await callOnce(primary, apiKey, env.AI_GATEWAY_URL, body, stage)
  } catch (err) {
    if (!(err instanceof CallError) || !err.retryable) throw err
    return await callOnce(fallback, apiKey, env.AI_GATEWAY_URL, body, `${stage}_fallback`)
  }
}

function extractText(res: any): string {
  const parts = res?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim()
}

/** Real search citations the model actually used — this is the ONLY source of candidate product URLs. Free-text URLs the model might also type in its answer are never trusted (see file header). */
function extractGroundingUrls(res: any): string[] {
  const chunks = res?.candidates?.[0]?.groundingMetadata?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of chunks) {
    const uri = c?.web?.uri
    if (typeof uri === 'string' && uri && !seen.has(uri)) {
      seen.add(uri)
      out.push(uri)
    }
  }
  return out
}

function buildSearchPrompt(url: string, category: Category): string {
  const label = CATEGORY_DETAIL_SV[category]
  const domain = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./i, '')
    } catch {
      return url
    }
  })()
  return `Du research:ar ett företags webbplats: ${url}

Använd Google-sökning för att hitta riktiga produktsidor — t.ex. sökningar i stil med "site:${domain} produkter", "site:${domain} shop" eller liknande, kombinerat med relevanta kategoriord.

Sök upp och besök MINST ${DISCOVERY_VISIT_COUNT} olika RIKTIGA, ENSKILDA produktsidor inom ${label} på DENNA webbplats — inte kategori-/kollektionssidor, utan faktiska produktsidor för olika, tydligt skilda, PUBLIKT TILLGÄNGLIGA produkter/modeller som säljs just nu. Föredra direkta produktsidor framför kategorisidor.

Svara sedan ENDAST i detta exakta format, inget annat:
FÖRETAG: <företagets/varumärkets namn, eller OKÄNT>
TON: <2-4 ord som beskriver deras tilltal/tonalitet, t.ex. "minimalistisk och saklig">
SECONDHAND_NAMN: <hur en secondhand-sektion troligen skulle namnges hos dem, t.ex. "Pre-owned" eller "Archive">

Du behöver inte lista produkterna i svaret ovan — det viktiga är att du faktiskt besöker flera olika produktsidor via sökningen. Om webbplatsen inte går att hitta, skriv OKÄNT för FÖRETAG.`
}

function parseField(text: string, label: string): string | null {
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'im')
  const m = text.match(re)
  if (!m) return null
  const v = m[1].trim()
  if (!v || /^(okänt|unknown|n\/a|-)$/i.test(v)) return null
  return v.slice(0, 120)
}

/** Reads only the first PAGE_FETCH_BYTE_CAP bytes of the response — bounds worker time/memory regardless of how large the actual page is. Always either reads to completion or explicitly cancels the reader, so the body is never left hanging. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let out = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    out += decoder.decode(value, { stream: true })
    if (total >= PAGE_FETCH_BYTE_CAP) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return out
}

/** Generic brand assets (logo/icon/avatar/favicon/placeholder) and category/collection HERO banners are never a real single-product photo — showing one as "the product" would be worse than showing none, so these are filtered out before ever becoming an image candidate. The categor(y)/kategori(bild) check matters more now that a page only needs a name+image to pass (see extractProductInfo's doc comment): confirmed live, a real category page's ONLY og:image was itself filename-tagged as a category banner (e.g. "...-Kategoribild_ottoman.jpg") — a common, general CMS asset-naming convention, not specific to any one site. */
function looksLikeGenericImage(imageUrl: string): boolean {
  return /\/(logo|logos|icon|icons|avatar|avatars|favicon|placeholder|sprite)(?:[\/_.-]|$)/i.test(imageUrl) || /categor|kategori|collection[-_]?banner|hero[-_]?image/i.test(imageUrl)
}

/** Weak, URL-only signal for "this image is probably an on-model/lifestyle shot rather than a plain packshot" — used only to DEPRIORITIZE (not reject) a candidate in favor of a cleaner-looking one, since without a vision call there's no reliable way to actually look at the pixels. */
const LIFESTYLE_HINT_RE = /(model|lifestyle|worn|on-body|editorial|campaign|hero-model|outfit)/i

/** Picks the best available product image with zero network/AI cost: prefers the first candidate whose URL has no lifestyle/on-model hint, keeping JSON-LD/og:image's own ordering (typically the primary packshot first) as the tiebreaker. Returns null only if there were no candidates at all. */
function pickProductImage(candidates: string[]): string | null {
  if (candidates.length === 0) return null
  const clean = candidates.find((c) => !LIFESTYLE_HINT_RE.test(c))
  return clean ?? candidates[0]
}

/** Conservative, keyword-only category sanity check — the earlier architecture verified category correctness via a Gemini vision call per product; that's exactly the fan-out this rewrite removes. This only REJECTS when a product name clearly matches a DIFFERENT category's vocabulary and not this one's, so ambiguous/unmatched names (the common case) still pass through — the upstream discovery prompt and listing-URL guesses are already category-scoped, so this is a backstop, not the primary filter. */
const CATEGORY_KEYWORDS: Record<Category, RegExp> = {
  fashion:
    /\b(jacket|jacka|shirt|skjorta|dress|klänning|shoe|sko|shoes|skor|boot|boots|bag|väska|trouser|byxa|byxor|sweater|tröja|coat|kappa|hoodie|t-shirt|top|blouse|blus|skirt|kjol|scarf|halsduk)\b/i,
  furniture: /\b(chair|stol|sofa|soffa|armchair|fåtölj|table|bord|shelf|hylla|bed|säng|desk|skrivbord|stool|pall|bench|bänk|cabinet|skåp|sideboard|byrå)\b/i,
  interior:
    /\b(lamp|lampa|mirror|spegel|vase|vas|rug|matta|candle|ljus|candleholder|ljushållare|cushion|kudde|throw|pläd|clock|klocka|tray|bricka|bowl|skål)\b/i,
}

function looksLikeWrongCategory(name: string, category: Category): boolean {
  if (CATEGORY_KEYWORDS[category].test(name)) return false
  return (Object.keys(CATEGORY_KEYWORDS) as Category[]).some((c) => c !== category && CATEGORY_KEYWORDS[c].test(name))
}

function extractMeta(html: string, ...properties: string[]): string | null {
  for (const prop of properties) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
    const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'))
    if (m?.[1]) return m[1]
  }
  return null
}

/** Extracts schema.org Product-typed nodes from JSON-LD blocks. Malformed JSON-LD (common in the wild) is silently skipped, never a hard error. */
function parseJsonLdProductNodes(html: string): any[] {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []
  const nodes: any[] = []
  for (const block of scripts) {
    const contentMatch = block.match(/>([\s\S]*?)<\/script>/i)
    if (!contentMatch) continue
    let data: any
    try {
      data = JSON.parse(contentMatch[1])
    } catch {
      continue
    }
    const candidates: any[] = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data]
    for (const node of candidates) {
      if (!node || typeof node !== 'object') continue
      const type = node['@type']
      const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'))
      if (isProduct) nodes.push(node)
    }
  }
  return nodes
}

interface ProductPageInfo {
  name: string
  price: string | null
  imageCandidateUrls: string[]
}

/** HTML meta content is raw markup, not plain text — a title like "Näin toimii" comes through as "N&#228;in toimii" (confirmed live) without this. Covers the common named entities plus numeric (decimal and hex) escapes; anything unrecognized is left as-is rather than guessed at. */
function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1]?.toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[ref.toLowerCase()] ?? match
  })
}

/** The single source of truth for "is this actually an individual product page, and what is it called" — schema.org Product JSON-LD first (name + gallery + price straight from the page's own structured data), falling back to plain OpenGraph (og:title/og:image). The minimum bar is a name AND at least one image — JSON-LD Product markup / og:type=product is a BONUS signal used when present (and preferred for price), never a hard requirement: several real, official product pages have accurate og:title/og:image but neither (confirmed live) — rejecting those outright was a real bug. Category/listing pages are kept out via looksLikeListingPath (checked by the caller) and the homepage/root-path guard below, not by requiring markup every site happens to include. */
function extractProductInfo(html: string, baseUrl: string): ProductPageInfo | null {
  const seen = new Set<string>()
  const imageCandidateUrls: string[] = []
  const pushImage = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw || looksLikeGenericImage(raw)) return
    try {
      const abs = new URL(raw, baseUrl).toString()
      if (!seen.has(abs)) {
        seen.add(abs)
        imageCandidateUrls.push(abs)
      }
    } catch {
      // ignore unparseable image URLs
    }
  }

  const productNodes = parseJsonLdProductNodes(html)
  let name: string | null = null
  let price: string | null = null

  if (productNodes.length > 0) {
    const node = productNodes[0]
    if (typeof node.name === 'string' && node.name.trim()) name = node.name.trim().slice(0, 120)
    const img = node.image
    if (typeof img === 'string') pushImage(img)
    else if (Array.isArray(img)) img.forEach((i: any) => pushImage(typeof i === 'string' ? i : i?.url))
    else if (img && typeof img === 'object') pushImage(img.url)
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers
    if (offers && typeof offers === 'object' && (offers.price || offers.lowPrice)) {
      price = `${offers.price ?? offers.lowPrice} kr`
    }
  }

  if (!name) {
    const ogTitle = extractMeta(html, 'og:title')
    if (ogTitle) name = decodeHtmlEntities(ogTitle.replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '').trim()).slice(0, 120) || null
  }
  pushImage(extractMeta(html, 'og:image', 'og:image:url', 'twitter:image'))

  if (!price) {
    const metaPrice = extractMeta(html, 'product:price:amount', 'og:price:amount')
    if (metaPrice) price = `${metaPrice} kr`
  }

  // Minimum bar: a name and at least one usable image. Price/specs are a
  // bonus (see doc comment above) — NOT required to accept the product.
  if (!name || imageCandidateUrls.length === 0) return null

  return { name, price, imageCandidateUrls: imageCandidateUrls.slice(0, MAX_IMAGE_CANDIDATES_PER_PRODUCT) }
}

interface ResolvedProduct {
  name: string
  price: string | null
  url: string
  image: string
}

/** Common ecommerce product-detail path patterns across Shopify/WooCommerce/Magento/Wix/Swedish-market sites. Used to mine real product links out of a listing/collection page's own HTML — no model involved, so these URLs can't be hallucinated. */
const PRODUCT_PATH_RE = /\/(products?|produkt(?:er)?)\/[a-z0-9][a-z0-9\-_%]*/i

/** URL-path signal for "this is a category/collection listing (or the homepage), not an individual product's own page" — checked BEFORE trusting any embedded structured data, because listing pages routinely embed one product's Product JSON-LD too (a "recently viewed"/"featured" widget), which would otherwise make the whole listing page look like that one arbitrary product's detail page. The bare-root check matters more now that extractProductInfo's minimum bar is just name+image (see its doc comment) — a homepage's own og:title/og:image would otherwise look like a plausible "product" once the stricter JSON-LD/og:type gate is gone. */
function looksLikeListingPath(pathname: string): boolean {
  const p = pathname.toLowerCase()
  if (p === '' || p === '/') return true
  if (/^\/(collections?|categor(?:y|ies)|product-categor(?:y|ies))(\/|$)/.test(p)) return true
  // Bare "/shop" or "/products" (no further path segment) is conventionally
  // a listing page; "/products/{handle}" or "/shop/{handle}" is the actual
  // product detail page on these same platforms, so only the bare form
  // counts here.
  if (/^\/(shop|products?)\/?$/.test(p)) return true
  return false
}

/** Pulls real product-detail links out of a listing/collection page's HTML — capped small since these only need to top up the SAME bounded queue, not replace it. This is what turns a single grounding-chunk citation of a CATEGORY page (which is what Google Search grounding actually tends to cite, in practice) into a few real, guaranteed-valid individual product URLs, without a separate fetch "wave". Links that are true URL-path CHILDREN of this page are prioritized ahead of same-domain-but-unrelated product-shaped links — confirmed live and necessary: on a real site, the first ~10 product-shaped hrefs in raw document order were ALL sidebar/breadcrumb navigation to sibling/parent categories, with the page's own actual child products appearing only much further down in the product grid — capping in plain document order silently dropped every real child in favor of nav noise. */
function extractProductLinksFromListingPage(html: string, baseUrl: string): string[] {
  const hrefs = Array.from(html.matchAll(/<a[^>]+href=["']([^"'#?]+)["']/gi)).map((m) => m[1])
  const basePathname = (() => {
    try {
      return new URL(baseUrl).pathname.replace(/\/$/, '')
    } catch {
      return ''
    }
  })()
  const childPrefix = `${basePathname}/`
  const seen = new Set<string>()
  const children: string[] = []
  const others: string[] = []
  for (const href of hrefs) {
    if (!PRODUCT_PATH_RE.test(href)) continue
    try {
      const abs = new URL(href, baseUrl).toString()
      if (seen.has(abs)) continue
      seen.add(abs)
      const isChild = basePathname !== '' && new URL(abs).pathname.startsWith(childPrefix)
      ;(isChild ? children : others).push(abs)
    } catch {
      // ignore unparseable links
    }
  }
  return [...children, ...others].slice(0, CANDIDATE_FETCH_CAP)
}

/** Counts how many of the given URLs are true URL-path CHILDREN of pagePathname (i.e. "pagePathname/something") — the decisive, site-structure-agnostic signal for "this page is itself a category/hub page, not a leaf product," confirmed live: a real hierarchical-taxonomy site's subcategory page (e.g. /produkter/fatoljer/fotpallar) links to its own child product pages (/produkter/fatoljer/fotpallar/lamino-fotpall), while a real leaf product page never links to anything nested under its own path. This is what catches listing pages that ALSO happen to have a plausible-looking og:title/og:image (a category hero banner) — exactly the case extractProductInfo's relaxed name+image bar can no longer tell apart on its own. Cross-links to sibling/unrelated categories (nav menus, "related products") don't count, since they aren't nested under this page's own path. */
function countPathChildren(urls: string[], pagePathname: string): number {
  const prefix = `${pagePathname.replace(/\/$/, '')}/`
  let count = 0
  for (const raw of urls) {
    try {
      if (new URL(raw).pathname.startsWith(prefix)) count++
    } catch {
      // ignore
    }
  }
  return count
}

interface FetchAndResolveResult {
  product: ResolvedProduct | null
  /** Real product-detail links harvested from this page's own HTML, when the page turned out to be a listing/collection page rather than a product page — topped up onto the SAME bounded queue, never a separate fetch wave. */
  discoveredUrls: string[]
}

/** Fetches ONE candidate URL (a real search citation, a deterministic listing-URL guess, or a link harvested from a listing page — see file header), follows redirects, and ONLY treats it as a product once the LANDED page (a) is actually on the requested brand's domain, (b) verifiably is an individual product page via extractProductInfo, and (c) doesn't look like an obviously wrong category. Every exit path either fully reads or explicitly cancels the response body — no fetch() call here can leave a stalled response behind. */
async function fetchAndResolve(candidateUrl: string, domainHost: string, category: Category): Promise<FetchAndResolveResult> {
  const empty: FetchAndResolveResult = { product: null, discoveredUrls: [] }
  const short = candidateUrl.length > 90 ? candidateUrl.slice(0, 90) + '…' : candidateUrl
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(candidateUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopaBrandPreview/1.0)' },
    })
    if (!res.ok) {
      console.log(`[brand-preview] stage=fetch action=reject reason=http_${res.status} url=${short}`)
      cancelBody(res)
      return empty
    }

    const finalUrl = res.url || candidateUrl
    let finalHost: string
    try {
      finalHost = new URL(finalUrl).hostname.replace(/^www\./i, '')
    } catch {
      cancelBody(res)
      return empty
    }
    // Same-brand guarantee, checked on the LANDED url — grounding chunk
    // URIs are often google-hosted redirect links, so this can't be
    // checked before following the redirect.
    if (finalHost !== domainHost && !finalHost.endsWith(`.${domainHost}`)) {
      console.log(`[brand-preview] stage=fetch action=reject reason=domain_mismatch landed_host=${finalHost} url=${short}`)
      cancelBody(res)
      return empty
    }

    const html = await readCapped(res)

    // URL path wins over any embedded structured data: collection/category
    // pages routinely embed ONE product's Product JSON-LD (a "recently
    // viewed" or "featured product" widget) — trusting that would make
    // extractProductInfo misidentify the whole listing page as if it WERE
    // that one arbitrary product's own detail page.
    const finalPathname = new URL(finalUrl).pathname
    const isListingPath = looksLikeListingPath(finalPathname)
    const discoveredUrls = extractProductLinksFromListingPage(html, finalUrl)
    // A page that links to two or more of its own URL-path children is
    // itself a hub/category page, regardless of what its og:title/og:image
    // look like (see countPathChildren doc comment) — this is what keeps
    // extractProductInfo's relaxed name+image bar from mistaking a
    // subcategory's hero banner for an actual single product.
    const looksLikeHubPage = countPathChildren(discoveredUrls, finalPathname) >= 2
    // Applied here (not just to sitemap-sourced candidates in
    // scoreSitemapCandidates) because it matters regardless of WHERE a
    // candidate URL came from — confirmed live: a Gemini grounding citation
    // (Strategy A, not the sitemap at all) landed on a real site's
    // inspiration/blog article, which had a perfectly good name+image and
    // would otherwise have been accepted as a fake "product".
    const looksLikeNonProductPath = NON_PRODUCT_PATH_HINT_RE.test(finalPathname)
    const info = isListingPath || looksLikeHubPage || looksLikeNonProductPath ? null : extractProductInfo(html, finalUrl)
    if (!info) {
      console.log(
        `[brand-preview] stage=fetch action=no_product_info listing_path=${isListingPath} hub_page=${looksLikeHubPage} non_product_path=${looksLikeNonProductPath} harvested=${discoveredUrls.length} url=${short}`,
      )
      return { product: null, discoveredUrls }
    }

    if (looksLikeWrongCategory(info.name, category)) {
      console.log(`[brand-preview] stage=fetch action=reject reason=wrong_category name="${info.name}" url=${short}`)
      return { product: null, discoveredUrls: [] }
    }

    const image = pickProductImage(info.imageCandidateUrls)
    if (!image) {
      console.log(`[brand-preview] stage=fetch action=reject reason=no_image name="${info.name}" url=${short}`)
      return { product: null, discoveredUrls: [] }
    }

    return { product: { name: info.name, price: info.price, url: finalUrl, image }, discoveredUrls: [] }
  } catch (err) {
    console.log(`[brand-preview] stage=fetch action=reject reason=exception error=${err instanceof Error ? err.message.slice(0, 120) : String(err)} url=${short}`)
    return empty
  } finally {
    clearTimeout(timer)
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** A few plausible category-listing slugs to try per category, on top of universal ones ("all", "shop") — deliberately generic since real category taxonomies vary a lot per site. Sliced down to GUESS_SEED_CAP entries since every seed competes for the same CANDIDATE_FETCH_CAP fetch budget as real grounding citations. */
const CATEGORY_SLUG_GUESSES: Record<Category, string[]> = {
  fashion: ['all', 'clothing', 'new-arrivals'],
  furniture: ['furniture', 'all', 'chairs'],
  interior: ['home', 'interior', 'decor'],
}

/** Deterministic, model-free listing-page URL guesses — no Gemini call involved, these are either real pages (verified live before ever being trusted) or they 404 and are dropped for free. Only the first GUESS_SEED_CAP are used as a backstop alongside real grounding citations. */
function guessListingUrls(baseUrl: string, category: Category): string[] {
  const slugs = CATEGORY_SLUG_GUESSES[category]
  const paths = ['/collections/all', '/shop', ...slugs.map((s) => `/collections/${s}`)]
  const out: string[] = []
  for (const path of paths) {
    try {
      out.push(new URL(path, baseUrl).toString())
    } catch {
      // ignore
    }
  }
  return out.slice(0, GUESS_SEED_CAP)
}

// ─── Strategy B: sitemap discovery ─────────────────────────────────────

/** Fetches a URL as plain text, capped and always either fully read or explicitly cancelled — same body-safety contract as readCapped, but standalone since sitemap/robots fetches aren't part of the product-resolution flow. Returns null on any failure (network, non-2xx, timeout) — sitemap discovery is a bonus strategy, never a hard requirement. */
async function fetchTextCapped(url: string, byteCap: number): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopaBrandPreview/1.0)' },
    })
    if (!res.ok) {
      cancelBody(res)
      return null
    }
    const reader = res.body?.getReader()
    if (!reader) return null
    const decoder = new TextDecoder()
    let out = ''
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      out += decoder.decode(value, { stream: true })
      if (total >= byteCap) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Real sitemap locations vary a lot in practice (confirmed live: one real furniture retailer's sitemap is NOT at /sitemap.xml at all) — robots.txt's `Sitemap:` directive is the authoritative source, so it's checked first. */
function extractSitemapUrlsFromRobots(text: string): string[] {
  return Array.from(text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)).map((m) => m[1].trim())
}

function isSitemapIndex(text: string): boolean {
  return /<sitemapindex[\s>]/i.test(text)
}

/** Sitemaps come in two real-world shapes: standard XML (<loc>url</loc>) and plain-text, one URL per line (confirmed live on a real large ecommerce site) — both are handled without needing to know which one a given site uses ahead of time. */
function parseSitemapEntries(text: string): string[] {
  const locMatches = Array.from(text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1].trim())
  if (locMatches.length > 0) return locMatches
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l))
}

// A path-depth bucket needs at least this many entries before it's trusted
// as "the product catalog depth" — below this it's more likely a handful of
// stray same-depth utility pages than a real product listing.
const MIN_DEPTH_BUCKET_SIZE = 3

// How many separate depth buckets get pooled together (see
// scoreSitemapCandidates) — confirmed live necessary: one real furniture
// retailer's sitemap has REAL products living at two unrelated sections of
// the site simultaneously (one bucket of product-series pages, another of
// individual SKU pages, at different depths) — committing to only the single
// "best" bucket left the pipeline dependent on guessing which one actually
// had the yield, when both were valid, so the top few are pooled instead.
const MAX_POOLED_DEPTH_BUCKETS = 3

/** Turns a flat list of raw sitemap URLs into a short list of good product-page candidates with zero extra HTTP requests — pure text/URL analysis. Real sitemaps mix product pages with contact/legal/blog/store-locator pages (denylisted via NON_PRODUCT_PATH_HINT_RE), so after that filter, URLs are bucketed by path-DEPTH (segment count). Deeper paths are more likely to be actual leaf/product pages than the site's own category/subcategory structure — confirmed live on a real site with an inconsistent taxonomy (some categories are /root/category/product, others /root/category/subcategory/product): picking one shallow "largest bucket" grabbed a mix of real products AND bare subcategory pages, while deeper buckets cleanly isolated genuine leaf products. Rather than betting everything on a single "best" bucket (also confirmed live to sometimes pick wrong — a different real site's deepest sizeable bucket turned out to be blog articles, not products, even after denylisting), the top few qualifying buckets (deepest first) are POOLED together up to SITEMAP_CANDIDATE_CAP, spreading the bet across multiple plausible sections of the site. Falls back to the single largest bucket if none meet MIN_DEPTH_BUCKET_SIZE. This holds regardless of what the site's URL scheme actually looks like — the strategy never assumes a specific scheme. */
function scoreSitemapCandidates(urls: string[], domainHost: string): string[] {
  const buckets = new Map<number, string[]>()
  for (const raw of urls) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    const host = u.hostname.replace(/^www\./i, '')
    if (host !== domainHost && !host.endsWith(`.${domainHost}`)) continue
    if (NON_PRODUCT_PATH_HINT_RE.test(u.pathname)) continue
    const segments = u.pathname.split('/').filter(Boolean)
    // Bare homepage / single top-level nav pages ("/about") are essentially
    // never products — require at least 2 path segments.
    if (segments.length < 2) continue
    const depth = segments.length
    if (!buckets.has(depth)) buckets.set(depth, [])
    buckets.get(depth)!.push(raw)
  }
  if (buckets.size === 0) return []

  // The single LARGEST bucket by entry count is unconditionally included —
  // confirmed live as the correct signal on its own for several real sites
  // (a real furniture retailer's biggest bucket by far was its actual
  // product-series catalog, regardless of depth). The deepest few qualifying
  // buckets are pooled ALONGSIDE it, not instead of it — confirmed live
  // necessary too (a different real site's real products lived one level
  // deeper than its own subcategory pages, while its largest bucket by count
  // was shallower and mixed). Depth alone and size alone each failed on a
  // real site the other one got right, so both signals are combined rather
  // than picking one.
  let largestDepth = -1
  let largestSize = 0
  for (const [depth, list] of buckets) {
    if (list.length > largestSize) {
      largestSize = list.length
      largestDepth = depth
    }
  }
  const depthsDeepestFirst = Array.from(buckets.keys()).sort((a, b) => b - a)
  const qualifying = depthsDeepestFirst.filter((d) => buckets.get(d)!.length >= MIN_DEPTH_BUCKET_SIZE)
  const chosenDepths = new Set<number>([largestDepth, ...qualifying.slice(0, MAX_POOLED_DEPTH_BUCKETS)])
  // Interleaved (round-robin across buckets), not concatenated — confirmed
  // live necessary: concatenating in any fixed bucket order meant whichever
  // bucket happened to be largest completely crowded out a smaller-but-also-
  // real bucket once the combined list got trimmed to SITEMAP_CANDIDATE_CAP
  // (and later again to the overall per-request fetch cap). Interleaving
  // guarantees every chosen bucket gets SOME representation in the final,
  // capped candidate list regardless of its relative size.
  const lists = Array.from(chosenDepths, (d) => buckets.get(d)!)
  const pooled: string[] = []
  for (let i = 0; pooled.length < SITEMAP_CANDIDATE_CAP; i++) {
    let addedAny = false
    for (const list of lists) {
      if (i < list.length) {
        pooled.push(list[i])
        addedAny = true
        if (pooled.length >= SITEMAP_CANDIDATE_CAP) break
      }
    }
    if (!addedAny) break
  }
  return pooled
}

/** Orchestrates the whole sitemap strategy in at most 3 HTTP fetches: robots.txt (to find the real sitemap location), the sitemap itself (or, if it's an index, whichever sub-sitemap's own URL mentions "product" — else just the first listed one), then scores its entries. Returns an empty array (never throws) on any failure — this runs in parallel with the Gemini search call and must never be what makes the whole request slower or fail. */
async function discoverSitemapCandidates(baseUrl: string, domainHost: string): Promise<string[]> {
  let sitemapUrl: string | null = null
  const robotsText = await fetchTextCapped(new URL('/robots.txt', baseUrl).toString(), 200_000)
  if (robotsText) {
    const found = extractSitemapUrlsFromRobots(robotsText)
    // Large international sites list one Sitemap: line per locale (confirmed
    // live: a real brand's robots.txt listed sitemaps for a dozen countries)
    // — this app is Swedish-market-focused throughout, so a Swedish-locale
    // sitemap is strongly preferred over whichever happens to be listed
    // first (which was Finnish for a real .com brand, purely because of
    // robots.txt line order — an arbitrary, non-market-relevant choice).
    const swedishMatch = found.find((u) => /\bsv-se\b/i.test(u)) ?? found.find((u) => /[./]se\b/i.test(u))
    if (swedishMatch) sitemapUrl = swedishMatch
    else if (found.length > 0) sitemapUrl = found[0]
  }
  if (!sitemapUrl) sitemapUrl = new URL('/sitemap.xml', baseUrl).toString()

  const sitemapText = await fetchTextCapped(sitemapUrl, SITEMAP_FETCH_BYTE_CAP)
  if (!sitemapText) {
    console.log(`[brand-preview] stage=sitemap action=unavailable url=${sitemapUrl}`)
    return []
  }

  if (isSitemapIndex(sitemapText)) {
    const subSitemaps = parseSitemapEntries(sitemapText)
    if (subSitemaps.length === 0) return []
    const chosen = subSitemaps.find((u) => /product/i.test(u)) ?? subSitemaps[0]
    const subText = await fetchTextCapped(chosen, SITEMAP_FETCH_BYTE_CAP)
    if (!subText) {
      console.log(`[brand-preview] stage=sitemap action=sub_unavailable url=${chosen}`)
      return []
    }
    const candidates = scoreSitemapCandidates(parseSitemapEntries(subText), domainHost)
    console.log(`[brand-preview] stage=sitemap action=ok sub_sitemaps=${subSitemaps.length} chosen=${chosen} candidates=${candidates.length}`)
    return candidates
  }

  const candidates = scoreSitemapCandidates(parseSitemapEntries(sitemapText), domainHost)
  console.log(`[brand-preview] stage=sitemap action=ok flat_urlset entries=${parseSitemapEntries(sitemapText).length} candidates=${candidates.length}`)
  return candidates
}

/** The entire product-resolution stage: one bounded work queue, FETCH_CONCURRENCY (2) workers, hard-capped at CANDIDATE_FETCH_CAP total page fetches, stopping the instant TARGET_PRODUCTS valid products have been assembled. Listing pages discovered mid-queue push a few more real links onto this SAME queue rather than starting a separate "wave" — the fetch cap is the only thing bounding total work, never an unbounded second pass. */
async function discoverProducts(
  seedUrls: string[],
  domainHost: string,
  category: Category,
): Promise<{ products: ResolvedProduct[]; fetchCount: number }> {
  const queue: string[] = []
  const seen = new Set<string>()
  for (const u of seedUrls) {
    if (queue.length >= CANDIDATE_FETCH_CAP || seen.has(u)) continue
    seen.add(u)
    queue.push(u)
  }

  const products: ResolvedProduct[] = []
  let nextIndex = 0
  let fetchCount = 0

  async function worker() {
    for (;;) {
      // Checked against the DEDUPED count, not the raw array length — a
      // seed list can legitimately contain two distinct products (e.g. a
      // men's and women's cut of the same jacket) that share an identical
      // display name and collapse to one entry under dedupeProducts.
      // Stopping on the raw count was confirmed live to under-shoot the
      // real target: it declared victory at 6 raw hits that deduped down
      // to only 5, leaving an unfetched seed that would have supplied the
      // 6th genuinely distinct product on the table.
      if (dedupeProducts(products).length >= TARGET_PRODUCTS) return
      if (fetchCount >= CANDIDATE_FETCH_CAP) return
      if (nextIndex >= queue.length) return
      const url = queue[nextIndex++]
      fetchCount++
      const result = await fetchAndResolve(url, domainHost, category)
      if (result.product) {
        products.push(result.product)
        console.log(`[brand-preview] stage=fetch action=product_found name="${result.product.name}" total=${products.length}/${TARGET_PRODUCTS} fetch_count=${fetchCount}`)
      } else if (result.discoveredUrls.length > 0) {
        for (const u of result.discoveredUrls) {
          if (queue.length >= CANDIDATE_FETCH_CAP) break
          if (seen.has(u)) continue
          seen.add(u)
          queue.push(u)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()))
  return { products, fetchCount }
}

/** Merges products deduping by normalized product name, final image URL, AND product URL — no duplicate card, no repeated image, no repeated link across the whole result. */
function dedupeProducts(products: ResolvedProduct[]): ResolvedProduct[] {
  const seenNames = new Set<string>()
  const seenImages = new Set<string>()
  const seenUrls = new Set<string>()
  const out: ResolvedProduct[] = []
  for (const p of products) {
    const nameKey = normalizeName(p.name)
    if (seenNames.has(nameKey) || seenImages.has(p.image) || seenUrls.has(p.url)) continue
    seenNames.add(nameKey)
    seenImages.add(p.image)
    seenUrls.add(p.url)
    out.push(p)
  }
  return out
}

/** Accepts bare domains too (example.se), normalizes to a full https URL. Returns null for anything unparseable — treated as "no URL given", never a hard error. */
function normalizeUrl(input: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    return u.hostname.includes('.') ? u : null
  } catch {
    return null
  }
}

function normalizeCategory(raw: unknown): Category | null {
  return raw === 'fashion' || raw === 'furniture' || raw === 'interior' ? raw : null
}

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context

  let body: { url?: string; category?: string }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  const parsedUrl = normalizeUrl((body.url || '').trim().slice(0, 300))
  const category = normalizeCategory(body.category)
  if (!parsedUrl) return json({ ok: false, error: 'invalid_url' }, 400)
  if (!category) return json({ ok: false, error: 'invalid_category' }, 400)

  const domainHost = parsedUrl.hostname.replace(/^www\./i, '')

  if (!env.GEMINI_API_KEY) {
    console.log('[brand-preview] stage=init action=abort reason=no_api_key')
    return json({ ok: true, result: null }, 200)
  }

  const startedAt = Date.now()

  try {
    // ─── Stage 1: grounded Gemini search (Strategy A) run IN PARALLEL with
    // sitemap discovery (Strategy B) — they're independent, so overlapping
    // them costs nothing in latency. allSettled (not all) is deliberate: a
    // transient Gemini outage (confirmed live: 503 "high demand" on the
    // primary model immediately followed by the fallback model timing out
    // too — a correlated outage, not a per-site issue) must NOT discard an
    // otherwise-successful sitemap result. Product discovery in Stage 2 can
    // proceed on sitemap/guess candidates alone; only the brand-level text
    // fields (company/tone/secondhand-naming) and grounding URLs are lost
    // when the search call fails.
    const [searchSettled, sitemapSettled] = await Promise.allSettled([
      callWithFallback(
        env,
        {
          contents: [{ role: 'user', parts: [{ text: buildSearchPrompt(parsedUrl.toString(), category) }] }],
          tools: [{ googleSearch: {} }],
          // This only needs 3 short brand-level fields, not deep reasoning —
          // capping the thinking budget cuts latency substantially.
          generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 512 } },
        },
        'search',
      ),
      discoverSitemapCandidates(parsedUrl.toString(), domainHost),
    ])
    if (searchSettled.status === 'rejected') {
      console.log(`[brand-preview] stage=search action=failed error=${searchSettled.reason instanceof Error ? searchSettled.reason.message.slice(0, 200) : String(searchSettled.reason)}`)
    }
    const searchRes = searchSettled.status === 'fulfilled' ? searchSettled.value : null
    const sitemapCandidates = sitemapSettled.status === 'fulfilled' ? sitemapSettled.value : []
    const text = searchRes ? extractText(searchRes) : ''
    const companyName = parseField(text, 'FÖRETAG')
    const tone = parseField(text, 'TON')
    const resaleTermStyle = parseField(text, 'SECONDHAND_NAMN')
    const groundingUrls = searchRes ? extractGroundingUrls(searchRes) : []
    console.log(
      `[brand-preview] stage=search company=${companyName ?? 'null'} grounding_urls=${groundingUrls.length} sitemap_candidates=${sitemapCandidates.length}`,
    )

    // ─── Stage 2: bounded product-page resolution (≤8 subrequests) ────────
    // Priority order: real grounding citations (Strategy A, AI-verified)
    // first, then sitemap-sourced candidates (Strategy B, deterministic and
    // usually the highest-yield source), then generic listing-URL guesses
    // (Strategy C) as the cheapest last resort.
    const seeds = [...groundingUrls, ...sitemapCandidates, ...guessListingUrls(parsedUrl.toString(), category)].slice(
      0,
      CANDIDATE_FETCH_CAP,
    )
    console.log(`[brand-preview] stage=seeds list=${JSON.stringify(seeds)}`)
    const { products: rawProducts, fetchCount } = await discoverProducts(seeds, domainHost, category)
    const merged = dedupeProducts(rawProducts)

    const elapsedMs = Date.now() - startedAt
    console.log(
      `[brand-preview] stage=done domain=${domainHost} category=${category} company=${companyName ?? 'null'} products=${merged.length} target=${TARGET_PRODUCTS} page_fetches=${fetchCount} meets_target=${merged.length >= TARGET_PRODUCTS} elapsed_ms=${elapsedMs}`,
    )

    // Six means six — a partial result (even 5/6) is not a "personalized"
    // storefront and must not be returned as one.
    if (merged.length < TARGET_PRODUCTS) {
      return json({ ok: true, result: null }, 200)
    }

    return json(
      {
        ok: true,
        result: {
          companyName,
          tone,
          resaleTermStyle,
          category,
          products: merged.slice(0, MAX_RETURNED_PRODUCTS).map((p) => ({ name: p.name, price: p.price, url: p.url, image: p.image })),
        },
      },
      200,
    )
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    console.error(
      `[brand-preview] stage=done result=error elapsed_ms=${elapsedMs} domain=${domainHost} category=${category} error=${err instanceof Error ? err.message.slice(0, 400) : String(err)}`,
    )
    return json({ ok: true, result: null }, 200)
  }
}

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405)
