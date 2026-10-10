import { useEffect, useState } from "react";
import ModelSearchLoader from "./ModelSearchLoader";
import { useT } from "../lib/i18n";

/**
 * Väntan medan modellen letas upp — och vad den väntan används till.
 *
 * Steget tar tio-tjugo sekunder, den längsta pausen i flödet, och säljaren har just gjort det enda
 * hen behöver göra: filma möbeln. Skärmen säger det, och visar sedan par för par vad som hade
 * återstått vid en egen försäljning och vad Loopa tar i stället. Formen följer skissen
 * "Granskar 2a": laddaren, statusraden, rubriken, två rutor som växlar, prickarna under.
 *
 * Paren växlar var 2,6 sekund. Fem par tar tretton sekunder, ungefär en vänta; den som väntar
 * längre ser dem igen, vilket är bättre än att skärmen står still och ser hängd ut.
 *
 * Statusraden är det som läses upp (role="status"). Jämförelsen är läsbar men inte "live": en
 * region som byter text var 2,6 sekund hade avbrutit uppläsningen om och om igen.
 *
 * Samma skärm används vid omvalet ("Hitta nya"), då med texten "Letar efter andra modeller…" —
 * att säga "Letar upp modellen…" en andra gång hade sett ut som att inget hänt.
 */
const PAR: Array<[sjalv: string, loopa: string]> = [
  ["Skriva annons och sätta pris", "AI skriver annonsen och sätter priset från verkliga försäljningar"],
  ["Svara på ”finns den kvar?”", "Loopa hanterar alla köpare åt dig"],
  ["Prutare och no-shows", "Köparen har redan betalat innan hämtning"],
  ["Bära ner till köparens bil", "Möbeln hämtas utanför din dörr"],
  ["Hoppas att swishen går igenom", "Pengarna ligger säkert hos Loopa tills affären är klar"],
];
const PAR_MS = 2600;

export default function ModelSearchWait({ brand, again }: { brand: string | null; again: boolean }) {
  const t = useT();
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % PAR.length), PAR_MS);
    return () => clearInterval(id);
  }, []);

  const modeller = brand ? t("{märke}-modeller", { märke: brand }) : t("modeller");
  const [sjalv, loopa] = PAR[i];

  return (
    <div className="screen screen-light center-column vanta-modell">
      {/* Ett inre block med `margin: auto` i stället för skärmens egen centrering: står innehållet
          högre än skärmen (liggande telefon) blir marginalen noll och toppen går att rulla till,
          medan `justify-content: center` hade klippt den. */}
      <div className="vanta-inner">
      <ModelSearchLoader />

      {/* Statusraden syns inte längre — animationen och texten om processen räcker för ögat — men den
          läses fortfarande upp: den som inte ser laddaren ska ändå få veta vad som händer. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {again ? t("Letar efter andra modeller…") : t("Letar upp modellen…")}{" "}
        {again
          ? t("Söker vidare bland {modeller} — de du sagt nej till räknas bort", { modeller })
          : t("Jämför med {modeller} som matchar bilderna", { modeller })}
      </div>

      <div className="vanta-head">
        <h2>{t("Det svåra är redan gjort. Du har tagit bilderna.")}</h2>
        <p>{t("Resten av försäljningen sköter Loopa.")}</p>
      </div>

      {/* Nyckeln gör varje par till ett nytt element, vilket startar om intoningen. */}
      <div className="jamfor jamfor-anim" key={i}>
        <div className="jamfor-box jamfor-sjalv">
          <div className="jamfor-etikett">{t("Sälja själv")}</div>
          <div className="jamfor-rad">
            <b aria-hidden="true">–</b>
            <span>{t(sjalv)}</span>
          </div>
        </div>
        <div className="jamfor-box jamfor-loopa">
          <div className="jamfor-etikett">{t("Med Loopa")}</div>
          <div className="jamfor-rad">
            <b aria-hidden="true">✓</b>
            <span>{t(loopa)}</span>
          </div>
        </div>
      </div>

      <div className="vanta-dots" aria-hidden="true">
        {PAR.map((_, n) => (
          <i key={n} className={n === i ? "on" : undefined} />
        ))}
      </div>
      </div>
    </div>
  );
}
