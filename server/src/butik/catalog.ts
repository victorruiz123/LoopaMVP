/**
 * Butikens kategorier och märken.
 *
 * Kategorierna är ETT slutet fält med åtta värden, och det är en avsiktlig skillnad mot resten av
 * systemet: annonsgeneratorn skriver fritext, och i de 109 skarpa annonserna står kategorin som
 * "Barstol", "Möbler", "Möbler > Soffor & Fåtöljer > Fåtöljer", "fåtölj", "3-sitssoffa" — och i två
 * fall som ett MODELLNAMN ("NORDVIKEN", "Lamino"). Ett rutnät går inte att filtrera på det. Slugen
 * här är vad butiken navigerar och indexerar på; generatorns text är bara en av signalerna in.
 */

export interface Category {
  slug: string;
  label: string;
  /** Kort text på kategorisidan. Också SEO-slot. */
  blurb: string;
}

/** MVP-uppsättningen, i den ordning de visas på landningssidan. */
export const CATEGORIES: readonly Category[] = [
  { slug: "soffor-fatoljer", label: "Soffor & fåtöljer", blurb: "Soffor, fåtöljer och loungemöbler — besiktigade, mätta och prissatta." },
  { slug: "bord", label: "Bord", blurb: "Matbord, soffbord och sidobord med måtten utskrivna." },
  { slug: "stolar", label: "Stolar", blurb: "Matstolar, barstolar och pinnstolar, en och en granskade." },
  { slug: "forvaring", label: "Förvaring", blurb: "Byråer, bokhyllor, skåp och sideboards." },
  { slug: "sangar", label: "Sängar", blurb: "Sängramar och sängar med mått och skick redovisat." },
  { slug: "skrivbord-kontor", label: "Skrivbord & kontor", blurb: "Skrivbord, kontorsstolar och hurtsar." },
  { slug: "belysning", label: "Belysning", blurb: "Golvlampor, bordslampor och taklampor." },
  { slug: "ovrigt", label: "Övrigt", blurb: "Speglar, mattor och det som inte hittade hem i en egen hylla." },
];

const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string): Category | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Kategorin i ENTAL, för meningar som handlar om EN möbel.
 *
 * Etiketterna ovan är plural eftersom de står över ett rutnät. "Har du en soffor & fåtöljer?" och
 * "innehåller troligen din stolar" är svenska ingen skriver — och båda meningarna hann gå ut i
 * skarp körning innan den här funktionen fanns. Den bor i katalogen så att annonsutkasten och
 * tömningsbreven läser samma ord.
 */
const NOUNS: Record<string, string> = {
  "soffor-fatoljer": "soffa eller fåtölj",
  "bord": "bord",
  "stolar": "stol",
  "forvaring": "hylla eller byrå",
  "sangar": "säng",
  "skrivbord-kontor": "skrivbord",
  "belysning": "lampa",
  "ovrigt": "möbel",
};

export function categoryNoun(slug: string | null | undefined): string {
  return (slug && NOUNS[slug]) || "möbel";
}

export function categoryLabel(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? "Övrigt";
}

/**
 * Nyckelorden som avgör kategori, längsta träff först.
 *
 * Längden ÄR regeln, inte ordningen i listan: "barstol" innehåller "stol" och "soffbord" innehåller
 * "bord", så en vinnare måste väljas på hur specifik träffen är. Skrivs listan om till en if-kedja
 * hamnar soffbordet bland sofforna första gången någon lägger till ett ord på fel rad.
 */
