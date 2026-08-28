import { useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { LISTING_IMAGES, LISTING_THUMBS } from '../data/listing'
import { AskLoopaChat } from './AskLoopaChat'
import { BuyNowFlow } from './BuyNowFlow'

export function ListingDemo() {
  const { t } = useLanguage()
  const l = t.listingDemo
  const [activeImage, setActiveImage] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [buyOpen, setBuyOpen] = useState(false)

  const fields: { label: string; value: string }[] = [
    { label: l.configLabel, value: l.configValue },
    { label: l.dimensionsLabel, value: l.dimensionsValue },
    { label: l.materialLabel, value: l.materialValue },
    { label: l.colorLabel, value: l.colorValue },
    { label: l.conditionLabel, value: l.conditionValue },
    { label: l.estValueLabel, value: l.estValueValue },
  ]

  return (
    <div className="overflow-hidden rounded-3xl border border-[var(--color-line)] bg-white shadow-[var(--shadow-card)]">
      <div className="grid md:grid-cols-2">
        {/* Seller photos */}
        <div className="border-b border-[var(--color-line)] p-6 md:border-r md:border-b-0 md:p-8">
          <p className="mb-4 text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
            {l.sellerPhotos}
          </p>
          <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-cream-soft)]">
            <img
              src={LISTING_IMAGES[activeImage]}
              alt={l.productTitle}
              className="aspect-[4/3] w-full object-cover"
              width={800}
              height={600}
            />
          </div>
          <div className="mt-3 grid grid-cols-5 gap-2">
            {LISTING_THUMBS.map((thumb, i) => (
              <button
                key={thumb}
                type="button"
                onClick={() => setActiveImage(i)}
                className={`overflow-hidden rounded-lg border transition-colors ${
                  activeImage === i ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]'
                }`}
                aria-label={`Photo ${i + 1}`}
                aria-pressed={activeImage === i}
              >
                <img src={thumb} alt="" className="aspect-square w-full object-cover" />
              </button>
            ))}
          </div>
        </div>

        {/* Loopa listing */}
        <div className="p-6 md:p-8">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
              {l.loopaListing}
            </p>
            <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              {l.published}
            </span>
          </div>

          <h3 className="text-xl font-bold text-[var(--color-ink)]">{l.productTitle}</h3>
          <p className="mt-1 text-sm text-[var(--color-body)]">{l.productSubtitle}</p>

          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-[var(--color-line)] pt-5 text-sm">
            {fields.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-[var(--color-body)] uppercase">{f.label}</dt>
                <dd className="mt-1 font-medium text-[var(--color-ink)]">{f.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 border-t border-[var(--color-line)] pt-5">
            <p className="text-xs text-[var(--color-body)] uppercase">{l.descriptionLabel}</p>
            <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line text-[var(--color-body)]">
              {l.description}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
            {l.askButton}
          </button>

          <div className="mt-6 flex items-center justify-between gap-4 border-t border-[var(--color-line)] pt-5">
            <div>
              <p className="text-xs text-[var(--color-body)] uppercase">{l.priceLabel}</p>
              <p className="text-2xl font-bold text-[var(--color-ink)]">{l.priceValue}</p>
              <p className="text-xs text-[var(--color-body)]">{l.priceNote}</p>
            </div>
            <button
              type="button"
              onClick={() => setBuyOpen(true)}
              className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
            >
              {l.buyNow}
            </button>
          </div>
        </div>
      </div>

      {chatOpen && <AskLoopaChat onClose={() => setChatOpen(false)} />}
      {buyOpen && <BuyNowFlow onClose={() => setBuyOpen(false)} />}
    </div>
  )
}
