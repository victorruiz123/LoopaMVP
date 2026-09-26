/**
 * Gruppreglerna -> får Loopa lägga ut en möbelannons här?
 *
 * KONSERVATIVT MED FLIT, i tre steg som inte får byta ordning:
 *
 *   1. Ett uttryckligt FÖRBUD vinner alltid. "Ingen reklam", "inga företag", "endast privatpersoner"
 *      — då är gruppen PROHIBITED, oavsett vad resten av texten säger.
 *   2. Ett uttryckligt TILLSTÅND ger ALLOWED.
 *   3. En köp/sälj-grupp vars regler finns men inte nämner företag ger LIKELY_ALLOWED — och BARA då:
 *      gruppens hela syfte är att sälja saker, och möbelannonser är normalt innehåll där.
 *
 * Allt annat är UNCLEAR, och UNCLEAR publiceras det aldrig till. En regeltext som inte lästs är inte
 * ett tillstånd.
 *
 * Loopa är ett företag som säljer begagnade möbler åt privatpersoner. Det är inte "reklam" i vardaglig
 * mening — det är en riktig möbel till ett riktigt pris — men en grupp som skrivit "inga företag" har
 * bestämt något, och det respekteras.
 */

import type { AdsStatus, GroupCategory } from "./types.js";

const PROHIBIT_PATTERNS: RegExp[] = [
  /ingen\s+reklam/i,
  /inga?\s+reklam/i,
  /reklam\s+(är\s+)?(inte|ej)\s+till[åa]t/i,
  /reklam\s+(är\s+)?f[öo]rbjud/i,
  /f[öo]rbjudet\s+(att\s+)?(g[öo]ra\s+)?reklam/i,
  /ingen\s+f[öo]retagsreklam/i,
  /(inga|ej|inte|no)\s+f[öo]retag(sannonser|sreklam|are)?\b/i,
  /f[öo]retag\s+(f[åa]r\s+)?(inte|ej)\s+(annonsera|posta|s[äa]lja|g[öo]ra)/i,
  /endast\s+(f[öo]r\s+)?privatpersoner/i,
  /privatpersoner\s+endast/i,
  /bara\s+(f[öo]r\s+)?privatpersoner/i,
  /(inga|ej|inte)\s+kommersiell/i,
  /kommersiella?\s+(inl[äa]gg|annonser)\s+(är\s+)?(inte|ej|f[öo]rbjud)/i,
  /(inga|ej|inte)\s+(tj[äa]nster|f[öo]retagsannonser|n[äa]ringsidkare|butiker|[åa]terf[öo]rs[äa]ljare)/i,
  /\bno\s+(advertising|ads|adverts|advertisements|businesses|companies|commercial|promotion|promotions|self[- ]promotion|spam|solicit(ing|ation)|resellers?|shops?)\b/i,
  /\bprivate\s+(individuals|persons|sellers)\s+only\b/i,
  /\bbusinesses?\s+(are\s+)?not\s+(allowed|permitted|welcome)\b/i,
  /\bcommercial\s+posts?\s+(are\s+)?(not\s+allowed|prohibited|forbidden)\b/i,
];

const ALLOW_PATTERNS: RegExp[] = [
  /f[öo]retag\s+(är\s+)?v[äa]lkomna/i,
  /f[öo]retag\s+f[åa]r\s+(g[äa]rna\s+)?(annonsera|posta|g[öo]ra\s+reklam|s[äa]lja)/i,
  /reklam\s+(är\s+)?(till[åa]te[nt]|ok|okej|v[äa]lkommen)/i,
  /annonsera\s+(dina|era|din)\s+(tj[äa]nster|varor|m[öo]bler)/i,
  /(allm[äa]n\s+)?information\s*&\s*reklam/i,
  /reklam\s+(och|&)\s+erbjudanden/i,
  /\b(businesses|companies|shops)\s+(are\s+)?welcome\b/i,
  /\b(ads|advertising|advertisements|promotion)\s+(are\s+|is\s+)?(allowed|welcome|permitted|ok)\b/i,
  /inga\s+regler/i,
  /utan\s+(massa\s+)?(kr[åa]ngliga\s+)?regler/i,
];

/**
 * Länkförbud. Loopas inlägg bär ALLTID adressen till produktsidan — det är hela poängen med kanalen —
 * så en grupp som förbjuder länkar är en grupp vi inte publicerar till, hur välkomna företag än är.
 */