const KEYWORDS: Readonly<Record<string, string>> = {
  // soffor & fåtöljer
  soffa: "soffor-fatoljer", soffor: "soffor-fatoljer", baddsoffa: "soffor-fatoljer",
  divan: "soffor-fatoljer", schaslong: "soffor-fatoljer", sackosack: "soffor-fatoljer",
  fatolj: "soffor-fatoljer", fatoljer: "soffor-fatoljer", oronlappsfatolj: "soffor-fatoljer",
  loungestol: "soffor-fatoljer", puff: "soffor-fatoljer", fotpall: "soffor-fatoljer",
  "sits": "soffor-fatoljer", "sitssoffa": "soffor-fatoljer", soffgrupp: "soffor-fatoljer",
  // bord
  bord: "bord", matbord: "bord", soffbord: "bord", sidobord: "bord", sangbord: "bord",
  avlastningsbord: "bord", klaffbord: "bord", barbord: "bord", brickbord: "bord",
  // stolar
  stol: "stolar", stolar: "stolar", matstol: "stolar", matsalsstol: "stolar",
  barstol: "stolar", pinnstol: "stolar", karmstol: "stolar", pall: "stolar", stapelstol: "stolar",
  // förvaring
  byra: "forvaring", skap: "forvaring", garderob: "forvaring", bokhylla: "forvaring",
  hylla: "forvaring", vagghylla: "forvaring", regal: "forvaring", vitrin: "forvaring",
  sideboard: "forvaring", kommod: "forvaring", "tv-bank": "forvaring", tvbank: "forvaring",
  skobank: "forvaring", hatthylla: "forvaring",
  // sängar
  sang: "sangar", sangram: "sangar", resarsang: "sangar", kontinentalsang: "sangar",
  madrass: "sangar", vaggsang: "sangar",
  // skrivbord & kontor
  skrivbord: "skrivbord-kontor", kontorsstol: "skrivbord-kontor", skrivbordsstol: "skrivbord-kontor",
  konferensbord: "skrivbord-kontor", hurts: "skrivbord-kontor", ladhurts: "skrivbord-kontor",
  arbetsstol: "skrivbord-kontor", kontorsmobel: "skrivbord-kontor",
  // belysning
  lampa: "belysning", golvlampa: "belysning", bordslampa: "belysning", taklampa: "belysning",
  pendel: "belysning", vagglampa: "belysning", ljusstake: "belysning", belysning: "belysning",
  // övrigt
  spegel: "ovrigt", matta: "ovrigt", tavla: "ovrigt",
};

/** Uppslaget, sorterat en gång: längsta nyckelordet först så att "barstol" slår "stol". */
const KEYWORDS_BY_LENGTH = Object.entries(KEYWORDS).sort((a, b) => b[0].length - a[0].length);

/**
 * Viker bort å/ä/ö och versaler så att "Fåtölj", "fatolj" och "FÅTÖLJ" är samma ord.
 *
 * Behövs för att signalerna kommer från tre håll som stavar olika: generatorns kategori, säljarens
 * egen inmatning och Traderas annonstitlar.
 */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Kategorin, vald ur alla signaler vi har.
 *
 * Ordningen är ett förtroendeled: `type`-attributet är generatorns EGET svar på frågan "vad är det
 * här", kategorifältet är samma svar fast ofta nedärvt från en brödsmula, och titeln är sista
 * utvägen. Ett modellnamn som "NORDVIKEN" eller "Lamino" matchar inget nyckelord alls och faller
 * därför igenom till nästa signal i stället för att bli en egen kategori.
 */
export function resolveCategorySlug(signals: {
  type?: string | null;
  category?: string | null;
  title?: string | null;
  model?: string | null;
}): string {
  for (const raw of [signals.type, signals.category, signals.title, signals.model]) {
    if (!raw) continue;
    const hit = matchKeyword(fold(raw));
    if (hit) return hit;
  }
  return "ovrigt";
}

function matchKeyword(folded: string): string | null {
  const padded = ` ${folded} `;
  for (const [word, slug] of KEYWORDS_BY_LENGTH) {
    // Ordgräns i ena änden räcker: svenska sammansättningar sitter ihop ("bäddsoffa", "3-sitssoffa"),
    // så ett krav på gräns i BÅDA ändarna hade missat just de orden kategorin oftast står i.
    if (padded.includes(word)) return slug;
  }
  return null;
}

/** Märkets slug i adressen. "String Furniture" -> "string-furniture". */
export function brandSlug(brand: string): string {
  return fold(brand).replace(/\s+/g, "-");
}
