import { useState } from "react";
import { track } from "./Bits";
import HeroPreview from "./HeroPreview";

/**
 * Förstasidans hjärta: klistra in en annons du hittat någon annanstans.
 *
 * DEN HÄR RUTAN ÄR PRODUKTEN, inte en bifunktion. Loopas lager är hundratals möbler; Blockets är
 * hundratusentals. Den som letar en soffa har nästan alltid redan hittat en — det de saknar är någon
 * som kan säga om den är värd pengarna och sedan bära hem den. Därför står fältet överst, ensamt,
 * och allt annat på sidan kommer efter.
 *
 * TRE SAKER GÖR FÄLTET SJÄLVKLART, och alla tre är svar på "vad händer om jag skriver här":
 *
 *   1. Rubriken säger vad man får, inte vad vi gör: "Vi granskar den. Du får hem den."
 *   2. Fältet visar en RIKTIG adress som platshållare. En tom ruta med "klistra in länk" lämnar
 *      frågan om vilken sorts länk öppen — en Blocket-adress svarar på den utan ett ord.
 *   3. Under fältet står de tre stegen i en rad. Den som tvekar behöver veta att inget händer
 *      bakom deras rygg: vi läser annonsen, de får en bedömning, och först därefter kontaktas
 *      säljaren — av dem själva.
 */
export default function LinkHero({ compact = false }: {
  /**
   * Smal upprepning längst ned på sidan.
   *
   * Samma fält, samma anrop — inte en andra komponent. Den som scrollat genom hela förklaringen och
   * först då kommit på att de har en Blocket-flik öppen ska slippa scrolla tillbaka, och en kopia
   * av rutan hade genast börjat glida isär från originalet.
   */
  compact?: boolean;
} = {}) {
  const [link, setLink] = useState("");
  // Två fält på samma sida får inte dela id — etiketten hade pekat på fel ruta.
  const id = compact ? "ad-link-foot" : "ad-link";

  return (
    <section className={compact ? "hero hero-compact" : "hero"}>
      <div className="hero-main">
      {!compact && <span className="butik-geo">📍 Just nu i Stockholm</span>}

      {compact ? (
        <h2 className="hero-title hero-title-compact">
          Har du en annons i en annan flik? <em>Klistra in den här.</em>
        </h2>
      ) : (
        <>
          <h1 className="hero-title">
            Hittat en möbel<br />
            någon annanstans?<br />
            <em>Vi granskar den. Du får hem den.</em>
          </h1>

          <p className="hero-lede">
            Klistra in länken till annonsen — Blocket, Tradera, Marketplace. Du får veta vilken modell det är,
            vad den mäter och vad den faktiskt är värd. Vill du köpa den sköter vi granskning, betalning och
            hemleverans ända in i rummet.
          </p>
        </>
      )}

      <form
        className="hero-form"
        onSubmit={(e) => {
          e.preventDefault();
          const url = link.trim();
          if (!url) {
            document.getElementById(id)?.focus();
            return;
          }
          track("elsewhere_link_submitted", { host: safeHost(url) });
          window.location.href = `/kop/analysera?url=${encodeURIComponent(url)}`;
        }}
      >
        {!compact && <label className="hero-label" htmlFor={id}>Länken till annonsen</label>}
        <div className="hero-field">
          <span className="hero-field-icon" aria-hidden="true">🔗</span>
          <input
            id={id}
            className="hero-input butik-elsewhere-input"
            type="url"
            inputMode="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://www.blocket.se/annons/..."
            aria-label="Länk till annonsen"
            autoComplete="off"
            spellCheck={false}
          />
          {/*
            INTE `disabled`. En grå knapp överst på sidan är det första besökaren ser av produkten,
            och en avstängd huvudknapp läser som att något är trasigt eller att man saknar behörighet.
            Den är alltid tänd; trycker man på den tom hoppar markören ned i fältet i stället, vilket
            är exakt vad man ville göra.
          */}
          <button type="submit" className="hero-go butik-elsewhere-go">
            Granska annonsen
          </button>
        </div>
        {!compact && (
          <p className="hero-note">
            Det räcker med länken. Inget konto behövs för att se vad vi tycker om möbeln.
          </p>
        )}
      </form>

      {/* Vad som händer när man trycker. Tre rader, för att den vanligaste tveksamheten inte är
          "funkar det" utan "hör ni av er till säljaren bakom ryggen på mig". Det gör vi aldrig. */}
      {!compact && (
      <ol className="hero-next">
        <li><b>Direkt:</b> vi läser annonsen och visar modell, mått och marknadspris.</li>
        <li><b>Sedan:</b> du får en färdig text att skicka säljaren — om du vill.</li>
        <li><b>Aldrig:</b> vi kontaktar aldrig säljaren själva.</li>
      </ol>
      )}
      </div>
      {!compact && <HeroPreview />}
    </section>
  );
}

/** Bara värdnamnet till analysen — aldrig hela adressen, som kan bära vem annonsen tillhör. */
function safeHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}
