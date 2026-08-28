import { useState } from 'react'
import type { GeneratedListingResult, SellerMissingField } from '../../generator/schema'
import { conditionResultFromGeneratedListing, pricingResultFromGeneratedListing } from '../engines'

function sek(value: number): string {
  return `${new Intl.NumberFormat('sv-SE').format(Math.round(value))} kr`
}

/**
 * Seller-facing labels for the facts research could not verify. Only the ones
 * a seller would actually recognize are named — `variant`/`condition`/`price`
 * are tracked server-side but have no separate chip here, because the result
 * already shows their absence in place (no price number, generic condition).
 */
const MISSING_FIELD_LABELS: Partial<Record<SellerMissingField, string>> = {
  dimensions: 'Mått',
  material: 'Material',
  newPrice: 'Nypris',
  model: 'Exakt modell',
}

/**
 * Deliberately quiet. A partially-researched listing is still a good listing —
 * the title, price, condition and description stay visually dominant, and this
 * is one small line plus a few neutral chips, never a warning box.
 */
function MissingFacts({ missingFields }: { missingFields: SellerMissingField[] }) {
  const named = missingFields.map((f) => MISSING_FIELD_LABELS[f]).filter((l): l is string => !!l)
  if (!named.length) return null
  return (
    <div className="mt-4">
      <p className="text-sm text-[var(--color-body)]">Vi kunde inte verifiera alla produktuppgifter.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {named.map((label) => (
          <span key={label} className="rounded-full border border-dashed border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-body)]">
            {label}: saknas
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Progressive reveal: product → condition → price → listing → handoff. Each
 * section has one dominant element (product title+image, condition label,
 * price number, listing text) — never five competing facts at once.
 */
export function ResultScreen({
  result,
  heroImageUrl,
  onApprove,
  isSubmitting,
}: {
  result: GeneratedListingResult
  heroImageUrl: string | null
  onApprove: (final: { title: string; description: string }) => void
  isSubmitting: boolean
}) {
  const condition = conditionResultFromGeneratedListing(result)
  const pricing = pricingResultFromGeneratedListing(result)
  const [title, setTitle] = useState(result.listing.title)
  const [description, setDescription] = useState(result.listing.description)

  const metaLine = [result.identity.category, result.identity.brand].filter(Boolean).join(' · ')

  return (
    <div className="mx-auto w-full max-w-md px-5 pt-6 pb-28">
      {/* Product — dominant */}
      <div className="animate-fade-up">
        {heroImageUrl && (
          <div className="overflow-hidden rounded-3xl bg-[var(--color-cream-soft)]">
            <img src={heroImageUrl} alt="" className="aspect-[4/5] w-full object-cover" />
          </div>
        )}
        <p className="mt-4 text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{metaLine || 'Produkt'}</p>
        <h1 className="mt-1 text-[26px] leading-[1.1] font-bold tracking-tight text-[var(--color-ink)]">
          {result.identity.exactProduct || title}
        </h1>
        {result.identity.variant && <p className="mt-1 text-[15px] text-[var(--color-body)]">{result.identity.variant}</p>}

        {result.identity.uncertain && (
          <div className="mt-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
            {result.identity.uncertaintyNote || 'Vi kunde inte bekräfta produkten helt säkert utifrån bilderna.'}
          </div>
        )}

        {result.attributes.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {result.attributes.slice(0, 6).map((a) => (
              <span key={a.key} className="rounded-full border border-[var(--color-line)] bg-white px-2.5 py-1 text-xs text-[var(--color-body)]">
                {a.label}: <span className="font-medium text-[var(--color-ink)]">{a.value}</span>
              </span>
            ))}
          </div>
        )}

        <MissingFacts missingFields={result.missingFields ?? []} />
      </div>

      {/* Condition — dominant element = the label itself */}
      <section className="mt-9 border-t border-[var(--color-line)] pt-7">
        <p className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">Skick</p>
        <div className="mt-2 flex items-center gap-2.5">
          {condition.grade && <span className="rounded-full bg-[var(--color-ink)] px-2.5 py-1 text-xs font-semibold text-white">{condition.grade}</span>}
          <span className="text-xl font-bold text-[var(--color-ink)]">{condition.summary || 'Ej bedömt'}</span>
        </div>
        {condition.observations[0] && <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-body)]">{condition.observations[0]}</p>}
        {condition.defects.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-sm text-[var(--color-body)]">
            {condition.defects.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Price — the strongest visual moment after the product itself */}
      <section className="mt-9 border-t border-[var(--color-line)] pt-7">
        <p className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">Rekommenderat pris</p>
        {pricing.available && pricing.recommendedPriceSek != null ? (
          <>
            <p className="mt-1 text-5xl font-bold tracking-tight text-[var(--color-ink)]">{sek(pricing.recommendedPriceSek)}</p>
            {pricing.priceRangeMinSek != null && pricing.priceRangeMaxSek != null && (
              <p className="mt-1.5 text-sm text-[var(--color-body)]">
                Rimligt intervall: {sek(pricing.priceRangeMinSek)} – {sek(pricing.priceRangeMaxSek)}
              </p>
            )}
            {pricing.rationale && <p className="mt-2 max-w-[42ch] text-sm leading-relaxed text-[var(--color-body)]">{pricing.rationale}</p>}
            {/* Honest about provenance: an estimate is never dressed up as a comparables-backed price. */}
            {pricing.basis === 'estimate' && (
              <p className="mt-1.5 text-sm text-[var(--color-body)]">Uppskattning utifrån märke, produkttyp och skick — vi hittade inga jämförbara priser.</p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[15px] text-[var(--color-body)]">
            Vi hittade inte tillräckligt med underlag för ett prisförslag än — du kan ange ett pris själv i nästa steg.
          </p>
        )}
      </section>

      {/* Listing — lightly editable */}
      <section className="mt-9 border-t border-[var(--color-line)] pt-7">
        <p className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">Annons</p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-2 w-full rounded-xl border border-transparent bg-transparent px-0 text-lg font-semibold text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-line)] focus:bg-white focus:px-3 focus:py-2"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2 w-full resize-none rounded-xl border border-transparent bg-transparent px-0 text-[15px] leading-relaxed text-[var(--color-body)] outline-none transition-colors focus:border-[var(--color-line)] focus:bg-white focus:px-3 focus:py-2"
        />
      </section>

      {/* Handoff */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-cream)]/95 backdrop-blur">
        <div className="mx-auto max-w-md px-5 py-4">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onApprove({ title, description })}
            className="flex w-full items-center justify-center rounded-full bg-[var(--color-ink)] px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-black disabled:opacity-50"
          >
            {isSubmitting ? 'Ett ögonblick…' : 'Överlåt försäljningen till Loopa'}
          </button>
        </div>
      </div>
    </div>
  )
}
