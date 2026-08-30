import { useEffect, useState } from "react";
import { SofaIcon } from "./icons";
import { useT } from "../lib/i18n";

/**
 * Väntan medan annonsen byggs — steget direkt efter modellvalet.
 *
 * Syskon till ModelSearchLoader, med samma uppgift och avsiktligt olik form. De två väntorna ligger
 * sekunder ifrån varandra i flödet, och två likadana väntor i rad läser som EN vänta som hängt sig.
 * Där letandet studsar och fyller en ring gör det här steget i stället det appen faktiskt gör med en
 * möbel: måttar den och synar den efter skador.
 *
 * Luppen glider över möbeln och stannar där den hittar något — märket poppar och möbeln rycker till.
 * Måttbandet under mäter inte möbeln utan väntan: servern rapporterar ingen progress under bygget
 * heller, så bandet dras ut snabbt i början och kryper mot slutet, och hinner aldrig slå i taket och
 * stå still och ljuga om att annonsen är klar. Skärmen byts när annonsen kommer, inte när bandet är
 * utdraget.
 */
const WORDS = ["Mäter", "Synar", "Skannar", "Noterar", "Nagelfar", "Summerar"];
const WORD_MS = 1500;

/** Måttbandets streck: var fjärde är ett helstreck, som på en riktig tumstock. */
const TICKS = Array.from({ length: 17 }, (_, i) => ({ x: 4 + i * 8.5, major: i % 4 === 0 }));

export default function ListingBuildLoader() {
  const t = useT();
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((n) => n + 1), WORD_MS);
    return () => clearInterval(id);
  }, []);

  return (
    // Rent dekorativt, av samma skäl som i modelletningen: skärmens egen text ("Bygger annonsen…")
    // är det som läses upp, och ett ord som byts var 1,5 sekund i en aria-live-region hade avbrutit
    // uppläsningen om och om igen.
    <div className="listing-build" aria-hidden="true">
      <div className="listing-build-frame">
        <div className="listing-build-box">
          <span className="listing-build-piece">
            <SofaIcon size={44} />
          </span>
        </div>
        {/* Luppen ligger i ett eget lager ovanpå kortet, med kortets egna koordinater: en enhet i
            vyrutan är en pixel i ramen, så märkena kan pekas ut direkt på möbeln. */}
        <svg className="listing-build-scan" viewBox="0 0 144 144">
          <circle className="listing-build-mark listing-build-mark-a" cx="63" cy="63" r="3.6" />
          <circle className="listing-build-mark listing-build-mark-b" cx="86" cy="79" r="3.6" />
          {/* Ritad kring sin egen nollpunkt, så gruppens translate ÄR glasets mitt. */}
          <g className="listing-build-loupe">
            <line className="listing-build-loupe-grip" x1="7.8" y1="7.8" x2="15" y2="15" />
            <circle className="listing-build-loupe-glass" cx="0" cy="0" r="10" />
          </g>
        </svg>
      </div>
      <svg className="listing-build-tape" viewBox="0 0 144 22">
        {TICKS.map((t) => (
          <line
            key={t.x}
            className="listing-build-tape-tick"
            x1={t.x}
            y1={t.major ? 9 : 13}
            x2={t.x}
            y2={18}
          />
        ))}
        <line className="listing-build-tape-track" x1="4" y1="20" x2="140" y2="20" />
        <line className="listing-build-tape-fill" x1="4" y1="20" x2="140" y2="20" pathLength={100} />
      </svg>
      {/* Nyckeln gör varje ord till ett nytt element, vilket startar om intoningen. */}
      <p className="wait-word" key={step}>
        {t(WORDS[step % WORDS.length])}…
      </p>
    </div>
  );
}
