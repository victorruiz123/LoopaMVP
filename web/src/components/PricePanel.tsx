import type { PriceEstimate } from "../types";
import { formatSek, variantLabel } from "../lib/price";

/**
 * The price half of the combined report. Seller-facing, so it follows ResultScreen's rule: a number and
 * one sentence of plain Swedish, no engine internals — those live in TechnicalPanel.
 *
 * All three statuses render. A missing price is a thing the seller needs told, not an empty space:
 * "no_data" means the engine ran and found nothing comparable, "unavailable" means it never answered,
 * and those call for different next steps.
 */
export default function PricePanel({ price }: { price: PriceEstimate }) {
  if (price.status !== "ok") {
    return (
      <section className="price-panel price-panel-empty">
        <div className="price-panel-head">Prisförslag</div>
        <p className="price-empty-title">
          {price.status === "no_data" ? "Inget prisförslag den här gången" : "Priset kunde inte hämtas"}
        </p>
        <p className="muted small">
          {price.status === "no_data"
            ? "Vi hittade inga tillräckligt lika annonser att jämföra med. Skicket ovan gäller ändå."
            : price.unavailableReason}
        </p>
      </section>
    );
  }

  const deductionPct = price.damageDeduction ? Math.round(price.damageDeduction * 100) : 0;

  return (
    <section className="price-panel">
      <div className="price-panel-head">Prisförslag</div>
      <div className="price-main">{formatSek(price.default)}</div>
      <div className="price-range">
        <span className="price-range-end">
          <em>{formatSek(price.low)}</em>
          <span className="muted small">säljs snabbt</span>
        </span>
        <span className="price-range-bar" aria-hidden="true" />
        <span className="price-range-end price-range-end-high">
          <em>{formatSek(price.high)}</em>
          <span className="muted small">säljs långsamt</span>
        </span>
      </div>
      {deductionPct > 0 && (
        <p className="price-deduction">
          Skadorna nedan drar ner priset {deductionPct}&nbsp;%.
        </p>
      )}
      <p className="muted small price-basis">
        Bygger på {price.matchCount} liknande {price.matchCount === 1 ? "annons" : "annonser"}
        {price.variant?.length ? ` (${price.variant.map(variantLabel).join(", ")})` : ""}.
      </p>
    </section>
  );
}
