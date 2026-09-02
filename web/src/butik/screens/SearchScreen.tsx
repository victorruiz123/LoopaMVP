import { useEffect, useState } from "react";
import type { BrandFacet } from "../types";
import { fetchBrands, interpret, type BrowseQuery, type Interpretation } from "../api";
import ProductGrid from "../components/ProductGrid";
import Filters, { EMPTY_FILTER, type FilterState } from "../components/Filters";
import { SellCta } from "../components/Bits";

/**
 * Sökskärmen — och där AI-tolkningen landar.
 *
 * Frågan står i ADRESSEN, inte i ett tillstånd: /butik/sok?q=en soffa till ett litet vardagsrum går
 * att dela, bokmärka och backa till. Tolkningen görs om när sidan öppnas, vilket kostar ett anrop
 * men gör länken till en riktig länk i stället för en engångsvy.
 *
 * TOLKNINGEN VISAS. Köparen ska kunna se vad vi förstod — "Soffor & fåtöljer · max 5 000 kr" — och
 * rätta oss med filtren om vi förstod fel. En sökning som tyst filtrerar bort halva lagret utan att
 * säga varför är omöjlig att lita på; det är samma regel som gäller resten av butiken.
 */
export default function SearchScreen({ q }: { q: string }) {
  const [brands, setBrands] = useState<BrandFacet[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [reading, setReading] = useState<Interpretation | null>(null);
  const [thinking, setThinking] = useState(false);
  /** Sant när köparen rört filtren själv — då slutar tolkningen styra. */
  const [overridden, setOverridden] = useState(false);

  useEffect(() => {
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
  }, []);

  useEffect(() => {
    setOverridden(false);
    setFilter(EMPTY_FILTER);
    if (!q.trim()) { setReading(null); return; }
    let live = true;
    setThinking(true);
    interpret(q)
      .then((r) => { if (live) setReading(r); })
      .catch(() => { if (live) setReading(null); })
      .finally(() => { if (live) setThinking(false); });
    return () => { live = false; };
  }, [q]);

  /**
   * Frågan till rutnätet.
   *
   * Tolkningens filter ligger UNDER köparens egna val: rör de ett reglage vinner det, alltid. Utan
   * den ordningen kan man inte ta bort ett filter som AI:n satte, och då är tolkningen ett fängelse
   * i stället för en genväg.
   */
  const query: BrowseQuery = overridden || !reading
    ? { ...filter, q: q || null }
    : { ...reading.query, ...stripEmpty(filter) };

  return (
    <>
      <header className="butik-hero">
        <span className="butik-geo">📍 Just nu i Stockholm</span>
        <h1>{q ? q : "Alla möbler"}</h1>
        {!q && <p>Hela lagret — våra egna granskade möbler först.</p>}
      </header>

      {thinking && (
        <div className="butik-reading">
          <span className="butik-reading-tag">Tolkar</span>
          <span className="muted">Läser din beskrivning…</span>
        </div>
      )}

      {!thinking && reading && q && (
        <div className="butik-reading">
          <span className="butik-reading-tag">{reading.aiUsed ? "Vi förstod" : "Sökord"}</span>
          <span>{reading.summary}</span>
          {!reading.aiUsed && (
            <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              — vi matchade orden rakt av den här gången. Justera gärna med filtren.
            </span>
          )}
        </div>
      )}

      <Filters
        value={filter}
        onChange={(next) => { setFilter(next); setOverridden(true); }}
        brands={brands}
      />

      <ProductGrid
        query={query}
        emptyBody={
          q
            ? `Inget matchar "${q}" just nu. Prova en bredare beskrivning, eller lägg en bevakning så hör vi av oss.`
            : "Butiken är tom just nu. Lägg en bevakning så hör vi av oss."
        }
      />

      <SellCta />
    </>
  );
}

/** Bara de filterfält köparen faktiskt satt — resten ska inte skriva över tolkningen med tomma värden. */
function stripEmpty(f: FilterState): Partial<BrowseQuery> {
  const out: Partial<BrowseQuery> = {};
  if (f.onlyLoopa) out.onlyLoopa = true;
  if (f.marke.length) out.marke = f.marke;
  if (f.minPris !== null) out.minPris = f.minPris;
  if (f.maxPris !== null) out.maxPris = f.maxPris;
  if (f.skick.length) out.skick = f.skick;
  if (f.maxBredd !== null) out.maxBredd = f.maxBredd;
  if (f.maxDjup !== null) out.maxDjup = f.maxDjup;
  if (f.maxHojd !== null) out.maxHojd = f.maxHojd;
  if (f.hemleverans) out.hemleverans = true;
  if (f.sortering !== "relevans") out.sortering = f.sortering;
  return out;
}
