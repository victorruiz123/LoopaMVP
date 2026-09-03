/**
 * De fyra scenerna, en komponent var.
 *
 * FYLLDA FORMER, INTE STRECKIKONER. Första versionen var tunna konturer — samma språk som en
 * verktygsrad — och en soffa ritad som en ikon läser som en symbol för "möbel", inte som en möbel.
 * Scenerna bär därför massa: fyllda ytor, mjuka radier, skuggor och accentfärg där ögat ska landa.
 * En besökare ska känna igen sakerna på en halv sekund, för det är all tid en scen har.
 *
 * PLATSHÅLLARE SOM GÅR ATT BYTA. Varje scen är ett självständigt `<svg>` utan kunskap om tidslinjen
 * — den vet bara om den är aktiv. Att byta scen 2 mot en riktig illustration är att skriva över
 * kroppen i `Scen2`; spelaren behöver inte veta om det.
 *
 * FÄRGERNA KOMMER UR TOKENS via CSS-variabler, så scenerna följer resten av produkten i stället för
 * att bära en egen palett som glider isär.
 */

export interface ScenProps {
  /** Sant när scenen är den som visas. Startar om scenens egna rörelser. */
  aktiv: boolean;
}

const svgProps = {
  viewBox: "0 0 360 240",
  fill: "none" as const,
  xmlns: "http://www.w3.org/2000/svg",
  className: "scen-svg",
  "aria-hidden": true as const,
};

/** Delade ytor. Namnen är roller, inte färger — se .scen-svg i kop.css. */
const YTA = "var(--scen-yta)";
const YTA_MORK = "var(--scen-yta-mork)";
const BLACK = "var(--scen-black)";
const ACCENT = "var(--scen-accent)";
const ACCENT_LJUS = "var(--scen-accent-ljus)";
const GRON = "var(--scen-gron)";

/** Golvskuggan under varje motiv. Gör att sakerna står på något i stället för att sväva. */
function Golv({ cx = 180, rx = 120, cy = 214 }: { cx?: number; rx?: number; cy?: number }) {
  return <ellipse cx={cx} cy={cy} rx={rx} ry="9" fill={BLACK} opacity="0.07" />;
}

/**
 * Scen 1 — telefonen med annonsen, och tummen som trycker.
 *
 * Annonsen i telefonen är en RIKTIG liten annons: bild, rubrik, pris. Det är den saken besökaren
 * själv just tittat på, och igenkänningen är hela poängen med scenen.
 */
export function Scen1({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      <Golv rx={86} />

      {/* Telefonen */}
      <rect x="118" y="18" width="124" height="188" rx="20" fill={BLACK} />
      <rect x="126" y="26" width="108" height="172" rx="14" fill={YTA} />
      <rect x="164" y="31" width="32" height="5" rx="2.5" fill={BLACK} opacity="0.35" />

      {/* Annonsen på skärmen */}
      <g className="scen1-annons">
        <rect x="136" y="46" width="88" height="60" rx="8" fill={ACCENT_LJUS} />
        {/* En soffa i miniatyr, fylld */}
        <rect x="148" y="76" width="64" height="18" rx="5" fill={ACCENT} />
        <rect x="152" y="64" width="56" height="16" rx="6" fill={ACCENT} opacity="0.75" />
        <rect x="152" y="92" width="7" height="8" rx="3" fill={ACCENT} />
        <rect x="201" y="92" width="7" height="8" rx="3" fill={ACCENT} />

        <rect x="136" y="114" width="66" height="8" rx="4" fill={BLACK} opacity="0.7" />
        <rect x="136" y="128" width="42" height="7" rx="3.5" fill={BLACK} opacity="0.28" />
        <rect x="136" y="148" width="52" height="16" rx="8" fill={BLACK} />
        <rect x="144" y="154" width="36" height="4" rx="2" fill={YTA} />
      </g>

      {/* Tummen */}
      <g className="scen1-tumme">
        <path
          d="M232 168c0-9 7-16 16-16s16 7 16 16v22c0 14-11 25-25 25h-9c-11 0-20-9-20-20v-14l14-8z"
          fill={YTA_MORK}
        />
        <path d="M232 168c0-9 7-16 16-16s16 7 16 16" stroke={BLACK} strokeWidth="2" opacity="0.18" fill="none" />
      </g>
      <circle className="scen1-ring" cx="196" cy="156" r="18" stroke={ACCENT} strokeWidth="3" fill="none" />
    </svg>
  );
}

