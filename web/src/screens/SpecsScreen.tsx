import { useMemo } from "react";
import type { GeneratedListing } from "../types";
import { ArrowLeftIcon, ChevronRight } from "../components/icons";
import BrandAvatar from "../components/BrandAvatar";
import FlowSteps from "../components/FlowSteps";
import FurnitureRender from "../components/FurnitureRender";
import { archetypeFor, buildModel, parseDimensions } from "../lib/furnitureModel";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

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
 * värd i dag, inte till vad den kostade ny. Fältet finns kvar i datan och i annonsens underlag —
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
  const t = useT();
  const name = card.identity.exactProduct ?? card.identity.variant ?? t("Möbel");
  usePageTitle("Mått och specifikationer");
  // Raderna visar attributets EGEN text ("80–82 cm"), inte ett avrundat tal: det säljaren ska
  // kontrollera mot sin tumstock är det källan påstod.
  const dimRows = DIM_ROWS.map(([re, label]) => ({ label, attr: card.attributes.find((a) => re.test(a.label)) })).filter(
    (r) => r.attr,
  );
  /**
   * Samma modell och samma vy som annonsen ritar möbeln i.
   *
   * Måttsteget hade förut en egen, enklare figur. Två figurer av samma möbel i samma flöde är en för
   * mycket: säljaren ska känna igen bilden när den kommer tillbaka på kortet, och det gör hen bara
   * om det är samma bild.
   *
   * Här står den STILL — en bild snett framifrån, inte en figur att vrida på. Frågan under är
   * "kan det stämma?", och den besvaras med tumstocken i handen mot de tre talen i listan. Att
   * svänga in möbeln och vagga vidare med den lade en sekund framför en bild som ändå skulle läsas
   * i vila, och bjöd in till en runda kring en möbel som inte har något på baksidan att visa. Först
   * på kortet, där skadorna sitter som numrerade punkter, finns det något att vrida fram — och där
   * rör den sig fortfarande.
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
  // Ingen källa gav några mått, så de här kommer ur tabellen över typiska mått för möbeltypen. Frågan
  // under rubriken är densamma — kan det stämma? — men säljaren ska veta att det är en gissning hen
  // rättar, inte en uppgift hen kontrollerar.
  const dimsEstimated = dimRows.length > 0 && dimRows.every((r) => r.attr!.estimated);
  // Måtten bor i sitt eget segment — de ska inte stå två gånger på samma skärm.
  const other = card.attributes.filter((a) => !DIM_LABEL.test(a.label));
  return (
    <div className="screen screen-light specs-screen">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> {t("Byt modell")}
      </button>

      <header className="specs-head">
        <FlowSteps current={2} />
        <div className="price-identity">
          {card.identity.brand && <BrandAvatar name={card.identity.brand} size={30} />}
          <span>{name}</span>
        </div>
        <div className={`card-confidence card-confidence-${card.status ?? "partial"}`}>
          {t(STATUS_LABELS[card.status ?? "partial"] ?? card.status ?? "")}
        </div>
      </header>

      {/* Måtten och specifikationerna svarar på samma fråga från två håll, så i datorvyn ligger de
          bredvid varandra. Omslaget är genomskinligt på telefonen — se .specs-grid i styles.css. */}
      <div className="specs-grid">
        {/* Måtten får ett eget segment. De är det säljaren lättast kan kontrollera mot verkligheten —
            en tumstock räcker — och därför också det enda vi frågar rakt ut om. */}
        {hasDims && (
          <section className="card-block dim-block">
            <h3>{t("Måtten")}</h3>
            <p className="dim-question">
              {dimsEstimated
                ? t(
                    "Måtten gick inte att belägga mot någon källa. Det här är typiska mått för möbeltypen — stämmer de?",
                  )
                : t("Såhär blev måtten. Kan det stämma?")}
            </p>
            {model && (
              <div className="dim-render">
                <FurnitureRender model={model} still />
              </div>
            )}
            <dl className="dim-list">
              {dimRows.map(({ label, attr }) => (
                <div key={label} className="dim-row">
                  <dt>{t(label)}</dt>
                  <dd>
                    {attr!.value}
                    {attr!.estimated && <span className="card-est">{t("uppskattat")}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {other.length > 0 ? (
          <section className="card-block">
            <h3>{t("Specifikationer")}</h3>
            <dl className="card-specs">
              {other.map((a) => (
                <div key={a.key + a.label} className="card-spec">
                  <dt>{a.label}</dt>
                  <dd>
                    {a.value}
                    {a.sourceUrl ? (
                      <a className="card-src" href={a.sourceUrl} target="_blank" rel="noreferrer">
                        {t("källa")}
                      </a>
                    ) : (
                      a.estimated && <span className="card-est">{t("uppskattat")}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : (
          <section className="card-block">
            <h3>{t("Specifikationer")}</h3>
            <p className="muted small">{t("Inga specifikationer kunde beläggas mot en källa.")}</p>
          </section>
        )}
      </div>

      <section className="card-block">
        <h3>{t("Annonstext")}</h3>
        <div className="card-listing-title">{card.listing.title}</div>
        <p className="card-listing-body">{card.listing.description}</p>
      </section>

      {card.missingNotes && card.missingNotes.length > 0 && (
        <section className="card-block card-missing">
          <h3>{t("Kunde inte bekräftas")}</h3>
          <ul>
            {card.missingNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <button className="btn btn-primary next-step" onClick={onNext}>
        <span>{t("Se prisförslaget")}</span>
        <span className="next-step-meta">
          <ChevronRight size={18} />
        </span>
      </button>
    </div>
  );
}
