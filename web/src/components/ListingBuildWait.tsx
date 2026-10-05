import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import type { FurnitureIdentity } from "../types";

/**
 * Väntan medan annonsen byggs — och vad som händer sedan.
 *
 * Formen följer skissen "Fördelar 3b + skanning": soffan med luppen på en platta, en linjal vars
 * linje fylls om och om igen, verbet och statusraden, och under det fyra steg i ett kort där det
 * aktiva steget lyser upp var 2,6 sekund. Syster till ModelSearchWait, med samma uppbyggnad och med
 * flit ett annat innehåll: förra väntan sa vad säljaren slipper, den här säger vad som händer när
 * annonsen väl är uppe — publicering, köparna, betalningen, hämtningen.
 *
 * MÖBELN HAR ETT NAMN HÄR. Modellen valdes nyss, så statusraden säger "Bygger annonsen för IKEA
 * Söderhamn…" — en annons om en bestämd möbel. Saknas namnet (grinden hann inte läsa jobbet än)
 * står den allmänna raden.
 *
 * LINJALEN MÄTER INGEN PROGRESS. Servern rapporterar ingen under bygget, så linjen fylls på 2,6 s
 * och börjar om — samma takt som stegen byts i. Den säger att något pågår, inte hur långt det
 * kommit. Verbet ovanför statusraden byts i samma takt och är dekor: statusraden är det som läses
 * upp, och ett ord som byts var 2,6 sekund i en aria-live-region hade avbrutit uppläsningen.
 *
 * STEGEN ÄR INTE PROGRESS HELLER. Det som lyser är ett steg i det som kommer, inte ett som blivit
 * klart; listan går runt. Och varje rad är ett löfte som redan står någon annanstans i appen:
 * köparen betalar till Loopa och pengarna hålls tills affären är klar (HowLoopaWorks), hämtningen
 * sker vid dörren (HowLoopaWorks, säljbekräftelsen). Ändras villkoren ändras raderna här.
 */
const VERB = ["Mäter", "Slår upp", "Synar", "Prissätter"];
const STEG: Array<[titel: string, text: string]> = [
  ["Annonsen publiceras", "Med rätt rubrik och ett pris som säljer."],
  ["Loopa sköter köparna", "Inga frågor, ingen prutning, inga no-shows för dig."],
  ["Köparen betalar till Loopa", "Pengarna ligger säkert tills affären är klar."],
  ["Hämtas — du får betalt", "Utanför din dörr. Inga tunga lyft."],
];
/** Samma takt som jämförelsen i modelletningen: de två väntorna ska kännas som samma app. */
const TAKT_MS = 2600;

export default function ListingBuildWait({ identity }: { identity: FurnitureIdentity | null }) {
  const t = useT();
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((n) => n + 1), TAKT_MS);
    return () => clearInterval(id);
  }, []);

  const mobel = identity ? [identity.brand, identity.model].filter(Boolean).join(" ") : "";

  return (
    <div className="screen screen-light center-column vanta-modell">
      <div className="vanta-inner bygg-inner">
        <div className="bygg-scan">
          {/* Plattan är skissens, rörelsen är den gamla laddarens: luppen glider över soffan och
              stannar där den hittar något — märket poppar och soffan rycker till. Luppen är ritad
              kring sin egen nollpunkt, så gruppens translate ÄR glasets mitt (i vyrutans enheter). */}
          <div className="bygg-tile" aria-hidden="true">
            <svg width="96" height="96" viewBox="0 0 40 40" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <g className="bygg-tile-sofa" stroke="var(--ink-soft)" strokeWidth="2.2">
                <path d="M8 17v-3a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3" />
                <path d="M5 20a2.5 2.5 0 0 1 5 0v3h12" />
                <path d="M5 20v6h14" />
                <path d="M8 26v3" />
              </g>
              <circle className="bygg-mark bygg-mark-a" cx="13" cy="15" r="1.6" fill="var(--accent)" stroke="none" />
              <circle className="bygg-mark bygg-mark-b" cx="21" cy="24" r="1.6" fill="var(--accent)" stroke="none" />
              <g className="bygg-loupe" stroke="var(--accent)" strokeWidth="2.2">
                <circle className="bygg-loupe-glass" cx="0" cy="0" r="6" />
                <path d="M4.5 4.5 9 9" />
              </g>
            </svg>
          </div>
          <div className="bygg-ruler" aria-hidden="true">
            <div className="bygg-fill" />
          </div>
          {/* Nyckeln gör varje ord till ett nytt element, vilket startar om intoningen. */}
          <p className="bygg-verb" aria-hidden="true" key={`v${i}`}>
            {t(VERB[i % VERB.length])}…
          </p>
          <p className="bygg-status" role="status" aria-live="polite">
            {mobel ? t("Bygger annonsen för {möbel}…", { möbel: mobel }) : t("Bygger annonsen…")}
          </p>
        </div>

        <div className="bygg-why">
          <h2>{t("När den är publicerad kan du luta dig tillbaka.")}</h2>
          <ol className="bygg-list">
            {STEG.map(([titel, text], n) => (
              <li key={titel} className={`bygg-item${n === i % STEG.length ? " on" : ""}`}>
                <span className="bygg-n" aria-hidden="true">
                  {n + 1}
                </span>
                <div>
                  <div className="bygg-t">{t(titel)}</div>
                  <div className="bygg-b">{t(text)}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
