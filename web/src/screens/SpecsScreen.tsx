import type { GeneratedListing } from "../types";
import { ArrowLeftIcon, ChevronRight } from "../components/icons";
import BrandAvatar from "../components/BrandAvatar";

const STATUS_LABELS: Record<string, string> = {
  full: "Allt belagt med källa",
  partial: "Delvis belagt",
  fallback: "Kunde inte beläggas mot källor",
};

/**
 * Annonsen, som den ser ut direkt efter modellvalet.
 *
 * NYPRIS VISAS INTE. Det är ett medvetet produktval: säljaren ska förhålla sig till vad möbeln är
 * värd i dag, inte till vad den kostade ny. Fältet finns kvar i datan och i truth-cardets underlag —
 * det är bara den här skärmen som håller det utanför.
 */
export default function SpecsScreen({
  card,
  onNext,
  onBack,
}: {
  card: GeneratedListing;
  onNext: () => void;
  onBack: () => void;
}) {
  const name = card.identity.exactProduct ?? card.identity.variant ?? "Möbel";
  return (
    <div className="screen screen-light">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> Byt modell
      </button>

      <header className="specs-head">
        <span className="brand-pill">
          <span className="brand-dot" /> STEG 2 AV 4
        </span>
        <div className="price-identity">
          {card.identity.brand && <BrandAvatar name={card.identity.brand} size={30} />}
          <span>{name}</span>
        </div>
        <div className={`truth-confidence truth-confidence-${card.status ?? "partial"}`}>
          {STATUS_LABELS[card.status ?? "partial"] ?? card.status}
        </div>
      </header>

      {card.attributes.length > 0 ? (
        <section className="truth-block">
          <h3>Specifikationer</h3>
          <dl className="truth-specs">
            {card.attributes.map((a) => (
              <div key={a.key + a.label} className="truth-spec">
                <dt>{a.label}</dt>
                <dd>
                  {a.value}
                  {a.sourceUrl && (
                    <a className="truth-src" href={a.sourceUrl} target="_blank" rel="noreferrer">
                      källa
                    </a>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <section className="truth-block">
          <h3>Specifikationer</h3>
          <p className="muted small">Inga specifikationer kunde beläggas mot en källa.</p>
        </section>
      )}

      <section className="truth-block">
        <h3>Annonstext</h3>
        <div className="truth-listing-title">{card.listing.title}</div>
        <p className="truth-listing-body">{card.listing.description}</p>
      </section>

      {card.missingNotes && card.missingNotes.length > 0 && (
        <section className="truth-block truth-missing">
          <h3>Kunde inte bekräftas</h3>
          <ul>
            {card.missingNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <button className="btn btn-primary next-step" onClick={onNext}>
        <span>Se prisförslaget</span>
        <span className="next-step-meta">
          <ChevronRight size={18} />
        </span>
      </button>
    </div>
  );
}
