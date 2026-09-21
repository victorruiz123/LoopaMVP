import { callGeminiStructured } from "../gemini.js";

/**
 * Vilka varianter en modell finns i — "2-sitssoffa", "3-sitssoffa", "fåtölj", "divan".
 *
 * VARFÖR FRÅGAN STÄLLS ALLS. Skillnaden mellan en två- och en tresits syns inte på ett foto taget
 * snett framifrån i ett vardagsrum, och den avgör både måtten och priset. Bilderna gav Ektorp rätt
 * modell men 3-sitsens 218 cm på en 2-sits, och en SoffaDirekt fick "3-sitssoffa" med två sittdynor
 * på bilden. Ingen av dem gick att rätta med en bildmodell: uppgiften finns hos säljaren, som står
 * framför möbeln. Så vi frågar.
 *
 * FRÅGAN GÄLLER MÖBELN PÅ BILDEN, INTE SERIEN DEN TILLHÖR. Det här är felet listan gjorde: en
 * säljare skrev "Nordviken stol" och fick välja mellan matbord, utdragsbart matbord, stol, barstol
 * 63 cm, barstol 75 cm, barbord och bänk med förvaring. NORDVIKEN är ett SERIENAMN — IKEA säljer en
 * hel matgrupp under det — och frågan "vilka varianter finns av NORDVIKEN?" besvarades därför med
 * hela serien. Men ett bord är inte en variant av en stol. Att säljaren skrev "stol", och att det
 * står en stol på bilderna, hade redan avgjort saken; skärmen bad dem peka ut något de redan pekat
 * ut. Därför går möbeltypen med i frågan, och svaret får bara innehålla varianter AV DEN TYPEN.
 *
 * FRÅGAN STÄLLS BARA NÄR DET FINNS NÅGOT ATT VÄLJA MELLAN, och bara när valet inte redan syns. En
 * modell som bara finns i ett utförande ger ingen fråga, och inte heller en där utförandena skiljer
 * sig så tydligt att bilderna svarar själva — ett val utan alternativ är en skärm som stjäl ett
 * tryck och inte säger något. Kvar blir det frågan är till för: utföranden som liknar varandra så
 * mycket på ett foto att bara den som står framför möbeln kan skilja dem åt.
 *
 * Listan hämtas i bakgrunden när säljaren valt modell, parallellt med annonsen, och hinner nästan
 * alltid fram medan de svarar på frågorna om pälsdjur och lukt. Hinner den inte, eller faller den,
 * hoppas frågan över: en utebliven variantlista får aldrig stoppa någon.
 */

const SCHEMA = {
  type: "object",
  properties: {
    /** Möbeltypen modellen tolkade fram, t.ex. "stol". Loggas — den förklarar listan som följde. */
    mobeltyp: { type: "string" },
    varianter: { type: "array", items: { type: "string" } },
    osaker: { type: "boolean" },
  },
  required: ["mobeltyp", "varianter", "osaker"],
} as const;

const SYSTEM = [
  "Du är en möbelkännare som svarar kort och faktabaserat om en viss möbel.",
  "Du får ett märke, ett modellnamn och — när den är känd — vilken sorts möbel det är.",
  "Svara med vilka VARIANTER just den möbeln säljs eller såldes i.",
  "En variant är en storlek eller utförandeform som ändrar möbelns MÅTT: '2-sitssoffa', '3-sitssoffa',",
  "'fåtölj', 'divansoffa', 'hörnsoffa', 'fotpall', 'barstol 63 cm', 'barstol 75 cm'.",
  "Färger, klädslar och träslag är INTE varianter — de ändrar inte måtten. Ta aldrig med dem.",
  "MÖBELTYPEN ÄR REDAN AVGJORD. Många modellnamn är serienamn som täcker en hel möbelfamilj:",
  "bord, stolar, barstolar, bänkar. Andra möbler i serien är INTE varianter av den här möbeln.",
  "Är möbeln en stol ska listan bara innehålla stolar; är den ett bord bara bord. Byt aldrig typ.",
  "SVARET GÄLLER BARA DET SOM INTE SYNS PÅ ETT FOTO. Säljaren har redan fotograferat möbeln, så",
  "utföranden som är lätta att skilja åt på en bild är inget att fråga om — bara sådant som liknar",
  "varandra så mycket på foto att måtten måste bekräftas av någon som står framför möbeln.",
  "Finns bara ett utförande, eller räcker bilden för att avgöra: svara med exakt en variant.",
  "Känner du inte till modellen: svara med en tom lista och osaker = true. Gissa aldrig.",
  "Fältet mobeltyp: den sorts möbel du svarade om, ett ord, på svenska.",
].join(" ");

const MAX_VARIANTER = 8;
/** En månad. Sortimentet ändras långsamt, och en variantlista är inte en färskvara som ett pris. */
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Möbeltypen, som den är känd vid modellvalet.
 *
 * `productType` kommer från den valda kandidaten och är ofta redan mer än en typ ("3-sits soffa").
 * Den skickas rå: modellen läser den bättre än en normalisering gör, och en trimmad sträng som
 * "soffa" hade kastat bort just det som gör frågan onödig.
 */
export async function hamtaVarianter(
  brand: string | null,
  model: string,
  productType: string | null = null,
): Promise<string[]> {
  const namn = [brand, model].filter(Boolean).join(" ").trim();
  if (!model.trim()) return [];
  const typ = (productType ?? "").trim();
  try {
    const svar = await callGeminiStructured<{ varianter?: unknown; osaker?: unknown; mobeltyp?: unknown }>({
      purpose: "varianter",
      systemPrompt: SYSTEM,
      // Möbeltypen står i frågan när den är känd. Är den det inte får modellnamnet tala för sig
      // självt — en säljare som skrev "Nordviken stol" har sagt typen där, i sina egna ord.
      userPrompt: typ
        ? `Möbeln är en ${typ}. Vilka varianter finns av ${namn} som ${typ}?`
        : `Vilka varianter finns av ${namn}?`,
      images: [],
      responseSchema: SCHEMA as unknown as object,
      // Ingen bild, bara en fråga om ett sortiment: det billigaste läget räcker.
      resolution: "low",
      cacheMaxAgeMs: CACHE_MS,
    });
    if (svar.data?.osaker === true) return [];
    const raa = Array.isArray(svar.data?.varianter) ? svar.data.varianter : [];
    const rensade = raa
      .map((v) => String(v ?? "").trim())
      .filter((v) => v.length > 0 && v.length <= 40);
    // Skiftlägesokänslig dubblettgallring: "3-sitssoffa" och "3-Sitssoffa" är samma val.
    const sedda = new Set<string>();
    const unika = rensade.filter((v) => {
      const nyckel = v.toLowerCase();
      if (sedda.has(nyckel)) return false;
      sedda.add(nyckel);
      return true;
    });
    const valda = unika.slice(0, MAX_VARIANTER);
    const typSvar = String(svar.data?.mobeltyp ?? "").trim();
    if (valda.length > 1) {
      console.info(`[varianter] ${namn}${typ ? ` (${typ})` : ""}: ${typSvar || "?"} — ${valda.join(", ")}`);
    }
    return valda;
  } catch (err) {
    console.warn(`[varianter] ${namn}: kunde inte hämtas —`, err instanceof Error ? err.message : err);
    return [];
  }
}
