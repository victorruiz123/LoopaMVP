export function SellerFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className="mx-auto max-w-lg px-5 py-8 text-center text-xs text-[var(--color-body)]/70">
      © {year} Loopa
    </footer>
  )
}