const LINK_PROHIBIT_PATTERNS: RegExp[] = [
  /inga\s+(externa\s+)?l[äa]nkar/i,
  /l[äa]nkar\s+(är\s+)?(inte|ej)\s+till[åa]t/i,
  /(f[öo]rbjudet|inte\s+ok(ej)?|ej\s+till[åa]tet)\s+(att\s+)?(l[äa]nka|posta\s+l[äa]nkar|dela\s+l[äa]nkar)/i,
  /\bno\s+(external\s+)?links?\b/i,
  /\blinks?\s+(are\s+)?not\s+(allowed|permitted)\b/i,
];

/** Gruppens egen takt: "ett inlägg per vecka". Läses som en paus per grupp, i timmar. */
const FREQUENCY_PATTERNS: Array<{ re: RegExp; hours: number }> = [
  { re: /\b(ett|en|1|max(?:imalt)?\s*\d+)\s+(inl[äa]gg|annons(?:er)?|s[äa]ljinl[äa]gg)\s+(per|i|om|varje)\s+(dag|dygn)\b/i, hours: 24 },
  { re: /\b(ett|en|1|max(?:imalt)?\s*\d+)\s+(inl[äa]gg|annons(?:er)?|s[äa]ljinl[äa]gg)\s+(per|i|om|varje)\s+vecka\b/i, hours: 168 },
  { re: /\b(ett|en|1|max(?:imalt)?\s*\d+)\s+(inl[äa]gg|annons(?:er)?|s[äa]ljinl[äa]gg)\s+(per|i|om|varje)\s+m[åa]nad\b/i, hours: 720 },
  { re: /\b(one|1|max\s*\d+)\s+(posts?|ads?|listings?)\s+(per|a|every)\s+day\b/i, hours: 24 },
  { re: /\b(one|1|max\s*\d+)\s+(posts?|ads?|listings?)\s+(per|a|every)\s+week\b/i, hours: 168 },
  { re: /\b(one|1|max\s*\d+)\s+(posts?|ads?|listings?)\s+(per|a|every)\s+month\b/i, hours: 720 },
];

/** Den takt reglerna kräver, i timmar mellan två inlägg. Null när ingen står. */
export function postingCooldownFrom(text: string | null | undefined): { hours: number; evidence: string } | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ");
  for (const { re, hours } of FREQUENCY_PATTERNS) {
    const m = t.match(re)?.[0];
    if (m) return { hours, evidence: m };
  }
  return null;
}

/** Ord som säger att gruppen är en annonsplats. Krävs för LIKELY_ALLOWED. */
const CLASSIFIEDS_HINTS: RegExp[] = [
  /k[öo]p/i,
  /s[äa]lj/i,
  /byt/i,
  /bortsk[äa]nk/i,
  /annons/i,
  /loppis/i,
  /secondhand|second\s*hand/i,
  /begagna/i,
  /\bbuy\b|\bsell\b|\bfree\s+stuff\b|\bflea\b/i,
];

const CLASSIFIED_CATEGORIES: readonly GroupCategory[] = ["FURNITURE_BUY_SELL", "LOCAL_BUY_SELL", "SECONDHAND", "BRAND_COMMUNITY"];

export interface RulesAssessment {
  adsStatus: AdsStatus;
  /** De fraser som avgjorde. Sparas som `rulesEvidence` och visas i panelen. */
  evidence: string[];
  summary: string;
  /** Reglerna förbjuder länkar — och våra inlägg bär alltid en. */
  linksProhibited: boolean;
  /** Gruppens egen takt i timmar mellan inlägg, när reglerna säger en. */
  postCooldownHours: number | null;
}

