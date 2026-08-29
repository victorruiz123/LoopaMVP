import type { ConditionResult, GeneratedListing } from "../types";
import { formatSek } from "../lib/price";
import GradeBadge from "../components/GradeBadge";
import { ArrowLeftIcon } from "../components/icons";
import TraderaPublish from "../components/TraderaPublish";

const STATUS_LABELS: Record<string, string> = {
  full: "Allt belagt med källa",
  partial: "Delvis belagt",
  fallback: "Kunde inte beläggas mot källor",
};

/**
 * Annonsen: modell, specifikationer och färdig text, med skicket och priset inbakade.
 *
 * Sist i ordningen med flit. Skickmotorn ser skadorna, prismotorn värderar dem och annonsgeneratorn
 * letar reda på VAD möbeln är — tre oberoende system, och den här vyn är det enda stället där alla tre
 * svaren står bredvid varandra.
 */
export default function TruthCardScreen({
  result,
  onBack,
  onHome,
}: {
  result: ConditionResult;
  onBack: () => void;
  onHome: () => void;
}) {
  const listing = result.listing;
  const card = listing?.result ?? null;

  return (
    <div className="screen screen-light">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> Tillbaka till skicket
      </button>

      {!listing || listing.status === "unavailable" ? (
        <section className="truth-card">
          <div className="truth-kicker">Truth-card</div>
          <h2 className="truth-title">Annonsen kunde inte skapas</h2>
          <p className="muted small">
            {listing?.unavailableReason ?? "Inget märke angavs, så det fanns inget att söka på."}
          </p>
        </section>
      ) : listing.status === "pending" || !card ? (
        <section className="truth-card">
          <div className="truth-kicker">Truth-card</div>
          <div className="price-skeleton" />
          <p className="muted small">Letar upp modell och specifikationer…</p>
        </section>
      ) : (
        <>
          <TruthCard card={card} result={result} />
          {/* Sist på kortet, efter allt som ska granskas. Publiceringen är det enda på den här
              skärmen som lämnar appen, så den ska komma efter att säljaren läst vad som skickas. */}
          <TraderaPublish jobId={result.jobId} />
        </>
      )}

      {/* Bara en väg ut härifrån. "Tillbaka" i foten upprepade pilen längst upp, och två knappar
          som gör olika saker under samma ord är sämre än en knapp som gör en sak. */}
      <button className="btn btn-primary truth-done" onClick={onHome}>
        Klar
      </button>
    </div>
  );
}

function TruthCard({ card, result }: { card: GeneratedListing; result: ConditionResult }) {
  const name = card.identity.exactProduct ?? card.identity.variant ?? result.identity?.model ?? "Möbel";
  const price = result.price;

  return (
    <>
      <section className="truth-card">
        <div className="truth-kicker">Truth-card</div>
        <h2 className="truth-title">{name}</h2>
        <div className="truth-sub">
          {[card.identity.brand, card.identity.category].filter(Boolean).join(" · ") || "—"}
        </div>
        {/* Sagt rakt ut, inte begravt: generatorn markerar själv hur mycket den kunde belägga, och en
            annons där måtten är gissade ska inte se likadan ut som en där de har en källa. */}
        <div className={`truth-confidence truth-confidence-${card.status ?? "partial"}`}>
          {STATUS_LABELS[card.status ?? "partial"] ?? card.status}
          {card.identity.confidence ? ` · träffsäkerhet ${card.identity.confidence}` : ""}
        </div>
        {card.identity.uncertain && card.identity.uncertaintyNote && (
          <p className="truth-caveat">{card.identity.uncertaintyNote}</p>
        )}
      </section>

      <section className="truth-block">
        <h3>Skick och pris</h3>
        <div className="truth-verdict">
          {result.grade && <GradeBadge grade={result.grade.grade} size={44} />}
          <div>
            <div className="truth-verdict-label">{result.grade?.label ?? "—"}</div>
            <div className="muted small">
              {result.damages.filter((d) => d.sellerAction !== "rejected").length} synliga skador ·{" "}
              {result.images.length} vyer · {result.reviewed ? "två besiktningar" : "en besiktning"}
            </div>
          </div>
          <div className="truth-price">
            {price?.status === "ok" ? formatSek(price.default) : "—"}
            {price?.status === "ok" && price.damageDeduction ? (
              <span className="muted small"> efter avdrag</span>
            ) : null}
          </div>
        </div>
      </section>

      {card.attributes.length > 0 && (
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
      )}

      <section className="truth-block">
        <h3>Annonstext</h3>
        <div className="truth-listing-title">{card.listing.title}</div>
        <p className="truth-listing-body">{card.listing.description}</p>
        {card.listing.conditionText && <p className="truth-listing-condition">{card.listing.conditionText}</p>}
      </section>

      {/* Nypris visas inte. Säljaren ska förhålla sig till vad möbeln är värd i dag, inte till vad
          den kostade ny. Fältet finns kvar i `card.pricing` för den som behöver det. */}

      {card.sources.length > 0 && (
        <section className="truth-block">
          <h3>Källor ({card.sources.length})</h3>
          <ul className="truth-sources">
            {card.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

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
    </>
  );
}
