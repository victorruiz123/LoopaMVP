import { useState } from "react";
import { track } from "../../butik/components/Bits";

/**
 * "Redan hittat något?" — köparens andra tillstånd.
 *
 * FÖRSTKLASSIG INGÅNG, inte en textlänk. Köparen har exakt två lägen: letar fortfarande, eller har
 * redan hittat. Det andra läget är dessutom det som konverterar bäst tidigt — en köpare som står med
 * en Blocket-annons framför sig har redan bestämt sig om möbeln och behöver bara oss. Blocket har
 * hundratusentals annonser; vårt lager har hundratals. Att gömma den vägen bakom en länk hade varit
 * att gömma den vanligaste anledningen att komma hit.
 *
 * Ligger under efterlysningen och inte över, för att efterlysningen är det vi vill lära folk att
 * göra — men den är visuellt lika stark, och fältet ligger inne i blocket så att vägen är ett tryck
 * och inte två.
 */
export default function TryggAffarBlock() {
  const [link, setLink] = useState("");

  return (
    <section className="kop-trygg">
      <div className="kop-trygg-text">
        <h2>Redan hittat något?</h2>
        <p className="kop-trygg-lead">
          Köp den tryggt via Loopa – vi granskar, hämtar och levererar.
        </p>
        <p className="kop-trygg-sub">Blocket, Marketplace eller Tradera.</p>
      </div>

      <form
        className="kop-trygg-form"
        onSubmit={(e) => {
          e.preventDefault();
          const url = link.trim();
          if (!url) { document.getElementById("trygg-link")?.focus(); return; }
          track("tryggaffar_started_from_buypage", { host: safeHost(url) });
          window.location.href = `/kop/analysera?url=${encodeURIComponent(url)}`;
        }}
      >
        <div className="kop-trygg-field">
          <span className="kop-trygg-icon" aria-hidden="true">🔗</span>
          <input
            id="trygg-link"
            type="url"
            inputMode="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://www.blocket.se/annons/..."
            aria-label="Länk till annonsen"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Granska annonsen</button>
        </div>
        <p className="kop-trygg-hint">
          Det räcker med länken. Du får modell, mått och marknadspris innan du hör av dig till säljaren —
          och vi kontaktar aldrig säljaren själva.
        </p>
      </form>
    </section>
  );
}

/** Bara värdnamnet till analysen — aldrig hela adressen, som kan bära vem annonsen tillhör. */
function safeHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}
