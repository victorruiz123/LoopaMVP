import { useMemo } from "react";
import type { GeneratedListing } from "../types";
import { ArrowLeftIcon, ChevronRight } from "../components/icons";
import BrandAvatar from "../components/BrandAvatar";
import FlowSteps from "../components/FlowSteps";
import FurnitureRender from "../components/FurnitureRender";
import { archetypeFor, buildModel, parseDimensions } from "../lib/furnitureModel";
import { usePageTitle } from "../lib/pageTitle";

/** Måttraderna i den ordning en möbel mäts, inte i den ordning källan råkade lista dem. */
const DIM_ROWS: [RegExp, string][] = [
  // Längden står först och i måttblocket, inte nere bland specifikationerna: för ett bord är den
  // det längsta måttet och det modellen ritas på. Den låg tidigare utanför DIM_LABEL och hamnade
  // därför under "Specifikationer", bredvid material och färg.
  [/^(längd|langd|length)/i, "Längd"],
  [/^(bredd|width)/i, "Bredd"],
  [/^(djup|depth)/i, "Djup"],
  [/^(höjd|hojd|height)$|^(total)?höjd/i, "Höjd"],
  [/(sitthöjd|sitshöjd|seat height)/i, "Sitthöjd"],
];
const DIM_LABEL = /^(längd|langd|length|bredd|djup|höjd|hojd|sitthöjd|sitshöjd|width|depth|height|seat height)/i;

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
  usePageTitle("Mått och specifikationer");
  // Raderna visar attributets EGEN text ("80–82 cm"), inte ett avrundat tal: det säljaren ska
  // kontrollera mot sin tumstock är det källan påstod.
  const dimRows = DIM_ROWS.map(([re, label]) => ({ label, attr: card.attributes.find((a) => re.test(a.label)) })).filter(
    (r) => r.attr,
  );
  /**
   * Samma modell och samma vy som truth-cardet ritar möbeln i.
   *
   * Måttsteget hade förut en egen, enklare figur. Två figurer av samma möbel i samma flöde är en för
   * mycket: säljaren ska känna igen bilden när den kommer tillbaka på kortet, och det gör hen bara
   * om det är samma bild.
   */
  const model = useMemo(() => {
    const archetype = archetypeFor(card.identity.category, card.listing.title);
    const dims = parseDimensions(card.attributes, archetype);
    return dims
      ? buildModel(archetype, dims, card.attributes, {
          category: card.identity.category,
          title: card.listing.title,
          variant: card.identity.variant,
        })
      : null;
  }, [card]);
  const hasDims = dimRows.length > 0 || !!model;
  // Måtten bor i sitt eget segment — de ska inte stå två gånger på samma skärm.
  const other = card.attributes.filter((a) => !DIM_LABEL.test(a.label));
  return (
    <div className="screen screen-light specs-screen">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> Byt modell
      </button>

      <header className="specs-head">
        <FlowSteps current={2} />
        <div className="price-identity">
          {card.identity.brand && <BrandAvatar name={card.identity.brand} size={30} />}
          <span>{name}</span>
        </div>
        <div className={`truth-confidence truth-confidence-${card.status ?? "partial"}`}>
          {STATUS_LABELS[card.status ?? "partial"] ?? card.status}
        </div>
      </header>

      {/* Måtten och specifikationerna svarar på samma fråga från två håll, så i datorvyn ligger de
          bredvid varandra. Omslaget är genomskinligt på telefonen — se .specs-grid i styles.css. */}
      <div className="specs-grid">
        {/* Måtten får ett eget segment. De är det säljaren lättast kan kontrollera mot verkligheten —
            en tumstock räcker — och därför också det enda vi frågar rakt ut om. */}
        {hasDims && (
          <section className="truth-block dim-block">
            <h3>Måtten</h3>
            <p className="dim-question">Såhär blev måtten. Kan det stämma?</p>
            {model && (
              <div className="dim-render">
                <FurnitureRender model={model} />
              </div>
            )}
            <dl className="dim-list">
              {dimRows.map(({ label, attr }) => (
                <div key={label} className="dim-row">
                  <dt>{label}</dt>
                  <dd>{attr!.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {other.length > 0 ? (
          <section className="truth-block">
            <h3>Specifikationer</h3>
            <dl className="truth-specs">
              {other.map((a) => (
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
      </div>

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
