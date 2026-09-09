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
 *
 * MIO, SITS, SWEDESE OCH EM HOME tillkom när butiken började visa märken som stora brickor på
 * förstasidan: de fyra är de vi faktiskt har lager av, och en rad där bara IKEA hade en färg läste
 * som fyra tomma rutor. Savo och Sweef står kvar utan färg, för om dem säger ingenting i projektet
 * något, och regeln ovan gäller dem precis som förut.
 *
 * DEN HÄR FILEN ÄR NU ENDA KÄLLAN. brandTheme.ts bar tidigare en egen, parallell tabell för
 * säljflödets brickor, och de två sa olika saker om samma märke — Vitra svart i butiken och rött i
 * säljflödet. brandTheme härleds numera härifrån; ett märke som läggs till här syns överallt.
 */

/**
 * Hur märket sätter sitt namn. Styr FAMILJ, vikt, spärr och versalisering — märkets typografiska
 * tonfall.
 *
 * Familjen är märkets snitt så nära vi lagligen och praktiskt kommer: en stack av snitt som redan
 * finns på maskinen eller i appen, vald för att LIGGA NÄRA ordbilden. IKEAs snitt är en humanist i
 * Verdanas släkt, designhusens är neo-grotesker i Helveticas, Artek och de geometriska ligger i
 * Futuras. Ingen av dem ÄR märkets typsnitt — de är licensierade och betalda, och en webbfont vi
 * inte har rätt till hör inte hemma i en klientbunt.
 */
export type BrandType =
  /** Volymhandeln: tung humanist, hopdragen, versal. IKEA, JYSK. */
  | "heavy"
  /** Designhusen: ljus grotesk med vid spärr, versal. HAY, Muuto, Vitra, &Tradition. */
  | "wide"
  /** Modernisterna: geometrisk sans i Futuras släkt. Artek, Massproductions. */
  | "geometric"
  /**
   * De som skriver sitt namn med GEMENER. String, Muuto, artek.
   *
   * Egen typ och inte "wide utan versaler", för gemenerna ÄR identiteten hos de här märkena — deras
   * ordbild är låg och bred, och satt i versaler blir den någon annans. Det är samma skillnad som
   * mellan IKEA och ikea: det ena är fel märke.
   */
  | "lower"
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
  /**
   * Hur märket SKRIVER sitt namn, när det skiljer sig från namnet i vår korpus.
   *
   * "String Furniture" heter så i prismotorns data och i sökningen; på sina egna möbler står det
   * "string". Fältet är BARA för visning — matchning, sökning och allt som slår upp ett märke
   * använder oförändrat namnet i listan. Ett märke vars ordbild vi skriver fel är ett märke säljaren
   * inte känner igen, och igenkänningen är hela skälet den här filen finns.
   */
  wordmark?: string;
}

const PAPER = "#ffffff";
const INK = "#14110d";

