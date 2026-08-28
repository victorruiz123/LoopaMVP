# Sources — fashion-demo assets

Real product photography for the /company fashion demo (Asket "The Overshirt", Dark Navy).

## overshirt-front.webp / overshirt-full.webp / overshirt-detail.webp

Asket's own product photography, downloaded once via `scripts/fetch-fashion-demo-assets.mjs`
(source: https://www.asket.com/en-us/mens-overshirt-dark-navy). These are worn-by-model shots —
kept in the repo because `src/features/brands/data.ts` (the `/brands` page) and
`src/features/generator/mockListing.ts` (the `/secondhand` demo) still reference
`overshirt-front.webp`, but no longer used by `FashionProductPhoto.tsx` on `/company` (see below).

## overshirt-packshot.webp

Added to fix the `/company` demo showing a model wearing the garment instead of a product-only
image. This is Asket's own catalog/PLP thumbnail for the same product (a flat, isolated studio
shot on a plain background, no person visible) — fetched directly from
`https://images.asket.com/product-images/63_ZMITt0djvPEqkzri-asket_ovs-ma-dkn_thumbnail-original.jpg`
(linked from the same product page's `og:image`/catalog metadata), re-encoded to webp. Fetched 2026-08-25.
