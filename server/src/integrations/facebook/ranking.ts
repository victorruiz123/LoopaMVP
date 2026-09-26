/**
 * Rangordningen: vilka grupper som är värda att gå med i och publicera till.
 *
 * MÅLET ÄR INTE "SÅ MÅNGA GRUPPER SOM MÖJLIGT". Det är grupper där en möbelannons från Loopa faktiskt
 * leder till en försäljning: möbelspecifika köp/sälj-grupper först, stora aktiva lokala köp/sälj-
 * grupper därefter, secondhandgrupper, märkesgemenskaper, och sist allmänna anslagstavlor där
 * möbelannonser förekommer.
 *
 * Samma form som butikens rank.ts: rena funktioner, vikterna utbrutna, och SKÄLEN med i svaret. En
 * poäng utan skäl går inte att ifrågasätta i panelen, och "varför står den där" är exakt frågan en
 * människa ställer när de ska bestämma om roboten får gå med.
 */

import type { AdsStatus, ComposerKind, FacebookGroup, GroupCategory } from "./types.js";

// ---------------------------------------------------------------------------
// Orden
// ---------------------------------------------------------------------------

const FURNITURE = /m[öo]bel|m[öo]bler|inredning|soff|f[åa]t[öo]lj|\bbord\b|stol|hylla|byr[åa]|s[äa]ng|matbord|skrivbord|garderob|sk[åa]p|lamp|furniture|interi[öo]r/i;
const BUY_SELL = /k[öo]p|s[äa]lj|s[äa]ljes|k[öo]pes|byt|bortsk[äa]nk|sk[äa]nk|annons|\bbuy\b|\bsell\b|\bswap\b|\bfree\b|gratis/i;
const SECONDHAND = /secondhand|second\s*hand|loppis|vintage|retro|[åa]terbruk|begagna|antik|kuriosa|\bthrift/i;
const BRANDS = /\bikea\b|\bsweef\b|\bhay\b|string\s*furniture|\bmio\b|svenskt\s+tenn|\bnorrgavel\b|\bbolia\b|\bkinnarps\b|\blammhults\b|\bfogia\b|\bmuuto\b|\bfritz\s+hansen\b|\bcarl\s+malmsten\b|\bbruno\s+mathsson\b|\bstolab\b|\bg[äa]rsn[äa]s\b|\bswedese\b|\bdux\b/i;
const NEIGHBOURHOOD = /anslagstavla|grannar|vi\s+som\s+bor|boende\s+i|community|lokalt|\bgrann/i;

/**
 * Storstockholm, som orden står i gruppnamn. Ordningen spelar ingen roll; det första ordet som träffar
 * blir gruppens geografi.
 */
export const STOCKHOLM_PLACES: readonly string[] = [
  "Stockholm", "Sthlm", "Stockholms län", "Storstockholm", "Söderort", "Norrort", "Västerort", "Innerstan",
  "Södermalm", "Söder", "Vasastan", "Kungsholmen", "Östermalm", "Norrmalm", "Gamla stan", "Hammarby sjöstad",
  "Bromma", "Hägersten", "Liljeholmen", "Enskede", "Årsta", "Farsta", "Skarpnäck", "Bagarmossen", "Hökarängen",
  "Älvsjö", "Fruängen", "Skärholmen", "Vällingby", "Hässelby", "Kista", "Rinkeby", "Tensta", "Spånga",
  "Solna", "Sundbyberg", "Nacka", "Saltsjö-Boo", "Lidingö", "Huddinge", "Täby", "Sollentuna", "Danderyd",
  "Järfälla", "Jakobsberg", "Värmdö", "Gustavsberg", "Tyresö", "Haninge", "Handen", "Botkyrka", "Tumba",
  "Ekerö", "Upplands Väsby", "Upplands-Bro", "Sigtuna", "Märsta", "Vallentuna", "Österåker", "Åkersberga",
  "Norrtälje", "Nynäshamn", "Södertälje", "Salem", "Nykvarn", "Vaxholm",
];

