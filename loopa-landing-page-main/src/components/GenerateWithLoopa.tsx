import { Link } from '../router'

const VALUE_POINTS = [
  'Automatiserad produktresearch',
  'Konsekvent skickbedömning',
  'Färdig produktlisting',
  'SEO-redo produktdata',
]

// Compact teaser for the homepage. The full, real generator experience now
// lives at /secondhand — this section points there instead of duplicating
// it inline, so the two don't compete for primacy.
export function GenerateWithLoopa() {
  return (
    <section id="generate" className="border-t border-[var(--color-line)] py-16 md:py-20">
      <div className="container-loopa">
        <h2 className="max-w-3xl text-3xl leading-[1.08] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-[44px]">
          Från bilder till SEO-redo produkt. <span className="text-[var(--color-accent)]">Automatiskt.</span>
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--color-body)]">
          Loopa researchar produkten, bedömer skicket och skapar en komplett produktlisting redo för er webshop.
        </p>

        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-[var(--color-body)]">
          {VALUE_POINTS.map((point) => (
            <li key={point} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
              {point}
            </li>
          ))}
        </ul>

        <Link
          to="/secondhand"
          className="mt-8 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
        >
          Testa generatorn för secondhandaktörer →
        </Link>
      </div>
    </section>
  )
}
