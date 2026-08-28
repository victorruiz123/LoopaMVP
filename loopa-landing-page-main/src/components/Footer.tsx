import { useLanguage } from '../i18n/LanguageContext'
import { LanguageSwitch } from './LanguageSwitch'
import { Link, useRoute } from '../router'

export function Footer() {
  const { t } = useLanguage()
  const pathname = useRoute()
  const onHome = pathname !== '/secondhand' && pathname !== '/brands'
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-[var(--color-line)]">
      <div className="container-loopa flex flex-col gap-8 py-12 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span className="text-xl font-bold tracking-tight text-[var(--color-accent)]">Loopa</span>
          <p className="mt-3 max-w-xs text-sm text-[var(--color-body)]">{t.footer.tagline}</p>
          <p className="mt-1 text-sm text-[var(--color-body)]">{t.footer.location}</p>
          <LanguageSwitch className="mt-4" />
        </div>

        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--color-body)]">
          <Link to="/company" className="hover:text-[var(--color-ink)]">
            {t.nav.home}
          </Link>
          {onHome ? (
            <a href="#about" className="hover:text-[var(--color-ink)]">
              {t.nav.about}
            </a>
          ) : (
            <Link to="/company#about" className="hover:text-[var(--color-ink)]">
              {t.nav.about}
            </Link>
          )}
          <Link to="/brands" className="hover:text-[var(--color-ink)]">
            {t.nav.brands}
          </Link>
          <Link to="/secondhand" className="hover:text-[var(--color-ink)]">
            {t.nav.secondhand}
          </Link>
          <a href="/company#contact-form" className="hover:text-[var(--color-ink)]">
            {t.nav.contact}
          </a>
        </nav>
      </div>
      <div className="container-loopa border-t border-[var(--color-line)] py-5 text-xs text-[var(--color-body)]">
        © {year} Loopa
      </div>
    </footer>
  )
}