/** Andra svenska städer: en grupp för dem är fel geografi, hur relevant den än låter. */
const OTHER_CITIES = /g[öo]teborg|malm[öo]|uppsala|link[öo]ping|[öo]rebro|v[äa]ster[åa]s|helsingborg|norrk[öo]ping|j[öo]nk[öo]ping|ume[åa]|lund|bor[åa]s|g[äa]vle|eskilstuna|karlstad|halmstad|sundsvall|lule[åa]|trollh[äa]ttan|[öo]stersund|v[äa]xj[öo]|kalmar|falun|skellefte[åa]|kristianstad|karlskrona|sk[öo]vde|uddevalla|varberg|nyk[öo]ping|visby/i;
const NATIONAL = /hela\s+sverige|hela\s+landet|\bsverige\b|\bsweden\b|riks/i;

// ---------------------------------------------------------------------------
// Kategorin
// ---------------------------------------------------------------------------

export function classifyGroup(name: string, about: string | null | undefined = null): { category: GroupCategory; reasons: string[] } {
  const strong = name;
  const all = `${name} ${about ?? ""}`;
  const reasons: string[] = [];
  const furniture = FURNITURE.test(strong) || FURNITURE.test(all.slice(0, 600));
  const buySell = BUY_SELL.test(strong);
  const secondhand = SECONDHAND.test(strong);
  const brand = BRANDS.test(strong);
  const neighbourhood = NEIGHBOURHOOD.test(all.slice(0, 600));

  if (brand && (buySell || furniture || secondhand)) {
    reasons.push("märkesnamn i gruppnamnet tillsammans med köp/sälj eller möbler");
    return { category: "BRAND_COMMUNITY", reasons };
  }
  if (furniture && (buySell || secondhand)) {
    reasons.push("möbelord och köp/sälj-ord i namnet — en möbelspecifik annonsgrupp");
    return { category: "FURNITURE_BUY_SELL", reasons };
  }
  if (secondhand) {
    reasons.push("secondhand-, loppis- eller vintageord i namnet");
    return { category: "SECONDHAND", reasons };
  }
  if (buySell) {
    reasons.push("köp/sälj-ord i namnet — en allmän annonsgrupp");
    return { category: "LOCAL_BUY_SELL", reasons };
  }
  if (neighbourhood || detectGeography(name).score >= 0.9) {
    reasons.push("lokal anslagstavla eller grannskapsgrupp");
    return { category: "GENERAL", reasons };
  }
  reasons.push("varken möbel-, köp/sälj- eller secondhand-ord i namnet");
  return { category: "OTHER", reasons };
}

// ---------------------------------------------------------------------------
// Geografin
// ---------------------------------------------------------------------------

export function detectGeography(text: string): { geography: string; score: number; reason: string } {
  const t = text.replace(/\s+/g, " ");
  if (OTHER_CITIES.test(t) && !/stockholm|sthlm/i.test(t)) {
    return { geography: t.match(OTHER_CITIES)![0], score: 0, reason: "en annan stad än Stockholm i namnet" };
  }
  if (/stockholm|sthlm|\b08\b/i.test(t)) return { geography: "Stockholm", score: 1, reason: "Stockholm i namnet" };
  for (const place of STOCKHOLM_PLACES) {
    // I unicode-läge får bara riktiga metatecken escapas — ett escapat bindestreck är ett syntaxfel.
    const re = new RegExp(`(^|[^\\p{L}])${place.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^\\p{L}]|$)`, "iu");
    if (re.test(t)) return { geography: place, score: 0.9, reason: `${place} i namnet — Storstockholm` };
  }
  if (NATIONAL.test(t)) return { geography: "Sverige", score: 0.3, reason: "rikstäckande grupp" };
  return { geography: "", score: 0.2, reason: "ingen ort i namnet" };
}

// ---------------------------------------------------------------------------
// Poängen
// ---------------------------------------------------------------------------

