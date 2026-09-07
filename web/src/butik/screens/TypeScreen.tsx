import { useEffect, useState } from "react";
import type { BrandFacet, Category, FurnitureType } from "../types";
import { fetchBrands, fetchType } from "../api";
import ProductGrid from "../components/ProductGrid";
import Filters, { EMPTY_FILTER, type FilterState } from "../components/Filters";
import { Link, SellCta } from "../components/Bits";

type TypeInfo = Omit<FurnitureType, "count" | "loopa" | "tradera">;

/** "Begagnad soffa" / "Begagnat matbord". Samma böjning som serverns typeHeading — se catalog.ts. */
export function typeHeading(t: Pick<TypeInfo, "noun" | "neuter">): string {
  return `${t.neuter ? "Begagnat" : "Begagnad"} ${t.noun}`;
}

/**
 * En möbeltyp — sidan för "begagnad soffa".
 *
 * SAMMA RUBRIK OCH SAMMA INGRESS SOM SERVERN SKREV. seo.ts fyller skalet med "Begagnad soffa i
 * Stockholm" och katalogens ingress innan React startar; det här är vad som ritas EFTER, och Google
 * renderar JavaScript. Skrev skärmen "Soffor" i rubriken hade sidan haft två olika rubriker beroende
 * på vem som läste, och det är den renderade som räknas. Därför hämtas texten från samma katalogpost
 * (/api/butik/mobeltyper/:slug) i stället för att skrivas en gång till här.
 *
 * Kategorin är brödsmulan uppåt och syskonen vägen i sidled: den som letar soffbord och inte hittar
 * det ska se sidobord, inte en återvändsgränd.
 */
export default function TypeScreen({ slug }: { slug: string }) {
  const [type, setType] = useState<TypeInfo | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [siblings, setSiblings] = useState<TypeInfo[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [brands, setBrands] = useState<BrandFacet[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setFilter(EMPTY_FILTER);
    setMissing(false);
    setType(null);
    fetchType(slug)
      .then((r) => {
        setType(r.type);
        setCategory(r.category);
        setSiblings(r.siblings);
        setTotal(r.total);
        // Samma titel som servern satte i skalet, så att bakåt/framåt inte byter den till något vagare.
        document.title = `${typeHeading(r.type)} i Stockholm – ${r.total ? `${r.total} till salu – ` : ""}Loopa Butik`;
      })
      .catch(() => setMissing(true));
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
  }, [slug]);

  if (missing) {
    return (
      <div className="butik-empty">
        <h3>Möbeltypen finns inte</h3>
        <p>Länken kan vara gammal. Här är allt vi har just nu.</p>
        <Link to={{ name: "search", q: "" }} className="btn btn-outline btn-small">Till butiken</Link>
      </div>
    );
  }

  const heading = type ? typeHeading(type) : null;

  return (
    <>
      <header className="butik-hero">
        <span className="butik-geo">📍 Just nu i Stockholm</span>
        {/* Brödsmulan uppåt. Text och inte bara strukturerad data: den som landat fel ska kunna gå upp. */}
        {category && (
          <nav className="butik-crumbs" aria-label="Brödsmulor">
            <Link to={{ name: "search", q: "" }}>Butik</Link>
            <span aria-hidden="true"> › </span>
            <Link to={{ name: "category", slug: category.slug }}>{category.label}</Link>
          </nav>
        )}
        <h1>{heading ? `${heading} i Stockholm` : "…"}</h1>
        {type?.blurb && <p>{type.blurb}</p>}
        {total !== null && total > 0 && type && (
          <p className="butik-hero-lager">
            Just nu {total} {total === 1 ? `begagnad ${type.noun}` : `begagnade ${type.label.toLowerCase()}`} till salu — granskade, prissatta efter skick och med hemleverans i Stockholm.
          </p>
        )}
      </header>

      <Filters value={filter} onChange={setFilter} brands={brands} />

      <ProductGrid
        query={{ ...filter, typ: slug }}
        categorySlug={type?.categorySlug ?? null}
        emptyBody={`Ingen ${type?.noun ?? "möbel"} matchar just nu. Lägg en bevakning så hör vi av oss när något dyker upp.`}
      />

      <SellCta
        categorySlug={type?.categorySlug ?? null}
        heading={type ? `Har du en ${type.noun} att sälja?` : undefined}
        body={type ? `${type.label} går snabbt hos oss. Filma ett varv med mobilen så besiktigar och prissätter vi den åt dig.` : undefined}
      />

      {category && siblings.length > 0 && (
        <section className="butik-section">
          {/* "Fler övrigt" är inte svenska; hyllan utan eget namn får ett allmänt ord. Samma regel som i seo.ts. */}
          <div className="butik-section-head"><h2>{category.slug === "ovrigt" ? "Fler möbler" : `Fler ${category.label.toLowerCase()}`}</h2></div>
          <div className="butik-field-row">
            {siblings.map((t) => (
              <Link key={t.slug} to={{ name: "type", slug: t.slug }} className="butik-chip">
                {typeHeading(t)}
              </Link>
            ))}
            <Link to={{ name: "category", slug: category.slug }} className="butik-chip">
              Alla {category.label.toLowerCase()}
            </Link>
          </div>
        </section>
      )}
    </>
  );
}
