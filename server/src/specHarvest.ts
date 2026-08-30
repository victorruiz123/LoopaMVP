import type { ListingAttribute } from "./types.js";

/**
 * Specifikationer lästa ur produktsidans EGEN HTML.
 *
 * Måtten kommer i dag bara en väg: den grundade sökningen skriver dem i löptext, och
 * struktureringen ska plocka upp dem. Två modellsteg i rad, och båda missar ibland — sökningen tänder
 * inte (`sources=0`) eller struktureringen låter MÅTT-raderna falla. Då står säljaren med en annons
 * utan mått, och fas 2 kör om hela anropet för att försöka igen.
 *
 * Men sidan med specifikationerna är REDAN hämtad. Kandidatbildhämtningen laddar ner varje kandidats
 * produktsida och kontrollerar att den nämner modellen innan den lånar dess bild — det är samma
 * "nysida" måtten står på. Att läsa dem ur den HTML vi ändå har kostar noll anrop, noll sekunder och
 * noll nya hämtningar, och värdet är belagt mot en adress vi själva besökt.
 *
 * ALDRIG en gissning: bara etikett-värde-par som faktiskt står på sidan, bara tal med enhet, och bara
 * inom rimliga intervall. Hittar den inget lämnar den tomt — det som redan finns rörs aldrig.
 */

/** Bokstäver, inklusive svenska. Används för att se var ett ord slutar — "sitthöjd" är inte "höjd". */
const L = "a-zA-ZÀ-ÿ";
const NUM = "(\\d{1,4}(?:[.,]\\d{1,2})?)";
const LEN_UNIT = "(millimeter|centimeter|meter|mm|cm|m)";
/** Mellan etikett och värde ryms ": ", " | ", " ca " — men aldrig en hel mening. */
const GAP = "[^\\d<>]{0,12}";
/**
 * Delens mått är inte möbelns.
 *
 * Svenskan skriver ihop dem — "sitthöjd" — och ordgränsen nedan skiljer dem redan åt. Engelskan
 * skriver isär dem, och då står bara ett mellanslag mellan orden: "Seat height 62 cm" läses som
 * höjden, "Seat width 40 cm" som bredden. Samma klausul står dessutom i IKEA:s egna produktnamn —
 * "NORDVIKEN bar stool, counter height/black, 62 cm" — och den barstolen är 88 cm hög, inte 62.
 */
const PART = "(?<!(?:seat|back|backrest|arm|armrest|counter|bar|leg|inner|inside)[ /-])";

interface SpecLabel {
  key: string;
  label: string;
  /** Alternativ som får skrivas i källan, svenska och engelska. */
  alts: string;
}

/** Måtten i den ordning en möbel mäts. Sitthöjd står för sig — den är inte möbelns höjd. */
const DIMENSIONS: SpecLabel[] = [
  { key: "bredd", label: "Bredd", alts: "bredd|width" },
  { key: "djup", label: "Djup", alts: "djup|depth" },
  { key: "hojd", label: "Höjd", alts: "höjd|hojd|height" },
  { key: "sitthojd", label: "Sitthöjd", alts: "sitthöjd|sitshöjd|seat height" },
  { key: "sittdjup", label: "Sittdjup", alts: "sittdjup|seat depth" },
  { key: "langd", label: "Längd", alts: "längd|length" },
  { key: "diameter", label: "Diameter", alts: "diameter" },
];

/** Textegenskaper. Kräver ett riktigt skiljetecken — annars läser den löptext som om den vore en tabell. */
const TEXT_SPECS: SpecLabel[] = [
  { key: "material", label: "Material", alts: "material|materialsammansättning|materials" },
  { key: "kladsel", label: "Klädsel", alts: "klädsel|tygkvalitet|upholstery" },
  { key: "stomme", label: "Stomme", alts: "stomme" },
  { key: "traslag", label: "Träslag", alts: "träslag" },
];

/** Vad en möbel rimligen mäter i cm. Utanför det är det inte ett mått vi läst utan ett tal vi råkat på. */
const MIN_CM = 3;
const MAX_CM = 500;
const MAX_SPECS = 10;

/**
 * Där produktens mått slutar och kartongens börjar.
 *
 * IKEA skriver båda, i den ordningen: "Bredd 40 cm | Djup 45 cm | Höjd 88 cm | Sitshöjd 62 cm |
 * Förpackning | … | Bredd: 47 cm | Höjd: 10 cm | Längd: 90 cm | Vikt: 5.80 kg". Utan den här gränsen
 * blir en barstol 90 cm lång och väger 5,8 kg — sant om paketet, falskt om möbeln.
 */
