import { useLanguage } from '../i18n/LanguageContext'

export function Technology() {
  const { t } = useLanguage()
  const tech = t.technology

  return (
    <section className="border-t border-[var(--color-line)] py-20">
      <div className="container-loopa">
        <h2 className="max-w-2xl text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {tech.heading}
        </h2>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--color-body)]">{tech.body}</p>

        <div className="mt-10 max-w-xl rounded-2xl border border-[var(--color-line)] bg-[var(--color-cream-soft)] p-6 sm:p-8">
          <p className="text-xs font-medium tracking-wide text-[var(--color-accent)] uppercase">
            {tech.layer1Label}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {tech.layer1Items.map((item) => (
              <span
                key={item}
                className="rounded-full border border-[var(--color-line)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-ink)]"
              >
                {item}
              </span>
            ))}
          </div>

          <div className="my-4 flex justify-center text-[var(--color-line)]">↓</div>

          <p className="text-xs font-medium tracking-wide text-[var(--color-accent)] uppercase">
            {tech.layer2Label}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {tech.layer2Items.map((item) => (
              <span
                key={item}
                className="rounded-full border border-[var(--color-line)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-ink)]"
              >
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[var(--color-line)] pt-8">
          {tech.current.map((cat) => (
            <span key={cat} className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink)]">
              {cat}
              <span className="rounded-full bg-[var(--color-accent)] px-2.5 py-0.5 text-xs font-medium text-white">
                {tech.currentLabel}
              </span>
            </span>
          ))}
          {tech.future.map((cat) => (
            <span key={cat} className="flex items-center gap-1.5 text-sm text-[var(--color-body)]">
              {cat}
              <span className="text-xs text-[var(--color-body)]/70">{tech.futureLabel}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
