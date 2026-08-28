import { useState, type FormEvent } from 'react'
import { useLanguage } from '../i18n/LanguageContext'

interface FormState {
  name: string
  company: string
  email: string
  message: string
}

const EMPTY: FormState = { name: '', company: '', email: '', message: '' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function Contact() {
  const { t } = useLanguage()
  const f = t.contact.form
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitted, setSubmitted] = useState(false)

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {}
    if (!form.name.trim()) next.name = f.errorRequired
    if (!form.email.trim()) next.email = f.errorRequired
    else if (!EMAIL_RE.test(form.email.trim())) next.email = f.errorEmail
    if (!form.message.trim()) next.message = f.errorRequired
    setErrors(next)
    return Object.keys(next).length === 0
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!validate()) return
    setSubmitted(true)
    setForm(EMPTY)
  }

  const inputClass = (hasError: boolean) =>
    `w-full rounded-xl border px-4 py-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] ${
      hasError ? 'border-red-400' : 'border-[var(--color-line)]'
    }`

  return (
    <section id="contact" className="border-t border-[var(--color-line)] py-20">
      <div className="container-loopa grid gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
            {t.contact.heading}
          </h2>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-[var(--color-body)]">
            {t.contact.body}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <a
              href="mailto:info@loopa.nu"
              className="font-medium text-[var(--color-ink)] underline underline-offset-4"
            >
              info@loopa.nu
            </a>
            <span className="text-[var(--color-body)]">{t.footer.location}</span>
          </div>
          <p className="mt-2 text-sm text-[var(--color-body)]">
            {t.contact.generalNote}{' '}
            <a href="mailto:info@loopa.nu" className="underline underline-offset-4">
              info@loopa.nu
            </a>
          </p>
        </div>

        <div id="contact-form" className="rounded-2xl border border-[var(--color-line)] bg-white p-6 shadow-[var(--shadow-card)] sm:p-8">
          {submitted ? (
            <div className="flex flex-col items-center py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-2xl text-green-600">
                ✓
              </div>
              <p className="mt-4 font-medium text-[var(--color-ink)]">{f.success}</p>
              <button
                type="button"
                onClick={() => setSubmitted(false)}
                className="mt-5 text-sm text-[var(--color-accent)] underline underline-offset-4"
              >
                {t.nav.contact}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">
                    {f.name}
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    className={inputClass(!!errors.name)}
                  />
                  {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">
                    {f.company}
                  </label>
                  <input
                    value={form.company}
                    onChange={(e) => update('company', e.target.value)}
                    className={inputClass(false)}
                  />
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">
                  {f.email}
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => update('email', e.target.value)}
                  className={inputClass(!!errors.email)}
                />
                {errors.email && <p className="mt-1 text-xs text-red-500">{errors.email}</p>}
              </div>

              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">
                  {f.message}
                </label>
                <textarea
                  rows={4}
                  value={form.message}
                  onChange={(e) => update('message', e.target.value)}
                  className={inputClass(!!errors.message)}
                />
                {errors.message && <p className="mt-1 text-xs text-red-500">{errors.message}</p>}
              </div>

              <button
                type="submit"
                className="mt-6 w-full rounded-full bg-[var(--color-ink)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-black"
              >
                {f.submit}
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
