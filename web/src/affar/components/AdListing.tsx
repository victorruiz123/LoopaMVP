import { useState } from "react";
import type { ConditionJob, GeneratedListing } from "../../types";
import { track } from "../../butik/components/Bits";
import { marketValue } from "../marketValue";

/**
 * Annonssidan — det köparen tar med sig till säljaren.
 *
 * Slutet på köparens väg, och den ENDA skärmen som har ett utgående steg: länken som skickas till
 * säljaren. Allt före den handlar om att förstå möbeln; det här handlar om att göra något åt den.
 *
 * INGET SKICK STÅR HÄR, och frånvaron är avsiktlig. Sidan visar modellen, måtten, egenskaperna och
 * marknadsvärdet — allt som går att veta om VILKEN möbel det är. Vad just det här exemplaret är värt
 * avgörs av slitaget, och det ser vi först när säljaren filmat. Att gissa det här hade gjort
 * säljarens filmning meningslös.
 */

const SEK = new Intl.NumberFormat("sv-SE");

export default function AdListing({
  job,
  card,
  askingPriceSek,
  adText,
  onInvite,
}: {
  job: ConditionJob;
  card: GeneratedListing;
  askingPriceSek: number | null;
  /** Annonsens egen text. Se varför den och inte kortets nedan. */
  adText: string | null;
  /** Vidare till inbjudan: postnummer, konto, och länken köparen skickar till säljaren. */
  onInvite: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const name = [card.identity.brand, card.identity.exactProduct].filter(Boolean).join(" ") || card.listing.title;
  const { low, high } = marketValue(card);
  /**
   * Annonsens första bild — säljarens egen, inte tillverkarens katalogfoto.
   *
   * Sidan ska likna den annons köparen kom ifrån. Katalogbilden visar en NY möbel, och den skulle
   * lova precis det skick sidan i övrigt är noga med att inte uttala sig om.
   */
  const photo = job.images?.[0];

  const dims = card.attributes.filter((a) => /bredd|djup|h[öo]jd|l[äa]ngd|sitth/i.test(`${a.key} ${a.label}`));
  const rest = card.attributes.filter((a) => !dims.includes(a));

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">Steg 4 av 4</span>
        <h1>{name}</h1>
        {askingPriceSek !== null && <p>Säljaren begär {SEK.format(askingPriceSek)} kr.</p>}
      </header>

      {photo && (
        <figure className="affar-photo">
          <img src={`/api/affar/analys/${job.id}/bild/${photo.id}`} alt={name} />
          <figcaption>Bilden kommer från annonsen.</figcaption>
        </figure>
      )}

      <section className="affar-card">
        <h2>Vad vi vet om möbeln</h2>

        {dims.length > 0 && (
          <>
            <span className="affar-label">Mått</span>
            <dl className="affar-measures">
              {dims.map((a) => (
                <div key={a.key + a.label}>
                  <dt>{a.label}</dt>
                  <dd>{a.value}{a.estimated && <span className="affar-est"> uppskattat</span>}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {rest.length > 0 && (
          <>
            <span className="affar-label">Egenskaper</span>
            <dl className="affar-measures">
              {rest.map((a) => (
                <div key={a.key + a.label}>
                  <dt>{a.label}</dt>
                  <dd>{a.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {low !== null && high !== null && (
          <>
            <span className="affar-label">Marknadsvärde</span>
            <p className="affar-amount-value" style={{ fontSize: 24 }}>{SEK.format(low)}–{SEK.format(high)} kr</p>
          </>
        )}

        <p className="affar-hint">
          Skicket står inte här — det går inte att bedöma från annonsens bilder. Det får du när säljaren
          filmat möbeln.
        </p>
      </section>

      {/*
        SÄLJARENS EGEN TEXT, inte kortets genererade annonstext.
        Generatorn skriver färdig annonstext åt en säljare vars möbel ÄR besiktigad, och den skrev
        "Soffan är i fint använt skick" om en soffa ingen sett — två stycken under löftet att skicket
        inte står här. Annonsens egen text påstår inget i vårt namn: den är citerad, som bilden.
      */}
      {adText && (
        <section className="affar-card">
          <h2>Ur annonsen</h2>
          <p className="affar-quote">{adText}</p>
          <p className="affar-hint">Ordagrant ur annonsen. Vi har inte kontrollerat påståendena.</p>
        </section>
      )}

      <section className="affar-card affar-cta">
        <h2>Nästa steg: bjud in säljaren</h2>
        <p>
          Säljaren filmar möbeln på tre minuter. Då får du det riktiga skicket, ett granskat pris — och kan
          köpa tryggt med hemleverans.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            track("invite_from_listing", { jobId: job.id });
            /**
             * Nästa STEG, inte nästa adress.
             *
             * Stod som `window.location.href = "/kop/analysera?analys=…"` — men det är adressen
             * köparen redan står på, och ingen läste `?analys`. Knappen laddade om samma sida och
             * såg ut att inte göra någonting alls.
             */
            onInvite();
          }}
        >
          Bjud in säljaren
        </button>
        <p className="affar-hint">
          {copied ? "Länken är kopierad." : "Du får en färdig text att klistra in där du redan pratar med säljaren."}
        </p>
        <button
          type="button"
          className="btn btn-text btn-small"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
          }}
        >
          Kopiera länken till den här sidan
        </button>
      </section>
    </div>
  );
}
