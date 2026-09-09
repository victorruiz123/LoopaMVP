import { callGeminiStructured, Type } from "./gemini.js";
import type { FurnitureIdentity, PriceEstimate } from "./types.js";

/**
 * Styckpriset på en stol.
 *
 * PROBLEMET ÄR I DATAN, inte i motorn. Stolar säljs sällan en och en: annonserna heter "4 st Stefan",
 * "6 pinnstolar" eller "matgrupp med sex stolar", och priset i dem är priset för HELA bunten.
 * Prismotorn läser utropspriser rakt av, så en enskild stol får en buntprislapp — och den säljare vi
 * sedan visar talet för tror att stolen är värd fyra gånger vad den är. Felet är systematiskt och
 * går bara åt ett håll: uppåt.
 *
 * Vi kan inte se det ur talet självt — 2 400 kr är ett rimligt tal både för en Lamino och för sex
 * IKEA-stolar. Det som avgör är vad MODELLEN är, och det är en fråga om omvärldskunskap: vad en
 * begagnad stol av det märket och den modellen brukar kosta styck. Därför frågas Gemini, och därför
 * får den märke och modellnamn — utan dem är frågan obesvarbar.
 *
 * Frågan är ställd så att svaret blir ett TAL och inte ett omdöme: är priset rimligt för en stol
 * svarar den 1, och är det ett buntpris svarar den vad det ska delas med. Divisorn är den siffra
 * annonserna bär — 2, 4, 6 — inte en fri korrigering, och den har ett tak: en modell vars pris är
 * tio gånger fel är inte en bunt utan fel modell, och det är inte den här funktionens sak att laga.
 *
 * BARA STOLAR. Soffor, bord och hyllor säljs styckvis och har inte problemet; att fråga om dem vore
 * ett extra modellanrop i prisvägen utan något att vinna.
 */

/**
 * Möbeltyper där buntannonser är regeln.
 *
 * Ingen ordgräns FÖRE stammen, med flit: motorns typer heter "barstol", "matstol", "kontorsstol",
 * och ett `\b` framför hade missat varenda sammansättning — alltså precis de stolar som säljs i set.
 */
const STOLORD = /stol(ar|en|arna)?\b/i;

/**
 * Taket för korrigeringen. Buntar är 2–8 stycken; ett svar över det är inte en bunt utan en modell
 * motorn läst fel, och att dela med tolv hade dolt det felet bakom ett trovärdigt tal.
 */
const MAX_DIVISOR = 8;

export interface StolPrisSvar {
  /** Är modellen över huvud taget en stol? Modellnamnet är inte alltid vad möbeltypen säger. */
  arStol: boolean;
  /** Vad priset ska delas med för att bli styckpris. 1 = priset är redan ett styckpris. */
  divisor: number;
  /** En mening till loggen och till prisnoten. */
  motivering: string;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    arStol: { type: Type.BOOLEAN, description: "true om modellen är en stol (matstol, pinnstol, barstol, kontorsstol, karmstol)" },
    divisor: { type: Type.NUMBER, description: "1 om priset är rimligt för EN stol, annars antalet stolar priset gäller (2, 4, 6 ...)" },
    motivering: { type: Type.STRING, description: "En kort mening på svenska om varför." },
  },
  required: ["arStol", "divisor", "motivering"],
};

const SYSTEM = `Du är möbelvärderare och kan andrahandsmarknaden för möbler i Sverige.

Du får ett märke, ett modellnamn och ett prisspann som räknats fram ur begagnatannonser. Din enda
uppgift är att avgöra om spannet gäller EN stol eller FLERA.

Bakgrunden: stolar annonseras nästan alltid i set — "4 st", "6 pinnstolar", "matgrupp med stolar" —
och priset i annonsen gäller hela setet. Ett spann som räknats ur sådana annonser är därför för högt
för den som ska sälja en enda stol.

Svara med en divisor:
- 1 om spannet redan är rimligt för en enskild stol av just den modellen.
- Annars antalet stolar priset rimligen gäller: 2, 4, 6 eller 8.

Utgå från vad EN begagnad stol av det märket och den modellen faktiskt kostar. En begagnad IKEA-stol
går för ett par hundra kronor; en Lamino eller en Series 7 för flera tusen — ett högt tal är alltså
inte i sig ett buntpris. Är du osäker, svara 1: att sänka ett riktigt pris är ett lika stort fel som
att låta ett buntpris stå.

Är modellen inte en stol: arStol = false och divisor = 1.`;

