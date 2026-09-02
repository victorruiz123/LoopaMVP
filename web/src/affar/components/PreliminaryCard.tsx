import type { Analysis } from "../types";

/**
 * Det preliminära sanningskortet.
 *
 * SKILLNADEN MOT DET RIKTIGA KORTET ÄR HELA POÄNGEN, och den måste synas innan man läst en rad.
 * Loopas verifierade kort är ett attest: möbeln är filmad ur kända vinklar och varje skada är
 * utpekad med närbild. Det här är en bedömning av NÅGON ANNANS annonsbilder — bilder säljaren valt,
 * ofta just för att slitaget inte syns. Skulle de två läsa likadant vore det verifierade kortet
 * inte värt något.
 *
 * Därför: gul ram i stället för vit, ordet "preliminär" i rubriken, säkerheten utskriven, och
 * iakttagelser formulerade som iakttagelser. Inget betyg alls när säkerheten är låg — se
 * assess.ts, som håller tillbaka det på serversidan så att gränssnittet inte kan råka visa ett.
 */

const SEK = new Intl.NumberFormat("sv-SE");

const CONFIDENCE_TEXT: Record<Analysis["assessment"]["confidence"], string> = {
  low: "Låg säkerhet — bilderna räcker inte för att säga mycket. Ställ frågorna nedan.",
  medium: "Medelhög säkerhet — bilderna visar en del, men långt ifrån allt.",
  high: "God säkerhet för att vara annonsbilder — men möbeln är fortfarande inte granskad av oss.",
};

export default function PreliminaryCard({ analysis }: { analysis: Analysis }) {
  const a = analysis.assessment;
  const name = [a.brand, a.model].filter(Boolean).join(" ");

  return (
    <section className="affar-prelim">
      <header className="affar-prelim-head">
        <span className="affar-prelim-tag">Preliminär bedömning</span>
        <p className="affar-prelim-basis">Baserad på annonsens bilder — möbeln är inte granskad av oss</p>
      </header>

      {name && <h2 className="affar-prelim-name">{name}</h2>}

      {a.gradeNote && <p className="affar-prelim-note">{a.gradeNote}</p>}
      <p className="affar-prelim-confidence">{CONFIDENCE_TEXT[a.confidence]}</p>

      {analysis.priceVerdict.verdict !== "okant" && (
        <div className={`affar-price affar-price-${analysis.priceVerdict.verdict}`}>
          {analysis.priceVerdict.text}
        </div>
      )}
      {analysis.priceVerdict.verdict === "okant" && (
        <p className="affar-prelim-note muted">{analysis.priceVerdict.text}</p>
      )}

      {a.redFlags.length > 0 && (
        <div className="affar-flags">
          <h3>Var uppmärksam</h3>
          <ul>{a.redFlags.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}

      {a.observations.length > 0 && (
        <div className="affar-block">
          <h3>Vad vi ser på bilderna</h3>
          <ul className="affar-list">{a.observations.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
      )}

      {/* Det mest användbara på hela kortet: vad bilderna INTE visar. En bedömning som bara säger
          "ser bra ut" är värdelös; den här listan är vad köparen faktiskt kan agera på. */}
      {a.questions.length > 0 && (
        <div className="affar-block">
          <h3>Frågor att ställa säljaren</h3>
          <ul className="affar-list affar-questions">
            {a.questions.map((q, i) => (
              <li key={i}>
                <span>{q}</span>
                <button type="button" className="affar-copy-mini" onClick={() => navigator.clipboard?.writeText(q)}>
                  Kopiera
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(a.marketLowSek !== null || a.grade) && (
        <dl className="affar-facts">
          {a.grade && (
            <div><dt>Uppskattat skick</dt><dd>{a.grade}</dd></div>
          )}
          {a.marketLowSek !== null && a.marketHighSek !== null && (
            <div>
              <dt>Marknadsvärde</dt>
              <dd>{SEK.format(a.marketLowSek)}–{SEK.format(a.marketHighSek)} kr</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
