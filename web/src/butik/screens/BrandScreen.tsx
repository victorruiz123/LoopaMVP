import { useEffect, useState } from "react";
import type { BrandFacet } from "../types";
import { fetchBrands } from "../api";
import ProductGrid from "../components/ProductGrid";
import Filters, { EMPTY_FILTER, type FilterState } from "../components/Filters";
import { Link, SellCta } from "../components/Bits";
import { brandLook, brandTypeStyle } from "../../lib/brandLook";

/**
 * En märkessida — förstklassig, inte ett filter med egen adress.
 *
 * Skälet är organiskt: "begagnad Swedese Lamino" är en sökning människor faktiskt gör, och den ska
 * landa på en sida som handlar om just det märket. Därför egen rubrik, egen ingress och en egen
 * säljuppmaning med märket ifyllt — den som söker på ett märke äger ofta en möbel av det.
 *
 * Märkena kommer ur LAGRET och inte ur en lista: en märkessida utan varor är en död sida, och en
 * handskriven lista blir just det så fort lagret ändras.
 */

/** Ingresser för de märken vi har egen text om. Resten får en generisk, aldrig en påhittad historia. */
const BLURBS: Record<string, string> = {
  ikea: "Begagnade IKEA-möbler i Stockholm, besiktigade och prissatta efter skick. Samma modeller som i katalogen — till en bråkdel av nypriset.",
  swedese: "Swedese har tillverkat svensk designmöbel sedan 1945. Lamino av Yngve Ekström är en av de mest välkända fåtöljerna som gjorts i Sverige.",
  sits: "Sits gör stoppade soffor och fåtöljer med avtagbara klädslar — möbler som mår bra av att få ett andra hem.",
  string: "String-hyllan ritades av Nisse Strinning 1949 och tillverkas fortfarande. Delar från olika årtionden passar ihop.",
  hay: "HAY är dansk formgivning med rena linjer och tåliga material.",
  lammhults: "Lammhults möbler är ritade för offentliga miljöer och byggda därefter — de tål ett andra liv.",
  mio: "Mio-möbler i begagnat skick, granskade och mätta.",
};

function titleCase(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export default function BrandScreen({ slug }: { slug: string }) {
  const [brands, setBrands] = useState<BrandFacet[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);

  useEffect(() => {
    setFilter(EMPTY_FILTER);
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
  }, [slug]);

  // Märkets riktiga skrivning hämtas ur lagret; slugen är bara adressen.
  const match = brands.find((b) => b.brand.toLowerCase().replace(/\s+/g, "-") === slug);
  const name = match?.brand ?? titleCase(slug);
  const blurb = BLURBS[slug] ?? `Begagnade möbler från ${name}, granskade av Loopa och klara att köpa i Stockholm.`;
  // Märkesbrickorna längst ner ska visa märkets egen färg, precis som på förstasidan.

  return (
    <>
      <header className="butik-hero">
        <span className="butik-geo">📍 Just nu i Stockholm</span>
        {/* Märkets namn i märkets egen bokstavsform, "secondhand" i Loopas. Samma delning som på
            brickan: namnet är deras, ordet om begagnat är vårt. */}
        <h1 style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0.3em" }}>
          <span style={{ ...brandTypeStyle(brandLook(name).type), fontSize: "1em" }}>{name}</span>
          <span style={{ fontWeight: 400, color: "var(--muted)", letterSpacing: 0, textTransform: "none" }}>
            secondhand
          </span>
        </h1>
        <p>{blurb}</p>
      </header>

      <Filters value={filter} onChange={setFilter} brands={brands} />

      <ProductGrid
        query={{ ...filter, marke: [name] }}
        emptyBody={`Vi har inget från ${name} just nu. Lägg en bevakning så hör vi av oss så fort något kommer in.`}
      />

      <SellCta
        brand={name}
        heading={`Har du en ${name}-möbel?`}
        body={`Möbler från ${name} går snabbt hos oss. Filma ett varv med mobilen så besiktigar och prissätter vi den åt dig.`}
      />

      {brands.length > 1 && (
        <section className="butik-section">
          <div className="butik-section-head"><h2>Fler märken</h2></div>
          <div className="butik-field-row">
            {brands.filter((b) => b.brand !== name).map((b) => (
              <Link key={b.brand} to={{ name: "brand", slug: b.brand.toLowerCase().replace(/\s+/g, "-") }} className="butik-chip">
                {b.brand} <span className="butik-chip-count">{b.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
