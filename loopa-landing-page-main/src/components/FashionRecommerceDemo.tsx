import { useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { FashionProductPhoto } from './FashionProductPhoto'

type Stage = 1 | 2 | 3 | 4
type SellPhase = 'product' | 'photos'
type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export function FashionRecommerceDemo() {
  const { t } = useLanguage()
  const d = t.brandsDemo

  const [stage, setStage] = useState<Stage>(1)
  const [sellPhase, setSellPhase] = useState<SellPhase>('product')
  const [approval, setApproval] = useState<ApprovalStatus>('pending')

  function goToStage(next: Stage) {
    setStage(next)
  }

  function approve() {
    setApproval('approved')
    setTimeout(() => setStage(4), 900)
  }

  function reset() {
    setStage(1)
    setSellPhase('product')
    setApproval('pending')
  }

  return (
    <div>
      <h3 className="max-w-2xl text-2xl font-bold text-[var(--color-ink)] sm:text-3xl">{d.heading}</h3>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--color-body)]">{d.body}</p>

      <div className="mt-8 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-5 py-4 sm:gap-3">
        {d.stageLabels.map((label, i) => {
          const num = (i + 1) as Stage
          const active = num === stage
          const complete = num < stage
          return (
            <div key={label} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => goToStage(num)}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--color-accent)] text-white'
                    : complete
                      ? 'bg-[var(--color-ink)] text-white'
                      : 'bg-[var(--color-cream-soft)] text-[var(--color-body)] hover:text-[var(--color-ink)]'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                    active || complete ? 'bg-white/20' : 'bg-white'
                  }`}
                >
                  {complete ? '✓' : num}
                </span>
                <span className="hidden sm:inline">{label}</span>
              </button>
              {i < d.stageLabels.length - 1 && <span className="text-[var(--color-line)]">→</span>}
            </div>
          )
        })}
        <button
          type="button"
          onClick={reset}
          className="ml-auto text-xs text-[var(--color-body)] underline underline-offset-4"
        >
          {d.resetLabel}
        </button>
      </div>

      <div className="p-6 sm:p-8">
        {stage === 1 && (
          <div className="grid gap-6 sm:grid-cols-2">
            {sellPhase === 'product' ? (
              <>
                <FashionProductPhoto variant="full" className="aspect-[4/5] w-full" />
                <div>
                  <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
                    {d.sell.brandName}
                  </p>
                  <h4 className="text-2xl font-bold text-[var(--color-ink)]">{d.sell.itemName}</h4>
                  <div className="mt-3 flex items-baseline gap-2 text-sm">
                    <span className="text-[var(--color-body)]">{d.sell.newLabel}</span>
                    <span className="font-semibold text-[var(--color-ink)]">{d.sell.newPrice}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSellPhase('photos')}
                    className="mt-5 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
                  >
                    {d.sell.sellBackButton}
                  </button>
                </div>
              </>
            ) : (
              <div className="sm:col-span-2">
                <p className="text-sm font-medium text-[var(--color-ink)]">{d.sell.twoPhotosNote}</p>
                <div className="mt-4 grid max-w-sm grid-cols-2 gap-4">
                  <div className="text-center">
                    <FashionProductPhoto variant="front" className="aspect-square w-full" />
                    <p className="mt-2 text-xs text-[var(--color-body)]">{d.sell.garmentPhotoLabel}</p>
                  </div>
                  <div className="text-center">
                    <FashionProductPhoto variant="detail" className="aspect-square w-full" />
                    <p className="mt-2 text-xs text-[var(--color-body)]">{d.sell.labelPhotoLabel}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => goToStage(2)}
                  className="mt-6 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
                >
                  {d.sell.continueButton}
                </button>
              </div>
            )}
          </div>
        )}

        {stage === 2 && (
          <div className="grid gap-6 sm:grid-cols-2">
            <FashionProductPhoto variant="front" className="aspect-[4/5] w-full" scanning />
            <div>
              <h4 className="flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
                <span className="text-green-600">✓</span> {d.ai.heading}
              </h4>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div className="animate-fade-up" style={{ animationDelay: '80ms' }}>
                  <dt className="text-xs text-[var(--color-body)] uppercase">{d.ai.colorLabel}</dt>
                  <dd className="font-medium text-[var(--color-ink)]">{d.ai.color}</dd>
                </div>
                <div className="animate-fade-up" style={{ animationDelay: '160ms' }}>
                  <dt className="text-xs text-[var(--color-body)] uppercase">{d.ai.sizeLabel}</dt>
                  <dd className="font-medium text-[var(--color-ink)]">{d.ai.size}</dd>
                </div>
                <div className="animate-fade-up" style={{ animationDelay: '240ms' }}>
                  <dt className="text-xs text-[var(--color-body)] uppercase">{d.ai.materialLabel}</dt>
                  <dd className="font-medium text-[var(--color-ink)]">{d.ai.material}</dd>
                </div>
                <div className="animate-fade-up" style={{ animationDelay: '320ms' }}>
                  <dt className="text-xs text-[var(--color-body)] uppercase">{d.ai.conditionLabel}</dt>
                  <dd className="font-medium text-[var(--color-ink)]">{d.ai.conditionValue}</dd>
                </div>
              </dl>

              <span className="animate-fade-up mt-4 inline-flex items-center gap-1 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700" style={{ animationDelay: '400ms' }}>
                ✓ {d.ai.eligibleLabel}
              </span>

              <div
                className="animate-fade-up mt-4 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 p-4"
                style={{ animationDelay: '440ms' }}
              >
                <p className="text-xs font-medium tracking-wide text-[var(--color-accent)] uppercase">
                  {d.ai.recommendedPriceLabel}
                </p>
                <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">{d.ai.recommendedPrice}</p>
              </div>

              <div className="animate-fade-up mt-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-cream-soft)] p-4" style={{ animationDelay: '480ms' }}>
                <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
                  {d.ai.offerHeading}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  <span className="font-semibold text-[var(--color-ink)]">{d.ai.offerCash}</span>
                  <span className="text-[var(--color-body)]">{t.common.or}</span>
                  <span className="font-semibold text-[var(--color-ink)]">{d.ai.offerCredit}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => goToStage(3)}
                className="mt-6 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
              >
                {d.ai.continueButton}
              </button>
            </div>
          </div>
        )}

        {stage === 3 && (
          <div className="max-w-md">
            <h4 className="text-lg font-semibold text-[var(--color-ink)]">{d.approve.heading}</h4>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-body)]">{d.approve.automationNote}</p>
            <dl className="mt-4 space-y-2 rounded-xl border border-[var(--color-line)] p-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--color-body)]">{d.approve.productLabel}</dt>
                <dd className="font-medium text-[var(--color-ink)]">{d.sell.itemName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-body)]">{d.approve.customerLabel}</dt>
                <dd className="font-medium text-[var(--color-ink)]">{d.approve.customerValue}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-body)]">{d.approve.conditionLabel}</dt>
                <dd className="font-medium text-[var(--color-ink)]">{d.ai.conditionValue}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-body)]">{d.approve.suggestedPriceLabel}</dt>
                <dd className="font-medium text-[var(--color-ink)]">{d.ai.recommendedPrice}</dd>
              </div>
              <div className="flex justify-between border-t border-[var(--color-line)] pt-2">
                <dt className="text-[var(--color-body)]">{d.approve.suggestedCreditLabel}</dt>
                <dd className="font-semibold text-[var(--color-ink)]">{d.ai.offerCredit}</dd>
              </div>
            </dl>

            {approval === 'pending' && (
              <div className="mt-5 flex gap-3">
                <button
                  type="button"
                  onClick={approve}
                  className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
                >
                  {d.approve.approveButton}
                </button>
                <button
                  type="button"
                  onClick={() => setApproval('rejected')}
                  className="inline-flex items-center justify-center rounded-full border border-[var(--color-line)] px-6 py-3 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
                >
                  {d.approve.rejectButton}
                </button>
              </div>
            )}

            {approval === 'approved' && (
              <div className="mt-5 flex items-center gap-3 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
                <span>✓</span>
                <div>
                  <p className="font-medium">{d.approve.approvedNote}</p>
                  <p className="text-xs text-green-700/80">{d.approve.inventoryNote}</p>
                </div>
              </div>
            )}

            {approval === 'rejected' && (
              <div className="mt-5">
                <p className="text-sm text-[var(--color-body)]">{d.approve.rejectedNote}</p>
                <button
                  type="button"
                  onClick={() => setApproval('pending')}
                  className="mt-3 rounded-full border border-[var(--color-line)] px-5 py-2.5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
                >
                  {d.approve.tryAgainButton}
                </button>
              </div>
            )}
          </div>
        )}

        {stage === 4 && (
          <div>
            <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
              {d.resell.brandPageLabel}
            </p>
            <div className="mt-2 grid gap-6 sm:grid-cols-2">
              <div>
                <h4 className="text-xl font-bold text-[var(--color-ink)]">{d.sell.itemName}</h4>
                <div className="mt-3 space-y-1.5 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[var(--color-body)]">{d.sell.newLabel}</span>
                    <span className="font-medium text-[var(--color-ink)]">{d.sell.newPrice}</span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[var(--color-body)]">{d.resell.preLovedLabel}</span>
                    <span className="font-medium text-[var(--color-ink)]">{d.resell.preLovedPrice}</span>
                    <span className="text-xs text-[var(--color-body)]">{d.resell.available}</span>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-[var(--color-line)]">
                <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-cream-soft)] px-3 py-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-line)]" />
                  <span className="text-xs text-[var(--color-body)]">{d.resell.secondhandUrl}</span>
                </div>
                <div className="flex gap-3 p-3">
                  <FashionProductPhoto variant="front" className="h-20 w-20 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-[var(--color-ink)]">
                      {d.resell.productCardName}
                    </p>
                    <p className="text-sm font-medium text-[var(--color-ink)]">{d.resell.preLovedPrice}</p>
                    <p className="text-xs text-[var(--color-body)]">
                      {d.resell.conditionLabel}: {d.resell.conditionValue}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <span className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-body)]">
                {d.resell.brandOwnsChip}
              </span>
              <span className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-body)]">
                {d.resell.loopaPowersChip}
              </span>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="#contact"
                className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
              >
                {t.brands.pilotCta}
              </a>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center rounded-full border border-[var(--color-line)] px-6 py-3 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
              >
                {d.resetLabel}
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