const PACKAGING = /(förpackning|paketmått|paketstorlek|emballage|frakt(?:mått|vikt)|packaging|package (?:size|dimensions|weight)|shipping (?:dimensions|weight))/i;
const A_DIMENSION = new RegExp(`${PART}(?<![${L}])(?:bredd|djup|höjd|width|depth|height)[${L}]{0,3}(?![${L}])${GAP}${NUM}\\s*${LEN_UNIT}`, "i");

/**
 * Ett materialvärde måste NAMNGE ett material.
 *
 * Etiketten "Material" följs på riktiga sidor lika ofta av en knapp ("Lägg i varukorgen"), en rubrik
 * ("Material och skötsel") eller en underrubrik ("Ben/ Sarg") som av ett svar. Mätt på elva skarpa
 * kandidatsidor gav den fria läsningen "Frame", "Ben/ Sarg" och "Lägg i varukorgen" — tre påståenden
 * om materialet som inte var påståenden om materialet. Ordlistan är kravet: står det inget material i
 * värdet är det inte ett materialvärde.
 */
const MATERIAL_WORDS = [
  // Korta ord som måste stå för sig själva: "korg" i "varukorgen" är ingen korgmöbel.
  new RegExp(`(?<![${L}])(?:ek|bok|al|alm|ask|lin|ull|glas|sten|korg|skum|dun|tyg|mdf|ply)(?![${L}])`, "i"),
  // Distinkta stammar, som får böjas och sättas ihop: "ekfanér", "spånskivor", "läderklädsel".
  new RegExp(
    `(?<![${L}])(?:trä(?!ff)|massiv|björk|furu|teak|valnöt|plywood|faner|fanér|spånskiv|metall|stål|krom|aluminium|` +
      `järn|mässing|plast|polyprop|polyester|polyamid|polyuretan|polyurethane|akryl|bomull|linne|viskos|läder|skinn|` +
      `mocka|sammet|velour|textil|marmor|betong|rotting|bambu|gummi|latex|fjäder|mikrofiber|chenille|jute|sisal|kork|` +
      `lack|betsad|oljad|vaxad)`,
    "i",
  ),
];

/** Namnger värdet faktiskt ett material? Annars är det en rubrik eller en knapp, inte ett svar. */
const namesMaterial = (v: string) => MATERIAL_WORDS.some((re) => re.test(v));

const word = (alts: string) => `${PART}(?<![${L}])(?:${alts})[${L}]{0,3}(?![${L}])`;
/** "Bredd: 81 cm", "Bredd | 81 cm", "Bredd ca 81 cm" — enheten står efter talet. */
const valueAfter = (alts: string) => new RegExp(`${word(alts)}${GAP}${NUM}\\s*${LEN_UNIT}(?![${L}])`, "i");
/** "Bredd (cm) | 81" — enheten står i etiketten, vanligt i specifikationstabeller. */
const unitInLabel = (alts: string) => new RegExp(`${word(alts)}\\s*[([]\\s*${LEN_UNIT}\\s*[)\\]][^\\d<>]{0,6}${NUM}`, "i");
/** "B120 x D80 x H75 cm" — hela måttet på en rad, i den ordning etiketterna själva anger. */
const TRIPLE = new RegExp(
  `(?<![${L}])b(?:redd)?\\s*[:.]?\\s*(\\d{2,3})\\s*[x×*]\\s*d(?:jup)?\\s*[:.]?\\s*(\\d{2,3})\\s*[x×*]\\s*h(?:öjd)?\\s*[:.]?\\s*(\\d{2,3})\\s*${LEN_UNIT}?`,
  "i",
);
const WEIGHT = new RegExp(`${word("vikt|weight")}${GAP}${NUM}\\s*(kilo|kg|g)(?![${L}])`, "i");
/**
 * Etiketten plus de närmaste cellerna efter den.
 *
 * En enda cell räckte inte: sidorna lägger en underrubrik mellan fråga och svar — "Material | Frame: |
 * Plywood, Polyurethane foam", "Om materialet | Ben/ Sarg: | Massiv furu, Betsad klarlack". Fönstret
 * läses cell för cell och den första som namnger ett material vinner.
 */
const textValue = (alts: string) => new RegExp(`${word(alts)}\\s*[:|]\\s*([^<>]{2,200})`, "i");
const MAX_VALUE_CELLS = 3;

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&#160;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&times;": "×",
};

