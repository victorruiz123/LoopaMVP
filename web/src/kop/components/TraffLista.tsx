import ProductCard from "../../butik/components/ProductCard";
import type { Traff } from "../api";

/**
 * Direktsvepets träffar.
 *
 * KÄLLAN OCH PASSFORMEN STÅR PÅ VARJE KORT, och det är inte pynt. En Loopa-vara är granskad, prissatt
 * och köpbar i dag; en Tradera-annons är någon annans, som vi kan analysera och leverera. Att visa
 * dem i samma rutnät utan att säga vilket som är vilket vore att låna vår granskning till något vi
 * inte granskat.
 *
 * NÄRA-TRÄFFAR BÄR SIN AVVIKELSE. "Rätt modell och pris — men blå, inte grön" är byggd i kod ur
 * jämförelsen som släppte igenom möbeln, aldrig av en modell: en mening om varför något visas får
 * inte kunna hitta på ett skäl.
 */

const KALLA: Record<Traff["kalla"], { label: string; tone: string }> = {
  loopa_live: { label: "Hos oss nu", tone: "live" },
  loopa_incoming: { label: "På väg in till oss", tone: "incoming" },
  tradera: { label: "Säljs via Tradera", tone: "extern" },
  own_find: { label: "Din egen länk", tone: "extern" },
};

export default function TraffLista({
  traffar, lasta, prognos, degraded,
}: {
  traffar: Traff[];
  lasta: number;
  prognos: string | null;
  degraded: boolean;
}) {
  const exakta = traffar.filter((t) => t.typ === "exact").length;

  return (
    <section className="kop-traffar">
      <div className="kop-traffar-head">
        <h2>
          {traffar.length === 0
            ? "Inget som stämmer just nu"
            : exakta > 0
              ? `${exakta} som stämmer helt${traffar.length > exakta ? `, och ${traffar.length - exakta} som nästan gör det` : ""}`
              : `${traffar.length} som nästan stämmer`}
        </h2>
        {/* Siffran är verklig — den kommer ur svepets egen räkning, se recordSweep. */}
        <p className="kop-traffar-lasta">Vi läste igenom {lasta.toLocaleString("sv-SE")} objekt.</p>
      </div>

      {degraded && (
        <p className="kop-notis">
          Tradera svarade inte just nu, så listan visar bara våra egna möbler. Vi söker vidare där i bakgrunden.
        </p>
      )}

      {traffar.length === 0 ? (
        <p className="kop-tomt">
          Ingenting som håller måttet i dag. Spara efterlysningen så letar vi vidare — vi hör av oss så
          fort något dyker upp.
        </p>
      ) : (
        <ul className="kop-traff-lista">
          {traffar.map((t) => (
            <li key={t.produkt.id} className="kop-traff">
              <div className={`kop-traff-kalla kop-traff-kalla-${KALLA[t.kalla].tone}`}>
                {KALLA[t.kalla].label}
              </div>
              <ProductCard product={t.produkt} />
              <p className={`kop-traff-passform${t.typ === "exact" ? " kop-traff-exakt" : ""}`}>
                {t.passform}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* Prognosen visas bara när den räknats ur riktig historik. Null = elementet finns inte. */}
      {prognos && <p className="kop-prognos">{prognos}</p>}
    </section>
  );
}
