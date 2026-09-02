import { useEffect, useRef, useState } from "react";
import { browse, type BrowseQuery } from "../api";
import type { Product } from "../types";
import ProductCard from "./ProductCard";
import { EmptyState, GridSkeleton, Notice, track } from "./Bits";
import BevakningSheet from "./BevakningSheet";

/**
 * Rutnätet med sidladdning.
 *
 * Hämtar en sida i taget och lägger på fler — aldrig hela lagret. Bilderna är dessutom `loading=lazy`
 * (se ProductCard), så en lång lista kostar inte mer än den syns.
 *
 * TVÅ TILLSTÅND SOM INTE FÅR SE UT SOM SAMMA SAK: noll träffar (filtret är för snävt) och ett fel
 * (vi kunde inte hämta). Det första får ett tomt läge med vägar vidare; det andra får ett felkort med
 * en väg tillbaka. Ett tomt rutnät utan besked är det som läser som "butiken är tom".
 */

const PAGE = 24;

export default function ProductGrid({
  query,
  emptyBody,
  categorySlug,
}: {
  query: BrowseQuery;
  emptyBody: string;
  categorySlug?: string | null;
}) {
  // Bevakningsarket bor här: det är rutnätet som vet när det är tomt, och det är då det behövs.
  const [bevakning, setBevakning] = useState(false);
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [excluded, setExcluded] = useState(0);
  const [excludedData, setExcludedData] = useState(0);

  // Nyckeln gör om filterändringar till en ny hämtning utan att jämföra objekt djupt.
  const key = JSON.stringify(query);
  // Sena svar från en gammal filterinställning får inte skriva över ett nyare resultat.
  const requestRef = useRef(0);

  useEffect(() => {
    const id = ++requestRef.current;
    setLoading(true);
    setError(null);
    browse({ ...query, antal: PAGE, fran: 0 })
      .then((r) => {
        if (id !== requestRef.current) return;
        setItems(r.items);
        setTotal(r.total);
        setDegraded(r.traderaDegraded);
        setExcluded(r.excludedForMissingDimensions);
        setExcludedData(r.excludedForMissingData ?? 0);
      })
      .catch((e: unknown) => {
        if (id !== requestRef.current) return;
        setError(e instanceof Error ? e.message : "Kunde inte hämta varorna.");
      })
      .finally(() => { if (id === requestRef.current) setLoading(false); });
  }, [key]);

  const loadMore = () => {
    setLoadingMore(true);
    browse({ ...query, antal: PAGE, fran: items.length })
      .then((r) => setItems((prev) => [...prev, ...r.items]))
      .catch(() => setError("Kunde inte hämta fler varor."))
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <GridSkeleton />;

  if (error) {
    return (
      <div className="butik-empty">
        <h3>Det gick inte att hämta butiken</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-outline btn-small" onClick={() => setItems([])}>Försök igen</button>
      </div>
    );
  }

  return (
    <>
      {degraded && (
        <Notice>
          Vi når inte Tradera just nu, så listan visar bara Loopa-granskade möbler. Försök igen om en stund.
        </Notice>
      )}
      {excluded > 0 && (
        <Notice>
          {excluded} {excluded === 1 ? "annons" : "annonser"} saknar mått och visas inte när du filtrerar på storlek. Det gäller
          nästan alla Tradera-annonser — vi har bara mått på det vi själva mätt upp.
        </Notice>
      )}
      {/* Färg och material finns bara på det vi själva besiktigat. Ett sådant filter tömmer hela
          Tradera-halvan, och ett tomt rutnät utan förklaring läser som ett tomt lager. */}
      {excluded === 0 && excludedData > 0 && (
        <Notice>
          {excludedData} {excludedData === 1 ? "annons" : "annonser"} saknar uppgift om färg eller material och visas inte här.
          Vi vet bara det om möbler vi själva granskat.
        </Notice>
      )}
      {bevakning && (
        <BevakningSheet categorySlug={categorySlug} brand={query.marke?.[0] ?? null} onClose={() => setBevakning(false)} />
      )}
      {items.length === 0 ? (
        <EmptyState body={emptyBody} categorySlug={categorySlug} onBevakning={() => setBevakning(true)} />
      ) : (
        <>
          <div className="butik-grid">
            {items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
          {items.length < total ? (
            <div className="butik-more">
              <button type="button" className="btn btn-outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Hämtar…" : `Visa fler (${total - items.length} kvar)`}
              </button>
            </div>
          ) : (
            <p className="butik-count">Visar alla {total} {total === 1 ? "möbel" : "möbler"}.</p>
          )}
        </>
      )}
    </>
  );
}

/** Ett litet rutnät utan filter och paginering — "Nyinkommet" på landningssidan. */
export function ProductStrip({ query, limit = 8 }: { query: BrowseQuery; limit?: number }) {
  const [items, setItems] = useState<Product[] | null>(null);
  useEffect(() => {
    browse({ ...query, antal: limit }).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [JSON.stringify(query), limit]);

  if (items === null) return <GridSkeleton n={limit} />;
  if (items.length === 0) return null;
  return (
    <div className="butik-grid">
      {items.map((p) => <ProductCard key={p.id} product={p} />)}
    </div>
  );
}

export function useViewItem(product: Product | null) {
  useEffect(() => {
    if (!product) return;
    track("view_item", {
      item_id: product.id,
      source: product.source,
      category: product.categorySlug,
      brand: product.brand,
      price: product.priceSek,
    });
  }, [product?.id]);
}