export function assessRules(rulesText: string | null | undefined, category: GroupCategory, groupName = ""): RulesAssessment {
  const text = `${groupName}\n${rulesText ?? ""}`.replace(/\s+/g, " ");
  const cooldown = postingCooldownFrom(rulesText);
  const postCooldownHours = cooldown?.hours ?? null;
  const taktEvidence = cooldown ? [`TAKT: "${cooldown.evidence}"`] : [];
  const prohibit = PROHIBIT_PATTERNS.map((p) => text.match(p)?.[0]).filter((m): m is string => !!m);
  if (prohibit.length) {
    return {
      adsStatus: "PROHIBITED",
      evidence: [...prohibit.map((m) => `FÖRBUD: "${m}"`), ...taktEvidence],
      summary: `Reglerna förbjuder företags- eller reklaminlägg (${prohibit.slice(0, 3).map((m) => `"${m}"`).join(", ")}).`,
      linksProhibited: false,
      postCooldownHours,
    };
  }
  const links = LINK_PROHIBIT_PATTERNS.map((p) => text.match(p)?.[0]).filter((m): m is string => !!m);
  if (links.length) {
    return {
      adsStatus: "PROHIBITED",
      evidence: [...links.map((m) => `LÄNKFÖRBUD: "${m}"`), ...taktEvidence],
      summary: `Reglerna förbjuder länkar (${links.slice(0, 2).map((m) => `"${m}"`).join(", ")}) — och Loopas inlägg bär alltid adressen till möbeln.`,
      linksProhibited: true,
      postCooldownHours,
    };
  }

  const allow = ALLOW_PATTERNS.map((p) => text.match(p)?.[0]).filter((m): m is string => !!m);
  if (allow.length) {
    return {
      adsStatus: "ALLOWED",
      evidence: [...allow.map((m) => `TILLÅTET: "${m}"`), ...taktEvidence],
      summary: `Reglerna välkomnar uttryckligen företag eller annonser (${allow.slice(0, 3).map((m) => `"${m}"`).join(", ")}).`,
      linksProhibited: false,
      postCooldownHours,
    };
  }

  const hasRules = (rulesText ?? "").trim().length > 40;
  const classifieds = CLASSIFIEDS_HINTS.some((p) => p.test(text));
  if (hasRules && classifieds && CLASSIFIED_CATEGORIES.includes(category)) {
    return {
      adsStatus: "LIKELY_ALLOWED",
      evidence: ["KÖP/SÄLJ: gruppen är en annonsplats och reglerna nämner inte företag eller reklam", ...taktEvidence],
      summary: "Köp/sälj-grupp vars regler inte förbjuder företag. Möbelannonser är gruppens normala innehåll.",
      linksProhibited: false,
      postCooldownHours,
    };
  }

  return {
    adsStatus: "UNCLEAR",
    evidence: taktEvidence,
    summary: hasRules ? "Reglerna är lästa men säger inget om företag, reklam eller annonser." : "Ingen regeltext läst än.",
    linksProhibited: false,
    postCooldownHours,
  };
}

/** Kan Loopa publicera till gruppen? Bara två av fyra lägen. UNCLEAR är ett nej. */
export function adsStatusAllowsPosting(status: AdsStatus): boolean {
  return status === "ALLOWED" || status === "LIKELY_ALLOWED";
}

const JOIN_BLOCKING_PATTERNS: RegExp[] = [
  /endast\s+p[åa]\s+inbjudan|invite[- ]only|inbjudan\s+kr[äa]vs/i,
  /(inga|ej|inte)\s+(nya\s+)?f[öo]retag\s+(f[åa]r\s+)?(bli\s+)?medlem/i,
  /f[öo]retag\s+(f[åa]r\s+)?(inte|ej)\s+(bli\s+|vara\s+)?medlem/i,
  /businesses?\s+(are\s+)?not\s+(allowed|permitted)\s+(to\s+)?(join|be\s+members?)/i,
  /endast\s+(f[öo]r\s+)?boende\s+i/i,
];

/** En regel som säger att vi inte ens ska försöka gå med. Null = ingen sådan. */
export function joinBlockedBy(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ");
  for (const p of JOIN_BLOCKING_PATTERNS) {
    const m = t.match(p)?.[0];
    if (m) return m;
  }
  return null;
}

/**
 * Regelavsnittet ur Om-sidans text. Facebook rubricerar det "Gruppregler" / "Regler från
 * administratörerna"; saknas rubriken används beskrivningen — den är ofta där reglerna står i äldre
 * grupper.
 */
export function extractRulesSection(aboutText: string | null | undefined): { rules: string | null; hasRulesSection: boolean } {
  if (!aboutText) return { rules: null, hasRulesSection: false };
  const idx = aboutText.search(/gruppregler|group rules|regler från administratörerna|rules from the admins/i);
  if (idx >= 0) return { rules: aboutText.slice(idx, idx + 6000), hasRulesSection: true };
  return { rules: aboutText.slice(0, 6000) || null, hasRulesSection: false };
}

/** Sant när reglerna är för gamla för att lita på före en publicering. Aldrig lästa = för gamla. */
export function rulesStale(rulesLastCheckedAt: string | null, maxAgeHours: number, now: Date = new Date()): boolean {
  if (!rulesLastCheckedAt) return true;
  const t = Date.parse(rulesLastCheckedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > maxAgeHours * 3_600_000;
}
