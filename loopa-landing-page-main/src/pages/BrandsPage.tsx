import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { fetchBrandPreview, type BrandPreviewResult, type BrandProduct } from '../features/brands/brandPreviewClient'
import {
  getCategoryLabel,
  getDemoExamples,
  getRoutes,
  ROUTE_ORDER,
  buybackLabelFor,
  resaleAreaLabel,
  estimateResaleValue,
  parseSekAmount,
  type Category,
  type RichExample,
  type RouteKey,
} from '../features/brands/data'

// Page structure (see docs/BRANDS_REDESIGN_CHECKPOINT.md):
//   Hero (cream) → ValueWall (ink) → PreviewStage (white) → OwnIt (cream)
//   → HardPart (white) → Models (cream) → FinalCta (ink)
// One message per section, background alternation instead of border seams,
// and the personalized preview as the page's centerpiece and only deliberate
// motion moment.

function deriveDomain(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'brand.se'
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return u.hostname.replace(/^www\./i, '') || 'brand.se'
  } catch {
    return 'brand.se'
  }
}

function slugifyPath(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      .replace(new RegExp('[̀-ͯ]', 'g'), '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'secondhand'
  )
}

function sek(n: number, language: 'sv' | 'en'): string {
  return language === 'en' ? `${new Intl.NumberFormat('en-US').format(n)} SEK` : `${new Intl.NumberFormat('sv-SE').format(n)} kr`
}

const CATEGORY_ORDER: Category[] = ['fashion', 'furniture', 'interior']

// A "personalized" storefront requires at least this many distinct,
// verified, same-brand products — below this bar, every surface on the
// page falls back to the static illustrative example instead of claiming
// a real result. Mirrors TARGET_PRODUCTS in functions/api/brand-preview.ts.
const MIN_PERSONALIZED_PRODUCTS = 6

// Domains verified live to return ≥6 products in their category — offered
// as one-click suggestions so a skeptical visitor's first impression is the
// working magic, never the fallback state.
const SUGGESTIONS: { domain: string; category: Category }[] = [
  { domain: 'deadwoodstudios.com', category: 'fashion' },
  { domain: 'swedese.se', category: 'furniture' },
  { domain: 'iittala.com', category: 'interior' },
]

type CategoryCache = Record<Category, { status: 'idle' | 'loading' | 'done'; data: BrandPreviewResult | null }>

const EMPTY_CACHE: CategoryCache = {
  fashion: { status: 'idle', data: null },
  furniture: { status: 'idle', data: null },
  interior: { status: 'idle', data: null },
}

// How often the shared static demo product alternates between the fashion
// and furniture example — an ambient detail, deliberately slow and subtle.
const DEMO_ROTATION_MS = 5000

