// Real product photography for the fashion demo (Asket "The Overshirt",
// Dark Navy). Source: https://www.asket.com/en-us/mens-overshirt-dark-navy
// — see public/assets/fashion-demo/SOURCE.md for full provenance.
//
// All three variants point at the same product-only packshot (flat,
// isolated studio shot against a plain background, no person/model/face
// visible) — the original front/full/detail photos were all worn-by-model
// shots, which is not appropriate for a garment demo.
const VARIANTS = {
  front: '/assets/fashion-demo/overshirt-packshot.webp',
  full: '/assets/fashion-demo/overshirt-packshot.webp',
  detail: '/assets/fashion-demo/overshirt-packshot.webp',
} as const

export function FashionProductPhoto({
  variant = 'front',
  className = '',
  scanning = false,
  alt = 'Overshirt, navy',
}: {
  variant?: keyof typeof VARIANTS
  className?: string
  scanning?: boolean
  alt?: string
}) {
  return (
    <div className={`relative overflow-hidden rounded-xl bg-[var(--color-cream-soft)] ${className}`}>
      <img src={VARIANTS[variant]} alt={alt} className="h-full w-full object-cover" />
      {scanning && (
        <span className="animate-scan-line absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-[var(--color-accent)]/25 to-transparent" />
      )}
    </div>
  )
}
