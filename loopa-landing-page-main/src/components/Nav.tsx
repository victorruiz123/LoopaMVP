import { useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { LanguageSwitch } from './LanguageSwitch'
import { Link, useRoute } from '../router'

// One shared header, identical on every page — /company, /brands and
// /secondhand all render this same Nav via App.tsx. Fixed order: Hem,
// About us, För varumärken, För secondhandaktörer.
export function Nav() {
  const { t } = useLanguage()
  const pathname = useRoute()
  const [open, setOpen] = useState(false)
  const onHome = pathname !== '/secondhand' && pathname !== '/brands'

  // "About us" points at the About section on /company. From /company
  // itself a plain same-page anchor gives native scroll behaviour; from any
  // other page it needs a real route change first, so the router's Link is
  // used there instead (matches the same onHome-conditional pattern already
  // proven for "Kontakta oss" below).
  const aboutLink = onHome ? (
    <a href="#about" className="text-[15px] font-medium text-[var(--color-body)] transition-colors hover:text-[var(--color-ink)]">
      {t.nav.about}
    </a>
  ) : (
    <Link to="/company#about" className="text-[15px] font-medium text-[var(--color-body)] transition-colors hover:text-[var(--color-ink)]">
      {t.nav.about}
    </Link>
  )

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-cream)]/90 backdrop-blur">
      <div className="container-loopa flex h-16 items-center justify-between md:h-20">
        <Link to="/company" className="text-xl font-bold tracking-tight text-[var(--color-accent)]">
          Loopa
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          <Link
            to="/company"
            className={`text-[15px] font-medium transition-colors ${
              pathname === '/company' ? 'text-[var(--color-ink)]' : 'text-[var(--color-body)] hover:text-[var(--color-ink)]'
            }`}
          >
            {t.nav.home}
          </Link>
          {aboutLink}
          <Link
            to="/brands"
            className={`text-[15px] font-medium transition-colors ${
              pathname === '/brands' ? 'text-[var(--color-ink)]' : 'text-[var(--color-body)] hover:text-[var(--color-ink)]'
            }`}
          >
            {t.nav.brands}
          </Link>
          <Link
            to="/secondhand"
            className={`text-[15px] font-medium transition-colors ${
              pathname === '/secondhand' ? 'text-[var(--color-ink)]' : 'text-[var(--color-body)] hover:text-[var(--color-ink)]'
            }`}
          >
            {t.nav.secondhand}
          </Link>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <LanguageSwitch />
          <a
            href="/company#contact-form"
            className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-5 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            {t.nav.contact}
          </a>
        </div>

        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-line)] md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={open}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M2 5h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-cream)] md:hidden">
          <div className="container-loopa flex flex-col gap-1 py-4">
            <Link
              to="/company"
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-2.5 text-[15px] font-medium text-[var(--color-ink)] hover:bg-white"
            >
              {t.nav.home}
            </Link>
            {onHome ? (
              <a
                href="#about"
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-2.5 text-[15px] font-medium text-[var(--color-ink)] hover:bg-white"
              >
                {t.nav.about}
              </a>
            ) : (
              <Link
                to="/company#about"
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-2.5 text-[15px] font-medium text-[var(--color-ink)] hover:bg-white"
              >
                {t.nav.about}
              </Link>
            )}
            <Link
              to="/brands"
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-2.5 text-[15px] font-medium text-[var(--color-ink)] hover:bg-white"
            >
              {t.nav.brands}
            </Link>
            <Link
              to="/secondhand"
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-2.5 text-[15px] font-medium text-[var(--color-ink)] hover:bg-white"
            >
              {t.nav.secondhand}
            </Link>
            <div className="mt-2 flex items-center justify-between gap-3 px-2">
              <LanguageSwitch />
              <a
                href="/company#contact-form"
                onClick={() => setOpen(false)}
                className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-5 py-2.5 text-[15px] font-medium text-white"
              >
                {t.nav.contact}
              </a>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
