import { STEG } from "./StegIkoner";

/**
 * Stegindikatorn i Trygg affär.
 *
 * SAMMA FYRA IKONER SOM KÖPSIDANS ANIMATION. Den som sett "vi granskar den åt dig" röra sig på
 * förstasidan och sedan står mitt i granskningen ska möta samma bild — annars är det två produkter
 * som råkar heta likadant. Ikonerna bor i StegIkoner.tsx och används av båda.
 *
 * REN PRESENTATION. Komponenten känner inte till affärens tillstånd; den får ett nummer och ritar.
 * Trygg affärs logik är oförändrad.
 */
export default function Stegrad({ nu }: { nu: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="stegrad" aria-label={`Steg ${nu} av 4`}>
      {STEG.map((s) => {
        const Ikon = s.ikon;
        const läge = s.nr < nu ? "klar" : s.nr === nu ? "nu" : "kvar";
        return (
          <li key={s.nr} className={`stegrad-steg stegrad-${läge}`} aria-current={s.nr === nu ? "step" : undefined}>
            <span className="stegrad-ikon"><Ikon size={20} /></span>
            <span className="stegrad-text">{s.text}</span>
          </li>
        );
      })}
    </ol>
  );
}
