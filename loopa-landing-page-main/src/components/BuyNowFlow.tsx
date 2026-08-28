import { useEffect, useMemo, useRef, useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { generateDeliverySlots, type DeliverySlot } from '../data/deliverySlots'

type Step = 'summary' | 'delivery' | 'waiting' | 'confirmed' | 'tracker' | 'done'

export function BuyNowFlow({ onClose }: { onClose: () => void }) {
  const { t, language } = useLanguage()
  const b = t.buyFlow
  const l = t.listingDemo

  const [step, setStep] = useState<Step>('summary')
  const [selected, setSelected] = useState<string[]>([])
  const [confirmedSlot, setConfirmedSlot] = useState<DeliverySlot | null>(null)
  const [stageIndex, setStageIndex] = useState(0)

  const slots = useMemo(() => generateDeliverySlots(language), [language])
  const waitingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (step !== 'waiting') return
    waitingTimer.current = setTimeout(() => {
      const chosen = slots.find((s) => s.id === selected[Math.floor(Math.random() * selected.length)])
      setConfirmedSlot(chosen ?? null)
      setStep('confirmed')
    }, 1600)
    return () => {
      if (waitingTimer.current) clearTimeout(waitingTimer.current)
    }
  }, [step, selected, slots])

  useEffect(() => {
    if (step !== 'tracker') return
    setStageIndex(0)
    let i = 0
    stageTimer.current = setInterval(() => {
      i += 1
      if (i >= b.trackerStages.length) {
        setStageIndex(b.trackerStages.length - 1)
        if (stageTimer.current) clearInterval(stageTimer.current)
        setTimeout(() => setStep('done'), 900)
        return
      }
      setStageIndex(i)
    }, 1500)
    return () => {
      if (stageTimer.current) clearInterval(stageTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  function toggleSlot(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((s) => s !== id)
      if (prev.length >= 3) return prev
      return [...prev, id]
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-line)] p-4">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">{l.productTitle}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={b.close}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-body)] hover:bg-[var(--color-cream-soft)]"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-6">
          {step === 'summary' && (
            <div>
              <h4 className="text-lg font-semibold text-[var(--color-ink)]">{b.summaryTitle}</h4>
              <div className="mt-4 overflow-hidden rounded-xl border border-[var(--color-line)]">
                <img src="/assets/ikea/img-8304.webp" alt={l.productTitle} className="aspect-video w-full object-cover" />
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-[var(--color-body)]">{b.summaryItemLabel}</dt>
                  <dd className="font-medium text-[var(--color-ink)]">{l.productTitle}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--color-body)]">{b.summaryPriceLabel}</dt>
                  <dd className="font-semibold text-[var(--color-ink)]">{l.priceValue}</dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-[var(--color-body)]">{b.summaryDisclaimer}</p>
              <button
                type="button"
                onClick={() => setStep('delivery')}
                className="mt-6 w-full rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
              >
                {b.summaryContinue}
              </button>
            </div>
          )}

          {step === 'delivery' && (
            <div>
              <h4 className="text-lg font-semibold text-[var(--color-ink)]">{b.deliveryHeading}</h4>
              <p className="mt-1 text-sm text-[var(--color-body)]">{b.deliveryHelper}</p>

              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {slots.map((slot) => {
                  const isSelected = selected.includes(slot.id)
                  const disabled = !isSelected && selected.length >= 3
                  return (
                    <button
                      key={slot.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleSlot(slot.id)}
                      className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors ${
                        isSelected
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent-bg,#fdf1ec)]'
                          : 'border-[var(--color-line)] hover:bg-[var(--color-cream-soft)]'
                      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                    >
                      <span>
                        <span className="block font-medium text-[var(--color-ink)] capitalize">
                          {slot.dateLabel}
                        </span>
                        <span className="text-[var(--color-body)]">{slot.timeLabel}</span>
                      </span>
                      {isSelected && <span className="text-[var(--color-accent)]">✓</span>}
                    </button>
                  )
                })}
              </div>

              <div className="mt-5 flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--color-body)]">
                  {b.deliveryCounter(selected.length)}
                </span>
                <button
                  type="button"
                  disabled={selected.length !== 3}
                  onClick={() => setStep('waiting')}
                  className="rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {b.deliverySend}
                </button>
              </div>
            </div>
          )}

          {step === 'waiting' && (
            <div className="flex flex-col items-center py-10 text-center">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" />
              <h4 className="mt-5 text-lg font-semibold text-[var(--color-ink)]">{b.waitingHeading}</h4>
              <p className="mt-1 text-sm text-[var(--color-body)]">{b.waitingSub}</p>
            </div>
          )}

          {step === 'confirmed' && (
            <div className="flex flex-col items-center py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-2xl text-green-600">
                ✓
              </div>
              <h4 className="mt-5 text-lg font-semibold text-[var(--color-ink)]">{b.confirmedHeading}</h4>
              {confirmedSlot && (
                <p className="mt-2 text-sm text-[var(--color-body)]">
                  {b.confirmedSub}{' '}
                  <span className="font-medium text-[var(--color-ink)] capitalize">
                    {confirmedSlot.dateLabel}, {confirmedSlot.timeLabel}
                  </span>
                </p>
              )}
              <button
                type="button"
                onClick={() => setStep('tracker')}
                className="mt-6 w-full rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
              >
                {b.confirmedContinue}
              </button>
            </div>
          )}

          {step === 'tracker' && (
            <div>
              <h4 className="text-lg font-semibold text-[var(--color-ink)]">{b.trackerHeading}</h4>
              <p className="mt-1 text-xs text-[var(--color-body)]">{b.trackerDisclaimer}</p>

              <div className="mt-8 px-2">
                <div className="relative h-1 rounded-full bg-[var(--color-line)]">
                  <div
                    className="absolute top-0 left-0 h-1 rounded-full bg-[var(--color-accent)] transition-all duration-700 ease-out"
                    style={{
                      width: `${(stageIndex / (b.trackerStages.length - 1)) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute -top-3 text-xl transition-all duration-700 ease-out"
                    style={{
                      left: `calc(${(stageIndex / (b.trackerStages.length - 1)) * 100}% - 12px)`,
                    }}
                    aria-hidden
                  >
                    🚚
                  </div>
                </div>
              </div>

              <ol className="mt-8 space-y-3">
                {b.trackerStages.map((stage, i) => (
                  <li key={stage} className="flex items-center gap-3 text-sm">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        i <= stageIndex
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'bg-[var(--color-line)] text-[var(--color-body)]'
                      }`}
                    >
                      {i < stageIndex ? '✓' : i + 1}
                    </span>
                    <span
                      className={
                        i <= stageIndex
                          ? 'font-medium text-[var(--color-ink)]'
                          : 'text-[var(--color-body)]'
                      }
                    >
                      {stage}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center py-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-3xl text-green-600">
                ✓
              </div>
              <h4 className="mt-5 text-xl font-semibold text-[var(--color-ink)]">{b.doneHeading}</h4>
              <p className="mt-2 text-sm text-[var(--color-body)]">{b.doneSub}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 w-full rounded-full bg-[var(--color-ink)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-black"
              >
                {b.doneButton}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