const LOOKS: Record<string, BrandLook> = {
  // Volymhandeln — starka husfärger, tung typografi.
  ikea: { bg: "#0058a3", fg: "#ffda1a", type: "heavy" },
  jysk: { bg: "#00509e", fg: PAPER, type: "heavy" },
  chilli: { bg: "#d81f26", fg: PAPER, type: "heavy" },
  mio: { bg: "#b23a3a", fg: PAPER, type: "heavy" },

  // Designhusen — svart på papper, vid spärr. Deras identitet ÄR frånvaron av färg.
  hay: { bg: PAPER, fg: INK, type: "heavy", ring: true },
  muuto: { bg: "#edece8", fg: "#7d7c78", type: "lower", ring: true },
  "&tradition": { bg: PAPER, fg: INK, type: "wide", ring: true },
  "ferm living": { bg: "#f3efe6", fg: INK, type: "wide", ring: true },
  vitra: { bg: INK, fg: PAPER, type: "wide" },
  "fritz hansen": { bg: "#e9e3d5", fg: "#2b2823", type: "wide" },
  gubi: { bg: INK, fg: PAPER, type: "wide" },
  "normann copenhagen": { bg: PAPER, fg: INK, type: "wide", ring: true },
  "louis poulsen": { bg: INK, fg: PAPER, type: "wide" },
  /**
   * Modernisterna. Aalto och Massproductions sätter sina namn i geometrisk sans — samma släkt som
   * Futura — och det är den skillnaden mot designhusens neo-grotesk som gör dem igenkännliga.
   */
  // Artek sätter sitt namn i rött med gemener — den röda ordbilden ÄR märket.
  artek: { bg: PAPER, fg: "#e2231a", type: "lower", ring: true },
  massproductions: { bg: PAPER, fg: INK, type: "geometric", ring: true },
  "west elm": { bg: INK, fg: PAPER, type: "wide" },
  bolia: { bg: PAPER, fg: INK, type: "wide", ring: true },
  sits: { bg: PAPER, fg: "#3f3b35", type: "wide", ring: true },
  "string furniture": { bg: "#141414", fg: PAPER, type: "lower", wordmark: "string" },
  "herman miller": { bg: INK, fg: PAPER, type: "wide" },
  stressless: { bg: "#2b2b2b", fg: PAPER, type: "wide" },

  // Arvet — antikva, dova toner.
  "svenskt tenn": { bg: "#123528", fg: "#c9a961", type: "serif" },
  källemo: { bg: "#2a2723", fg: "#f2ede2", type: "serif" },
  dux: { bg: "#232019", fg: "#f2ede2", type: "serif" },
  "carl malmsten": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "bruno mathsson": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "arne jacobsen": { bg: "#2a2723", fg: "#f2ede2", type: "serif" },
  swedese: { bg: "#3d4634", fg: "#f2ede2", type: "serif" },
  /**
   * DESIGNERNA, inte husen. Ett personnamn har ingen husfärg att återge — och att hitta på en åt
   * Yngve Ekström vore precis den gissning filen finns för att undvika. Antikvan är däremot ingen
   * gissning utan en läsanvisning: den säger "det här är ett arv och en upphovsperson", vilket är
   * exakt vad namnet betyder på en begagnad möbel.
   */
  "yngve ekström": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "josef frank": { bg: "#4a3f2f", fg: "#f4ece0", type: "serif" },
  "carl hansen & søn": { bg: PAPER, fg: "#8a8880", type: "wide", ring: true },
  lammhults: { bg: "#2a2723", fg: "#f2ede2", type: "serif" },
  gärsnäs: { bg: "#2a2723", fg: "#f2ede2", type: "serif" },

  // Övrigt med känd hållning.
  "em home": { bg: "#8a6b45", fg: "#f7f3ee", type: "plain" },
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

/**
 * Samma märke under flera namn.
 *
 * Lagret får sina namn från tre håll — säljarens egen inmatning, prismotorns korpus och Traderas
 * annonser — och de stavar inte lika. "String" och "String Furniture" är ett märke, och ett av dem
 * fick tidigare en neutral bricka bredvid en färgad, vilket läste som två olika företag.
 */
const ALIAS: Record<string, string> = {
  string: "string furniture",
  "and tradition": "&tradition",
  "&tradition copenhagen": "&tradition",
  "carl hansen": "carl hansen & søn",
  "carl hansen och søn": "carl hansen & søn",
  "carl hansen & son": "carl hansen & søn",
  "fermliving": "ferm living",
  "herman miller furniture": "herman miller",
  "ekornes stressless": "stressless",
};

function fold(name: string): string {
  const rensat = name.toLowerCase().trim().replace(/\s+/g, " ");
  return ALIAS[rensat] ?? rensat;
}

export function brandLook(name: string): BrandLook {
  const known = LOOKS[fold(name)];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return NEUTRALS[hash % NEUTRALS.length];
}

/**
 * Snittstackarna, en per tonfall.
 *
 * Systemsnitt först, appens egna sist. Fungerar överallt utan en enda extra hämtning — och en
 * besökare som saknar Futura får Century Gothic eller Poppins, som ligger i samma släkt.
 */
const FAMILJER: Record<BrandType, string | undefined> = {
  heavy: 'Verdana, "Noto Sans", "Segoe UI", Inter, sans-serif',
  wide: '"Helvetica Neue", Helvetica, Arial, Inter, sans-serif',
  geometric: 'Futura, "Century Gothic", "Avenir Next", Poppins, sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  lower: '"Helvetica Neue", Helvetica, Arial, Inter, sans-serif',
  plain: undefined,
};

/** CSS för märkets bokstavsform. Samma regler används av brickan och av det valda märkets namn. */
/**
 * Om märket har en EGEN identitet i tabellen ovan, eller får en neutral ur Loopas palett.
 *
 * Finns för startsidans ordning: de märken vi kan visa i sin egen färg läggs först, så att rutnätet
 * öppnar med igenkänning i stället för med trettio beigea rutor. Frågan ställs HÄR och inte genom att
 * jämföra en look mot neutralerna hos anroparen — tabellen är privat, och en anropare som gissar sig
 * till svaret gissar fel dagen någon lägger till en neutral som råkar likna en riktig.
 */
export function harEgenIdentitet(name: string): boolean {
  return LOOKS[name.trim().toLowerCase()] !== undefined;
}

export function brandTypeStyle(type: BrandType): CSSProperties {
  const fontFamily = FAMILJER[type];
  switch (type) {
    case "heavy":
      return { fontFamily, fontWeight: 800, letterSpacing: "-0.02em", textTransform: "uppercase" };
    case "wide":
      return { fontFamily, fontWeight: 500, letterSpacing: "0.16em", textTransform: "uppercase" };
    case "geometric":
      return { fontFamily, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" };
    case "lower":
      /**
       * TVINGAT GEMENT, inte "orörd skiftning".
       *
       * Namnen står som "Artek" och "Muuto" i korpusen, för det är så en katalog skriver dem. Husen
       * själva skriver "artek" och "muuto", och det är den ordbilden man känner igen. `none` hade
       * lämnat versalen kvar och gjort typen verkningslös på precis de märken den finns för.
       */
      return { fontFamily, fontWeight: 400, letterSpacing: "0.22em", textTransform: "lowercase" };
    case "serif":
      /**
       * VERSALT OCH SPÄRRAT. Arvet sätter sina namn så — Svenskt Tenn, Carl Hansen & Søn, Källemo,
       * DUX — och en antikva i gemener med tät spärr läser som brödtext i en bok, inte som ett
       * märke på en möbel.
       */
      return { fontFamily, fontWeight: 600, letterSpacing: "0.11em", textTransform: "uppercase" };
    default:
      return { fontWeight: 700, letterSpacing: "0.01em" };
  }
}

/**
 * Märkets färg som TEXT på en ljus yta.
 *
 * `bg`/`fg` är ett par gjort för en platta, och paret går inte att använda rakt av när namnet står
 * som text på ett vitt kort: HAYs par är svart på papper, IKEAs är gult på blått. Den mörkare av de
 * två är den som bär på vitt — gul text på vitt kort är ingen igenkänning, den är oläslig.
 */
export function brandInk(name: string): string {
  const look = brandLook(name);
  return ljushet(look.bg) <= ljushet(look.fg) ? look.bg : look.fg;
}

/** Relativ ljushet, grov och tillräcklig: vi rangordnar två färger, vi mäter ingen kontrast. */
function ljushet(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
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
