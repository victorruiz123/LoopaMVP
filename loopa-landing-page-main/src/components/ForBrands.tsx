import { useLanguage } from '../i18n/LanguageContext'
import { Link } from '../router'

export function ForBrands() {
  const { t } = useLanguage()
  const b = t.brands

  return (
    <section id="brands" className="border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] py-20">
      <div className="container-loopa">
        <div className="max-w-2xl">
          <h2 className="text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
            {b.heading}
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-[var(--color-body)]">{b.body}</p>
          <Link
            to="/brands"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            {b.cta}
          </Link>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 sm:gap-8">
          <div className="rounded-2xl border border-[var(--color-line)] bg-white p-6">
            <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
              {b.keepsHeading}
            </p>
            <ul className="mt-4 space-y-2.5">
              {b.keeps.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] text-[var(--color-ink)]">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-ink)]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-[var(--color-line)] bg-white p-6">
            <p className="text-xs font-medium tracking-wide text-[var(--color-accent)] uppercase">
              {b.automatesHeading}
            </p>
            <ul className="mt-4 space-y-2.5">
              {b.automates.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] text-[var(--color-ink)]">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