export function BrandsPage() {
  const [category, setCategory] = useState<Category>('fashion')
  const [brandInput, setBrandInput] = useState('')
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [cache, setCache] = useState<CategoryCache>(EMPTY_CACHE)
  const { language } = useLanguage()

  // ONE shared clock for every static example surface on the page (hero
  // image, idle storefront card, integration mock, condition proof card) —
  // they must always show the same product with matching copy, never mix.
  const [demoIndex, setDemoIndex] = useState(0)
  const demoExamples = getDemoExamples(language)
  useEffect(() => {
    const id = setInterval(() => setDemoIndex((i) => (i + 1) % 2), DEMO_ROTATION_MS)
    return () => clearInterval(id)
  }, [])
  const demo = demoExamples[demoIndex]

  const domain = useMemo(() => deriveDomain(activeUrl ?? brandInput), [activeUrl, brandInput])

  const current = cache[category]
  const preview = current.data
  const resalePath = preview?.resaleTermStyle ? slugifyPath(preview.resaleTermStyle) : resaleAreaLabel(category)
  // Only counts as "personalized" once the 6-distinct-product bar is met —
  // 1-5 real hits are treated the same as zero: an honest fallback, never a
  // half-personalized storefront.
  const realProducts = (preview?.products?.length ?? 0) >= MIN_PERSONALIZED_PRODUCTS ? preview!.products : []

  function fetchCategory(url: string, cat: Category) {
    setCache((prev) => ({ ...prev, [cat]: { status: 'loading', data: null } }))
    fetchBrandPreview(url, cat).then((result) => {
      setCache((prev) => ({ ...prev, [cat]: { status: 'done', data: result } }))
    })
  }

  function handlePreviewSubmit() {
    const trimmed = brandInput.trim()
    if (!trimmed) return
    setActiveUrl(trimmed)
    setCache(EMPTY_CACHE)
    fetchCategory(trimmed, category)
  }

  function handleSuggestion(s: { domain: string; category: Category }) {
    setBrandInput(s.domain)
    setCategory(s.category)
    setActiveUrl(s.domain)
    setCache(EMPTY_CACHE)
    fetchCategory(s.domain, s.category)
  }

  function handleCategoryChange(next: Category) {
    setCategory(next)
    if (activeUrl && cache[next].status === 'idle') {
      fetchCategory(activeUrl, next)
    }
  }

  return (
    <div>
      <Hero demo={demo} />
      <ValueWall />
      <PreviewStage
        category={category}
        setCategory={handleCategoryChange}
        brandInput={brandInput}
        setBrandInput={setBrandInput}
        onSubmit={handlePreviewSubmit}
        onSuggestion={handleSuggestion}
        status={current.status}
        activeUrl={activeUrl}
        preview={preview}
        domain={domain}
        resalePath={resalePath}
        realProducts={realProducts}
        demo={demo}
      />
      <OwnIt />
      <HardPart demo={demo} />
      <Models />
      <FinalCta />
    </div>
  )
}

/** The single best product to feature — the first real product ONLY once the full 6-distinct-product bar is met, otherwise the shared rotating static demo product. Real personalized data always wins over the demo. */
function featuredProduct(demo: RichExample, realProducts: BrandProduct[]): { real: BrandProduct | null; fallback: RichExample } {
  const real = realProducts.length >= MIN_PERSONALIZED_PRODUCTS ? realProducts[0] : null
  return { real, fallback: demo }
}

// ─── 1 · Hero ────────────────────────────────────────────────────────────

function Hero({ demo }: { demo: RichExample }) {
  const { t } = useLanguage()
  const h = t.brandsPage.hero

  return (
    <section className="container-loopa pt-16 pb-24 md:pt-24 md:pb-32">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-accent)] uppercase">{h.eyebrow}</p>
          <h1 className="mt-5 max-w-2xl text-[42px] leading-[1.04] font-bold tracking-tight text-[var(--color-ink)] sm:text-6xl lg:text-[68px]">
            {h.titleLine1}
            <br />
            <span className="text-[var(--color-accent)]">{h.titleLine2}</span>
          </h1>
          <p className="mt-7 max-w-lg text-lg leading-relaxed text-[var(--color-body)]">{h.subtitle}</p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="#preview"
              className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-7 py-3.5 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
            >
              {h.ctaPrimary} →
            </a>
            <a
              href="/company#contact-form"
              className="inline-flex items-center justify-center rounded-full border border-[var(--color-line)] bg-white px-7 py-3.5 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
            >
              {h.ctaSecondary}
            </a>
          </div>
        </div>

        <div className="mx-auto w-full max-w-md lg:max-w-none">
          {/* Keyed on the demo image so the swap re-triggers a soft fade — the page's ambient fashion↔furniture alternation. */}
          <div key={demo.image} className="animate-fade-up">
            <div className="overflow-hidden rounded-[2rem] bg-white shadow-[var(--shadow-card)]">
              <img src={demo.image} alt={demo.imageAlt} className="aspect-[4/5] w-full object-cover" />
            </div>
            <p className="mt-3 text-right text-xs text-[var(--color-body)]/70">
              {demo.brand} · {demo.productName} — {h.exampleSuffix}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── 2 · Value wall ──────────────────────────────────────────────────────

