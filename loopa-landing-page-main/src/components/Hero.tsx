import { useEffect, useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { FashionProductPhoto } from './FashionProductPhoto'
import { MOCK_FASHION_LISTING, MOCK_FURNITURE_LISTING } from '../features/generator/mockListing'
import type { GeneratedListing } from '../features/generator/types'

const STAGE_COUNT = 6
const STAGE_MS = 1300

function useHeroEngine() {
  // A single tick counter drives both stage and category as pure derived
  // values. Avoids nested setState-inside-setState (which React Strict
  // Mode's dev-only double-invocation of updater functions would otherwise
  // make flip twice and silently cancel out).
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), STAGE_MS)
    return () => clearInterval(id)
  }, [])

  const stageIndex = tick % STAGE_COUNT
  const cycle = Math.floor(tick / STAGE_COUNT)
  const category: 'fashion' | 'furniture' = cycle % 2 === 0 ? 'fashion' : 'furniture'

  return { stageIndex, category }
}

function buildChips(
  listing: GeneratedListing,
  language: 'sv' | 'en',
  conditionLabel: string,
  priceLabel: string,
  creditLabel: string,
  currency: string,
) {
  const nf = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : 'en-US')
  const chips = listing.attributes.map((a) => ({
    label: a.label[language],
    value: a.value[language],
    revealAt: 2,
  }))
  chips.push({
    label: conditionLabel,
    value: `${listing.condition.grade} · ${listing.condition.label[language]}`,
    revealAt: 3,
  })
  const priceValue = listing.pricing.suggestedPriceSek
    ? `${nf.format(listing.pricing.suggestedPriceSek)} ${currency}`
    : listing.pricing.suggestedCreditSek
      ? `${nf.format(listing.pricing.suggestedCreditSek)} ${currency}`
      : ''
  chips.push({
    label: listing.pricing.suggestedCreditSek ? creditLabel : priceLabel,
    value: priceValue,
    revealAt: 4,
  })
  return chips
}

export function Hero() {
  const { t, language } = useLanguage()
  const { stageIndex, category } = useHeroEngine()

  const listing = category === 'fashion' ? MOCK_FASHION_LISTING : MOCK_FURNITURE_LISTING
  const chips = buildChips(
    listing,
    language,
    t.generatorPreview.conditionLabel,
    t.generatorPreview.priceLabel,
    t.generatorPreview.creditLabel,
    t.common.currency,
  )
  const scanning = stageIndex < 2

  return (
    <section id="top" className="container-loopa pt-10 pb-16 md:pt-16 md:pb-24">
      <div className="grid items-start gap-12 md:grid-cols-2 md:gap-10">
        <div className="flex flex-col items-start">
          <h1 className="text-5xl leading-[1.02] font-bold tracking-tight text-[var(--color-ink)] sm:text-6xl md:text-[64px]">
            {t.hero.titleLine1}
            <br />
            <span className="text-[var(--color-accent)]">{t.hero.titleLine2}</span>
          </h1>

          <p className="mt-6 max-w-md text-lg leading-relaxed text-[var(--color-body)]">
            {t.hero.subtitle}
          </p>
          <p className="mt-3 text-lg font-medium text-[var(--color-ink)]">{t.hero.categoryLine}</p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#how"
              className="inline-flex items-center justify-center rounded-full bg-[var(--color-ink)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-black"
            >
              {t.hero.ctaPrimary}
            </a>
            <a
              href="#brands"
              className="inline-flex items-center justify-center rounded-full border border-[var(--color-line)] bg-transparent px-6 py-3 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-white"
            >
              {t.hero.ctaSecondary}
            </a>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--color-line)] bg-white p-5 shadow-[var(--shadow-card)] sm:p-6">
          {/* stage rail */}
          <div className="flex flex-wrap items-center gap-1.5">
            {t.hero.stages.map((label, i) => (
              <span
                key={label}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  i === stageIndex
                    ? 'bg-[var(--color-accent)] text-white'
                    : i < stageIndex
                      ? 'bg-[var(--color-ink)] text-white'
                      : 'bg-[var(--color-cream-soft)] text-[var(--color-body)]'
                }`}
              >
                {label}
              </span>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-5 gap-4">
            <div className="col-span-2">
              {category === 'fashion' ? (
                <FashionProductPhoto variant="front" className="aspect-square w-full" scanning={scanning} />
              ) : (
                <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
                  <img
                    src="/assets/ikea/thumb-img-8304.webp"
                    alt="IKEA SÖDERHAMN"
                    className="h-full w-full object-cover"
                  />
                  {scanning && (
                    <span className="animate-scan-line absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-white/40 to-transparent" />
                  )}
                </div>
              )}
              <span className="mt-2 inline-block rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium text-[var(--color-body)]">
                {category === 'fashion' ? t.brands.tabFashion : t.brands.tabFurniture}
              </span>
            </div>

            <div className="col-span-3 min-h-[168px]">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                {chips
                  .filter((chip) => chip.revealAt <= stageIndex)
                  .map((chip, i) => (
                    <div key={chip.label} className="animate-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
                      <dt className="text-[10px] text-[var(--color-body)] uppercase">{chip.label}</dt>
                      <dd className="text-sm font-medium text-[var(--color-ink)]">{chip.value}</dd>
                    </div>
                  ))}
              </dl>

              {stageIndex >= 5 && (
                <span className="animate-fade-up mt-4 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700">
                  ✓ {t.hero.readyBadge}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
