// Minimal client-side router. This site has 2-3 routes total, so a full
// router library is unnecessary infrastructure — pushState + a popstate
// listener covers it. `_redirects` in public/ provides the SPA fallback
// (/* -> /index.html) so hard refreshes and direct links to /secondhand
// work in production.

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

const NAVIGATE_EVENT = 'loopa:navigate'

export function navigate(path: string): void {
  if (normalize(window.location.pathname) === normalize(path)) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
  window.scrollTo(0, 0)
}

export function useRoute(): string {
  const [pathname, setPathname] = useState(() => normalize(window.location.pathname))
  useEffect(() => {
    const onChange = () => setPathname(normalize(window.location.pathname))
    window.addEventListener('popstate', onChange)
    window.addEventListener(NAVIGATE_EVENT, onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener(NAVIGATE_EVENT, onChange)
    }
  }, [])
  return pathname
}

/**
 * On a fresh cross-page load (e.g. /company#contact-form), the browser
 * attempts its native hash scroll before React has rendered the page — the
 * target element doesn't exist yet, so the attempt silently does nothing and
 * the page is left at the top. Retries the scroll for a few frames after
 * this route's content has actually mounted.
 */
export function useScrollToHash(pathname: string): void {
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id) return
    let attempts = 0
    let frame: number
    const tryScroll = () => {
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        return
      }
      attempts += 1
      if (attempts < 10) frame = requestAnimationFrame(tryScroll)
    }
    frame = requestAnimationFrame(tryScroll)
    return () => cancelAnimationFrame(frame)
  }, [pathname])
}

export function Link({
  to,
  className,
  children,
  onClick,
}: {
  to: string
  className?: string
  children: ReactNode
  onClick?: () => void
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        onClick?.()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
