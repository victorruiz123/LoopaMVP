// Browser client for POST /api/brand-preview — real, per-category,
// same-brand product discovery for /brands. Never throws: any failure
// resolves to `null`, which callers treat as "show the generic illustrative
// preview" rather than an error state.

export interface BrandProduct {
  name: string
  price: string | null
  url: string
  image: string
}

export interface BrandPreviewResult {
  companyName: string | null
  tone: string | null
  resaleTermStyle: string | null
  category: 'fashion' | 'furniture' | 'interior'
  products: BrandProduct[]
}

export async function fetchBrandPreview(
  url: string,
  category: 'fashion' | 'furniture' | 'interior',
): Promise<BrandPreviewResult | null> {
  try {
    const res = await fetch('/api/brand-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, category }),
    })
    const parsed = await res.json()
    if (!parsed?.ok) return null
    return parsed.result ?? null
  } catch {
    return null
  }
}
