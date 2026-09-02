import { useEffect, useState } from "react";
import type { BrandFacet, Category } from "../types";
import { fetchBrands, fetchCategories } from "../api";
import ProductGrid from "../components/ProductGrid";
import Filters, { EMPTY_FILTER, type FilterState } from "../components/Filters";
import { Link, SellCta } from "../components/Bits";

/**
 * En kategori. Samma rutnät och samma filter som söket — bara med kategorin låst.
 *
 * Rubriken och ingressen är SEO-ytan: sidan ska kunna svara på "begagnade soffor Stockholm" utan att
 * texten blir nyckelordsgrus. Blurben kommer från katalogen på servern (catalog.ts) och är därför en
 * text som går att redigera på ett ställe.
 */
export default function CategoryScreen({ slug }: { slug: string }) {
  const [category, setCategory] = useState<Category | null>(null);
  const [brands, setBrands] = useState<BrandFacet[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setFilter(EMPTY_FILTER);
    fetchCategories()
      .then((r) => {
        const hit = r.categories.find((c) => c.slug === slug);
        setCategory(hit ?? null);
        setMissing(!hit);
      })
      .catch(() => setMissing(true));
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
  }, [slug]);

  if (missing) {
    return (
      <div className="butik-empty">
        <h3>Kategorin finns inte</h3>
        <p>Länken kan vara gammal. Här är allt vi har just nu.</p>
        <Link to={{ name: "landing" }} className="btn btn-outline btn-small">Till butiken</Link>
      </div>
    );
  }

  return (
    <>
      <header className="butik-hero">
        <span className="butik-geo">📍 Just nu i Stockholm</span>
        <h1>{category?.label ?? "…"}</h1>
        {category?.blurb && <p>{category.blurb}</p>}
      </header>

      <Filters value={filter} onChange={setFilter} brands={brands} />

      <ProductGrid
        query={{ ...filter, kategori: slug }}
        categorySlug={slug}
        emptyBody={`Inget i ${(category?.label ?? "denna kategori").toLowerCase()} matchar just nu. Lägg en bevakning så hör vi av oss när något dyker upp.`}
      />

      <SellCta categorySlug={slug} />
    </>
  );
}
