import type { CSSProperties } from "react";

/**
 * Märkenas egen färg och egen bokstavsform.
 *
 * Väljaren visade tidigare varje märke som ett monogram i en av fem slumpade pastelltoner — IKEA
 * kunde bli rosa och Muuto blå, och listan såg ut som en färgkarta i stället för som en hylla med
 * varumärken. En säljare känner igen IKEA på den blå-gula rutan innan hen har läst ordet.
 *
 * INGA logotyper: de kräver klarerad upphovsrätt och egna assets. Det som återges här är märkets
 * publikt kända FÄRGPAR och dess typografiska karaktär — inte dess märke. Det räcker för igenkänning
 * och är samtidigt bara text i en färgad ruta.
 *
 * Bara märken vars identitet är entydig står i tabellen. Resten får en varm neutral ur Loopas egen
 * palett — en gissad husfärg är värre än ingen, eftersom den ser lika säker ut som en riktig.
 */

/** Hur märket sätter sitt namn. Styr vikt, spärr och versalisering — märkets typografiska tonfall. */
export type BrandType =
  /** Volymhandeln: tung grotesk, hopdragen, versal. IKEA, JYSK. */
  | "heavy"
  /** Designhusen: ljus grotesk med vid spärr, versal. HAY, Muuto, Vitra, &Tradition. */
  | "wide"
  /** Arvet: antikva. Svenskt Tenn, Källemo, DUX, Carl Malmsten. */
  | "serif"
  /** Allt annat — appens egen typografi. */
  | "plain";

export interface BrandLook {
  bg: string;
  fg: string;
  type: BrandType;
  /** Ljus botten behöver en kontur för att inte flyta ihop med det vita kortet under. */
  ring?: boolean;
}

const PAPER = "#ffffff";
const INK = "#14110d";

const LOOKS: Record<string, BrandLook> = {
  // Volymhandeln — starka husfärger, tung typografi.
  ikea: { bg: "#0058a3", fg: "#ffda1a", type: "heavy" },
  jysk: { bg: "#00509e", fg: PAPER, type: "heavy" },
  chilli: { bg: "#d81f26", fg: PAPER, type: "heavy" },

  // Designhusen — svart på papper, vid spärr. Deras identitet ÄR frånvaron av färg.
  hay: { bg: PAPER, fg: INK, type: "wide", ring: true },
  muuto: { bg: PAPER, fg: INK, type: "wide", ring: true },
  "&tradition": { bg: PAPER, fg: INK, type: "wide", ring: true },
  "ferm living": { bg: "#f3efe6", fg: INK, type: "wide", ring: true },
  vitra: { bg: INK, fg: PAPER, type: "wide" },
  "fritz hansen": { bg: INK, fg: PAPER, type: "wide" },
  artek: { bg: PAPER, fg: INK, type: "wide", ring: true },
  "west elm": { bg: INK, fg: PAPER, type: "wide" },
  bolia: { bg: PAPER, fg: INK, type: "wide", ring: true },
  "string furniture": { bg: PAPER, fg: INK, type: "wide", ring: true },
  "herman miller": { bg: INK, fg: PAPER, type: "wide" },
  stressless: { bg: "#2b2b2b", fg: PAPER, type: "wide" },

  // Arvet — antikva, dova toner.
  "svenskt tenn": { bg: "#1f4b3f", fg: "#f2ede2", type: "serif" },
  källemo: { bg: "#2a2723", fg: "#f2ede2", type: "serif" },
  dux: { bg: "#232019", fg: "#f2ede2", type: "serif" },
  "carl malmsten": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "bruno mathsson": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "arne jacobsen": { bg: "#2a2723", fg: "#f2ede2", type: "serif" },
};

/**
 * Fyra varma neutraler ur Loopas palett för märken utan känd husfärg. Stabil per namn, så samma
 * märke ser likadant ut varje gång listan ritas.
 */
const NEUTRALS: BrandLook[] = [
  { bg: "#efe7da", fg: "#5f4a2e", type: "plain", ring: true },
  { bg: "#e7e6dc", fg: "#4a4a38", type: "plain", ring: true },
  { bg: "#f0e3df", fg: "#7a3f31", type: "plain", ring: true },
  { bg: "#e4e6e4", fg: "#3d4a44", type: "plain", ring: true },
];

function fold(name: string): string {
  return name.toLowerCase().trim();
}

export function brandLook(name: string): BrandLook {
  const known = LOOKS[fold(name)];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return NEUTRALS[hash % NEUTRALS.length];
}

/** CSS för märkets bokstavsform. Samma regler används av brickan och av det valda märkets namn. */
export function brandTypeStyle(type: BrandType): CSSProperties {
  switch (type) {
    case "heavy":
      return { fontWeight: 800, letterSpacing: "-0.02em", textTransform: "uppercase" };
    case "wide":
      return { fontWeight: 500, letterSpacing: "0.16em", textTransform: "uppercase" };
    case "serif":
      return { fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 600, letterSpacing: "0.01em" };
    default:
      return { fontWeight: 700, letterSpacing: "0.01em" };
  }
}

/** Delar av namnet som kan bära en initial — "&Tradition" ska ge TR, inte &T. */
export function brandInitials(name: string): string {
  const words = name
    .split(/[\s/&-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0];
  // Ett versalt kortnamn ÄR sitt monogram: "EM Home" blir EM, inte EH, och "IKEA" blir IK.
  if (first.length >= 2 && first === first.toUpperCase()) return first.slice(0, 2).toUpperCase();
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return first.slice(0, 2).toUpperCase();
}