/**
 * Scen 2 — granskningen. Längst av de fyra, och den enda som visar något nytt.
 *
 * En riktig soffa: fyllda dynor, armstöd, ben. Skanningslinjen sveper över den, två anmärkningar
 * pekas ut med nålar, och till sist stämplas betyget och prisintervallet.
 */
export function Scen2({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      <Golv rx={118} />

      {/* Soffan */}
      <g>
        {/* Ryggstöd */}
        <rect x="52" y="70" width="216" height="62" rx="18" fill={YTA_MORK} />
        {/* Sittdynor — ljusare än kroppen, så de läser som dynor och inte som ett hål. */}
        <rect x="66" y="118" width="92" height="44" rx="12" fill={YTA} />
        <rect x="162" y="118" width="92" height="44" rx="12" fill={YTA} />
        <path d="M112 122v36M208 122v36" stroke={BLACK} strokeWidth="1.6" opacity="0.08" />
        {/* Armstöd */}
        <rect x="38" y="92" width="34" height="76" rx="16" fill={YTA_MORK} />
        <rect x="248" y="92" width="34" height="76" rx="16" fill={YTA_MORK} />
        {/* Bas och ben */}
        <rect x="46" y="158" width="228" height="22" rx="10" fill={YTA_MORK} />
        <rect x="62" y="178" width="12" height="20" rx="5" fill={BLACK} opacity="0.72" />
        <rect x="246" y="178" width="12" height="20" rx="5" fill={BLACK} opacity="0.72" />
        {/* Skarven mellan ryggdynorna */}
        <path d="M160 76v50" stroke={BLACK} strokeWidth="1.6" opacity="0.08" />
      </g>

      {/* Skanningslinjen */}
      <g className="scen2-skanner">
        <rect x="-6" y="52" width="12" height="140" fill={ACCENT} opacity="0.14" />
        <rect x="4" y="52" width="3" height="140" rx="1.5" fill={ACCENT} />
      </g>

      {/* Anmärkningar */}
      <g className="scen2-nal scen2-nal-1">
        <circle cx="104" cy="104" r="13" fill={ACCENT} />
        <path d="M104 98v7M104 109.5v1.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      </g>
      <g className="scen2-nal scen2-nal-2">
        <circle cx="222" cy="140" r="13" fill={ACCENT} />
        <path d="M222 134v7M222 145.5v1.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      </g>

      {/*
        Betyget och spannet, stämplade.
        Placerade FRI FRÅN MÖBELN: prisremsan låg först bredvid soffan, där den både krockade med
        armstödet och klipptes av ramens högerkant. Den ligger nu ovanför, där det är tomt.
      */}
      <g className="scen2-stampel">
        <rect x="176" y="16" width="172" height="34" rx="17" fill={BLACK} />
        <text x="262" y="39" textAnchor="middle" className="scen-text scen-text-pris">3 000–5 000 kr</text>
        <rect x="292" y="62" width="56" height="56" rx="18" fill={GRON} />
        <text x="320" y="102" textAnchor="middle" className="scen-text scen-text-betyg">B</text>
      </g>
    </svg>
  );
}

/**
 * Scen 3 — betalningen. Sedeln flyger in i kassaskåpet och säljaren kvitterar.
 *
 * Kassaskåpet är fyllt och tungt med flit: det är bilden av att pengarna ligger STILLA någonstans,
 * vilket är precis vad escrow betyder för den som aldrig hört ordet.
 */
