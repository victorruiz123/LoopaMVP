import { useEffect, useRef, useState } from "react";
import { track } from "../../butik/components/Bits";
import { SCENER } from "./Scener";
import { STEG } from "./StegIkoner";

/**
 * Fyra scener, tio sekunder, i loop.
 *
 * KOMMUNIKATION GENOM DEMONSTRATION. Sidans hela jobb är att en besökare på under tio sekunder ska
 * förstå "jag har hittat en möbel någon annanstans → Loopa gör köpet riskfritt och levererar den".
 * Fyra bilder som rör sig gör det; fyra stycken text gör det inte.
 *
 * SCEN 2 ÄR LÄNGST med flit. Granskningen är det enda steget besökaren inte redan förstår — att
 * hitta en annons, betala och få hem något är bekant, medan "vi går igenom möbeln åt dig" är den nya
 * saken. Den scenen får därför fyra sekunder av tio.
 *
 * TRE LÄGEN, inte två:
 *
 *   spelar    autoplay i loop
 *   pausad    besökaren tryckte paus, eller fliken ligger i bakgrunden
 *   stilla    prefers-reduced-motion — då är det inte en animation utan fyra paneler bredvid
 *             varandra, allihop synliga samtidigt. Ingen rörelse alls, ingen spelare.
 */

/** Millisekunder per scen. Summan är loopens längd. Scen 2 är längst — se ovan. */
const TIDER = [2000, 4000, 2000, 2000];
const LOOP_MS = TIDER.reduce((a, b) => a + b, 0);

export default function SaFunkarDet() {
  const [scen, setScen] = useState(0);
  const [pausad, setPausad] = useState(false);
  const [stilla, setStilla] = useState(false);
  const [synlig, setSynlig] = useState(false);
  const varv = useRef(0);
  const rutan = useRef<HTMLDivElement>(null);

  /** Respekterar systemets inställning, och lyssnar om den ändras mitt i besöket. */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const läs = () => setStilla(mq.matches);
    läs();
    mq.addEventListener("change", läs);
    return () => mq.removeEventListener("change", läs);
  }, []);

  /**
   * LAZY: spelaren startar först när rutan är på väg in i bild.
   *
   * Sidans LCP ska vara heron. En animation som börjar räkna direkt gör arbete ingen ser, och på en
   * telefon kostar det just den tiondel som avgör om fältet kändes snabbt.
   */
  useEffect(() => {
    const el = rutan.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([post]) => setSynlig(post.isIntersecting),
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /** Tidslinjen. En timer i taget — inget rAF som fortsätter snurra i en bakgrundsflik. */
  useEffect(() => {
    if (stilla || pausad || !synlig) return;
    const id = setTimeout(() => {
      setScen((n) => {
        const nästa = (n + 1) % SCENER.length;
        if (nästa === 0) {
          varv.current += 1;
          // Ett varv sett hela vägen runt. Måttet på om demonstrationen faktiskt landar.
          track("animation_completed_views", { varv: varv.current });
        }
        return nästa;
      });
    }, TIDER[scen]);
    return () => clearTimeout(id);
  }, [scen, pausad, stilla, synlig]);

  const Scen = SCENER[scen];

  if (stilla) {
    return (
      <section className="funkar funkar-stilla" ref={rutan} aria-label="Så funkar det">
        <ol className="funkar-paneler">
          {STEG.map((s, i) => {
            const S = SCENER[i];
            return (
              <li key={s.nr} className="funkar-panel">
                <div className="funkar-bild"><S aktiv /></div>
                <p><span className="funkar-nr">{s.nr}</span> {s.text}</p>
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  return (
    <section className="funkar" ref={rutan} aria-label="Så funkar det">
      <div className="funkar-scen">
        <div className="funkar-bild" key={scen}><Scen aktiv /></div>
        <p className="funkar-text" key={`t${scen}`}>{STEG[scen].text}</p>
      </div>

      {/* Stegindikatorn är samma fyra ikoner som Trygg affär-flödet visar. Se StegIkoner.tsx. */}
      <ol className="funkar-steg">
        {STEG.map((s, i) => {
          const Ikon = s.ikon;
          return (
            <li key={s.nr}>
              <button
                type="button"
                className={i === scen ? "funkar-steg-nu" : undefined}
                aria-current={i === scen ? "step" : undefined}
                aria-label={s.text}
                onClick={() => { setScen(i); setPausad(true); }}
              >
                <Ikon size={22} />
              </button>
            </li>
          );
        })}
      </ol>

      <div className="funkar-kontroll">
        <button type="button" onClick={() => setPausad((p) => !p)} aria-pressed={pausad}>
          {pausad ? "Spela" : "Pausa"}
        </button>
        {/* Framdriften ritas av CSS och startas om per scen — ingen tidräkning i React. */}
        <span className="funkar-linje" aria-hidden="true">
          <span key={`p${scen}-${pausad}`} style={{ animationDuration: `${TIDER[scen]}ms`, animationPlayState: pausad ? "paused" : "running" }} />
        </span>
        <span className="funkar-langd">{Math.round(LOOP_MS / 1000)} sek</span>
      </div>
    </section>
  );
}