/**
 * HTML till läsbar text, med cellgränserna kvar.
 *
 * Gränserna är hela poängen: en specifikationstabell är `<td>Bredd</td><td>81 cm</td>`, och utan en
 * markör mellan cellerna går etikett och värde inte att skilja från löpande text. Blockslut blir
 * därför "|" — samma tecken källan själv använder när den skriver "Bredd | 81 cm" — medan inline-taggar
 * (`<span>`, `<b>`) bara försvinner, för de sitter mitt i ett värde.
 */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(?:td|th|tr|li|p|div|dt|dd|h[1-6]|section|article|table|ul|ol|caption)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, " | ")
    .replace(/<[^>]*>/g, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  return out
    .replace(/\s*[\r\n]+\s*/g, " | ")
    .replace(/[ \t ]+/g, " ")
    .replace(/(?:\s*\|\s*){2,}/g, " | ")
    .trim();
}

/** Talet i centimeter, eller null när det inte är ett mått på en möbel. */
function toCm(raw: string, unit: string | undefined): string | null {
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? "cm").toLowerCase();
  const cm = u.startsWith("mm") || u.startsWith("milli") ? n / 10 : u === "m" || u.startsWith("meter") ? n * 100 : n;
  if (cm < MIN_CM || cm > MAX_CM) return null;
  return `${String(Math.round(cm * 10) / 10).replace(".", ",")} cm`;
}

/** Ett textvärde som faktiskt säger något: namnger ett material, är ingen adress och ingen annan etikett. */
function cleanTextValue(raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").replace(/^[\s:|,-]+|[\s:|,;-]+$/g, "").trim();
  if (v.length < 2 || v.length > 60) return null;
  if (/https?:|@|\{|\}/.test(v)) return null;
  if ([...DIMENSIONS, ...TEXT_SPECS].some((s) => new RegExp(`^(?:${s.alts})$`, "i").test(v))) return null;
  return namesMaterial(v) ? v : null;
}

/**
 * Produktens egna mått: texten fram till förpackningsavsnittet, när det finns mått före det.
 *
 * Alla gränser prövas, inte bara den första. Ordet står lika gärna i löptext ("plastfri förpackning")
 * långt före tabellen, och den träffen har inga mått bakom sig — då är det inte avsnittet vi letar
 * efter, och läsningen går vidare till nästa.
 */
function productSection(text: string): string {
  for (const marker of matches(text, PACKAGING)) {
    const before = text.slice(0, marker.index);
    if (A_DIMENSION.test(before)) return before;
  }
  return text;
}

/** Alla träffar för ett mönster, så en förkastad träff (fel intervall, en knapp) inte tar med sig raden. */
function* matches(text: string, re: RegExp): Generator<RegExpMatchArray> {
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) yield m;
}

/**
 * Specifikationerna sidan faktiskt skriver ut.
 *
 * `sourceUrl` är sidan vi läste dem på — samma adress säljaren kan öppna och kontrollera. Ett värde
 * utan sida hade varit ett påstående; det här är ett citat.
 */
export function harvestSpecs(html: string, sourceUrl: string | null): ListingAttribute[] {
  const text = htmlToText(html);
  if (!text) return [];
  const product = productSection(text);
  const out: ListingAttribute[] = [];
  const add = (key: string, label: string, value: string) => {
    if (out.length < MAX_SPECS && !out.some((a) => a.key === key)) out.push({ key, label, value, sourceUrl });
  };

  // Sammanskrivna mått först: står de på en rad är ordningen redan angiven av etiketterna, och den
  // raden är entydigare än tre lösryckta tal.
  for (const triple of matches(product, TRIPLE)) {
    const [bredd, djup, hojd] = [toCm(triple[1], triple[4]), toCm(triple[2], triple[4]), toCm(triple[3], triple[4])];
    if (bredd && djup && hojd) {
      add("bredd", "Bredd", bredd);
      add("djup", "Djup", djup);
      add("hojd", "Höjd", hojd);
      break;
    }
  }

  for (const spec of DIMENSIONS) {
    let value: string | null = null;
    for (const m of matches(product, valueAfter(spec.alts))) {
      value = toCm(m[1], m[2]);
      if (value) break;
    }
    if (!value) {
      for (const m of matches(product, unitInLabel(spec.alts))) {
        value = toCm(m[2], m[1]);
        if (value) break;
      }
    }
    if (value) add(spec.key, spec.label, value);
  }

  for (const m of matches(product, WEIGHT)) {
    const n = Number(m[1].replace(",", "."));
    const kg = m[2].toLowerCase() === "g" ? n / 1000 : n;
    if (Number.isFinite(kg) && kg >= 0.2 && kg <= 300) {
      add("vikt", "Vikt", `${String(Math.round(kg * 10) / 10).replace(".", ",")} kg`);
      break;
    }
  }

  // Materialet läses ur HELA sidan: det står ofta under "Material och skötsel", långt efter måtten
  // och därmed efter förpackningsavsnittet. Ordlistan i cleanTextValue är vad som skyddar det.
  for (const spec of TEXT_SPECS) {
    let found: string | null = null;
    for (const m of matches(text, textValue(spec.alts))) {
      for (const cell of m[1].split("|").slice(0, MAX_VALUE_CELLS)) {
        found = cleanTextValue(cell);
        if (found) break;
      }
      if (found) break;
    }
    if (found) add(spec.key, spec.label, found);
  }

  return out;
}

