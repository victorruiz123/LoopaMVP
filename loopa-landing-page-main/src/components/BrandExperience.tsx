import { useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { CategorySelector } from './CategorySelector'
import { FashionRecommerceDemo } from './FashionRecommerceDemo'
import { FurnitureProof } from './FurnitureProof'
import type { ProductCategory } from '../features/generator/types'

// ONE prominent Fashion/Furniture selector controlling ONE shared content
// region. Only the selected category's brand experience renders — the two
// are alternative views, never stacked sequentially on the page.
export function BrandExperience() {
  const { t } = useLanguage()
  const e = t.brandExperience
  const [category, setCategory] = useState<ProductCategory>('fashion')

  return (
    <section id="walkthrough" className="border-t border-[var(--color-line)] py-20">
      <div className="container-loopa">
        <h2 className="max-w-2xl text-3xl leading-[1.1] font-bold tracking-tight text-[var(--color-ink)] sm:text-4xl md:text-5xl">
          {e.heading}
        </h2>

        <div className="mt-8 max-w-xl">
          <CategorySelector
            value={category}
            onChange={setCategory}
            fashionLabel={t.brands.tabFashion}
            furnitureLabel={t.brands.tabFurniture}
            fashionCta={e.fashionSubtext}
            furnitureCta={e.furnitureSubtext}
          />
        </div>

        <div className="mt-10">
          {category === 'fashion' ? <FashionRecommerceDemo /> : <FurnitureProof />}
        </div>
      </div>
    </section>
  )
}
