import { useEffect, useState } from "react";
import { SofaIcon } from "./icons";

/**
 * Väntan medan modellerna letas fram.
 *
 * Steget tar tio-tjugo sekunder och gav tidigare bara en snurra — samma tecken som appen visar för
 * varje kort paus, vilket inte skiljer "arbetar hårt" från "hänger sig". Här sker tre saker i stället:
 * möbeln studsar (något LEVER), ringen fylls (det går FRAMÅT), och orden växlar (det görs NÅGOT).
 *
 * Ringen mäter inte riktig progress — servern rapporterar ingen under identifieringen. Den fylls i
 * stället snabbt i början och kryper mot slutet, så den aldrig hinner slå i taket och stå still och
 * ljuga om att sökningen är klar. Skärmen byts när kandidaterna kommer, inte när ringen är full.
 */
const WORDS = ["Granskar", "Inspekterar", "Kikar", "Jämför", "Mäter", "Letar"];
const WORD_MS = 1500;

/** Ruta med rundade hörn, ritad medurs från toppens mitt så fyllningen börjar där blicken är. */
const RING =
  "M76 3h42a31 31 0 0 1 31 31v84a31 31 0 0 1-31 31H34a31 31 0 0 1-31-31V34A31 31 0 0 1 34 3Z";

export default function ModelSearchLoader() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((n) => n + 1), WORD_MS);
    return () => clearInterval(id);
  }, []);

  return (
    // Rent dekorativt: skärmens egen text ("Letar upp modellen…") är det som läses upp, och ett ord
    // som byts var 1,5 sekund i en aria-live-region hade avbrutit uppläsningen om och om igen.
    <div className="model-search" aria-hidden="true">
      <div className="model-search-frame">
        <svg className="model-search-ring" viewBox="0 0 152 152">
          <path className="model-search-ring-track" d={RING} />
          <path className="model-search-ring-fill" d={RING} pathLength={100} />
        </svg>
        <div className="model-search-box">
          <span className="model-search-shadow" />
          <span className="model-search-icon">
            <SofaIcon size={44} />
          </span>
        </div>
      </div>
      {/* Nyckeln gör varje ord till ett nytt element, vilket startar om intoningen. */}
      <p className="model-search-word" key={step}>
        {WORDS[step % WORDS.length]}…
      </p>
    </div>
  );
}
