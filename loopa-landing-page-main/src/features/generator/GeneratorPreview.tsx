import { useLanguage } from '../../i18n/LanguageContext'
import type { GeneratedListing } from './types'

// Renders a GeneratedListing. Used today to display mock data (e.g. inside
// the "Generate with Loopa" section); designed so a real generator can feed
// this the same shape later without any UI changes.
export function GeneratorPreview({ listing }: { listing: GeneratedListing }) {
  const { language, t } = useLanguage()
  const g = t.generatorPreview
  const nf = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : 'en-US')

  let priceLine: string | null = null
  if (listing.pricing.fixedPrice && listing.pricing.suggestedPriceSek) {
    priceLine = `${g.priceLabel}: ${nf.format(listing.pricing.suggestedPriceSek)} ${t.common.currency}`
  } else if (listing.pricing.suggestedCreditSek) {
    priceLine = `${g.creditLabel}: ${nf.format(listing.pricing.suggestedCreditSek)} ${t.common.currency}`
  } else if (listing.pricing.estimatedRangeSek) {
    const [a, b] = listing.pricing.estimatedRangeSek
    priceLine = `${g.rangeLabel}: ${nf.format(a)}-${nf.format(b)} ${t.common.currency}`
  }

  const photos = listing.images.photos

  const dataColumn = (
    <div>
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-lg font-bold text-[var(--color-ink)]">{listing.generatedTitle[language]}</h4>
        <span className="shrink-0 rounded-full bg-[var(--color-cream-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-body)]">
          {Math.round(listing.confidence * 100)}%
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {listing.attributes.map((attr) => (
          <div key={attr.label[language]}>
            <dt className="text-xs text-[var(--color-body)] uppercase">{attr.label[language]}</dt>
            <dd className="font-medium text-[var(--color-ink)]">{attr.value[language]}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-[var(--color-body)] uppercase">{g.conditionLabel}</dt>
          <dd className="font-medium text-[var(--color-ink)]">
            {listing.condition.grade} · {listing.condition.label[language]}
          </dd>
        </div>
      </dl>

      {listing.generatedDescription[language] && (
        <p className="mt-4 border-t border-[var(--color-line)] pt-4 text-sm leading-relaxed text-[var(--color-body)]">
          {listing.generatedDescription[language]}
        </p>
      )}

      {priceLine && (
        <p className="mt-4 border-t border-[var(--color-line)] pt-4 text-lg font-bold text-[var(--color-ink)]">
          {priceLine}
        </p>
      )}

      {listing.missingInfo && listing.missingInfo.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-body)]">
          {listing.missingInfo.map((m) => m[language]).join(', ')}
        </p>
      )}
    </div>
  )

  if (photos.length === 0) {
    return <div className="rounded-2xl border border-[var(--color-line)] bg-white p-5">{dataColumn}</div>
  }

  return (
    <div className="grid gap-6 rounded-2xl border border-[var(--color-line)] bg-white p-5 shadow-[var(--shadow-card)] sm:grid-cols-2 sm:p-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
          <img src={photos[0]} alt={listing.generatedTitle[language]} className="aspect-[4/3] w-full object-cover" />
        </div>
        {photos[1] && (
          <div className="overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
            <img src={photos[1]} alt="" className="aspect-square w-full object-cover" />
          </div>
        )}
      </div>
      {dataColumn}
    </div>
  )
}
