/**
 * De fyra scenerna, en komponent var.
 *
 * PLATSHÅLLARE SOM GÅR ATT BYTA. Varje scen är ett rent `<svg>`-block utan logik och utan kunskap om
 * tidslinjen — den vet bara om den är `aktiv`, och animerar sina egna delar därefter. Att byta scen 2
 * mot en riktig illustration är att skriva över kroppen i `Scen2`; ingenting i spelaren behöver veta
 * om det.
 *
 * RÖRELSEN LIGGER I CSS, inte i JavaScript. En `requestAnimationFrame`-slinga för fyra scener är en
 * slinga som fortsätter snurra när fliken ligger i bakgrunden, och `prefers-reduced-motion` är en
 * mediefråga — det hör hemma i stilmallen där webbläsaren redan lyssnar på den.
 */

export interface ScenProps {
  /** Sant när scenen är den som visas. Startar om scenens egna rörelser. */
  aktiv: boolean;
}

const svgProps = {
  viewBox: "0 0 320 200",
  fill: "none" as const,
  xmlns: "http://www.w3.org/2000/svg",
  className: "scen-svg",
  "aria-hidden": true as const,
};

const linje = {
  stroke: "currentColor",
  strokeWidth: 2.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Scen 1 — telefonen, annonsen, trycket. */
export function Scen1({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      <rect x="112" y="24" width="96" height="152" rx="12" {...linje} />
      <rect x="124" y="40" width="72" height="52" rx="6" className="scen1-annons" {...linje} />
      <path d="M136 66l12-12 10 10 8-7 14 15" className="scen1-annons" {...linje} opacity="0.55" />
      <path d="M124 104h72M124 116h48" {...linje} opacity="0.7" />
      <rect x="124" y="132" width="72" height="22" rx="11" className="scen1-knapp" fill="currentColor" opacity="0.12" />
      <path d="M148 143h24" {...linje} />
      {/* Fingret som trycker */}
      <g className="scen1-finger">
        <path d="M196 150c0-6 4-10 9-10s9 4 9 10v14c0 8-6 14-14 14h-4c-6 0-11-5-11-11v-9" {...linje} />
      </g>
    </svg>
  );
}

/** Scen 2 — skanningslinjen, defektnålarna, stämpeln. Den längsta scenen. */
export function Scen2({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      {/* Soffan */}
      <path d="M48 128V96a14 14 0 0 1 14-14h136a14 14 0 0 1 14 14v32" {...linje} />
      <path d="M40 128h192v34H40z" {...linje} />
      <path d="M62 162v14M210 162v14" {...linje} />
      <path d="M76 128v-30M160 128v-30" {...linje} opacity="0.4" />

      {/* Skanningslinjen sveper */}
      <g className="scen2-skanner">
        <path d="M0 40v128" stroke="currentColor" strokeWidth="2.4" opacity="0.75" />
        <rect x="-14" y="40" width="14" height="128" fill="currentColor" opacity="0.07" />
      </g>

      {/* Defektnålar, en i taget */}
      <g className="scen2-nal scen2-nal-1">
        <circle cx="92" cy="112" r="7" {...linje} />
        <path d="M92 109v4M92 116v.5" {...linje} />
      </g>
      <g className="scen2-nal scen2-nal-2">
        <circle cx="178" cy="146" r="7" {...linje} />
        <path d="M178 143v4M178 150v.5" {...linje} />
      </g>

      {/* Betyg och prisintervall stämplas */}
      <g className="scen2-stampel">
        <rect x="228" y="60" width="70" height="34" rx="8" fill="currentColor" opacity="0.1" />
        <text x="263" y="83" textAnchor="middle" className="scen-text scen-text-stor">B</text>
        <rect x="212" y="102" width="102" height="26" rx="13" {...linje} opacity="0.6" />
        <text x="263" y="119" textAnchor="middle" className="scen-text">3 000–5 000 kr</text>
      </g>
    </svg>
  );
}

/** Scen 3 — pengarna in i kassaskåpet, säljaren får sin bock. */
export function Scen3({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      <rect x="98" y="52" width="124" height="106" rx="12" {...linje} />
      <circle cx="146" cy="105" r="24" {...linje} />
      <path d="M146 89v32M138 96h16M138 114h16" {...linje} opacity="0.6" />
      <path d="M192 78v54" {...linje} />

      {/* Sedeln flyger in */}
      <g className="scen3-pengar">
        <rect x="18" y="92" width="46" height="28" rx="4" {...linje} />
        <circle cx="41" cy="106" r="7" {...linje} opacity="0.6" />
      </g>

      {/* Säljaren kvitterar */}
      <g className="scen3-bock">
        <circle cx="268" cy="106" r="20" {...linje} />
        <path d="M258 106l7 8 14-16" {...linje} />
      </g>
    </svg>
  );
}

/** Scen 4 — bilen kör fram, möbeln står i rummet. */
export function Scen4({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      {/* Rummet */}
      <path d="M186 156V78l52-26v104" {...linje} opacity="0.45" />
      <path d="M212 118v38" {...linje} opacity="0.45" />
      <g className="scen4-mobel">
        <path d="M196 152v-14a8 8 0 0 1 8-8h22a8 8 0 0 1 8 8v14" {...linje} />
        <path d="M192 152h44v14h-44z" {...linje} />
      </g>

      {/* Bilen kör in */}
      <g className="scen4-bil">
        <path d="M12 132V108h56" {...linje} />
        <path d="M68 112h24l18 20v10" {...linje} />
        <path d="M8 142h118" {...linje} />
        <circle cx="40" cy="146" r="9" {...linje} />
        <circle cx="98" cy="146" r="9" {...linje} />
      </g>

      <path d="M8 178h304" {...linje} opacity="0.25" />
    </svg>
  );
}

export const SCENER = [Scen1, Scen2, Scen3, Scen4] as const;
