import { useState } from "react";
import { track } from "./Bits";

/**
 * "Hittat en möbel någon annanstans?" — ingången till Trygg affär.
 *
 * EN LÄNK RÄCKER. Servern läser annonsen och plockar ut rubrik, beskrivning, bilder, pris och
 * säljarens skickuppgift; köparen ska inte behöva göra om det arbete som redan finns på en sida de
 * just tittat på. Går hämtningen inte — sidan förbjuder det, eller svarar inte — säger nästa skärm
 * det rakt ut och ber om skärmbilder i stället.
 *
 * Ligger på KÖPSIDAN. Den som öppnar /butik är i köpläge; den som öppnar startsidan är där för att
 * sälja. Rutan stod först på den senare, vilket bad folk välja riktning innan de sagt vad de ville.
 */
export default function BuySomewhereElse() {
  const [link, setLink] = useState("");

  return (
    <section className="butik-elsewhere">
      <div className="butik-elsewhere-text">
        <h2>Hittat en möbel någon annanstans?</h2>
        <p>
          Klistra in länken — vi läser annonsen och säger vad vi tror om möbeln och priset. Vill du köpa den
          sköter vi granskning, betalning och hemleverans.
        </p>
      </div>
      <form
        className="butik-elsewhere-form"
        onSubmit={(e) => {
          e.preventDefault();
          const url = link.trim();
          if (!url) return;
          track("elsewhere_link_submitted", { host: safeHost(url) });
          window.location.href = `/kop/analysera?url=${encodeURIComponent(url)}`;
        }}
      >
        <input
          className="butik-elsewhere-input"
          type="url"
          inputMode="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Klistra in länken till annonsen"
          aria-label="Länk till annonsen"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="butik-elsewhere-go" disabled={!link.trim()}>
          Kolla annonsen
        </button>
      </form>
      <p className="butik-elsewhere-hint">Fungerar med Blocket, Facebook Marketplace och de flesta andra annonssidor.</p>
    </section>
  );
}

/** Bara värdnamnet till analysen — aldrig hela adressen, som kan bära vem annonsen tillhör. */
function safeHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}
