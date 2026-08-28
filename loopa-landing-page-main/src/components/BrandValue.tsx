import { useLanguage } from '../i18n/LanguageContext'

export function BrandValue() {
  const { t } = useLanguage()
  const v = t.brandValue

  return (
    <section className="border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] py-20">
      <div className="container-loopa">
        <h2 className="max-w-2xl text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {v.heading}
        </h2>

        <div className="mt-12 grid gap-12 sm:grid-cols-2">
          {v.pillars.map((pillar) => (
            <div key={pillar.title}>
              <div className="flex items-baseline gap-3 border-b border-[var(--color-line)] pb-3">
                <h3 className="text-2xl font-bold text-[var(--color-ink)]">{pillar.title}</h3>
                <span className="text-sm text-[var(--color-body)]">{pillar.tagline}</span>
              </div>
              <div className="mt-5 space-y-5">
                {pillar.items.map((item) => (
                  <div key={item.h}>
                    <h4 className="font-semibold text-[var(--color-ink)]">{item.h}</h4>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--color-body)]">{item.b}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
