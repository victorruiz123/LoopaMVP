import { useEffect, useState } from "react";
import { listaFeedback } from "../api";
import type { AdminFeedback } from "../types";

/**
 * Feedbackfliken: vad säljarna tyckte om processen, nyast först.
 *
 * EN LÄSLISTA, INTE EN ARBETSKÖ. Det finns ingen svarsknapp och ingen "hanterad"-markering. Raderna
 * är inte ärenden som ska stängas — de är meningar om vårt eget flöde, och den som vill höra av sig
 * har adressen på raden och skriver ett riktigt mejl. En knapp hade gjort en läslista till en kö som
 * genast får en eftersläpning ingen bestämt att den skulle ha.
 *
 * SNITTET STÅR ÖVERST men litet, och antalet står bredvid. Ett snitt på 4,5 betyder olika saker vid
 * tre svar och vid tre hundra, och ett tal utan sitt underlag är den sortens siffra som citeras
 * vidare. Det räknas på servern, av alla rader — inte på de som råkar visas.
 *
 * BETYGET STÅR SOM "4/5" OCH INTE SOM STJÄRNOR. Stjärnor läser som en offentlig recension av något
 * vi säljer; det här är säljarens intryck av ett arbetsflöde, och skillnaden är värd att behålla i
 * formen. Rader utan betyg får inget märke alls — en fritext är inte en nolla.
 */
export default function AdminFeedbackScreen() {
  const [poster, setPoster] = useState<AdminFeedback[] | null>(null);
  const [snitt, setSnitt] = useState<number | null>(null);
  const [antalBetyg, setAntalBetyg] = useState(0);
  const [fel, setFel] = useState<string | null>(null);

  useEffect(() => {
    listaFeedback()
      .then((r) => {
        setPoster(r.poster);
        setSnitt(r.snitt);
        setAntalBetyg(r.antalBetyg);
      })
      .catch((err: unknown) => {
        setPoster([]);
        setFel(err instanceof Error ? err.message : "Kunde inte hämta feedbacken.");
      });
  }, []);

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {poster === null
          ? "Hämtar…"
          : `${poster.length} ${poster.length === 1 ? "svar" : "svar"}${
              snitt !== null ? ` · snitt ${snitt.toString().replace(".", ",")} av 5 på ${antalBetyg} betyg` : ""
            }`}
      </p>

      {fel && <p className="public-card-error">{fel}</p>}

      {poster?.length === 0 && !fel && (
        <p className="admin-lede">Ingen har svarat än. Rutan visas direkt efter att en säljare sagt ja.</p>
      )}

      <div className="feedback-lista">
        {(poster ?? []).map((p) => (
          <article key={p.id} className="feedback-rad">
            <header className="feedback-rad-topp">
              {p.betyg !== null && (
                <span className={`feedback-betyg betyg-${p.betyg}`} title={`${p.betyg} av 5`}>
                  {p.betyg}/5
                </span>
              )}
              {/* Möbeln raden gäller. Titeln är den som stod på annonsen när svaret gavs — se
                  server/src/feedback.ts. Loopa-ID:t står bredvid för den som vill slå upp annonsen. */}
              <span className="feedback-mobel">{p.titel ?? p.loopaId ?? "Okänd möbel"}</span>
              {p.loopaId && p.titel && <span className="feedback-id">{p.loopaId}</span>}
              <time className="feedback-tid" dateTime={p.skapad}>
                {datum(p.skapad)}
              </time>
            </header>
            {/* Texten som den skrevs, med radbrytningarna kvar (white-space i CSS). Den som skrev tre
                stycken menade tre stycken. */}
            {p.text ? <p className="feedback-text-svar">{p.text}</p> : <p className="feedback-tom">Bara betyg.</p>}
            <p className="feedback-avsandare">{p.epost ?? p.userId}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function datum(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}
