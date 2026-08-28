import { useLanguage } from '../i18n/LanguageContext'
import { TEAM } from '../data/people'

export function Team() {
  const { t } = useLanguage()

  return (
    <section id="team" className="border-t border-[var(--color-line)] py-20">
      <div className="container-loopa">
        <h2 className="text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {t.team.heading}
        </h2>

        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {t.team.members.map((member, i) => {
            const person = TEAM[i]
            return (
              <div key={member.name}>
                <div className="aspect-[4/5] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-cream-soft)]">
                  <img src={person.photo} alt={member.name} className="h-full w-full object-cover" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-[var(--color-ink)]">{member.name}</h3>
                <p className="text-sm font-medium text-[var(--color-accent)]">{member.role}</p>
                <p className="mt-1 text-sm text-[var(--color-body)]">{member.bio}</p>
                <a
                  href={person.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm text-[var(--color-ink)] underline underline-offset-4"
                >
                  {t.common.linkedin}
                </a>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
