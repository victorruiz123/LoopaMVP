// Deliberately minimal — no nav, no links to /company /brands /secondhand.
// The seller product is a separate experience; the only shared thing is the
// Loopa wordmark and visual language. See docs/SELLER_MVP_ARCHITECTURE.md.
export function SellerHeader() {
  return (
    <header className="sticky top-0 z-40 bg-[var(--color-cream)]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-lg items-center px-5 sm:h-16">
        <span className="text-lg font-bold tracking-tight text-[var(--color-accent)]">Loopa</span>
      </div>
    </header>
  )
}
