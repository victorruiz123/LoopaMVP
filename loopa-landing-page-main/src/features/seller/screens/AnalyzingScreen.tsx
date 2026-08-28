import { useEffect, useState } from 'react'

const STEPS = [
  'Vi tittar på dina bilder',
  'Hittar produkten',
  'Kontrollerar produktinformationen',
  'Bedömer skicket',
  'Tar fram ett bra pris',
  'Skapar din annons',
]

// Paced to the real generation time. Seller generation now measures ~10-11s
// end-to-end (research ~6.6s + structuring ~3.5s — see
// docs/SELLER_GENERATION_PERFORMANCE.md), so the six steps are spaced to land
// roughly with the result instead of the 25s the old 30-90s pipeline needed.
const STEP_INTERVAL_MS = 1_800
/** Only when the run is genuinely slower than normal. The server's own hard deadline is 26s, so anything past this is the tail, not the norm. */
const SLOW_PHASE_AFTER_MS = 18_000

function useLoadingSteps() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((v) => Math.min(v + 1, STEPS.length - 1)), STEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  return i
}

function useSlowPhase() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_PHASE_AFTER_MS)
    return () => clearTimeout(id)
  }, [])
  return slow
}

/**
 * No fake percentage — the steps track real pipeline stages (identify →
 * research → condition → price → listing) rather than pretending to measure
 * progress. The seller's own photo carried forward from capture keeps the
 * wait feeling like continuity, not a dead spinner.
 */
export function AnalyzingScreen({ heroImageUrl }: { heroImageUrl: string | null }) {
  const stepIndex = useLoadingSteps()
  const slow = useSlowPhase()

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center px-6 py-10 text-center sm:min-h-[calc(100dvh-4rem)]">
      <div className="relative w-full max-w-[260px] overflow-hidden rounded-3xl bg-[var(--color-cream-soft)] shadow-[var(--shadow-card)]">
        {heroImageUrl && <img src={heroImageUrl} alt="" className="aspect-[4/5] w-full object-cover" />}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-x-0 h-1/3 bg-gradient-to-b from-transparent via-[var(--color-accent)]/25 to-transparent animate-scan-line" />
        </div>
      </div>

      <div className="mt-8 flex flex-col items-center gap-2">
        {STEPS.map((label, i) => {
          if (Math.abs(i - stepIndex) > 1) return null
          return (
            <p
              key={label}
              className={`text-[15px] transition-all duration-500 ${
                i === stepIndex ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-body)]/40'
              }`}
            >
              {label}
              {i === stepIndex && <span className="ml-1 inline-block animate-pulse text-[var(--color-accent)]">…</span>}
            </p>
          )
        })}
      </div>

      {slow && (
        <p className="mt-6 max-w-xs text-sm text-[var(--color-body)]">
          Vi jämför produktinformation för att minska fel — det kan ta ytterligare en liten stund.
        </p>
      )}
    </div>
  )
}
