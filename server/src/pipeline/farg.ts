/**
 * Färgorden, och hur de jämförs.
 *
 * VARFÖR DE BEHÖVS: produktsidan väljs på modellnamn. NORDVIKEN finns i svart och i vitlaserad ek,
 * EKTORP i sex klädslar, och sidrangordningen såg ingen skillnad — den tog den sida som råkade ligga
 * först och lånade dess bild. Utfallet är en annons där möbeln är svart i skickrapporten, i måtten
 * och på säljarens egen bild, och vit på omslaget. Det är inte en skönhetsfläck: omslaget är det man
 * väljer på, och en köpare som klickar för att bilden visade en vit stol har blivit lurad av oss.
 *
 * KANONISKA FÄRGER, INTE STRÄNGAR. "Svart", "black", "matt svart" och "svartbetsad" är samma färg,
 * och en jämförelse på strängar hade missat tre av fyra. Varje ord nedan pekar på en kanonisk färg,
 * och det är de kanoniska som jämförs.
 *
 * TRÄSLAG ÄR FÄRGER HÄR. "Ek", "valnöt" och "björk" beskriver inte ett material i det här
 * sammanhanget utan hur möbeln SER UT, och de skiljer varianter åt precis som svart och vit gör.
 * Att kalla dem färger är fel i en materiallista och rätt i en bildvalsrutin.
 *
 * ORDLISTAN ÄR AVSIKTLIGT KORT. Den ska täcka de ord som faktiskt står i en produktsidas titel eller
 * adress, inte varje nyans en tillverkare hittat på. Ett ord som inte finns här ger ingen matchning
 * och därmed ingen påverkan — sidan rangordnas som förut. Det är rätt utfall: gissa aldrig på färg.
 */

/** Kanonisk färg -> orden som betyder den. Alla i gemener, utan diakriter (se `vik`). */
const ORD: Record<string, string[]> = {
  svart: ["svart", "black", "svartbetsad", "svartlackerad", "antracit", "anthracite", "koks", "graphite"],
  vit: ["vit", "white", "vitlaserad", "vitpigmenterad", "offwhite", "off-white", "creme", "cream", "ivory", "elfenben"],
  gra: ["gra", "grey", "gray", "ljusgra", "morkgra", "silver", "betong", "concrete", "stengra"],
  beige: ["beige", "sand", "linne", "linen", "greige", "taupe", "natur", "naturell", "ecru"],
  brun: ["brun", "brown", "mork brun", "cognac", "konjak", "chocolate", "choklad", "mocka", "tobacco"],
  bla: ["bla", "blue", "marinbla", "navy", "denim", "petrol", "indigo", "himmelsbla"],
  gron: ["gron", "green", "olive", "oliv", "salvia", "sage", "mossgron", "flaskgron"],
  rod: ["rod", "red", "vinrod", "burgundy", "bordeaux", "tegel", "rost", "rust"],
  rosa: ["rosa", "pink", "puder", "dusty pink", "gammelrosa"],
  gul: ["gul", "yellow", "senap", "mustard", "ockra", "ochre"],
  ek: ["ek", "oak", "ekfaner", "ljus ek", "rokt ek", "smoked oak"],
  valnot: ["valnot", "walnut", "notlackerad"],
  bjork: ["bjork", "birch", "bok", "beech", "furu", "pine", "asp"],
  teak: ["teak", "palisander", "rosewood", "mahogny", "mahogany"],
};

/** Diakriter bort och gemener på. "Mörkgrå" och "morkgra" är samma ord för den här rutinen. */
function vik(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "a")
    .toLowerCase();
}

/**
 * De kanoniska färger en text nämner.
 *
 * ORDGRÄNSER KRÄVS. Utan dem matchade "ek" i "dekorativ", "teak" och "eklektisk", och "bla" i
 * "tablar" — en sida om ett svart bord hade fått räknas som en ek-sida. Gränsen är allt som inte är
 * en bokstav eller en siffra, vilket gör att bindestreck och snedstreck i en adress fungerar som
 * ordmellanrum: `/nordviken-barstol-svart/` ger `svart`.
 */
