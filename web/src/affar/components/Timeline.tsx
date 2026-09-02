import type { DealState, DealView } from "../types";

/**
 * Affärens gång, som båda parter ser den.
 *
 * SAMMA TIDSLINJE FÖR BÅDA, med flit. En affär där köparen och säljaren ser olika bilder av var den
 * står är en affär som mailas om. Stegen är formulerade neutralt av samma skäl — "Betalningen är
 * gjord", inte "Du har betalat" — så att samma rad går att visa åt båda hållen.
 *
 * Stegen är FÄRRE än tillstånden i maskinen. `created`, `invited` och `seller_joined` är tre
 * tillstånd men ett enda skede för den som tittar, och `price_pending` och `price_agreed` likaså. En
 * tidslinje med fjorton punkter beskriver systemet, inte affären.
 */

const STEPS: Array<{ label: string; states: DealState[] }> = [
  { label: "Inbjudan skickad", states: ["invited", "seller_joined", "scanned", "price_pending", "price_agreed", "paid", "pickup_booked", "picked_up", "delivered", "approved", "paid_out"] },
  { label: "Säljaren med", states: ["seller_joined", "scanned", "price_pending", "price_agreed", "paid", "pickup_booked", "picked_up", "delivered", "approved", "paid_out"] },
  { label: "Möbeln granskad", states: ["scanned", "price_pending", "price_agreed", "paid", "pickup_booked", "picked_up", "delivered", "approved", "paid_out"] },
  { label: "Priset överens", states: ["price_agreed", "paid", "pickup_booked", "picked_up", "delivered", "approved", "paid_out"] },
  { label: "Betald", states: ["paid", "pickup_booked", "picked_up", "delivered", "approved", "paid_out"] },
  { label: "Levererad", states: ["delivered", "approved", "paid_out"] },
  { label: "Klar", states: ["approved", "paid_out"] },
];

/** Vad som händer just nu, i en mening. Den enda raden de flesta läser. */
export function statusLine(deal: DealView): string {
  const seller = deal.role === "seller";
  switch (deal.state) {
    case "created": return "Affären är skapad. Nästa steg är att bjuda in säljaren.";
    case "invited": return seller ? "Köparen väntar på ditt svar." : "Inbjudan är skickad. Nu väntar vi på att säljaren ska gå med.";
    case "seller_joined": return seller ? "Nu filmar du möbeln — det tar ungefär tre minuter." : "Säljaren är med och ska filma möbeln.";
    case "scanned": return "Möbeln är granskad. Nästa steg är att komma överens om priset.";
    case "price_pending": return deal.awaiting === deal.role ? "Du har ett prisförslag att ta ställning till." : "Väntar på motpartens svar om priset.";
    case "price_agreed": return seller ? "Priset är klart. Köparen betalar." : "Priset är klart. Nästa steg är betalningen.";
    case "paid": return "Betalningen är gjord och hålls tills möbeln är levererad.";
    case "pickup_booked": return "Upphämtningen är bokad.";
    case "picked_up": return "Möbeln är hämtad och på väg.";
    case "delivered": return seller ? "Möbeln är levererad. Köparen har ett dygn på sig att kvittera." : "Möbeln är levererad. Kvittera när du sett den.";
    case "approved": return "Köpet är kvitterat. Utbetalningen är på väg.";
    case "paid_out": return "Klart. Pengarna är utbetalda.";
    case "declined": return "Affären avbröts.";
    case "expired": return "Affären hann gå ut innan den blev av.";
  }
}

export default function Timeline({ deal }: { deal: DealView }) {
  const dead = deal.state === "declined" || deal.state === "expired";
  return (
    <section className="affar-card">
      <p className="affar-status">{statusLine(deal)}</p>
      {!dead && (
        <ol className="affar-timeline">
          {STEPS.map((step) => {
            const done = step.states.includes(deal.state);
            return (
              <li key={step.label} className={done ? "affar-step affar-step-done" : "affar-step"}>
                <span className="affar-step-dot" aria-hidden="true">{done ? "✓" : ""}</span>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
