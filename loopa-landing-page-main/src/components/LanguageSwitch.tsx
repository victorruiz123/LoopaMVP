import { useLanguage } from '../i18n/LanguageContext'

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { language, setLanguage } = useLanguage()

  return (
    <div
      className={`inline-flex items-center rounded-full border border-[var(--color-line)] bg-white p-0.5 text-sm font-medium ${className}`}
      role="group"
      aria-label="Language"
    >
      {(['en', 'sv'] as const).map((lang) => (
        <button
          key={lang}
          type="button"
          onClick={() => setLanguage(lang)}
          aria-pressed={language === lang}
          className={`rounded-full px-2.5 py-1 uppercase transition-colors ${
            language === lang
              ? 'bg-[var(--color-ink)] text-white'
              : 'text-[var(--color-body)] hover:text-[var(--color-ink)]'
          }`}
        >
          {lang}
        </button>
      ))}
    </div>
  )
}
