import { decide, useConsent } from "../lib/consent";
import LegalLink from "./LegalLink";
import { useT } from "../lib/i18n";

/**
 * Cookierutan.
 *
 * Två saker styr formen, och båda är regler snarare än smak.
 *
 * KNAPPARNA VÄGER LIKA. "Godkänn" i orange och "neka" som en blek textlänk är precis det mönster
 * tillsynen kallar mörkt: valet ska vara lika lätt att göra åt båda hållen. Därför delar de klass,
 * storlek och tyngd, och skiljs bara av vad det står på dem.
 *
 * RUTAN LÅSER INTE SIDAN. Inget överlägg, ingen fokusfälla, ingen kryssruta som måste tryckas för
 * att komma vidare — appen fungerar i sin helhet med frågan obesvarad, eftersom obesvarad betyder
 * att ingenting funktionellt lagras. Det som ÄR nödvändigt får sättas ändå, och en ruta som utger
 * sig för att vara ett hinder för det hade ljugit om vad den gör.
 *
 * Rutan visas när valet saknas — vid första besöket, efter en rensad webbläsare, och när någon
 * tryckt "Ändra mitt val" på cookiesidan.
 */
export default function CookieConsent() {
  const t = useT();
  const consent = useConsent();
  if (consent) return null;

  return (
    <div className="consent" role="dialog" aria-labelledby="consent-title" aria-describedby="consent-body">
      <div className="consent-inner">
        <h2 className="consent-title" id="consent-title">
          {t("Cookies")}
        </h2>
        <p className="consent-body" id="consent-body">
          {t(
            "Loopa sparar det som krävs för att hålla dig inloggad och visa dina bilder. Utöver det bara en sak: chatthistoriken på en annons du läser.",
          )}{" "}
          <strong>{t("Ingen analys, inga annonskakor, ingen spårning.")}</strong>
        </p>

        <div className="consent-actions">
          {/* Ordningen är den enda skillnaden, och den är godtycklig. Se komponentens kommentar. */}
          <button className="btn btn-outline consent-choice" onClick={() => decide(false)}>
            {t("Bara nödvändiga")}
          </button>
          <button className="btn btn-outline consent-choice" onClick={() => decide(true)}>
            {t("Godkänn alla")}
          </button>
        </div>

        <p className="consent-links">
          <LegalLink doc="cookies" /> · <LegalLink doc="privacy" />
        </p>
      </div>
    </div>
  );
}