/** Kategorins grundpoäng, 0–100. Ordningen är målets: möbelspecifikt först. */
export const CATEGORY_BASE: Record<GroupCategory, number> = {
  FURNITURE_BUY_SELL: 100,
  LOCAL_BUY_SELL: 75,
  SECONDHAND: 70,
  BRAND_COMMUNITY: 65,
  GENERAL: 40,
  OTHER: 10,
};

/** Justeringen för reglerna. Ett förbud sänker gruppen långt ner utan att gömma den. */
const RULES_ADJUST: Record<AdsStatus, number> = {
  ALLOWED: 10,
  LIKELY_ALLOWED: 0,
  UNCLEAR: -10,
  PROHIBITED: -50,
};

/** Medlemsantalet som en bonus på logaritmisk skala: 300 medlemmar ger ~0, 3 000 ~8, 30 000 ~15. */
export function memberBonus(memberCount: number | null): number {
  if (!memberCount || memberCount < 300) return 0;
  return Math.min(15, Math.round(Math.log10(memberCount / 300) * 7.5));
}

export interface RankInput {
  name: string;
  category: GroupCategory;
  geography?: string;
  memberCount: number | null;
  adsStatus: AdsStatus;
  composerKind: ComposerKind | null;
  activityScore: number;
  about?: string | null;
}

export interface RankResult {
  relevanceScore: number;
  reasons: string[];
}

/**
 * Relevansen, 0–100, med skälen.
 *
 * grund = kategori × geografi. Kategorin säger vad gruppen är till för, geografin om det är där
 * möblerna står — och en möbelgrupp i Göteborg är noll värd för en soffa på Södermalm. Ovanpå det
 * medlemsbonusen, aktiviteten och reglerna.
 */
export function rankGroup(input: RankInput): RankResult {
  const reasons: string[] = [];
  const base = CATEGORY_BASE[input.category];
  reasons.push(`kategori ${input.category}: ${base} p`);

  const geo = detectGeography(`${input.name} ${input.geography ?? ""} ${(input.about ?? "").slice(0, 300)}`);
  reasons.push(`geografi ×${geo.score}: ${geo.reason}`);

  let score = base * geo.score;

  const members = memberBonus(input.memberCount);
  if (members) reasons.push(`medlemmar ${input.memberCount}: +${members}`);
  score += members;

  const activity = Math.round((input.activityScore / 100) * 10);
  if (activity) reasons.push(`aktivitet ${input.activityScore}: +${activity}`);
  score += activity;

  const rules = RULES_ADJUST[input.adsStatus];
  if (rules) reasons.push(`regler ${input.adsStatus}: ${rules > 0 ? "+" : ""}${rules}`);
  score += rules;

  if (input.composerKind === "none") {
    reasons.push("ingen skrivruta för medlemmar: −20");
    score -= 20;
  } else if (input.composerKind === "listing") {
    reasons.push("Sälj något-rutan (annonsformulär i stället för textinlägg): −2");
    score -= 2;
  }

  return { relevanceScore: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/** Aktivitet ur det vi kan se utan att bli medlem: antal inlägg i flödet vid besöket, 0–100. */
export function activityFromFeed(recentPostCount: number | null, memberCount: number | null): number {
  if (recentPostCount === null) return 0;
  const posts = Math.min(100, Math.round((recentPostCount / 10) * 70));
  const size = memberCount ? Math.min(30, Math.round(Math.log10(Math.max(1, memberCount)) * 6)) : 0;
  return Math.max(0, Math.min(100, posts + size));
}

/** Ordningen i panelen och i kön: högst relevans först, därefter flest medlemmar, därefter namn. */
export function compareGroups(a: FacebookGroup, b: FacebookGroup): number {
  if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
  if ((b.memberCount ?? 0) !== (a.memberCount ?? 0)) return (b.memberCount ?? 0) - (a.memberCount ?? 0);
  return a.name.localeCompare(b.name, "sv");
}
