import { useLanguage } from '../i18n/LanguageContext'
import { ADVISORS } from '../data/people'

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function Advisors() {
  const { t, language } = useLanguage()

  return (
    <section className="border-t border-[var(--color-line)] bg-[var(--color-cream-soft)] py-20">
      <div className="container-loopa">
        <h2 className="text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {t.advisors.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--color-body)]">
          {t.advisors.body}
        </p>

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {ADVISORS.map((advisor) => (
            <div
              key={advisor.name}
              className="flex flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white shadow-[var(--shadow-card)]"
            >
              <div className="aspect-square w-full overflow-hidden bg-[var(--color-cream-soft)]">
                {advisor.photo ? (
                  <img src={advisor.photo} alt={advisor.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[var(--color-body)]">
                    {initials(advisor.name)}
                  </div>
                )}
              </div>
              <div className="flex flex-1 flex-col p-5">
                <h3 className="font-semibold text-[var(--color-ink)]">{advisor.name}</h3>
                <p className="mt-0.5 text-sm font-medium text-[var(--color-accent)]">
                  {advisor.role[language]}
                </p>
                <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-body)]">
                  {advisor.bio[language]}
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {advisor.tags[language].map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-[var(--color-line)] bg-[var(--color-cream-soft)] px-2.5 py-1 text-xs text-[var(--color-body)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <a
                  href={advisor.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-block text-sm text-[var(--color-ink)] underline underline-offset-4"
                >
                  {t.common.linkedin}
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
