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
 * Tre källor, och INGEN av dem får rösta ner de andra. Prismotorns `variant` är typen den faktiskt
 * filtrerade annonserna på, kandidatens `productType` är typen säljaren pekade ut, och
 * modellsträngen är det som finns kvar när båda saknas ("Stefan" säger ingenting, "IKEA barstol"
 * säger allt). Säger någon av dem "stol" räcker det.
 *
 * DET HÄR VAR FELET bakom stolar som fick ett buntpris rakt i ansiktet. Varianten läses först och
 * fick tidigare sista ordet: fanns den och saknade ordet "stol" — motorn kan ha filtrerat på
 * "matgrupp", eller på ingenting alls — returnerades false, och styckpriskontrollen hoppades över
 * helt. Samtidigt hade `finalizeWithModel` redan sagt ja på kandidatens möbeltyp och frågat
 * säljaren hur många stolar de har. Resultatet blev det värsta av två: buntpriset ur korpusen
 * ALDRIG delat, och sedan gångat med säljarens antal.
 *
 * Ett falskt ja kostar ett Gemini-anrop som svarar `arStol: false`, och där tar det slut. Ett falskt
 * nej kostar säljaren ett pris som är flera gånger fel. Filtret ska luta åt att fråga.
 */
export function kanVaraStol(identity: FurnitureIdentity, variant: string[] | null, productType?: string | null): boolean {
  if (variant?.some((v) => STOLORD.test(v))) return true;
  if (productType?.trim() && STOLORD.test(productType)) return true;
  return STOLORD.test(`${identity.brand ?? ""} ${identity.model}`);
}

/* ==========================================================================
   Antalet stolar — säljarens svar, och vad bunten är värd
   ========================================================================== */

/**
 * Taket för hur många stolar en säljare kan säga sig ha.
 *
 * Inte en teknisk gräns utan en trolighetsgräns: matgrupper går till tolv, och ett tal över det är
 * nästan alltid en felskrivning — och en felskrivning som tjugofaldigar priset är värre än en fråga
 * som måste ställas om.
 */
export const MAX_ANTAL_STOLAR = 12;

/**
 * Hur långt bort från "antal × styckpris" en bunt får hamna.
 *
 * Nedåt finns mängdrabatten: sex stolar säljs sällan för sex gånger vad en kostar, för köparskaran
 * som vill ha sex krymper med varje stol. Uppåt finns det motsatta och sällsyntare: ett komplett,
 * matchande set av en eftertraktad modell är värt mer än sina delar, för det går inte att sätta
 * ihop i efterhand. Bortom de gränserna är det inte längre en buntjustering utan ett annat pris,
 * och då är motorns tal ärligare än modellens.
 */
const MIN_FAKTOR = 0.6;
const MAX_FAKTOR = 1.2;

export interface BuntPrisSvar {
  /** Vad `antal × styckpris` ska multipliceras med. 1 = bunten är värd precis summan av delarna. */
  faktor: number;
  /** En mening till loggen och till prisnoten. */
  motivering: string;
}

const BUNT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    faktor: {
      type: Type.NUMBER,
      description: "Multiplikator på antal × styckpris. Under 1 = mängdrabatt, över 1 = setpremie, 1 = summan av delarna.",
    },
    motivering: { type: Type.STRING, description: "En kort mening på svenska om varför." },
  },
  required: ["faktor", "motivering"],
};

const BUNT_SYSTEM = `Du är möbelvärderare och kan andrahandsmarknaden för möbler i Sverige.

Du får ett märke, ett modellnamn, priset för EN begagnad stol av den modellen, och hur många stolar
säljaren säljer tillsammans. Din enda uppgift är att avgöra vad HELA bunten är värd jämfört med
antalet gånger styckpriset.

Svara med en faktor:
- Under 1 när bunten är värd mindre än summan av delarna. Det är det vanliga: köparskaran som vill
  ha sex stolar är mycket mindre än den som vill ha två, och säljaren tar ett avdrag för att slippa
  sälja dem en och en.
- 1 när antal × styckpris är rätt tal.
- Över 1 bara när ett KOMPLETT, MATCHANDE set av just den modellen är eftertraktat och svårt att
  sätta ihop i efterhand — sex likadana designstolar med samma slitage och samma klädsel.

Väg in modellen. Ett set IKEA-stolar är en transport och en mängdrabatt; sex Series 7 eller sex
pinnstolar i originalskick är ett fynd som köpare letar efter i åratal.

Är du osäker, svara 1. Ett påhittat avdrag kostar säljaren pengar, och en påhittad premie gör att
annonsen inte säljer.`;

