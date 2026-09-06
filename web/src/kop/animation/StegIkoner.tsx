/**
 * De fyra stegen som ikoner.
 *
 * ETT STÄLLE, TVÅ ANVÄNDNINGAR. Samma fyra komponenter driver animationen på köpsidan och
 * stegindikatorn inne i Trygg affär. Den som ser "vi granskar den åt dig" på förstasidan och sedan
 * står mitt i granskningen ska möta samma bild — annars är det två olika produkter som råkar heta
 * likadant.
 *
 * RENA SVG:ER UTAN LOGIK. Storlek styrs av `size`, färg ärvs via `currentColor`. Att byta en ikon
 * mot en riktig illustration är att skriva över kroppen i en av funktionerna nedan; ingenting annat
 * i kedjan behöver veta om det.
 */

export interface IkonProps {
  size?: number;
  className?: string;
}

const bas = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 48 48",
  fill: "none" as const,
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true as const,
});

/**
 * FYLLDA FORMER, INTE KONTURER.
 *
 * Konturikoner läser som en verktygsrad. De här ska läsa som SAKER — en telefon, en soffa, ett
 * kassaskåp, en bil — på den halvsekund en stegindikator får. Massa i stället för streck gör
 * skillnaden, och ikonerna fungerar dessutom i 20 px, vilket tunna konturer sällan gör.
 */

/** Steg 1 — Du hittar den. En telefon med en annons på skärmen. */
export function IkonHittar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="13" y="4" width="22" height="40" rx="5" fill="currentColor" />
      <rect x="16.5" y="9" width="15" height="26" rx="2.5" fill="#fff" opacity="0.95" />
      <rect x="19" y="12" width="10" height="7" rx="1.6" fill="currentColor" opacity="0.42" />
      <rect x="19" y="22" width="10" height="2" rx="1" fill="currentColor" opacity="0.42" />
      <rect x="19" y="27" width="6.5" height="2" rx="1" fill="currentColor" opacity="0.42" />
      <circle cx="24" cy="39.5" r="1.7" fill="#fff" opacity="0.9" />
    </svg>
  );
}

/** Steg 2 — Vi granskar. En soffa med en skanningslinje. */
export function IkonGranskar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="8" y="15" width="32" height="12" rx="5" fill="currentColor" />
      <rect x="11" y="24" width="26" height="10" rx="3.5" fill="currentColor" opacity="0.55" />
      <rect x="5" y="19" width="6" height="15" rx="3" fill="currentColor" />
      <rect x="37" y="19" width="6" height="15" rx="3" fill="currentColor" />
      <rect x="8" y="32" width="32" height="5" rx="2.4" fill="currentColor" />
      <rect x="11" y="37" width="3" height="5" rx="1.5" fill="currentColor" />
      <rect x="34" y="37" width="3" height="5" rx="1.5" fill="currentColor" />
      <rect x="22.7" y="8" width="2.6" height="34" rx="1.3" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

/** Steg 3 — Du betalar säkert. Ett kassaskåp med en ratt. */
export function IkonBetalar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="5" y="8" width="38" height="32" rx="6" fill="currentColor" />
      <circle cx="20" cy="24" r="9.5" fill="#fff" opacity="0.95" />
      <circle cx="20" cy="24" r="4" fill="currentColor" opacity="0.5" />
      <rect x="19" y="13" width="2" height="6" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="19" y="29" width="2" height="6" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="34" y="19" width="3" height="10" rx="1.5" fill="#fff" opacity="0.75" />
    </svg>
  );
}

