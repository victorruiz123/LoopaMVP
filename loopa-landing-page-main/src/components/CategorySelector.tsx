import { FashionProductPhoto } from './FashionProductPhoto'
import type { ProductCategory } from '../features/generator/types'

interface CategorySelectorProps {
  value: ProductCategory
  onChange: (value: ProductCategory) => void
  fashionLabel: string
  furnitureLabel: string
  fashionCta: string
  furnitureCta: string
}

// A large, unmissable Fashion / Furniture choice. Two substantial tiles,
// not a small pill toggle.
export function CategorySelector({
  value,
  onChange,
  fashionLabel,
  furnitureLabel,
  fashionCta,
  furnitureCta,
}: CategorySelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <button
        type="button"
        onClick={() => onChange('fashion')}
        aria-pressed={value === 'fashion'}
        className={`group rounded-2xl border-2 p-4 text-left transition-colors sm:p-5 ${
          value === 'fashion'
            ? 'border-[var(--color-accent)] bg-white shadow-[var(--shadow-card)]'
            : 'border-[var(--color-line)] bg-white hover:border-[var(--color-ink)]/30'
        }`}
      >
        <FashionProductPhoto variant="front" className="aspect-[4/3] w-full" />
        <p className="mt-3 text-lg font-semibold text-[var(--color-ink)]">{fashionLabel}</p>
        <p className="mt-0.5 text-sm text-[var(--color-body)]">{fashionCta}</p>
      </button>

      <button
        type="button"
        onClick={() => onChange('furniture')}
        aria-pressed={value === 'furniture'}
        className={`group rounded-2xl border-2 p-4 text-left transition-colors sm:p-5 ${
          value === 'furniture'
            ? 'border-[var(--color-accent)] bg-white shadow-[var(--shadow-card)]'
            : 'border-[var(--color-line)] bg-white hover:border-[var(--color-ink)]/30'
        }`}
      >
        <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-[var(--color-cream-soft)]">
          <img
            src="/assets/ikea/thumb-img-8304.webp"
            alt=""
            className="h-full w-full object-cover"
            aria-hidden
          />
        </div>
        <p className="mt-3 text-lg font-semibold text-[var(--color-ink)]">{furnitureLabel}</p>
        <p className="mt-0.5 text-sm text-[var(--color-body)]">{furnitureCta}</p>
      </button>
    </div>
  )
}