/**
 * Snabb koll på hur många mått som passerat — mot RÅ HTML, mitt i en strömmande hämtning.
 *
 * Specifikationstabellen ligger långt ned i dokumentet: hos IKEA runt 1 MB in på en sida på 1,1 MB.
 * Hämtningen läser därför vidare tills den ser måtten, och det är den här funktionen som avgör när
 * den sett dem. Grov med flit — den ska svara på "är vi framme?", inte producera värden.
 */
export function countDimensions(htmlChunk: string): number {
  const text = htmlChunk.replace(/<[^>]*>/g, " ");
  const re = new RegExp(
    `(?<![${L}])(?:bredd|djup|höjd|sitthöjd|width|depth|height)[${L}]{0,3}(?![${L}])[^\\d]{0,20}\\d{1,4}(?:[.,]\\d)?\\s*(?:cm|mm)(?![${L}])`,
    "gi",
  );
  return (text.match(re) ?? []).length;
}

/** Alla etiketter en och samma rad kan heta — så samma mått inte hamnar två gånger på kortet. */
const ROWS: Array<{ key: string; re: RegExp }> = [
  ...DIMENSIONS.map((s) => ({ key: s.key, re: new RegExp(`(?<![${L}])(?:${s.alts})`, "i") })),
  { key: "vikt", re: new RegExp(`(?<![${L}])(?:vikt|weight)`, "i") },
  ...TEXT_SPECS.map((s) => ({ key: s.key, re: new RegExp(`(?<![${L}])(?:${s.alts})`, "i") })),
];

/** En etikett som samlar flera mått i ett värde: "Mått", "Dimensioner", "Storlek". */
const COMBINED = /(mått|matt|dimension|storlek|size)/i;
const TRIPLE_VALUE = /\d+\s*[x×*]\s*\d+\s*[x×*]\s*\d+/i;

/**
 * Vilka rader en egenskap som redan står i annonsen upptar.
 *
 * Oftast en enda — "Bredd" är bredden. Men generatorn skriver lika gärna ihop måtten till ett fält
 * ("Mått: 81 x 92 x 82 cm"), och då är bredden redan sagd. Utan den här läsningen hade sidskörden
 * lagt till Bredd, Djup och Höjd bredvid ett fält som redan innehöll dem.
 */
function rowsCovered(attribute: ListingAttribute): string[] {
  const head = `${attribute.key} ${attribute.label}`;
  const direct = ROWS.find((r) => r.re.test(head));
  if (direct) return [direct.key];
  if (!COMBINED.test(head)) return [];
  if (TRIPLE_VALUE.test(attribute.value)) return ["bredd", "djup", "hojd"];
  return ROWS.filter((r) => r.re.test(attribute.value)).map((r) => r.key);
}

/**
 * Lägger till det sidan visste, utan att röra det sökningen redan belagt.
 *
 * Ordningen är medveten: en uppgift generatorn hittat har gått genom både sökning och strukturering
 * och bär ofta en egen källa. Sidskörden fyller luckorna — den ersätter aldrig något belagt.
 *
 * Det ENDA som ger vika är en uppskattning. Annonsen går numera aldrig ut utan mått: saknas belagda
 * fylls de på med typiska mått för möbeltypen, märkta `estimated`. Sidskörden kommer efter — den
 * läser produktsidans egen HTML — och ett mått som står på tillverkarens sida är alltid bättre än ett
 * ur tabellen. Utan det här hade uppskattningen blockerat det riktiga måttet den bara var ställföreträdare för.
 */
export function mergeSpecs(attributes: ListingAttribute[], harvested: ListingAttribute[]): ListingAttribute[] {
  if (harvested.length === 0) return attributes;
  const taken = new Set(attributes.filter((a) => !a.estimated).flatMap(rowsCovered));
  const extra = harvested.filter((h) => {
    const [row] = rowsCovered(h);
    if (!row || taken.has(row)) return false;
    taken.add(row);
    return true;
  });
  if (extra.length === 0) return attributes;
  const replaced = new Set(extra.flatMap(rowsCovered));
  const kept = attributes.filter((a) => !(a.estimated && rowsCovered(a).some((row) => replaced.has(row))));
  return [...kept, ...extra];
}
