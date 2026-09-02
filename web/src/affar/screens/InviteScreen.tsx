import { useEffect, useState } from "react";
import { fetchInvite, joinDeal } from "../api";
import type { PublicInvite } from "../types";
import { useAuth } from "../../auth/AuthProvider";
import { navigate } from "../router";

/**
 * Säljarens landningssida. Den enda sidan i produkten som en okänd person når utan konto.
 *
 * VEM SOM LÄSER DEN: någon som fått ett meddelande i Blockets chatt av en främling, med en länk till
 * en tjänst de aldrig hört talas om. De är misstänksamma, och de har rätt att vara det. Sidan är
 * därför skriven för att besvara deras frågor i deras ordning — vad är det här, vad kostar det mig,
 * vad ska jag göra — och inte för att sälja in Loopa.
 *
 * ALLT ÄR I SÄLJARENS TERMER. "Du får betalt när möbeln hämtas" är detsamma som escrow, sagt så som
 * det spelar roll för den som ska få pengarna. Ingenting om köparen står här: vem de är, vad de
 * betalat för annat, vad vi gissat om deras affär.
 */
export default function InviteScreen({ token }: { token: string }) {
  const { user } = useAuth();
  const [invite, setInvite] = useState<PublicInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    fetchInvite(token)
      .then((r) => setInvite(r.invite))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Kunde inte hämta inbjudan."));
  }, [token]);

  if (error) {
    return (
      <div className="affar-page">
        <section className="affar-card">
          <h2>Inbjudan gäller inte längre</h2>
          <p className="affar-hint">{error}</p>
          <p className="affar-hint">Be köparen skicka en ny länk om ni fortfarande vill göra affären.</p>
        </section>
      </div>
    );
  }

  if (!invite) return <div className="affar-page"><div className="affar-skeleton" /></div>;

  if (invite.closed) {
    return (
      <div className="affar-page">
        <section className="affar-card">
          <h2>Den här affären är avslutad</h2>
          <p className="affar-hint">
            {invite.state === "expired"
              ? "Inbjudan hann gå ut. Be köparen skicka en ny om ni fortfarande vill göra affären."
              : "Affären är avslutad."}
          </p>
        </section>
      </div>
    );
  }

  const price = invite.offeredPriceSek ?? invite.askingPriceSek;

  /**
   * Att gå med kräver konto, och det är hela skillnaden mot att bara ha öppnat länken.
   *
   * Utan konto skickas säljaren till inloggningen med token kvar i adressen, så de landar tillbaka
   * här när de är klara. Med konto går de med direkt och hamnar i affärsrummet, där nästa steg är
   * att filma.
   */
  const join = async () => {
    if (!user) {
      window.location.href = `/?affar=${encodeURIComponent(token)}&retur=${encodeURIComponent(`/a/${token}`)}`;
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const { deal } = await joinDeal(token);
      navigate({ name: "deal", id: deal.id });
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : "Kunde inte gå med i affären.");
      setJoining(false);
    }
  };

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">Någon vill köpa din {invite.what.toLowerCase()}</span>
        <h1>Få betalt tryggt — utan att möta någon</h1>
        <p>
          En köpare vill göra affären genom Loopa.
          {price !== null && <> De har din {invite.what.toLowerCase()} på {price.toLocaleString("sv-SE")} kr.</>}
          {" "}Det kostar dig ingenting.
        </p>
      </header>

      <section className="affar-card">
        <h2>Så funkar det för dig</h2>
        <ol className="affar-steps">
          <li>
            <strong>Du filmar möbeln</strong>
            <span>Ett varv runt med mobilen, ungefär tre minuter. Vi gör resten — mått, skick, beskrivning.</span>
          </li>
          <li>
            <strong>Ni kommer överens om priset</strong>
            <span>Du ser vad granskningen visade och bestämmer själv om du säljer.</span>
          </li>
          <li>
            <strong>Vi hämtar hos dig</strong>
            <span>Ingen frakt att ordna, inga visningar, ingen som kommer hem till dig och prutar.</span>
          </li>
          <li>
            <strong>Du får betalt</strong>
            <span>Köparen betalar in innan vi hämtar. Pengarna går till dig när möbeln är levererad.</span>
          </li>
        </ol>
      </section>

      <section className="affar-card affar-cta">
        <h2>Kom igång</h2>
        <p className="affar-hint">
          Du behöver ett konto för att vi ska kunna betala ut pengarna till dig. Det tar en minut.
        </p>
        <button type="button" className="btn btn-primary" disabled={joining} onClick={join}>
          {joining ? "Öppnar affären…" : user ? "Kom igång – filma möbeln" : "Skapa konto och filma möbeln"}
        </button>
        {joinError && <p className="affar-error">{joinError}</p>}
        <p className="affar-hint">Ca 3 minuter. Du bestämmer själv om du säljer efteråt.</p>
      </section>

      <section className="affar-card">
        <h2>Vanliga frågor</h2>
        <dl className="affar-faq">
          <dt>Vad kostar det mig?</dt>
          <dd>Ingenting. Köparen betalar vår avgift och leveransen.</dd>
          <dt>Måste jag sälja?</dt>
          <dd>Nej. Du ser priset efter granskningen och kan tacka nej.</dd>
          <dt>Vem kommer hem till mig?</dt>
          <dd>En budfirma som hämtar möbeln på en tid du valt. Köparen kommer aldrig hem till dig.</dd>
          <dt>Vad händer med mina uppgifter?</dt>
          <dd>Köparen ser aldrig din adress eller ditt telefonnummer. Vi behöver dem bara för hämtningen.</dd>
        </dl>
      </section>
    </div>
  );
}
