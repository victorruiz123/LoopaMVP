import type { MarketplaceListing } from '../types'

// Honest completion state — Tradera is NOT connected yet, so this never
// claims published/live/sold. It only confirms the listing itself is ready.

export function CompleteScreen({ heroImageUrl, listing }: { heroImageUrl: string | null; listing: MarketplaceListing }) {
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center px-6 py-10 text-center sm:min-h-[calc(100dvh-4rem)]">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
        <CheckIcon />
      </div>
      <h1 className="mt-6 text-3xl font-bold tracking-tight text-[var(--color-ink)]">Klart för försäljning</h1>
      <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-[var(--color-body)]">Din annons är redo för nästa steg.</p>

      {heroImageUrl && (
        <div className="mt-8 w-full max-w-[220px] overflow-hidden rounded-2xl bg-[var(--color-cream-soft)]">
          <img src={heroImageUrl} alt="" className="aspect-[4/5] w-full object-cover" />
        </div>
      )}
      <p className="mt-3 max-w-xs text-sm font-medium text-[var(--color-ink)]">{listing.title}</p>
      {listing.priceSek != null && (
        <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">{new Intl.NumberFormat('sv-SE').format(listing.priceSek)} kr</p>
      )}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