function ValueWall() {
  const { t } = useLanguage()
  const d = t.brandsPage.valueWall

  return (
    <section className="bg-[var(--color-ink)] py-24 md:py-36">
      <div className="container-loopa">
        <h2 className="max-w-3xl text-4xl leading-[1.06] font-bold tracking-tight text-white sm:text-5xl lg:text-[52px]">
          {d.heading1}
          <br />
          {d.heading2}
        </h2>

        <div className="mt-16 grid gap-14 sm:grid-cols-3 sm:gap-10 md:mt-20">
          {d.stats.map((s) => (
            <div key={s.title}>
              <p className="text-7xl font-bold tracking-tight text-[var(--color-accent)] md:text-[84px] md:leading-none">{s.value}</p>
              <h3 className="mt-5 text-lg font-semibold text-white">{s.title}</h3>
              <p className="mt-2 max-w-xs text-[15px] leading-relaxed text-white/60">{s.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-16 max-w-2xl text-xs leading-relaxed text-white/35 md:mt-20">{d.sourceNote}</p>
      </div>
    </section>
  )
}

// ─── 3 · Preview stage (the centerpiece) ─────────────────────────────────

function PreviewStage({
  category,
  setCategory,
  brandInput,
  setBrandInput,
  onSubmit,
  onSuggestion,
  status,
  activeUrl,
  preview,
  domain,
  resalePath,
  realProducts,
  demo,
}: {
  category: Category
  setCategory: (c: Category) => void
  brandInput: string
  setBrandInput: (v: string) => void
  onSubmit: () => void
  onSuggestion: (s: { domain: string; category: Category }) => void
  status: 'idle' | 'loading' | 'done'
  activeUrl: string | null
  preview: BrandPreviewResult | null
  domain: string
  resalePath: string
  realProducts: BrandProduct[]
  demo: RichExample
}) {
  const { t, language } = useLanguage()
  const d = t.brandsPage.preview
  const categoryLabel = getCategoryLabel(language)

  const foundCount = preview?.products?.length ?? 0
  const isPersonalized = status === 'done' && !!activeUrl && foundCount >= MIN_PERSONALIZED_PRODUCTS
  const isPartial = status === 'done' && !!activeUrl && foundCount > 0 && foundCount < MIN_PERSONALIZED_PRODUCTS
  const isEmpty = status === 'done' && !!activeUrl && foundCount === 0

  // Loading narration — part of the page's single deliberate motion moment.
  const [loadStep, setLoadStep] = useState(0)
  useEffect(() => {
    if (status !== 'loading') {
      setLoadStep(0)
      return
    }
    const id = setInterval(() => setLoadStep((s) => Math.min(s + 1, d.loadingSteps.length - 1)), 3200)
    return () => clearInterval(id)
  }, [status, d.loadingSteps.length])

  const { real, fallback } = featuredProduct(demo, realProducts)

  return (
    <section id="preview" className="bg-white py-24 md:py-32">
      <div className="container-loopa">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-accent)] uppercase">{d.eyebrow}</p>
          <h2 className="mt-4 text-4xl leading-[1.06] font-bold tracking-tight text-[var(--color-ink)] sm:text-5xl lg:text-[52px]">
            {d.heading}
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-[var(--color-body)]">{d.subheading}</p>

          <div className="mt-9 flex flex-col gap-2.5 sm:flex-row">
            <label className="sr-only" htmlFor="brand-url">
              {d.urlSrLabel}
            </label>
            <input
              id="brand-url"
              type="text"
              value={brandInput}
              onChange={(e) => setBrandInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
              placeholder={d.placeholder}
              className="w-full rounded-full border border-[var(--color-line)] bg-white px-5 py-3.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)] sm:flex-1"
            />
            <button
              type="button"
              onClick={onSubmit}
              disabled={!brandInput.trim() || status === 'loading'}
              className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-7 py-3.5 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:opacity-40"
            >
              {status === 'loading' ? d.submitLoading : d.submitIdle}
            </button>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
            <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-cream-soft)] p-1">
              {CATEGORY_ORDER.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(key)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    category === key ? 'bg-[var(--color-ink)] text-white' : 'text-[var(--color-body)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {categoryLabel[key]}
                </button>
              ))}
            </div>
            <p className="text-sm text-[var(--color-body)]">
              {d.tryLabel}{' '}
              {SUGGESTIONS.map((s, i) => (
                <span key={s.domain}>
                  <button
                    type="button"
                    onClick={() => onSuggestion(s)}
                    className="font-medium text-[var(--color-ink)] underline decoration-[var(--color-line)] underline-offset-4 transition-colors hover:text-[var(--color-accent)] hover:decoration-[var(--color-accent)]"
                  >
                    {s.domain}
                  </button>
                  {i < SUGGESTIONS.length - 1 && <span className="text-[var(--color-body)]/50"> · </span>}
                </span>
              ))}
            </p>
          </div>
        </div>

        {/* Status zone above the frame: narration → payoff headline → honest fallback note */}
        <div className="mx-auto mt-12 max-w-4xl">
          <div className="min-h-[56px] text-center">
            {status === 'loading' && (
              <p key={loadStep} className="animate-fade-up text-lg font-medium text-[var(--color-ink)]">
                {d.loadingSteps[loadStep]}
              </p>
            )}
            {isPersonalized && (
              <div className="animate-fade-up">
                <h3 className="text-2xl font-bold tracking-tight text-[var(--color-ink)] sm:text-[28px]">
                  {d.successHeading(preview?.companyName ?? null)}
                </h3>
                <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-green-50 px-3.5 py-1.5 text-sm font-semibold text-green-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
                  {d.successBadge(foundCount)}
                </p>
              </div>
            )}
            {isPartial && <p className="text-sm text-[var(--color-body)]">{d.statusPartial(foundCount, MIN_PERSONALIZED_PRODUCTS)}</p>}
            {isEmpty && <p className="text-sm text-[var(--color-body)]">{d.statusEmpty(domain)}</p>}
          </div>

          {/* The storefront frame — always visible, transforms in place */}
          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white shadow-[0_2px_6px_rgba(20,17,13,0.05),0_24px_60px_-24px_rgba(20,17,13,0.22)]">
            <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-cream-soft)] px-5 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
              <span className="ml-2 rounded-full bg-white px-3.5 py-1 text-xs text-[var(--color-body)]">
                {domain}/{resalePath}
              </span>
            </div>

            <div className="p-5 sm:p-7">
              {status === 'loading' && (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border border-[var(--color-line)]">
                      <div className="skeleton-shimmer aspect-square w-full" />
                      <div className="space-y-2 p-3">
                        <div className="skeleton-shimmer h-3 w-3/4 rounded-full" />
                        <div className="skeleton-shimmer h-3 w-1/2 rounded-full" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isPersonalized && (
                <div key={`${activeUrl}-${category}`} className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {realProducts.slice(0, 6).map((item, i) => {
                    const amount = parseSekAmount(item.price)
                    return (
                      <div
                        key={item.url}
                        className="animate-rise-in overflow-hidden rounded-xl border border-[var(--color-line)] bg-white"
                        style={{ animationDelay: `${i * 90}ms` }}
                      >
                        <div className="overflow-hidden bg-[var(--color-cream-soft)]">
                          <img src={item.image} alt={item.name} className="aspect-square w-full object-cover" loading="lazy" />
                        </div>
                        <div className="p-3">
                          <p className="truncate text-[13px] font-medium text-[var(--color-ink)]">{item.name}</p>
                          <div className="mt-1 flex items-baseline gap-1.5">
                            <span className="text-[13px] font-semibold text-[var(--color-accent)]">
                              {amount ? sek(estimateResaleValue(amount), language) : d.estimateLabel}
                            </span>
                            {/* Reformatted through sek() — raw scraped strings ("5500.0 kr") look broken next to properly localized prices. */}
                            {amount && <span className="text-[11px] text-[var(--color-body)]/60 line-through">{sek(amount, language)}</span>}
                          </div>
                          <p className="mt-0.5 text-[11px] text-[var(--color-body)]/70">{d.conditionExample}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {status !== 'loading' && !isPersonalized && (
                <div className="flex flex-col items-center py-6">
                  {/* Keyed on the rotating demo so image, name and price always swap together. */}
                  <div key={fallback.image} className="animate-fade-up w-full max-w-[240px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-white">
                    <div className="overflow-hidden bg-[var(--color-cream-soft)]">
                      <img src={fallback.image} alt={fallback.productName} className="aspect-square w-full object-cover" />
                    </div>
                    <div className="p-3">
                      <p className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                        {fallback.brand} {fallback.productName}
                      </p>
                      <p className="text-[13px] font-semibold text-[var(--color-accent)]">{fallback.resalePrice}</p>
                    </div>
                  </div>
                  <p className="mt-5 max-w-sm text-center text-sm text-[var(--color-body)]">{d.idleNote}</p>
                </div>
              )}
            </div>
          </div>

          {/* Peak-intent CTA directly under a personalized result */}
          {isPersonalized && (
            <div className="animate-fade-up mt-8 flex flex-col items-center justify-center gap-4 rounded-2xl bg-[var(--color-cream)] px-6 py-7 sm:flex-row sm:gap-6">
              <p className="text-center text-lg font-semibold text-[var(--color-ink)]">{d.ctaLead}</p>
              <a
                href="/company#contact-form"
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-7 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
              >
                {d.ctaButton} →
              </a>
            </div>
          )}

          <p className="mt-5 text-center text-xs text-[var(--color-body)]/70">{d.honesty}</p>
        </div>

        {/* Secondary: product-page integration option */}
        <div className="mx-auto mt-20 grid max-w-4xl items-center gap-10 md:mt-24 lg:grid-cols-[0.55fr_0.45fr]">
          <div className="order-2 lg:order-1">
            {/* Keyed on the demo when idle so the mock's image/name/prices swap in sync; a real personalized product pins it stable. */}
            <div key={real ? 'real' : fallback.image} className={real ? undefined : 'animate-fade-up'}>
              <ProductPageMock domain={domain} real={real} fallback={fallback} />
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <h3 className="text-2xl font-bold tracking-tight text-[var(--color-ink)] sm:text-3xl">{d.integrationHeading}</h3>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-body)]">{d.integrationBody}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function ProductPageMock({ domain, real, fallback }: { domain: string; real: BrandProduct | null; fallback: RichExample }) {
  const { t, language } = useLanguage()
  const d = t.brandsPage.productPageMock
  const name = real?.name ?? `${fallback.brand} ${fallback.productName}`
  const image = real?.image ?? fallback.image
  const realOriginalAmount = real ? parseSekAmount(real.price) : null
  // Reformatted through sek() when parseable — raw scraped strings ("5500.0 kr") read as broken formatting.
  const originalPriceLabel = real ? (realOriginalAmount ? sek(realOriginalAmount, language) : (real.price ?? d.priceUnknown)) : fallback.originalPrice
  const resaleLabel = real && realOriginalAmount ? sek(estimateResaleValue(realOriginalAmount), language) : fallback.resalePrice

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-cream-soft)] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-[var(--color-line)]" />
        <span className="h-2 w-2 rounded-full bg-[var(--color-line)]" />
        <span className="ml-2 rounded-full bg-white px-3 py-0.5 text-[11px] text-[var(--color-body)]">{domain}</span>
      </div>
      <div className="p-4 sm:p-5">
        <div className="flex gap-4">
          <div className="w-24 shrink-0 overflow-hidden rounded-lg bg-[var(--color-cream-soft)] sm:w-28">
            <img src={image} alt={name} className="aspect-square w-full object-cover" />
          </div>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-bold text-[var(--color-ink)]">{name}</h4>
            <p className="mt-1 text-[11px] text-[var(--color-body)] uppercase">{d.ny}</p>
            <p className="text-base font-bold text-[var(--color-ink)]">{originalPriceLabel}</p>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/[0.04] p-3.5">
          <p className="text-[11px] font-semibold text-[var(--color-accent)] uppercase">{d.secondhandAlternativ}</p>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-bold text-[var(--color-ink)]">{d.fromLabel(resaleLabel)}</p>
              <p className="text-[11px] text-[var(--color-body)]">{d.availableNote(fallback.conditionGrade)}</p>
            </div>
            <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-3.5 py-1.5 text-[11px] font-medium text-white">
              {d.ctaSeeSecondhand}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 4 · Own it or lose it ───────────────────────────────────────────────

function OwnIt() {
  const { t } = useLanguage()
  const d = t.brandsPage.ownIt

  return (
    <section className="py-24 md:py-36">
      <div className="container-loopa">
        <h2 className="max-w-3xl text-4xl leading-[1.06] font-bold tracking-tight text-[var(--color-ink)] sm:text-5xl lg:text-[52px]">
          {d.heading1}
          <br />
          <span className="text-[var(--color-accent)]">{d.heading2}</span>
        </h2>

        <div className="mt-14 grid gap-12 md:mt-16 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-body)] uppercase">{d.todayLabel}</p>
            <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-3 text-[15px] font-medium">
              {d.todaySteps.map((step, i) => (
                <span key={step} className="contents">
                  <span
                    className={
                      i === 1
                        ? 'rounded-full border border-dashed border-[var(--color-body)]/40 px-4 py-2 text-[var(--color-body)]'
                        : 'rounded-full bg-white px-4 py-2 text-[var(--color-ink)] shadow-[var(--shadow-card)]'
                    }
                  >
                    {step}
                  </span>
                  {i < d.todaySteps.length - 1 && <span className="text-[var(--color-body)]/50">→</span>}
                </span>
              ))}
            </div>
            <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-[var(--color-body)]">{d.todayBody}</p>
          </div>

          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-accent)] uppercase">{d.withLoopaLabel}</p>
            <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-3 text-[15px] font-medium">
              {d.withLoopaSteps.map((step, i) => (
                <span key={step} className="contents">
                  <span
                    className={
                      i === 1
                        ? 'rounded-full bg-[var(--color-ink)] px-4 py-2 text-white'
                        : 'rounded-full bg-white px-4 py-2 text-[var(--color-ink)] shadow-[var(--shadow-card)]'
                    }
                  >
                    {step}
                  </span>
                  {i < d.withLoopaSteps.length - 1 && <span className="text-[var(--color-body)]/50">→</span>}
                </span>
              ))}
            </div>
            <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-[var(--color-body)]">{d.withLoopaBody}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── 5 · Loopa runs the hard part ────────────────────────────────────────

function HardPart({ demo }: { demo: RichExample }) {
  const { t } = useLanguage()
  const d = t.brandsPage.hardPart
  const fallback = demo

  return (
    <section className="bg-white py-24 md:py-36">
      <div className="container-loopa">
        <div className="grid items-start gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <h2 className="max-w-xl text-4xl leading-[1.06] font-bold tracking-tight text-[var(--color-ink)] sm:text-5xl lg:text-[52px]">
              {d.heading}
            </h2>
            <p className="mt-5 max-w-md text-xl font-medium text-[var(--color-ink)]">{d.subheading}</p>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-body)]">{d.sellerLine}</p>

            <ol className="mt-10 space-y-4">
              {d.pipeline.map((step, i) => (
                <li key={step} className="flex items-baseline gap-4">
                  <span className="w-8 shrink-0 text-sm font-semibold tabular-nums text-[var(--color-body)]/50">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-lg font-semibold text-[var(--color-ink)]">{step}</span>
                </li>
              ))}
            </ol>

            <p className="mt-10 max-w-md text-[15px] leading-relaxed text-[var(--color-body)]">{d.trustLine}</p>
          </div>

          <div className="lg:mt-6">
            {/* Keyed on the rotating demo so image + grade + reasoning always swap together. */}
            <div key={fallback.image} className="animate-fade-up rounded-3xl bg-[var(--color-cream)] p-6 shadow-[var(--shadow-card)] sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="rounded-full bg-[var(--color-ink)] px-2.5 py-1 text-xs font-semibold text-white">
                    {fallback.conditionGrade}
                  </span>
                  <span className="text-lg font-bold text-[var(--color-ink)]">
                    {d.conditionPrefix} {fallback.conditionGrade} · {fallback.conditionLabel}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--color-body)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                  {d.aiAssessed}
                </span>
              </div>

              <div className="mt-5 overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
                <img src={fallback.image} alt={fallback.productName} className="aspect-[16/10] w-full object-cover" />
              </div>

              <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-body)]">{fallback.conditionReasoning}</p>
              <p className="mt-3 text-xs text-[var(--color-body)]/70">{d.exampleNote}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── 6 · Your model, your setup ──────────────────────────────────────────

