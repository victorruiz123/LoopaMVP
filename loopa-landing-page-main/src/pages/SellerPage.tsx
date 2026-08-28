import { SellerHeader } from '../features/seller/SellerHeader'
import { SellerFooter } from '../features/seller/SellerFooter'
import { SellerFlow } from '../features/seller/SellerFlow'

/** The consumer seller product (loopa.nu/). Intentionally its own shell —
 * no shared Nav/Footer with the B2B site, see App.tsx. */
export function SellerPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-cream)]">
      <SellerHeader />
      <SellerFlow />
      <SellerFooter />
    </div>
  )
}
