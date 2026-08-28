import { useLanguage } from '../i18n/LanguageContext'
import { STOREFRONT_LISTINGS, discountPercent } from '../data/storefront'

export function SoffadirektStorefront() {
  const { t, language } = useLanguage()
  const s = t.storefront
  const nf = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : 'en-US')

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white shadow-[var(--shadow-card)]">
      {/* Browser chrome */}
      <div className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-cream-soft)] px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-line)]" />
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs text-[var(--color-body)]">
          soffadirekt.se/second-hand
        </span>
      </div>

      {/* Storefront header */}
      <div className="border-b border-[var(--color-line)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-lg font-extrabold tracking-tight text-[var(--color-ink)]">
            SOFFADIREKT
          </span>
          <div className="min-w-0 flex-1">
            <input
              readOnly
              value=""
              placeholder={s.searchPlaceholder}
              className="w-full max-w-md rounded-full border border-[var(--color-line)] px-4 py-2 text-sm text-[var(--color-body)] outline-none"
            />
          </div>
          <div className="flex items-center gap-4 text-sm text-[var(--color-body)]">
            <span className="hidden sm:inline">{s.account}</span>
            <span className="hidden sm:inline">{s.cart}</span>
            <span className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-xs font-medium text-white">
              {s.sellCta}
            </span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-[var(--color-body)]">
          {s.categories.map((cat) => (
            <span key={cat}>{cat}</span>
          ))}
        </div>
      </div>

      {/* Hero */}
      <div className="grid gap-6 border-b border-[var(--color-line)] p-5 md:grid-cols-2 md:p-8">
        <div>
          <p className="text-xs font-medium tracking-wide text-[var(--color-accent)] uppercase">
            {s.kicker}
          </p>
          <h3 className="mt-2 text-2xl font-bold text-[var(--color-ink)] sm:text-3xl">{s.heading}</h3>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-body)]">{s.body}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <span className="rounded-full bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-white">
              {s.sellCta}
            </span>
            <span className="rounded-full border border-[var(--color-line)] px-5 py-2.5 text-sm font-medium text-[var(--color-ink)]">
              {s.browseCta}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-cream-soft)] p-5">
          <p className="font-semibold text-[var(--color-ink)]">{s.valuateTitle}</p>
          <ol className="mt-3 space-y-2 text-sm text-[var(--color-body)]">
            {s.valuateSteps.map((step, i) => (
              <li key={step} className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-[var(--color-ink)]">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <div className="mt-4 space-y-2 border-t border-[var(--color-line)] pt-4 text-sm">
            <div className="flex justify-between">
              <span className="text-[var(--color-body)]">{s.estimatedLabel}</span>
              <span className="font-medium text-[var(--color-ink)]">3 200-3 800 kr</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--color-body)]">{s.creditLabel}</span>
              <span className="font-semibold text-[var(--color-accent)]">4 100 kr</span>
            </div>
            <p className="text-xs text-[var(--color-accent)]">{s.bonusNote}</p>
          </div>
          <p className="mt-4 text-xs text-[var(--color-body)]">{s.pickupNote}</p>
        </div>
      </div>

      {/* Product grid */}
      <div className="p-5 md:p-8">
        <div className="mb-4 flex items-center justify-between">
          <p className="font-semibold text-[var(--color-ink)]">{s.nearYou}</p>
          <span className="text-sm text-[var(--color-body)]">{s.listingsCount}</span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {STOREFRONT_LISTINGS.map((item) => (
            <div key={item.id} className="overflow-hidden rounded-xl border border-[var(--color-line)]">
              <div className="relative">
                <img src={item.image} alt={item.name} className="aspect-square w-full object-cover" />
                <span className="absolute top-2 left-2 rounded-full bg-white/95 px-2 py-1 text-[11px] font-medium text-[var(--color-ink)]">
                  {item.condition[language]}
                </span>
              </div>
              <div className="p-3">
                <p className="text-sm font-semibold text-[var(--color-ink)]">{item.name}</p>
                <p className="text-xs text-[var(--color-body)]">{item.variant[language]}</p>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-[var(--color-ink)]">
                    {nf.format(item.priceSek)} kr
                  </span>
                  <span className="text-xs text-[var(--color-body)] line-through">
                    {nf.format(item.originalPriceSek)} kr
                  </span>
                  <span className="text-xs font-medium text-[var(--color-accent)]">
                    -{discountPercent(item.priceSek, item.originalPriceSek)}%
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--color-body)]">{item.location}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] px-5 py-3 text-xs text-[var(--color-body)]">
        <span>{t.brands.exampleLabel}</span>
        <span>
          {t.brands.poweredBy} <span className="font-semibold text-[var(--color-accent)]">Loopa</span>
        </span>
      </div>
    </div>
  )
}
