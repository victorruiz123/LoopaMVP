import { useEffect, useState } from "react";
import { bevis } from "../api";

/**
 * Bevisremsan: uppfyllda efterlysningar och öppen efterfrågan.
 *
 * RITAR INGENTING UTAN RIKTIG DATA. Servern svarar med tomma listor under tröskeln, och då
 * returnerar komponenten null — ingen rubrik, ingen platshållare, inget "snart här". En remsa som
 * säger "'Grön sammetssoffa' – matchad på 4 dagar" är värdefull just för att den är sann, och
 * exakt lika värdelös om den är påhittad. Det finns ingen mellanväg där en uppfunnen siffra gör
 * nytta.
 *
 * Dag ett är den därför tom, och det är avsett. Se DECISIONS.md #0.
 */
export default function ProofStrip() {
  const [data, setData] = useState<Awaited<ReturnType<typeof bevis>> | null>(null);

  useEffect(() => {
    bevis().then(setData).catch(() => setData({ uppfyllda: [], efterfragan: [] }));
  }, []);

  if (!data) return null;
  const { uppfyllda, efterfragan } = data;
  if (uppfyllda.length === 0 && efterfragan.length === 0) return null;

  return (
    <section className="kop-bevis" aria-label="Det som händer just nu">
      <ul className="kop-bevis-lista">
        {uppfyllda.map((u) => (
          <li key={`u-${u.vad}`} className="kop-bevis-post kop-bevis-uppfylld">
            <span className="kop-bevis-vad">”{u.vad}”</span>
            <span className="kop-bevis-nar">matchad på {u.dagar} {u.dagar === 1 ? "dag" : "dagar"}</span>
          </li>
        ))}
        {efterfragan.map((e) => (
          <li key={`e-${e.vad}`} className="kop-bevis-post">
            <span className="kop-bevis-vad">{e.vad}</span>
            <span className="kop-bevis-nar">{e.antal} {e.antal === 1 ? "väntar" : "väntar"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
