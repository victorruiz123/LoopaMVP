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
  { slug: "soffor", label: "Soffor", blurb: "Soffor, bäddsoffor och divaner — besiktigade, mätta och prissatta." },
  { slug: "fatoljer", label: "Fåtöljer", blurb: "Fåtöljer, loungestolar och puffar — en och en granskade." },
  { slug: "bord", label: "Bord", blurb: "Matbord, soffbord och sidobord med måtten utskrivna." },
  { slug: "stolar", label: "Stolar", blurb: "Matstolar, barstolar och pinnstolar, en och en granskade." },
  { slug: "forvaring", label: "Förvaring", blurb: "Byråer, bokhyllor, skåp och sideboards." },
  { slug: "sangar", label: "Sängar", blurb: "Sängramar och sängar med mått och skick redovisat." },
  { slug: "skrivbord-kontor", label: "Skrivbord & kontor", blurb: "Skrivbord, kontorsstolar och hurtsar." },
  { slug: "belysning", label: "Belysning", blurb: "Golvlampor, bordslampor och taklampor." },
  { slug: "ovrigt", label: "Övrigt", blurb: "Speglar, mattor och det som inte hittade hem i en egen hylla." },
];

const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

/**
 * Kategorier som INTE finns längre, och vart de tog vägen.
 *
 * `soffor-fatoljer` var en kategori fram till att soffor och fåtöljer delades. Den slugen ligger i
 * en publicerad sitemap, i kanoniska adresser och i länkar vi inte äger, och en delning som gör dem
 * till 404 kastar bort den rankning kategorisidan byggt upp. Uppslaget nedan låter dem leva vidare
 * som ingångar; att de ska svara 301 och inte 200 är SEO-lagrets sak (seo.ts), för det är där
 * kanoniska adresser bestäms.
 *
 * Soffor och inte fåtöljer som mål: soffan är den möbel de flesta som skrev den adressen letade
 * efter, och det är den som bär flest varor i lagret.
 */
export const FLYTTADE_SLUGGAR: Readonly<Record<string, string>> = {
  "soffor-fatoljer": "soffor",
};

/** Vart en gammal slug pekar i dag, eller null när den aldrig funnits. */
export function flyttadSlug(slug: string): string | null {
  return FLYTTADE_SLUGGAR[slug] ?? null;
}

/**
 * Kategorin, med gamla adresser inräknade.
 *
 * Slår upp den flyttade slugen också, så att en gammal länk landar på rätt rutnät i stället för på
 * en tom sida. Anroparen som behöver veta OM det var en omdirigering frågar `flyttadSlug`.
 */