function rundaTill10(v: number): number {
  return Math.max(0, Math.round(v / 10) * 10);
}

/**
 * Frågar Gemini om prisspannet är ett styckpris, och delar det om det inte är det.
 *
 * Kastar aldrig. Priset är svaret säljaren väntar på, och ett modellanrop som faller ska ge det
 * ojusterade talet — samma avvägning som resten av prisvägen: hellre motorns siffra än ingen.
 */
export async function styckprisForStol(
  identity: FurnitureIdentity,
  estimate: PriceEstimate,
): Promise<PriceEstimate> {
  if (estimate.status !== "ok" || estimate.default === null) return estimate;

  try {
    const brand = identity.brand?.trim() || "okänt märke";
    const model = identity.model.trim();
    const { data } = await callGeminiStructured<StolPrisSvar>({
      purpose: "stol_styckpris",
      systemPrompt: SYSTEM,
      userPrompt: [
        `Märke: ${brand}`,
        `Modell: ${model}`,
        `Prisspann ur annonserna: ${estimate.low ?? "?"}–${estimate.high ?? "?"} kr, mittvärde ${estimate.default} kr.`,
        `Baserat på ${estimate.matchCount} annonser.`,
        "Gäller det spannet en enda stol, eller flera?",
      ].join("\n"),
      images: [],
      responseSchema: SCHEMA,
      resolution: "low",
    });

    if (!data.arStol) return estimate;
    const divisor = Math.round(Number(data.divisor));
    if (!Number.isFinite(divisor) || divisor <= 1) return estimate;
    if (divisor > MAX_DIVISOR) {
      console.warn(`[pris] stol ${brand} ${model}: divisor ${divisor} över taket ${MAX_DIVISOR} — priset lämnas orört`);
      return estimate;
    }

    console.info(`[pris] stol ${brand} ${model}: ${estimate.default} kr / ${divisor} — ${data.motivering}`);
    const note = `Priset i annonserna gäller ${divisor} stolar; talet här är för en (delat med ${divisor}).`;
    return {
      ...estimate,
      low: estimate.low === null ? null : rundaTill10(estimate.low / divisor),
      default: rundaTill10(estimate.default / divisor),
      high: estimate.high === null ? null : rundaTill10(estimate.high / divisor),
      note: [estimate.note, note].filter(Boolean).join(" "),
      styckDivisor: divisor,
    };
  } catch (err) {
    console.warn(`[pris] styckpriskontrollen föll — priset lämnas orört: ${err instanceof Error ? err.message : String(err)}`);
    return estimate;
  }
}

/**
 * Är det här en stol?
 *
 * Två källor, och motorns egen går först: `variant` är den möbeltyp den faktiskt filtrerade
 * annonserna på, alltså ett svar och inte en gissning. Saknas den läses modellsträngen — "Stefan"
 * säger ingenting, men "IKEA barstol" gör det, och säljarens egen text är det enda som finns kvar.
 * Gemini avgör ändå frågan slutgiltigt (`arStol`); det här är bara filtret som avgör om den ska
 * frågas alls.
 */
export function kanVaraStol(identity: FurnitureIdentity, variant: string[] | null): boolean {
  if (variant?.length) return variant.some((v) => STOLORD.test(v));
  return STOLORD.test(`${identity.brand ?? ""} ${identity.model}`);
}
