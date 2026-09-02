import { useEffect, useState } from "react";

/**
 * Vad det kostar, och de tre frågor alla ställer.
 *
 * SIFFRORNA HÄMTAS, DE SKRIVS INTE. Serviceavgiften bor i affar/fees.ts och fraktzonerna i
 * delivery.ts; en siffra skriven en gång till här är en siffra som en dag säger något annat än
 * kassan gör — på en rad som lovar "inga överraskningar". Faller anropet visas raden inte alls,
 * hellre än med ett gissat tal.
 *
 * FAQ:n ÄR SIDANS ENDA BRÖDTEXT och finns lika mycket för sökmotorn som för läsaren. Den renderas
 * också server-side med strukturerad data (se butik/seo.ts) — samma tre frågor, samma svar, så att
 * det som indexeras är det som står här.
 */

const FRAGOR = [
  {
    q: "Hur funkar det?",
    a: "Du klistrar in länken till en annons du hittat. Vi läser den och säger vilken modell det är, " +
       "vad den mäter och vad den är värd. Vill du gå vidare får du en färdig text att skicka säljaren — " +
       "vi hör aldrig av oss till dem själva. Säljaren filmar möbeln på tre minuter, vi granskar den och " +
       "sätter ett pris efter skicket. Sedan betalar du, vi hämtar hos säljaren och bär in hos dig.",
  },
  {
    q: "Vad kostar det?",
    a: "Möbelns pris går oavkortat till säljaren. Ovanpå det betalar du en serviceavgift och frakten, " +
       "som prissätts efter zon i Stockholms län. Hela uppdelningen står på kortet innan du bjuder in " +
       "säljaren — det finns inget som tillkommer senare.",
  },
  {
    q: "Vad händer om möbeln inte stämmer?",
    a: "Pengarna hålls hos oss tills möbeln står hos dig. Är den inte som granskningen visade får du " +
       "dem tillbaka. Det är därför vi granskar innan du betalar och inte efter.",
  },
];

interface Avgifter { serviceavgiftSek: number; fraktFranSek: number; fraktTillSek: number }

export default function Prisarlighet() {
  const [avgifter, setAvgifter] = useState<Avgifter | null>(null);
  const [oppen, setOppen] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/butik/avgifter")
      .then((r) => (r.ok ? r.json() : null))
      .then(setAvgifter)
      .catch(() => setAvgifter(null));
  }, []);

  const kr = (n: number) => `${n.toLocaleString("sv-SE")} kr`;

  return (
    <section className="pris" id="vad-det-kostar">
      {avgifter && (
        <p className="pris-rad">
          <strong>+{kr(avgifter.serviceavgiftSek)} serviceavgift + frakt från {kr(avgifter.fraktFranSek)}</strong>{" "}
          (zonpris). Inga överraskningar.
        </p>
      )}

      <details className="pris-detalj">
        <summary>Så räknas det</summary>
        <div className="pris-detalj-kropp">
          <p>
            Säljaren får sitt fulla pris — vi tar ingenting från deras sida. Din kostnad är möbeln plus
            två poster:
          </p>
          <dl className="pris-lista">
            <div>
              <dt>Serviceavgift</dt>
              <dd>{avgifter ? kr(avgifter.serviceavgiftSek) : "—"} — granskningen, den skyddade betalningen och hanteringen. Samma belopp oavsett vad möbeln kostar, för arbetet är detsamma.</dd>
            </div>
            <div>
              <dt>Frakt</dt>
              <dd>
                {avgifter ? `${kr(avgifter.fraktFranSek)}–${kr(avgifter.fraktTillSek)}` : "—"} beroende på zon i
                Stockholms län. Vi hämtar hos säljaren och bär in hos dig.
              </dd>
            </div>
          </dl>
          <p className="pris-fot">
            Hela summan står på kortet innan du bjuder in säljaren. Är avgifterna stora i förhållande till
            möbelns pris säger vi det rakt ut — men vi hindrar dig inte, det är ditt beslut.
          </p>
        </div>
      </details>

      <div className="faq">
        <h2>Vanliga frågor</h2>
        <ul>
          {FRAGOR.map((f, i) => (
            <li key={f.q}>
              <button
                type="button"
                aria-expanded={oppen === i}
                onClick={() => setOppen(oppen === i ? null : i)}
              >
                {f.q}
                <span aria-hidden="true">{oppen === i ? "−" : "+"}</span>
              </button>
              {oppen === i && <p>{f.a}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Samma tre frågor som servern lägger i strukturerad data. Exporteras så de inte kan glida isär. */
export const FAQ = FRAGOR;
