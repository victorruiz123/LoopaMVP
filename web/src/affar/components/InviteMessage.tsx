import { useState } from "react";
import type { DealView } from "../types";

/**
 * Meddelandet köparen klistrar in i Blockets chatt.
 *
 * VI SKICKAR DET ALDRIG. Loopa kontaktar aldrig en säljare som inte bett om det — hela flödet bygger
 * på att köparen, som säljaren redan pratar med, tar med sig oss in i samtalet. Knappen här kopierar;
 * fingrarna som klistrar in är köparens.
 *
 * Texten är REDIGERBAR före kopiering, och det är inte en artighet. Ett standardmeddelande som
 * skickas ordagrant av tusen köpare läser som spam för den som tagit emot det förut, och det är
 * säljarens första intryck av oss. Att köparen kan skriva om det i sin egen röst är det som gör att
 * det ser ut som ett meddelande från en människa — vilket det också är.
 */

function defaultMessage(deal: DealView, link: string): string {
  const what = deal.what.toLowerCase();
  const offered = deal.proposals.find((p) => p.by === "buyer")?.amountSek ?? null;
  const price = offered ? ` Jag tänkte mig ${offered.toLocaleString("sv-SE")} kr.` : "";
  return (
    `Hej! Jag vill gärna köpa din ${what}. Kan vi ta affären via Loopa? ` +
    `Då får du betalt säkert direkt när den hämtas, och de sköter frakten – du behöver inte göra ` +
    `något mer än att filma möbeln kort.${price}\n\n${link}`
  );
}

export default function InviteMessage({
  deal,
  onCopied,
}: {
  deal: DealView;
  onCopied: () => void;
}) {
  const link = `${window.location.origin}/a/${deal.inviteToken ?? ""}`;
  const [text, setText] = useState(() => defaultMessage(deal, link));
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      onCopied();
      setTimeout(() => setCopied(false), 4000);
    } catch {
      // Utan urklippsrättighet (äldre webbläsare, osäker kontext) markeras texten i stället så att
      // köparen kan kopiera för hand. Ett tyst misslyckande hade sett ut som att knappen funkade.
      setFailed(true);
      onCopied();
    }
  };

  return (
    <section className="affar-card">
      <h2>Skicka det här till säljaren</h2>
      <p className="affar-hint">
        Kopiera texten och klistra in den i Blockets chatt. Vi hör aldrig av oss till säljaren själva —
        det är du som tar med oss in i samtalet.
      </p>

      <textarea
        className="affar-input affar-textarea affar-message"
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Meddelande till säljaren"
      />

      <div className="affar-actions">
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? "Kopierat ✓" : "Kopiera meddelandet"}
        </button>
        <button type="button" className="btn btn-outline btn-small" onClick={() => setText(defaultMessage(deal, link))}>
          Återställ texten
        </button>
      </div>

      {failed && (
        <p className="affar-hint affar-error">
          Kopieringen blockerades av webbläsaren. Markera texten ovan och kopiera den för hand.
        </p>
      )}

      <p className="affar-hint">
        Länken i meddelandet är din affärs egen. Den som har den kan se erbjudandet — dela den bara med säljaren.
      </p>
    </section>
  );
}