/** Steg 4 — Hemlevererad. En skåpbil. */
export function IkonLevererad({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="3" y="14" width="24" height="18" rx="4" fill="currentColor" />
      <path d="M27 19h7l6 7v6h-13z" fill="currentColor" opacity="0.72" />
      <rect x="29.5" y="20.5" width="6" height="5" rx="1.4" fill="#fff" opacity="0.9" />
      <circle cx="13" cy="35" r="4.6" fill="currentColor" />
      <circle cx="13" cy="35" r="1.7" fill="#fff" />
      <circle cx="33" cy="35" r="4.6" fill="currentColor" />
      <circle cx="33" cy="35" r="1.7" fill="#fff" />
      <rect x="2" y="38.5" width="44" height="2.4" rx="1.2" fill="currentColor" opacity="0.28" />
    </svg>
  );
}

/** Berättelsens steg 2 — Länken in, säljaren bjuds in. En kedjelänk och en person. */
export function IkonLank({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <path
        d="M17 31l14-14M20.5 14.5l3-3a8.5 8.5 0 0112 12l-3 3M27.5 33.5l-3 3a8.5 8.5 0 01-12-12l3-3"
        stroke="currentColor" strokeWidth="4.4" strokeLinecap="round" fill="none"
      />
      <circle cx="38" cy="38" r="7" fill="currentColor" />
      <path d="M32 46.5q6-6 12 0z" fill="currentColor" />
    </svg>
  );
}

/** Berättelsens steg 4 — Annonskortet hos Loopa. Ett kort med en bock. */
export function IkonKort({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="6" y="8" width="36" height="32" rx="5" fill="currentColor" />
      <rect x="10" y="12" width="28" height="13" rx="3" fill="#fff" opacity="0.92" />
      <rect x="10" y="28" width="16" height="3" rx="1.5" fill="#fff" opacity="0.7" />
      <rect x="10" y="33.5" width="10" height="3" rx="1.5" fill="#fff" opacity="0.45" />
      <circle cx="35" cy="33" r="7.5" fill="#fff" />
      <path d="M31.5 33l2.6 2.6L39 30.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Stegen i ordning, med de exakta raderna som står i animationen. */
export const STEG = [
  { nr: 1, ikon: IkonHittar, text: "Du hittar den – var som helst" },
  { nr: 2, ikon: IkonGranskar, text: "Vi granskar den åt dig" },
  { nr: 3, ikon: IkonBetalar, text: "Du betalar säkert" },
  { nr: 4, ikon: IkonLevererad, text: "Hemlevererad. Klar." },
] as const;

/**
 * KÖPSIDANS BERÄTTELSE — fem steg, den verkliga processen.
 *
 * Skild från STEG ovan med flit. STEG är Trygg affärs stegrad: fyra tillstånd en pågående affär
 * kan vara i. Det här är landningssidans berättelse om hur ett köp går till från början, och den
 * har två beats som affären inte har — att hitta annonsen och att klistra in länken. Samma ikoner
 * återanvänds där stegen är samma sak, så språket hänger ihop.
 *
 * RUBRIK OCH FÖRKLARING var för sig. Raden säger vad som händer, förklaringen vem som gör det
 * eller vad vi tittar på — och det är förklaringarna som svarar på frågorna en besökare faktiskt
 * har: letar ni skador, vad kostar den, kommer någon bära in den.
 */
export const BERATTELSEN = [
  {
    nr: 1,
    ikon: IkonHittar,
    rubrik: "Du hittar annonsen",
    text: "På Blocket, Tradera eller Marketplace",
  },
  {
    nr: 2,
    ikon: IkonLank,
    rubrik: "Länken in hos Loopa",
    text: "Du klistrar in den och bjuder in säljaren",
  },
  {
    nr: 3,
    ikon: IkonGranskar,
    rubrik: "Vi granskar möbeln",
    text: "Letar skador och sätter ett marknadsvärde",
  },
  {
    nr: 4,
    ikon: IkonKort,
    rubrik: "Annonskortet är klart",
    text: "Skick, pris och en knapp — klicka hem den tryggt",
  },
  {
    nr: 5,
    ikon: IkonLevererad,
    rubrik: "Hemleverans",
    text: "Vi bär in den i rummet. Pengarna släpps när du godkänt",
  },
] as const;
