import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { localDemoAnswer } from '../lib/listingQA'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  source?: 'gemini' | 'faq' | 'guard' | 'guard-post' | 'local-demo'
}

export function AskLoopaChat({ onClose }: { onClose: () => void }) {
  const { t, language } = useLanguage()
  const c = t.chat
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', text: c.greeting }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function send(question: string) {
    const text = question.trim()
    if (!text || loading) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, lang: language }),
      })
      if (!res.ok) throw new Error('bad response')
      const data = (await res.json()) as { reply: string; source: ChatMessage['source'] }
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply, source: data.source }])
    } catch {
      // No Functions runtime available (e.g. plain `vite dev`) or network
      // error, fall back to the same deterministic local-demo logic,
      // clearly labeled in the UI.
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: localDemoAnswer(text, language), source: 'local-demo' },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={c.title}
        className="flex h-[85vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:h-[600px] sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-line)] p-4">
          <div>
            <h3 className="text-base font-semibold text-[var(--color-ink)]">{c.title}</h3>
            <p className="text-xs text-[var(--color-body)]">{c.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={c.close}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-body)] hover:bg-[var(--color-cream-soft)]"
          >
            ✕
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-[var(--color-ink)] text-white'
                    : 'bg-[var(--color-cream-soft)] text-[var(--color-ink)]'
                }`}
              >
                {m.text}
                {m.source === 'local-demo' && (
                  <div className="mt-1.5 text-[11px] font-medium text-[var(--color-accent)]">
                    {c.localDemoBadge}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-[var(--color-cream-soft)] px-4 py-2.5 text-[14px] text-[var(--color-body)]">
                {c.thinking}
              </div>
            </div>
          )}
        </div>

        {messages.length < 3 && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] p-3">
            {c.suggested.slice(0, 4).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-body)] transition-colors hover:bg-[var(--color-cream-soft)]"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
          className="flex items-center gap-2 border-t border-[var(--color-line)] p-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={c.placeholder}
            className="flex-1 rounded-full border border-[var(--color-line)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="rounded-full bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {c.send}
          </button>
        </form>
      </div>
    </div>
  )
}
