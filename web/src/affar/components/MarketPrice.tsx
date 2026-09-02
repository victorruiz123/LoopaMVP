import type { GeneratedListing } from "../../types";
import { marketValue, verdictFor } from "../marketValue";

/**
 * Marknadspriset, ur köparens synvinkel.
 *
 * SÄLJARENS PRISSKÄRM ÄR EN ANNAN FRÅGA, och därför är det här en egen vy och inte PriceScreen.
 * Säljaren väljer sitt utropspris ur en stege — "hur bråttom har du?" — och det valet finns inte för
 * en köpare. Köparen har ett begärt pris framför sig och vill veta en sak: är det rimligt?
 *
 * Talen kommer från samma prismotor som säljaren möter. Det är bara frågan som skiljer.
 */

const SEK = new Intl.NumberFormat("sv-SE");

export default function MarketPrice({
  card,
  askingPriceSek,
  onNext,
  onBack,
}: {
  /** Null medan annonskortet fortfarande genereras — då står spannet som en platshållare. */
  card: GeneratedListing | null;
  askingPriceSek: number | null;
  onNext: () => void;
  onBack: () => void;
}) {
  const value = marketValue(card);
  const { low, high, retail } = value;
  const verdict = verdictFor(askingPriceSek, value);

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">Steg 3 av 4</span>
        <h1>Är priset rimligt?</h1>
        <p>Vi jämför det säljaren begär med vad liknande möbler faktiskt säljs för.</p>
      </header>

      <section className="affar-card">
        {askingPriceSek !== null && (
          <div className="affar-amount">
            <span className="affar-amount-value">{SEK.format(askingPriceSek)} kr</span>
            <span className="affar-amount-by">säljarens pris</span>
          </div>
        )}

        {low !== null && high !== null ? (
          <>
            <dl className="affar-facts affar-facts-light">
              <div>
                <dt>Marknadsvärde</dt>
                <dd>{SEK.format(low)}–{SEK.format(high)} kr</dd>
              </div>
              {retail && (
                <div>
                  <dt>Nypris</dt>
                  <dd>{SEK.format(retail)} kr</dd>
                </div>
              )}
            </dl>
            {verdict && <p className={`affar-price affar-price-${verdict.tone}`}>{verdict.text}</p>}
          </>
        ) : card ? (
          <p className="affar-hint">
            Vi hittade inga jämförbara annonser för just den här modellen, så vi kan inte säga om priset är rimligt.
          </p>
        ) : (
          <div className="affar-skeleton" style={{ height: 90 }} />
        )}

        {/* Sagt rakt ut: värderingen gäller MODELLEN, inte det här exemplaret. Skicket avgör resten,
            och det vet vi inget om förrän säljaren filmat. */}
        <p className="affar-hint">
          Värderingen gäller modellen i normalt begagnat skick. Vad just den här möbeln är värd beror på
          slitaget — och det ser vi först när säljaren filmat den.
        </p>

        <div className="affar-actions">
          <button type="button" className="btn btn-primary" onClick={onNext}>Se annonsen</button>
          <button type="button" className="btn btn-text btn-small" onClick={onBack}>Tillbaka</button>
        </div>
      </section>
    </div>
  );
}
