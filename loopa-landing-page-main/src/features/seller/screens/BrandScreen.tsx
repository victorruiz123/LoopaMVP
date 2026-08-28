import { useRef } from 'react'

// The ONLY required manual field in the whole product, plus one optional
// free-text note. No category, no product type, no questionnaire.

export function BrandScreen({
  brand,
  onBrandChange,
  sellerNote,
  onSellerNoteChange,
  onContinue,
}: {
  brand: string
  onBrandChange: (v: string) => void
  sellerNote: string
  onSellerNoteChange: (v: string) => void
  onContinue: () => void
}) {
  const brandInputRef = useRef<HTMLInputElement>(null)
  const canContinue = brand.trim() !== ''

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col justify-center px-6 py-10 sm:min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto w-full max-w-md">
        <p className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">Steg 1 av 3</p>
        <h2 className="mt-3 text-3xl leading-tight font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl">Vilket varumärke är det?</h2>

        <input
          ref={brandInputRef}
          type="text"
          value={brand}
          onChange={(e) => onBrandChange(e.target.value)}
          placeholder="t.ex. Swedese"
          autoFocus
          className="mt-6 w-full rounded-2xl border-2 border-[var(--color-line)] bg-white px-5 py-4 text-xl text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-accent)]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canContinue) onContinue()
          }}
        />

        <div className="mt-8">
          <label className="block text-base font-medium text-[var(--color-ink)]">Något mer du vill berätta?</label>
          <p className="mt-1 text-sm text-[var(--color-body)]">Till exempel modell, storlek eller något du vet om produkten. Valfritt.</p>
          <textarea
            value={sellerNote}
            onChange={(e) => onSellerNoteChange(e.target.value)}
            rows={2}
            className="mt-2.5 w-full resize-none rounded-2xl border border-[var(--color-line)] bg-white px-4 py-3 text-[15px] text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-accent)]"
          />
        </div>

        <button
          type="button"
          disabled={!canContinue}
          onClick={onContinue}
          className="mt-9 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:opacity-30 sm:w-auto"
        >
          Fortsätt
        </button>
      </div>
    </div>
  )
}
