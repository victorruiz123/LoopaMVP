import { useLanguage } from '../i18n/LanguageContext'

export function HowItWorks() {
  const { t } = useLanguage()

  return (
    <section id="how" className="border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] py-20">
      <div className="container-loopa">
        <h2 className="max-w-2xl text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {t.howItWorks.heading}
        </h2>

        <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
          {t.howItWorks.steps.map((step, i) => (
            <div key={step.num} className="relative">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--color-accent)]">{step.num}</span>
                {i < t.howItWorks.steps.length - 1 && (
                  <span className="hidden text-[var(--color-line)] md:inline">→</span>
                )}
              </div>
              <h3 className="mt-3 text-lg font-semibold text-[var(--color-ink)]">{step.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-body)]">{step.desc}</p>
              {i === 1 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {t.howItWorks.identifyTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-[var(--color-line)] bg-white px-2.5 py-1 text-xs text-[var(--color-body)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
