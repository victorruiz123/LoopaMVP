import { useEffect, useState } from "react";
import { actOnPrice, fetchDeal, markInvited } from "../api";
import type { DealActions, DealEvent, DealView, VerifiedCard as VerifiedCardData } from "../types";
import Timeline from "../components/Timeline";
import InviteMessage from "../components/InviteMessage";
import PreliminaryCard from "../components/PreliminaryCard";
import VerifiedCard from "../components/VerifiedCard";
import PriceRound from "../components/PriceRound";
import { navigate } from "../router";

/**
 * Affärsrummet. Samma rum, två roller.
 *
 * Vad som skiljer sig åt är litet och medvetet: köparen ser sin preliminära bedömning och sin
 * inbjudningslänk, säljaren ser ingetdera. Bedömningen är köparens eget underlag inför ett bud, och
 * att visa säljaren vad vi gissat om deras möbel innan de själva filmat den vore att lägga vår tumme
 * på deras våg. Efter skanningen har båda samma verifierade kort — se steg 4.
 *
 * INGEN CHATT, enligt briefen. Rummet visar status och strukturerade handlingar. Det som ska sägas
 * mellan parterna sägs där de redan pratar.
 */
export default function DealScreen({ id }: { id: string }) {
  const [deal, setDeal] = useState<DealView | null>(null);
  const [events, setEvents] = useState<DealEvent[]>([]);
  const [verified, setVerified] = useState<VerifiedCardData | null>(null);
  const [actions, setActions] = useState<DealActions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetchDeal(id)
      .then((r) => { setDeal(r.deal); setEvents(r.events); setVerified(r.verified); setActions(r.actions); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Kunde inte hämta affären."));

  useEffect(() => { void load(); }, [id]);

  if (error) {
    return (
      <div className="affar-page">
        <section className="affar-card">
          <h2>Vi hittar inte affären</h2>
          <p className="affar-hint">{error}</p>
          <button type="button" className="btn btn-outline btn-small" onClick={() => navigate({ name: "intake" })}>
            Tillbaka
          </button>
        </section>
      </div>
    );
  }

  if (!deal) return <div className="affar-page"><div className="affar-skeleton" /></div>;

  const buyer = deal.role === "buyer";

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">Affär · {buyer ? "du köper" : "du säljer"}</span>
        <h1>{deal.what}</h1>
        {deal.askingPriceSek !== null && (
          <p>Begärt pris: {deal.askingPriceSek.toLocaleString("sv-SE")} kr</p>
        )}
      </header>

      <Timeline deal={deal} />

      {/* Inbjudan visas bara för köparen, och bara så länge den är kvar att skicka. */}
      {buyer && (deal.state === "created" || deal.state === "invited") && (
        <InviteMessage
          deal={deal}
          onCopied={() => {
            // Övergången sker när köparen HÄMTAT sin länk, inte när säljaren svarat: det är den
            // enda punkt vi faktiskt kan observera, och det är den klockan om sju dagar mäter.
            if (deal.state === "created") void markInvited(deal.id).then((r) => setDeal(r.deal)).catch(() => undefined);
          }}
        />
      )}

      {/* Säljarens nästa steg: filma möbeln. Länken bär affärens id så att skanningen knyts till den
          — och därmed märks som privat, utanför Butik och det publika kortet. */}
      {!buyer && deal.state === "seller_joined" && !deal.scanJobId && (
        <section className="affar-card affar-cta">
          <h2>Filma möbeln</h2>
          <p>Ett varv runt med mobilen, ungefär tre minuter. Vi fyller i det vi redan vet från annonsen.</p>
          <a className="btn btn-primary" href={`/?affar=${encodeURIComponent(deal.id)}`}>Starta filmningen</a>
        </section>
      )}

      {!buyer && deal.state === "seller_joined" && deal.scanJobId && (
        <section className="affar-card">
          <h2>Granskningen pågår</h2>
          <p className="affar-hint">Vi går igenom bildrutorna. Det tar ett par minuter — du kan stänga sidan så länge.</p>
          <button type="button" className="btn btn-outline btn-small" onClick={() => void load()}>Uppdatera</button>
        </section>
      )}

      {/* Prisrundan står FÖRE kortet när den är öppen: den är det som väntar på ett svar, och kortet
          är underlaget man läser för att kunna ge det. */}
      {actions && (deal.state === "price_pending" || deal.state === "price_agreed") && (
        <PriceRound
          deal={deal}
          actions={actions}
          onAct={async (handling, belopp) => {
            const r = await actOnPrice(deal.id, handling, belopp);
            setDeal(r.deal);
            setActions(r.actions);
            setVerified(r.verified);
            // Huvudboken har fått nya rader — hämta om den så tidslinjen stämmer med knappen man tryckte.
            void fetchDeal(deal.id).then((f) => setEvents(f.events)).catch(() => undefined);
          }}
        />
      )}

      {/* Det verifierade kortet är gemensamt: efter skanningen ser båda exakt samma sak. */}
      {verified && <VerifiedCard card={verified} />}

      {/* Köparens preliminära bedömning står kvar, men UNDER det verifierade kortet när det finns:
          gissningen är inte längre det bästa vi vet. */}
      {buyer && deal.assessment && (
        <PreliminaryCard
          analysis={{
            assessment: deal.assessment,
            submission: deal.submission ?? { adUrl: null, description: null, askingPriceSek: null, imagePaths: 0 },
            priceVerdict: deal.priceVerdict ?? { verdict: "okant", text: "" },
            scratchId: deal.id,
            source: "MANUAL_CONTENT",
          }}
        />
      )}

      {deal.expiresAt && deal.state !== "declined" && deal.state !== "expired" && (
        <p className="affar-hint affar-expiry">
          Det här steget gäller till {new Date(deal.expiresAt).toLocaleDateString("sv-SE", { day: "numeric", month: "long" })}.
        </p>
      )}

      {events.length > 0 && (
        <section className="affar-card">
          <h2>Vad som hänt</h2>
          <ol className="affar-log">
            {events.map((e) => (
              <li key={e.id}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                <span>{e.note ?? e.to}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