export function categoryBySlug(slug: string): Category | undefined {
  return BY_SLUG.get(slug) ?? BY_SLUG.get(FLYTTADE_SLUGGAR[slug] ?? "");
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
  "soffor": "soffa",
  "fatoljer": "fåtölj",
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
  // soffor — det man ligger på och sitter flera i
  soffa: "soffor", soffor: "soffor", baddsoffa: "soffor", soffgrupp: "soffor",
  divan: "soffor", schaslong: "soffor", "sitssoffa": "soffor", hornsoffa: "soffor",
  // "3-sits" är soffa på svenska och föll bort en stund när kategorin delades.
  sits: "soffor", sitsar: "soffor",
  // fåtöljer — det man sitter en i
  fatolj: "fatoljer", fatoljer: "fatoljer", oronlappsfatolj: "fatoljer",
  loungestol: "fatoljer", puff: "fatoljer", fotpall: "fatoljer", sackosack: "fatoljer",
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

// ---------------------------------------------------------------------------
// Möbeltyper — ett steg finare än kategorin
// ---------------------------------------------------------------------------

/**
 * En möbeltyp: det ord någon faktiskt skriver i sökrutan.
 *
 * Kategorierna ovan är ett slutet fält med nio värden, och nio är rätt för ett filter — men fel för
 * en sökmotor. Ingen söker på "begagnad förvaring"; man söker på "begagnad byrå", "begagnat matbord",
 * "begagnad bäddsoffa". Typen är den nivån: en egen sida per ord, med lager räknat ur hyllan och en
 * rubrik som säger precis det man skrev.
 *
 * VARJE TYP HÖR TILL EN KATEGORI, aldrig tvärtom. Kategorin är fortfarande det rutnätet filtrerar på
 * och det brödsmulan går uppåt till; typen är en delmängd med egen adress. Byråer ligger under
 * Förvaring, matbord under Bord.
 *
 * `noun` är singular för rubriker och titlar ("Begagnad soffa"), `label` plural för listor och
 * brickor ("Soffor"). Samma skäl som `categoryNoun`: "har du en soffor" är inte svenska.
 *
 * `blurb` är sidans ingress och skrivs av en människa, en gång, här. Den ska vara SANN om vad Loopa
 * gör med just den möbeln — inte nyckelord i följd. Google läser den; det gör köparen också.
 *
 * `fallback` gäller typer som ÄR sin kategori: en soffa utan närmare ord är fortfarande en soffa.
 * Ett bord utan närmare ord är däremot inget matbord, så Bord har ingen sådan typ.
 */
export interface FurnitureType {
  slug: string;
  /** Plural. "Soffor". */
  label: string;
  /** Singular, obestämd form. "soffa". */
  noun: string;
  categorySlug: string;
  /** Ord i titel eller modell som gör varan till den här typen. Vikta med `fold`. */
  keywords: readonly string[];
  /** Ingressen på typsidan. En eller två meningar, sanna. */
  blurb: string;
  /** Sant när en vara i kategorin utan träffande ord ändå räknas hit. */
  fallback?: boolean;
  /** Sant för t-ord: "begagnat matbord", inte "begagnad matbord". */
  neuter?: boolean;
}

/** Alla typer, i den ordning brickorna visas: det folk oftast letar först. */
export const MOBELTYPER: readonly FurnitureType[] = [
  { slug: "soffor", label: "Soffor", noun: "soffa", categorySlug: "soffor", fallback: true,
    keywords: ["soffa", "soffor", "hornsoffa", "soffgrupp", "divan", "schaslong", "sitssoffa", "sits"],
    blurb: "Begagnade soffor i Stockholm — två-, tre- och hörnsoffor, filmade och besiktigade innan de läggs ut. Måtten står utskrivna och varje slitage är utpekat, så du vet vad som kommer innan den bärs in." },
  { slug: "baddsoffor", label: "Bäddsoffor", noun: "bäddsoffa", categorySlug: "soffor",
    keywords: ["baddsoffa", "sovsoffa", "baddsoffor"],
    blurb: "Begagnade bäddsoffor som granskats öppnade och stängda: mekanismen prövas och madrassen bedöms, inte bara klädseln." },
  { slug: "fatoljer", label: "Fåtöljer", noun: "fåtölj", categorySlug: "fatoljer", fallback: true,
    keywords: ["fatolj", "fatoljer", "oronlappsfatolj", "loungestol", "vilstol"],
    blurb: "Begagnade fåtöljer i Stockholm — från Lamino till IKEA:s Strandmon. En och en besiktigade, med sitthöjd och mått redovisade." },
  { slug: "matstolar", label: "Matstolar", noun: "matstol", categorySlug: "stolar", fallback: true,
    keywords: ["matstol", "matsalsstol", "karmstol", "pinnstol", "stapelstol", "stol", "stolar"],
    blurb: "Begagnade matstolar i Stockholm, ofta i set. Varje stol i setet är granskad för sig — en vinglig stol bland sex sägs rakt ut." },
  { slug: "barstolar", label: "Barstolar", noun: "barstol", categorySlug: "stolar",
    keywords: ["barstol", "barstolar", "barpall"],
    blurb: "Begagnade barstolar med sitthöjden utskriven, så att de passar din bänk och inte bara bilden." },
  { slug: "matbord", neuter: true, label: "Matbord", noun: "matbord", categorySlug: "bord",
    keywords: ["matbord", "matsalsbord", "koksbord", "klaffbord", "utdragbart bord"],
    blurb: "Begagnade matbord i Stockholm — massivt trä, laminat och glas. Längd, bredd och höjd står i centimeter, och skivans repor är fotograferade." },
  { slug: "soffbord", neuter: true, label: "Soffbord", noun: "soffbord", categorySlug: "bord",
    keywords: ["soffbord", "vardagsrumsbord"],
    blurb: "Begagnade soffbord, besiktigade uppifrån och underifrån. Skivans skick redovisas separat från benens." },
  { slug: "sidobord", neuter: true, label: "Sidobord", noun: "sidobord", categorySlug: "bord",
    keywords: ["sidobord", "sangbord", "nattduksbord", "avlastningsbord", "brickbord", "satsbord"],
    blurb: "Begagnade sidobord, sängbord och avlastningsbord — små möbler som ofta går att leverera samma vecka." },
  { slug: "byraer", label: "Byråer", noun: "byrå", categorySlug: "forvaring",
    keywords: ["byra", "byraer", "kommod"],
    blurb: "Begagnade byråer i Stockholm. Lådorna dras ut vid besiktningen — gången och botten granskas, inte bara fronten." },
  { slug: "bokhyllor", label: "Bokhyllor", noun: "bokhylla", categorySlug: "forvaring",
    keywords: ["bokhylla", "bokhyllor", "hylla", "vagghylla", "hyllsystem", "regal"],
    blurb: "Begagnade bokhyllor och hyllsystem — String, Billy, Ivar och andra. Antal hyllplan och mått står med, så du vet om den passar väggen." },
  { slug: "skap", neuter: true, label: "Skåp", noun: "skåp", categorySlug: "forvaring",
    keywords: ["skap", "garderob", "vitrin", "vitrinskap", "linneskap"],
    blurb: "Begagnade skåp och garderober, med dörrar och gångjärn kontrollerade. Stora möbler — vi bär in dem." },
  { slug: "sideboards", label: "Sideboards & tv-bänkar", noun: "sideboard", categorySlug: "forvaring",
    keywords: ["sideboard", "tv bank", "tvbank", "mediabank", "skanka"],
    blurb: "Begagnade sideboards och tv-bänkar i Stockholm, med skivan granskad för ringar och repor." },
  { slug: "sangar", label: "Sängar", noun: "säng", categorySlug: "sangar", fallback: true,
    keywords: ["sang", "sangram", "sangstomme", "kontinentalsang", "resarsang", "vaggsang"],
    blurb: "Begagnade sängar och sängramar med måtten utskrivna. Madrasser säljs bara när skicket tillåter det, och det står i så fall tydligt." },
  { slug: "skrivbord", neuter: true, label: "Skrivbord", noun: "skrivbord", categorySlug: "skrivbord-kontor", fallback: true,
    keywords: ["skrivbord", "arbetsbord", "hoj och sankbart"],
    blurb: "Begagnade skrivbord i Stockholm — höj- och sänkbara och fasta. Skivans mått står med, så det passar hörnet det ska stå i." },
  { slug: "kontorsstolar", label: "Kontorsstolar", noun: "kontorsstol", categorySlug: "skrivbord-kontor",
    keywords: ["kontorsstol", "skrivbordsstol", "arbetsstol"],
    blurb: "Begagnade kontorsstolar, med gasfjäder och mekanik prövade vid besiktningen. En bra stol tål ett andra kontor." },
  { slug: "golvlampor", label: "Golvlampor", noun: "golvlampa", categorySlug: "belysning",
    keywords: ["golvlampa", "golvlampor"],
    blurb: "Begagnade golvlampor med sladd, kontakt och fattning kontrollerade." },
  { slug: "taklampor", label: "Taklampor", noun: "taklampa", categorySlug: "belysning",
    keywords: ["taklampa", "taklampor", "pendel", "pendellampa", "takarmatur"],
    blurb: "Begagnade taklampor och pendlar. Skärmen granskas för sprickor och skavanker innan den läggs ut." },
  { slug: "bordslampor", label: "Bordslampor", noun: "bordslampa", categorySlug: "belysning",
    keywords: ["bordslampa", "bordslampor"],
    blurb: "Begagnade bordslampor, provade och fotograferade tända." },
  { slug: "speglar", label: "Speglar", noun: "spegel", categorySlug: "ovrigt",
    keywords: ["spegel", "speglar"],
    blurb: "Begagnade speglar med ramen och glaset granskade var för sig." },
  { slug: "mattor", label: "Mattor", noun: "matta", categorySlug: "ovrigt",
    keywords: ["matta", "mattor"],
    blurb: "Begagnade mattor, med måtten utskrivna och slitage och fläckar utpekade." },
];

const TYP_BY_SLUG = new Map(MOBELTYPER.map((t) => [t.slug, t]));

/** "Begagnad soffa" / "Begagnat matbord" — rubrikens första ord böjt efter substantivet. */
export function typeHeading(t: FurnitureType): string {
  return `${t.neuter ? "Begagnat" : "Begagnad"} ${t.noun}`;
}

export function furnitureTypeBySlug(slug: string): FurnitureType | undefined {
  return TYP_BY_SLUG.get(slug);
}

/** Typerna som hör till en kategori, i brickornas ordning. */
export function furnitureTypesIn(categorySlug: string): FurnitureType[] {
  return MOBELTYPER.filter((t) => t.categorySlug === categorySlug);
}

/**
 * Nyckelorden, längsta först — samma regel som för kategorierna, av samma skäl: "barstol" innehåller
 * "stol", "sängbord" innehåller "säng", och den mer specifika träffen ska vinna.
 */
const TYP_KEYWORDS_BY_LENGTH: ReadonlyArray<[string, string]> = MOBELTYPER
  .flatMap((t) => t.keywords.map((k): [string, string] => [fold(k), t.slug]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Möbeltypen för en vara, eller null när ingen typ passar.
 *
 * Titeln först, modellen sedan — titeln är det säljaren eller generatorn kallade möbeln, modellen är
 * ofta bara ett namn ("Lamino") som inte säger vad det är. Finns inget ord räknas varan till
 * kategorins fallback-typ, om kategorin har en. Ett "Bord" utan mer blir alltså ingen typ alls och
 * syns bara i kategorin: en typsida som lovar matbord får inte fyllas med bord vi inte vet är det.
 *
 * Null är ett giltigt svar. Typen är en väg IN, inte en egenskap varje vara måste ha.
 */
export function resolveTypeSlug(product: { title: string; model: string | null; categorySlug: string }): string | null {
  for (const raw of [product.title, product.model]) {
    if (!raw) continue;
    const padded = ` ${fold(raw)} `;
    for (const [word, slug] of TYP_KEYWORDS_BY_LENGTH) {
      if (padded.includes(word)) return slug;
    }
  }
  return MOBELTYPER.find((t) => t.fallback && t.categorySlug === product.categorySlug)?.slug ?? null;
}
