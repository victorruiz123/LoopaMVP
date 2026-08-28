import { useLanguage } from '../i18n/LanguageContext'

export function About() {
  const { t } = useLanguage()

  return (
    <section id="about" className="border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] py-20">
      <div className="container-loopa grid gap-8 sm:grid-cols-2 sm:gap-12">
        <h2 className="text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {t.about.heading}
        </h2>
        <div>
          <p className="text-[15px] leading-relaxed text-[var(--color-body)]">{t.about.body}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <span className="rounded-full border border-[var(--color-line)] bg-white px-4 py-2 text-sm text-[var(--color-ink)]">
              {t.about.badge1}
            </span>
            <span className="rounded-full border border-[var(--color-line)] bg-white px-4 py-2 text-sm text-[var(--color-ink)]">
              {t.about.badge2}
            </span>
          </div>
          <p className="mt-4 text-sm text-[var(--color-body)]">{t.about.originNote}</p>
        </div>
      </div>
    </section>
  )
}
