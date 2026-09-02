import { useState } from "react";
import type { DealActions, DealView } from "../types";

/**
 * Prisrundan, som båda parter ser den.
 *
 * SAMMA KORT ÅT BÅDA HÅLL. Beloppet, motiveringen och vem som redan sagt ja står likadant för
 * köparen och säljaren — en förhandling där parterna ser olika underlag är inte en förhandling utan
 * ett övertag.
 *
 * Loopas utgångsbud står först och är märkt som vårt, inte som motpartens. Det är skillnaden mellan
 * "de vill ha 1 200" och "så här värderas möbeln efter granskningen", och den skillnaden avgör om
 * nästa klick känns som ett prut eller som ett besked.
 */

const SEK = new Intl.NumberFormat("sv-SE");

export default function PriceRound({
  deal,
  actions,
  onAct,
}: {
  deal: DealView;
  actions: DealActions;
  onAct: (handling: "acceptera" | "motbud" | "avbryt", belopp?: number) => Promise<void>;
}) {
  const [countering, setCountering] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = deal.proposals.at(-1);
  if (!current) return null;

  const other = deal.role === "buyer" ? "seller" : "buyer";
  const otherAccepted = deal.acceptedBy.includes(other);
  const agreed = deal.state === "price_agreed";

  const act = async (handling: "acceptera" | "motbud" | "avbryt", belopp?: number) => {
    setBusy(true);
    setError(null);
    try {
      await onAct(handling, belopp);
      setCountering(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Det gick inte.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="affar-card affar-price-round">
      <h2>{agreed ? "Priset är klart" : "Priset"}</h2>

      <div className="affar-amount">
        <span className="affar-amount-value">{SEK.format(agreed ? deal.agreedPriceSek ?? current.amountSek : current.amountSek)} kr</span>
        <span className="affar-amount-by">
          {current.by === "loopa" ? "Loopas förslag efter granskningen"
            : current.by === deal.role ? "Ditt bud"
            : "Motpartens bud"}
        </span>
      </div>

      {current.rationale && <p className="affar-rationale">{current.rationale}</p>}

      {!agreed && otherAccepted && (
        <p className="affar-hint affar-accepted">
          {other === "buyer" ? "Köparen" : "Säljaren"} har accepterat. Säger du ja är affären klar.
        </p>
      )}
      {!agreed && actions.hasAccepted && (
        <p className="affar-hint affar-accepted">Du har accepterat. Vi väntar på motparten.</p>
      )}

      {error && <p className="affar-error">{error}</p>}

      {!agreed && (actions.canAccept || actions.canCounter || actions.canDecline) && (
        <div className="affar-actions">
          {actions.canAccept && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act("acceptera")}>
              Acceptera {SEK.format(current.amountSek)} kr
            </button>
          )}
          {actions.canCounter && !countering && (
            <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={() => setCountering(true)}>
              Lägg ett motbud
            </button>
          )}
          {actions.canDecline && (
            <button type="button" className="btn btn-text btn-small" disabled={busy} onClick={() => void act("avbryt")}>
              Tacka nej
            </button>
          )}
        </div>
      )}

      {countering && (
        <div className="affar-counter">
          <label className="affar-label" htmlFor="counter">Ditt bud</label>
          <div className="affar-field-row">
            <input
              id="counter"
              className="affar-input affar-input-short"
              type="number"
              inputMode="numeric"
              placeholder={String(current.amountSek)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy || !amount.trim()}
              onClick={() => void act("motbud", Number(amount.replace(/\D/g, "")))}
            >
              Skicka budet
            </button>
          </div>
          {/* Sagt en gång, tydligt: det här är enda motbudet. Trygg affär är inte en förhandling. */}
          <p className="affar-hint">Du kan lägga ett motbud. Efter det är det ja eller nej som gäller.</p>
        </div>
      )}
    </section>
  );
}
