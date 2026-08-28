import { useState } from 'react'
import type { SellerProductCandidate } from '../types'

// Candidate-selection interstitial — shown ONLY when identification found
// real ambiguity (2-4 plausible products) or explicitly none. Human
// disambiguation is cheap: the seller should be able to choose in seconds,
// so this stays deliberately minimal — no confidence scores, no AI wording,
// no card soup. "Ingen av dessa" always exists, the manual model field is
// optional, and the seller can always continue without knowing the model.

export function ModelSelectScreen({
  brand,
  candidates,
  onSelect,
  onManual,
  onUnknown,
}: {
  brand: string
  candidates: SellerProductCandidate[]
  onSelect: (candidate: SellerProductCandidate) => void
  /** Seller typed a model name after "Ingen av dessa". */
  onManual: (model: string) => void
  /** Seller doesn't know the model — continue without one. */
  onUnknown: () => void
}) {
  // With zero candidates there is nothing to list — open on the manual field.
  const [mode, setMode] = useState<'list' | 'manual'>(candidates.length > 0 ? 'list' : 'manual')
  const [manualModel, setManualModel] = useState('')

  if (mode === 'manual') {
    return (
      <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col justify-center px-6 py-10 sm:min-h-[calc(100dvh-4rem)]">
        <div className="mx-auto w-full max-w-md">
          <h2 className="text-3xl leading-tight font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl">Vilken modell är det?</h2>
          <p className="mt-2 text-[15px] text-[var(--color-body)]">Om du vet modellen hittar vi rätt mått och pris. Annars går det bra ändå.</p>

          <input
            type="text"
            value={manualModel}
            onChange={(e) => setManualModel(e.target.value)}
            placeholder="t.ex. Lamino"
            autoFocus
            className="mt-6 w-full rounded-2xl border-2 border-[var(--color-line)] bg-white px-5 py-4 text-xl text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-accent)]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualModel.trim()) onManual(manualModel.trim())
            }}
          />

          <button
            type="button"
            disabled={!manualModel.trim()}
            onClick={() => onManual(manualModel.trim())}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:opacity-30"
          >
            Fortsätt
          </button>

          <button
            type="button"
            onClick={onUnknown}
            className="mt-4 w-full text-center text-[15px] font-medium text-[var(--color-body)] underline-offset-4 hover:underline"
          >
            Jag vet inte modellen – fortsätt ändå
          </button>

          {candidates.length > 0 && (
            <button
              type="button"
              onClick={() => setMode('list')}
              className="mt-6 w-full text-center text-sm text-[var(--color-body)]/70 underline-offset-4 hover:underline"
            >
              Tillbaka till förslagen
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col justify-center px-6 py-10 sm:min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto w-full max-w-md">
        <h2 className="text-3xl leading-tight font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl">Vilken modell är det?</h2>
        <p className="mt-2 text-[15px] text-[var(--color-body)]">Välj den som stämmer – då kan vi hämta rätt mått och pris.</p>

        <div className="mt-6 flex flex-col gap-3">
          {candidates.map((c) => {
            const detail = [c.variant ?? c.productType, c.distinguishingDetail].filter(Boolean).join(' · ')
            return (
              <button
                key={`${c.brand} ${c.model}`}
                type="button"
                onClick={() => onSelect(c)}
                className="w-full rounded-2xl border-2 border-[var(--color-line)] bg-white px-5 py-4 text-left transition-colors hover:border-[var(--color-accent)] focus-visible:border-[var(--color-accent)]"
              >
                <span className="block text-lg font-semibold text-[var(--color-ink)]">
                  {c.brand || brand} {c.model}
                </span>
                {detail && <span className="mt-0.5 block text-sm text-[var(--color-body)]">{detail}</span>}
              </button>
            )
          })}

          <button
            type="button"
            onClick={() => setMode('manual')}
            className="w-full rounded-2xl border-2 border-dashed border-[var(--color-line)] px-5 py-4 text-left text-lg font-medium text-[var(--color-body)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
          >
            Ingen av dessa
          </button>
        </div>
      </div>
    </div>
  )
}
