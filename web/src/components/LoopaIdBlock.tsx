import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { publicCardPath } from "../lib/loopaId";

/**
 * Kortets publika ID, på säljarens egen vy.
 *
 * Ligger här och inte i en fotnot för att det är ett besked, inte en detalj: kortet är publikt, och
 * ID:t är det som gör det åtkomligt. Den som publicerar på Tradera ska ha läst det innan de trycker,
 * inte upptäcka det i annonstexten efteråt.
 */
export default function LoopaIdBlock({ loopaId }: { loopaId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      // Utanför en säker kontext finns inte clipboard alls. Då står ID:t kvar på skärmen att skriva
      // av — knappen får misslyckas tyst, den är en genväg och inte vägen.
      await navigator.clipboard?.writeText(loopaId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignoreras med flit */
    }
  }

  return (
    <section className="truth-block loopa-id-block">
      <h3>Loopa-ID</h3>
      <div className="loopa-id-row">
        <span className="loopa-id-value">{loopaId}</span>
        <button className="loopa-id-copy" onClick={copy} aria-label="Kopiera Loopa-ID">
          {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          {copied ? "Kopierat" : "Kopiera"}
        </button>
      </div>
      <p className="muted small">
        Truth-cardet är publikt. ID:t står i Tradera-annonsen, och den som söker på det hos Loopa ser
        skicket, alla skador, måtten och källorna — men aldrig dina egna bilder eller ditt konto.
      </p>
      <a className="loopa-id-link" href={publicCardPath(loopaId)} target="_blank" rel="noreferrer">
        Öppna det publika kortet
      </a>
    </section>
  );
}
