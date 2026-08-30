import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { useT } from "../lib/i18n";
import { publicCardPath } from "../lib/loopaId";

/**
 * Kortets publika ID, på säljarens egen vy.
 *
 * Ligger här och inte i en fotnot för att det är ett besked, inte en detalj: kortet är publikt, och
 * ID:t är det som gör det åtkomligt. Den som säljer med Loopa ska ha läst det innan de trycker,
 * inte upptäcka det i annonstexten efteråt.
 */
export default function LoopaIdBlock({ loopaId }: { loopaId: string }) {
  const t = useT();
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
    <section className="card-block loopa-id-block">
      <h3>{t("Loopa-ID")}</h3>
      <div className="loopa-id-row">
        <span className="loopa-id-value">{loopaId}</span>
        <button className="loopa-id-copy" onClick={copy} aria-label={t("Kopiera Loopa-ID")}>
          {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          {copied ? t("Kopierat") : t("Kopiera")}
        </button>
      </div>
      <p className="muted small">
        {t(
          "Annonsen är publik. ID:t står i Tradera-annonsen, och den som söker på det hos Loopa ser skicket, alla skador, måtten och källorna — men aldrig dina egna bilder eller ditt konto.",
        )}
      </p>
      <a className="loopa-id-link" href={publicCardPath(loopaId)} target="_blank" rel="noreferrer">
        {t("Öppna den publika annonsen")}
      </a>
    </section>
  );
}