/**
 * Skalar ett styckpris till ett buntpris. Ren räkning, ingen modell — så den går att pröva.
 *
 * `default` bär faktorn; spannets ändar följer med samma multiplikator, för de är samma pris sett
 * ur olika brådska och inte olika möbler.
 */
export function skalaTillAntal(estimate: PriceEstimate, antal: number, faktor: number): PriceEstimate {
  const skala = antal * faktor;
  return {
    ...estimate,
    low: estimate.low === null ? null : rundaTill10(estimate.low * skala),
    default: estimate.default === null ? null : rundaTill10(estimate.default * skala),
    high: estimate.high === null ? null : rundaTill10(estimate.high * skala),
    stolAntal: antal,
    styckPris: estimate.default,
  };
}

/**
 * Är faktorn användbar? Ett svar utanför spannet är inte en justering utan ett annat pris.
 */
export function rimligFaktor(varde: unknown): number | null {
  const faktor = Number(varde);
  if (!Number.isFinite(faktor)) return null;
  if (faktor < MIN_FAKTOR || faktor > MAX_FAKTOR) return null;
  return faktor;
}

/**
 * Priset för de stolar säljaren faktiskt säljer.
 *
 * VARFÖR DET INTE RÄCKER ATT GÅNGA. Styckpriset ovan är framräknat just för att en enskild stol
 * inte ska bära en buntprislapp. Men den säljare som har sex stolar säljer sex, och sex gånger
 * styckpriset är lika systematiskt fel åt andra hållet: bunten säljs nästan alltid med rabatt, och
 * ibland — ett komplett set av rätt modell — med premie. Vilket av dem det är går inte att räkna
 * fram ur talet, bara att veta om modellen. Därför frågas Gemini, och därför får den både modellen
 * och antalet.
 *
 * Kastar aldrig. Faller anropet gånges priset rakt av: ett tal som är rätt storleksordning slår ett
 * styckpris på en annons för sex stolar.
 */
export async function prisForAntalStolar(
  identity: FurnitureIdentity,
  estimate: PriceEstimate,
  antal: number,
): Promise<PriceEstimate> {
  if (estimate.status !== "ok" || estimate.default === null) return estimate;
  if (!Number.isInteger(antal) || antal < 1 || antal > MAX_ANTAL_STOLAR) return estimate;
  // En stol är ingen bunt. Styckpriset är redan svaret, och ett modellanrop som svarar "faktor 1"
  // är en sekund och en kostnad för ingenting.
  if (antal === 1) return { ...estimate, stolAntal: 1, styckPris: estimate.default };

  const brand = identity.brand?.trim() || "okänt märke";
  const model = identity.model.trim();

  try {
    const { data } = await callGeminiStructured<BuntPrisSvar>({
      purpose: "stol_buntpris",
      systemPrompt: BUNT_SYSTEM,
      userPrompt: [
        `Märke: ${brand}`,
        `Modell: ${model}`,
        `Styckpris för en begagnad stol i det här skicket: ${estimate.default} kr.`,
        `Säljaren säljer ${antal} stolar tillsammans.`,
        `Vad är bunten värd jämfört med ${antal} × ${estimate.default} kr?`,
      ].join("\n"),
      images: [],
      responseSchema: BUNT_SCHEMA,
      resolution: "low",
    });

    const faktor = rimligFaktor(data.faktor);
    if (faktor === null) {
      console.warn(
        `[pris] bunt ${brand} ${model} ×${antal}: faktor ${data.faktor} utanför ${MIN_FAKTOR}–${MAX_FAKTOR} — priset gångas rakt av`,
      );
      return medNot(skalaTillAntal(estimate, antal, 1), antal, estimate.default);
    }

    console.info(`[pris] bunt ${brand} ${model} ×${antal}: faktor ${faktor} — ${data.motivering}`);
    return medNot(skalaTillAntal(estimate, antal, faktor), antal, estimate.default, data.motivering);
  } catch (err) {
    console.warn(`[pris] buntpriset föll — ${antal} × styckpriset används: ${err instanceof Error ? err.message : String(err)}`);
    return medNot(skalaTillAntal(estimate, antal, 1), antal, estimate.default);
  }
}

/**
 * Prisnoten säger vad talet gäller.
 *
 * Utan den läser en säljare med sex stolar talet som ett styckpris och undrar varför det är sex
 * gånger för högt. Styckpriset skrivs alltid ut med: det är det enda sättet att se att bunten
 * räknats och inte gissats.
 */
function medNot(estimate: PriceEstimate, antal: number, styck: number | null, motivering?: string): PriceEstimate {
  const not = `Priset gäller alla ${antal} stolarna${styck === null ? "" : ` (styckpris ${styck} kr)`}.${
    motivering ? ` ${motivering}` : ""
  }`;
  return { ...estimate, note: [estimate.note, not].filter(Boolean).join(" ") };
}
