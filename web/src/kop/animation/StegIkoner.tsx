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

const stroke = {
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Steg 1 — Du hittar den. En telefon med en annons på skärmen. */
export function IkonHittar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="14" y="5" width="20" height="38" rx="3.5" {...stroke} />
      <rect x="18" y="11" width="12" height="9" rx="1.5" {...stroke} />
      <path d="M18 25h12M18 30h8" {...stroke} />
      <circle cx="24" cy="38" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Steg 2 — Vi granskar. En soffa med en skanningslinje över sig. */
export function IkonGranskar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <path d="M8 30v-8a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v8" {...stroke} />
      <path d="M6 30h36v7H6z" {...stroke} />
      <path d="M11 37v3M37 37v3" {...stroke} />
      <path d="M4 24h40" {...stroke} strokeDasharray="4 3" opacity="0.55" />
      <circle cx="30" cy="26" r="2.4" {...stroke} />
    </svg>
  );
}

/** Steg 3 — Du betalar säkert. Ett kassaskåp med en bock. */
export function IkonBetalar({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <rect x="7" y="9" width="34" height="30" rx="4" {...stroke} />
      <circle cx="21" cy="24" r="7" {...stroke} />
      <path d="M18 24l2.4 2.6L25 21" {...stroke} />
      <path d="M34 19v10" {...stroke} />
    </svg>
  );
}

/** Steg 4 — Hemlevererad. En bil på väg mot en dörr. */
export function IkonLevererad({ size = 32, className }: IkonProps) {
  return (
    <svg {...bas(size)} className={className}>
      <path d="M4 30V17h17v13" {...stroke} />
      <path d="M21 21h8l6 6v3" {...stroke} />
      <path d="M2 30h38" {...stroke} />
      <circle cx="13" cy="34" r="3.4" {...stroke} />
      <circle cx="31" cy="34" r="3.4" {...stroke} />
      <path d="M44 38V22l-6-4" {...stroke} opacity="0.5" />
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