export function Scen3({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      <Golv rx={104} />

      {/* Kassaskåpet */}
      <rect x="96" y="48" width="150" height="150" rx="22" fill={BLACK} />
      <rect x="110" y="62" width="122" height="122" rx="14" fill={YTA_MORK} />
      <circle cx="171" cy="123" r="34" fill={YTA} />
      <circle cx="171" cy="123" r="22" fill={YTA_MORK} />
      {/* Ratten */}
      <g className="scen3-ratt">
        <rect x="167" y="97" width="8" height="52" rx="4" fill={BLACK} opacity="0.75" />
        <rect x="145" y="119" width="52" height="8" rx="4" fill={BLACK} opacity="0.75" />
        <circle cx="171" cy="123" r="7" fill={ACCENT} />
      </g>
      <rect x="216" y="104" width="8" height="38" rx="4" fill={YTA} opacity="0.5" />

      {/* Sedeln */}
      <g className="scen3-pengar">
        <rect x="8" y="104" width="66" height="40" rx="7" fill={GRON} />
        <circle cx="41" cy="124" r="11" fill="#fff" opacity="0.85" />
        <path d="M41 118v12M37 121h8M37 127h8" stroke={GRON} strokeWidth="2.4" strokeLinecap="round" />
      </g>

      {/* Säljaren kvitterar */}
      <g className="scen3-bock">
        <circle cx="300" cy="123" r="30" fill={GRON} />
        <path d="M286 123l10 11 20-23" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
    </svg>
  );
}

/**
 * Scen 4 — hemleveransen. Skåpbilen kör in, möbeln står i rummet.
 *
 * Rummet antyds med en vägg och ett golv snarare än ritas ut: poängen är att möbeln är HEMMA, och
 * ett detaljerat rum drar blicken från den enda sak scenen ska säga.
 */
export function Scen4({ aktiv }: ScenProps) {
  return (
    <svg {...svgProps} data-aktiv={aktiv}>
      {/* Rummet */}
      <rect x="216" y="34" width="144" height="172" rx="16" fill={ACCENT_LJUS} />
      <rect x="246" y="60" width="52" height="40" rx="6" fill={YTA} />
      <Golv cx={288} rx={74} />

      {/* Möbeln på plats */}
      <g className="scen4-mobel">
        <rect x="238" y="130" width="104" height="30" rx="12" fill={YTA_MORK} />
        <rect x="246" y="152" width="88" height="26" rx="9" fill={YTA} />
        <rect x="234" y="140" width="18" height="40" rx="9" fill={YTA_MORK} />
        <rect x="328" y="140" width="18" height="40" rx="9" fill={YTA_MORK} />
        <rect x="250" y="176" width="9" height="14" rx="4" fill={BLACK} opacity="0.7" />
        <rect x="321" y="176" width="9" height="14" rx="4" fill={BLACK} opacity="0.7" />
      </g>

      {/* Skåpbilen */}
      <g className="scen4-bil">
        <rect x="4" y="96" width="112" height="76" rx="14" fill={ACCENT} />
        <path d="M116 118h34l28 30v24h-62z" fill={ACCENT} />
        <rect x="124" y="124" width="30" height="22" rx="6" fill={ACCENT_LJUS} />
        <rect x="22" y="116" width="60" height="10" rx="5" fill="#fff" opacity="0.55" />
        <rect x="22" y="134" width="38" height="8" rx="4" fill="#fff" opacity="0.35" />
        <circle cx="46" cy="176" r="18" fill={BLACK} />
        <circle cx="46" cy="176" r="7" fill={YTA} />
        <circle cx="150" cy="176" r="18" fill={BLACK} />
        <circle cx="150" cy="176" r="7" fill={YTA} />
      </g>

      <rect x="0" y="192" width="360" height="4" rx="2" fill={BLACK} opacity="0.1" />
    </svg>
  );
}

export const SCENER = [Scen1, Scen2, Scen3, Scen4] as const;
