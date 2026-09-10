/**
 * Röstrundans rena logik — allt som går att räkna på utan DOM, utbrutet så att rotens testsvit
 * (tests/voice-tour-logic.test.ts) kan fånga regressioner i regexar och matchning. Sidan
 * (voice-tour.tsx) äger inspelning och UI; det här äger tolkningen av det som sades.
 */

/** Ett segment ur transkriptet, i sekunder relativt möbelns eget klipp. */
export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Orden som pekar ut ett skadeögonblick. Stammar, inte hela ord, så böjningarna följer med
 * ("repa/repor/repig"). Samma regex driver TRE saker — närbildsuttaget, live-kvittot och
 * avstämningen — så ett ord som läggs till här får effekt överallt samtidigt.
 */
export const DAMAGE_WORDS =
  /skad|rep(a|o|i)|fläck|sprick|slit|hål|trasig|märke|skav|blek|vattenring|nopprig|fanér|lös|vingl|gångjärn|rost|buckl|saknas|nött|flagn|missfärg|defekt/i;

/** Röstkommandot som byter möbel utan knapptryck (där taligenkänning är aktiv). */
export const NEXT_PIECE_COMMAND = /nästa\s+möbel/i;

/** Två träffar tätare än så här är samma skadebeskrivning — slås ihop. */
export const MOMENT_MERGE_S = 6;

export interface DamageMoment {
  /** Sekunder in i möbelns klipp. */
  tS: number;
  said: string;
}

/**
 * Tidpunkterna där säljaren pratade om skador. Närliggande träffar ihopslagna
 * (samma skada beskriven i flera meningar), max `maxCount` per möbel.
 *
 * TRÄFFSÄKERHETEN HÄNGER PÅ SEGMENTERINGEN. Tidpunkten är segmentets MITT, vilket är rätt när
 * Avalon delar talet i meningar — men returnerar den ett enda segment för hela klippet (händer på
 * kort eller ohackat tal, sett i röktestet) blir mitten av klippet den enda tidpunkt vi kan peka på,
 * oavsett var skadan faktiskt nämndes. Närbilden blir då en godtycklig bildruta, och citatet i
 * `said` blir hela transkriptet.
 *
 * Det degraderar tyst och åt rätt håll — en extra bildruta skadar inte, och ledtråden i sellerNotes
 * är oförändrad — men det är skälet till att en närbild aldrig får presenteras som ett bevis för att
 * skadan syns just där.
 */
export function damageMoments(segments: SpeechSegment[], maxCount: number): DamageMoment[] {
  const hits = segments
    .filter((s) => DAMAGE_WORDS.test(s.text))
    .map((s) => ({ tS: (s.start + s.end) / 2, said: s.text.trim() }));
  const merged: DamageMoment[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.tS - last.tS < MOMENT_MERGE_S) {
      last.said = `${last.said} ${h.said}`;
    } else {
      merged.push({ ...h });
    }
  }
  return merged.slice(0, maxCount);
}

/**
 * Märket ur det säljaren sa, matchat mot appens märkesregister.
 *
 * Hela ord, skiftlägesokänsligt, längsta namn först — "Bruno Mathsson" ska vinna över ett
 * hypotetiskt "Bruno", och "Mio" får inte träffa inuti "kamION". Transkript stavar dessutom
 * gärna gement ("ikea"), så registrets stavning returneras, inte talets — det är registrets
 * form prismotorn och modellsökningen känner igen.
 */
export function detectBrand(transcript: string, brandNames: string[]): string | null {
  if (!transcript) return null;
  const haystack = transcript.toLowerCase();
  const sorted = [...brandNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const needle = name.toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      const before = idx === 0 ? "" : haystack[idx - 1];
      const afterIdx = idx + needle.length;
      const after = afterIdx >= haystack.length ? "" : haystack[afterIdx];
      const boundary = (ch: string) => ch === "" || !/[a-zåäöéü0-9]/i.test(ch);
      if (boundary(before) && boundary(after)) return name;
      idx = haystack.indexOf(needle, idx + 1);
    }
  }
  return null;
}

/**
 * Talat ord -> skadetyper modellen kan rapportera. Grupperna är medvetet BREDA: avstämningen ska
 * svara "nämnde du en repa, rapporterade modellen något repliknande?" — inte agera domare i exakt
 * taxonomi. En för snäv mappning hade dömt ut korrekta fynd som missar.
 */
const SPOKEN_TO_TYPES: [RegExp, string[]][] = [
  [/rep(a|o|i)|skav/i, ["scratch", "scuff", "abrasion", "general_wear"]],
  [/fläck|missfärg|vattenring/i, ["stain", "discoloration"]],
  [/blek/i, ["fading", "discoloration"]],
  [/sprick/i, ["crack", "structural_damage"]],
  [/hål|riv/i, ["hole", "tear"]],
  [/flagn|fanér/i, ["peeling_flaking", "chip"]],
  [/buckl/i, ["dent", "deformation"]],
  [/lös|vingl|gångjärn/i, ["loose_component", "broken_component", "structural_damage", "sagging"]],
  [/saknas/i, ["missing_part"]],
  [/trasig/i, ["broken_component", "crack", "tear", "structural_damage", "missing_part"]],
  [/slit|nött|nopprig/i, ["worn_material", "general_wear", "pilling", "fraying", "compressed_upholstery", "abrasion"]],
  [/rost/i, ["rust", "corrosion"]],
];

export interface SpokenCheck {
  said: string;
  /** true = modellen rapporterade minst ett fynd av en typ som svarar mot det sagda */
  found: boolean;
}

/**
 * Avstämningen på resultatkortet: för varje skadeögonblick, rapporterade modellen något som svarar
 * mot det? Utan typträff i mappningen räcker VILKET fynd som helst — då vet vi bara att en skada
 * nämndes, inte vilken sort.
 */
export function spokenDamageChecklist(moments: DamageMoment[], reportedTypes: string[]): SpokenCheck[] {
  return moments.map((m) => {
    const expected = SPOKEN_TO_TYPES.filter(([re]) => re.test(m.said)).flatMap(([, types]) => types);
    const found =
      expected.length > 0
        ? reportedTypes.some((t) => expected.includes(t))
        : reportedTypes.length > 0;
    return { said: m.said, found };
  });
}