const ROUTE_ICONS: Record<RouteKey, ReactElement> = {
  'seller-held': (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8l8-5 8 5v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 18v-5h6v5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  buyback: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.5 3v3.5H14M6.5 21v-3.5H10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  managed: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 7h11v9H3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 10h4l3 3v3h-7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="7" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17.5" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
}

function Models() {
  const { t, language } = useLanguage()
  const d = t.brandsPage.models
  const routes = getRoutes(language)
  // The route bodies mention the trade-in/buyback label; use the furniture
  // variant as the neutral default since this section is category-agnostic.
  const buybackLabel = buybackLabelFor('furniture', language)

  return (
    <section className="py-24 md:py-36">
      <div className="container-loopa">
        <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-accent)] uppercase">{d.eyebrow}</p>
        <h2 className="mt-4 max-w-3xl text-4xl leading-[1.06] font-bold tracking-tight text-[var(--color-ink)] sm:text-5xl lg:text-[52px]">
          {d.heading}
        </h2>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--color-body)]">{d.subheading}</p>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {ROUTE_ORDER.map((key) => {
            const r = routes[key]
            return (
              <div key={key} className="rounded-2xl border border-[var(--color-line)] bg-white p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-cream-soft)] text-[var(--color-ink)]">
                    {ROUTE_ICONS[key]}
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-[var(--color-ink)]">{r.headline}</h3>
                    <span className="text-[11px] font-medium tracking-wide text-[var(--color-body)] uppercase">{r.tag}</span>
                  </div>
                </div>
                <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-body)]">{r.body(buybackLabel)}</p>
              </div>
            )
          })}
        </div>

        <p className="mt-10 max-w-xl text-[15px] leading-relaxed text-[var(--color-body)]">{d.flexNote}</p>
        <p className="mt-4 text-xl font-semibold text-[var(--color-ink)] sm:text-2xl">{d.closing}</p>
      </div>
    </section>
  )
}

// ─── 7 · Final CTA ───────────────────────────────────────────────────────

function FinalCta() {
  const { t } = useLanguage()
  const d = t.brandsPage.finalCta
  return (
    <section className="bg-[var(--color-ink)] py-28 md:py-40">
      <div className="container-loopa">
        <h2 className="max-w-4xl text-4xl leading-[1.05] font-bold tracking-tight text-white sm:text-5xl md:text-6xl lg:text-[64px]">
          {d.heading1}
          <br />
          <span className="text-[var(--color-accent)]">{d.heading2}</span>
        </h2>
        <p className="mt-7 max-w-lg text-lg leading-relaxed text-white/70">{d.body}</p>
        <div className="mt-10">
          <a
            href="/company#contact-form"
            className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-8 py-4 text-base font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            {d.ctaTalk} →
          </a>
        </div>
      </div>
    </section>
  )
}
