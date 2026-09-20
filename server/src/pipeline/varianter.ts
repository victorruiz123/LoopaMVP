import { callGeminiStructured } from "../gemini.js";

/**
 * Vilka varianter en modell finns i — "2-sitssoffa", "3-sitssoffa", "fåtölj", "divan".
 *
 * VARFÖR FRÅGAN STÄLLS ALLS. Skillnaden mellan en två- och en tresits syns inte på ett foto taget
 * snett framifrån i ett vardagsrum, och den avgör både måtten och priset. Bilderna gav Ektorp rätt
 * modell men 3-sitsens 218 cm på en 2-sits, och en SoffaDirekt fick "3-sitssoffa" med två sittdynor
 * på bilden. Ingen av dem gick att rätta med en bättre bildmodell: uppgiften finns hos säljaren, som
 * står framför möbeln. Så vi frågar.
 *
 * FRÅGAN STÄLLS BARA NÄR DET FINNS NÅGOT ATT VÄLJA MELLAN. En modell som bara finns i ett utförande
 * ger ingen fråga — ett val utan alternativ är en skärm som stjäl ett tryck och inte säger något.
 *
 * Listan hämtas i bakgrunden när säljaren valt modell, parallellt med annonsen, och hinner nästan
 * alltid fram medan de svarar på frågorna om pälsdjur och lukt. Hinner den inte, eller faller den,
 * hoppas frågan över: en utebliven variantlista får aldrig stoppa någon.
 */

const SCHEMA = {
  type: "object",
  properties: {
    varianter: { type: "array", items: { type: "string" } },
    osaker: { type: "boolean" },
  },
  required: ["varianter", "osaker"],
} as const;

const SYSTEM = [
  "Du är en möbelkännare som svarar kort och faktabaserat om en viss möbelmodell.",
  "Du får ett märke och ett modellnamn och ska svara med vilka VARIANTER modellen säljs eller såldes i.",
  "En variant är en storlek eller utförandeform som ändrar möbelns MÅTT: '2-sitssoffa', '3-sitssoffa',",
  "'fåtölj', 'divansoffa', 'hörnsoffa', 'fotpall', 'barstol 63 cm', 'barstol 75 cm'.",
  "Färger, klädslar och träslag är INTE varianter — de ändrar inte måtten. Ta aldrig med dem.",
  "Skriv varianterna på svenska, i den form en säljare känner igen dem, högst fyra ord per variant.",
  "Finns modellen bara i ett enda utförande: svara med exakt en variant.",
  "Känner du inte till modellen: svara med en tom lista och osaker = true. Gissa aldrig.",
].join(" ");

const MAX_VARIANTER = 8;
/** En månad. Sortimentet ändras långsamt, och en variantlista är inte en färskvara som ett pris. */
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;

export async function hamtaVarianter(brand: string | null, model: string): Promise<string[]> {
  const namn = [brand, model].filter(Boolean).join(" ").trim();
  if (!model.trim()) return [];
  try {
    const svar = await callGeminiStructured<{ varianter?: unknown; osaker?: unknown }>({
      purpose: "varianter",
      systemPrompt: SYSTEM,
      userPrompt: `Vilka varianter finns av ${namn}?`,
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
    return unika.slice(0, MAX_VARIANTER);
  } catch (err) {
    console.warn(`[varianter] ${namn}: kunde inte hämtas —`, err instanceof Error ? err.message : err);
    return [];
  }
}