export function fargerI(text: string): Set<string> {
  const t = vik(text);
  const ut = new Set<string>();
  for (const [kanon, ord] of Object.entries(ORD)) {
    for (const o of ord) {
      const m = new RegExp(`(^|[^a-z0-9])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (m.test(t)) {
        ut.add(kanon);
        break;
      }
    }
  }
  return ut;
}

/** Den kanoniska färgen ett attributvärde beskriver, eller null. "Mörkgrå tyg" -> "gra". */
export function kanoniskFarg(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const funna = fargerI(raw);
  // Första träffen i ordlistans egen ordning: "svart ek" är en svart möbel av ek, inte en ek-möbel.
  for (const kanon of Object.keys(ORD)) if (funna.has(kanon)) return kanon;
  return null;
}

/**
 * Vad en sidas färg är värd, som ett PÅSLAG på dess rangordning. Lägre är bättre, som i rankPages.
 *
 *   0   sidan nämner den färg vi söker — eller ingen färg alls
 *   +N  sidan nämner BARA andra färger
 *
 * TYSTNAD STRAFFAS INTE. En produktsida som inte skriver ut färgen i sin titel är inte en sida om
 * fel färg; den är en sida som inte sa något. Att straffa den hade sorterat ned varje sida med en
 * ren titel till förmån för varje sida som råkade nämna en färg — vilken som helst.
 *
 * STRAFFET ÄR STÖRRE ÄN VARJE ANNAT PÅSLAG i rankPages (kvalitetsnivå 1–3, tillbehör 50). Det är
 * med flit: en sida om rätt modell i fel färg är sämre än en sida om rätt modell utan bild, för den
 * första ger en bild man tror på och den andra ger ingen alls.
 */
export const FARG_STRAFF = 200;

export function fargPaslag(sidtext: string, onskad: string | null): number {
  if (!onskad) return 0;
  const funna = fargerI(sidtext);
  if (funna.size === 0) return 0;
  return funna.has(onskad) ? 0 : FARG_STRAFF;
}

/**
 * Möbelns färg, ur det annonsen faktiskt vet.
 *
 * TRE KÄLLOR, i fallande tillförlitlighet — och de två sista är inte finess utan skillnaden mellan
 * att regeln fungerar och att den inte gör något. Mätt på 43 live-varor med katalogbild bär bara 10
 * ett färgattribut; med titeln och varianten är siffran 30. En färgregel som känner färgen på var
 * fjärde annons är ingen färgregel.
 *
 *   1. ATTRIBUTET ("Färg", "Klädsel"). Explicit, och det enda som är skrivet för att svara på
 *      frågan. Vinner när det finns.
 *   2. ANNONSTITELN. "IKEA NORDVIKEN Barstol Svart", "IKEA Tonstad matstol i off-white" — färgen
 *      står där för att den är det som skiljer varianterna åt, alltså precis det vi letar efter.
 *   3. KANDIDATENS VARIANT, som identifieringen satte. Sist för att den är en modellgissning och
 *      inte en observation.
 *
 * NULL ÄR ETT SVAR. En möbel vars färg ingen av de tre känner får ingen färgviktning alls, och
 * sidorna rangordnas som förut. Att gissa en färg vore värre än att inte veta: en gissad färg
 * sorterar bort den enda riktiga bilden.
 */
export function fargForAnnons(a: {
  attribut?: Array<{ label: string; value: string }> | null;
  titel?: string | null;
  variant?: string | null;
}): string | null {
  const attr = a.attribut?.find((x) => /^(farg|färg|kulör|kulor|kladsel|klädsel|color|colour)$/i.test(x.label))?.value;
  return kanoniskFarg(attr) ?? kanoniskFarg(a.titel) ?? kanoniskFarg(a.variant);
}
