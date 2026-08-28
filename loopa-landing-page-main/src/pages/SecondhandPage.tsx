import { useLanguage } from '../i18n/LanguageContext'
import { RealGenerator } from '../features/generator/RealGenerator'

export function SecondhandPage() {
  const { t } = useLanguage()
  const s = t.secondhandPage

  return (
    <div>
      {/* Compact hero — generator visible almost immediately */}
      <section className="container-loopa pt-10 pb-8 md:pt-14 md:pb-10">
        <p className="text-xs font-semibold tracking-wide text-[var(--color-accent)] uppercase">{s.hero.eyebrow}</p>
        <h1 className="mt-3 max-w-3xl text-4xl leading-[1.06] font-bold tracking-tight text-[var(--color-ink)] sm:text-5xl md:text-[54px]">
          {s.hero.titleLine1} <span className="text-[var(--color-accent)]">{s.hero.titleAccent}</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--color-body)]">{s.hero.subtitle}</p>
        <p className="mt-2 max-w-2xl text-base font-medium text-[var(--color-ink)]">{s.hero.subtitle2}</p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href="#generator"
            className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            {s.hero.ctaPrimary}
          </a>
          <a
            href="/company#contact-form"
            className="inline-flex items-center justify-center rounded-full border border-[var(--color-line)] bg-white px-6 py-3 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
          >
            {s.hero.ctaSecondary}
          </a>
        </div>
      </section>

      {/* Generator — the visual centerpiece */}
      <section id="generator" className="container-loopa pb-16 md:pb-20">
        <RealGenerator />
      </section>

      {/* Business value — four, concise, no fabricated numbers */}
      <section className="border-t border-[var(--color-line)] bg-white py-14 md:py-16">
        <div className="container-loopa">
          <h2 className="text-2xl font-bold tracking-tight text-[var(--color-ink)] sm:text-3xl">{s.why.heading}</h2>
          <div className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {s.why.values.map((v) => (
              <div key={v.title}>
                <h3 className="text-base font-semibold text-[var(--color-ink)]">{v.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-body)]">{v.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
