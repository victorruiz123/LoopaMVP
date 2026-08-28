import { useLanguage } from '../i18n/LanguageContext'
import { SoffadirektStorefront } from './SoffadirektStorefront'

export function FurnitureProof() {
  const { t } = useLanguage()
  const f = t.furnitureProof

  return (
    <div>
      <h3 className="max-w-xl text-2xl font-bold text-[var(--color-ink)] sm:text-3xl">{f.heading}</h3>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--color-body)]">{f.body}</p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 sm:items-start">
        <div className="overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
          <img
            src="/assets/brand-examples/lamino.webp"
            alt="Swedese Lamino"
            className="aspect-[4/3] w-full object-cover sm:aspect-[4/5]"
          />
        </div>
        <div className="rounded-2xl border border-[var(--color-line)] bg-white p-5 sm:p-6">
          <h4 className="flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
            <span className="text-green-600">✓</span> {f.identifiedHeading}
          </h4>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--color-body)] uppercase">{f.brandLabel}</dt>
              <dd className="font-medium text-[var(--color-ink)]">{f.brand}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-body)] uppercase">{f.modelLabel}</dt>
              <dd className="font-medium text-[var(--color-ink)]">{f.model}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mt-8">
        <SoffadirektStorefront />
      </div>
    </div>
  )
}
