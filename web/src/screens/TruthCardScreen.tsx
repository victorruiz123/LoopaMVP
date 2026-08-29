import type { ConditionResult } from "../types";
import { damageStands } from "../lib/damages";
import { ArrowLeftIcon } from "../components/icons";
import LoopaIdBlock from "../components/LoopaIdBlock";
import TruthCardView from "../components/TruthCardView";
import TraderaPublish from "../components/TraderaPublish";
import { usePageTitle } from "../lib/pageTitle";

/**
 * Säljarens vy av sitt truth-card.
 *
 * Själva kortet ritas av TruthCardView, som är samma vy det publika kortet använder — det säljaren
 * granskar här är exakt det en köpare ser på Loopa-ID:t. Runt kortet ligger det som bara är
 * säljarens: ID:t med vad det innebär, och publiceringen till Tradera.
 */
export default function TruthCardScreen({
  result,
  loopaId,
  onBack,
  onHome,
}: {
  result: ConditionResult;
  /** Kortets publika ID. Saknas bara om jobbsvaret hämtades innan servern började skicka med det. */
  loopaId?: string;
  onBack: () => void;
  onHome: () => void;
}) {
  const listing = result.listing;
  usePageTitle("Truth-card");
  const card = listing?.result ?? null;

  return (
    <div className="screen screen-light truth-screen">
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
          <TruthCardView
            card={card}
            identity={result.identity}
            grade={result.grade}
            price={result.price}
            damages={result.damages.filter(damageStands)}
            imageCount={result.images.length}
            reviewed={result.reviewed}
            productImage={result.productImage}
            loopaId={loopaId}
          />
          {/* ID:t före publiceringsknappen: det står i annonstexten som skickas, och säljaren ska ha
              sett vad de delar innan de trycker. */}
          {loopaId && <LoopaIdBlock loopaId={loopaId} />}
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
