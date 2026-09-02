/**
 * Den preliminära bedömningen — vad vi kan säga om en möbel vi bara sett i någon annans annons.
 *
 * VARFÖR INTE PIPELINEN. Säljflödets besiktning (pipeline/run.ts) är byggd för ett filmat varv:
 * kända vinklar, kontrollerat ljus, närbilder på det den själv pekat ut. Den producerar ett BETYG
 * som Loopa går i god för. Annonsbilder är motsatsen — två till åtta bilder någon annan valt, ofta
 * i motljus, ibland tillverkarens katalogbilder. Att köra samma pipeline på dem hade gett ett svar
 * som SER ut som ett attest men inte kan vara ett, och det är precis den förväxlingen hela produkten
 * står och faller med.
 *
 * Det här är därför ett eget, mindre anrop med ett eget språk: iakttagelser i stället för fynd,
 * uppskattning i stället för betyg, och en `confidence` som gränssnittet måste visa. Det riktiga
 * betyget kommer när säljaren filmar (steg 3), och då ersätter det det här.
 *
 * VAD KÖPAREN FAKTISKT BEHÖVER, och varför frågorna är med: en preliminär bedömning som bara säger
 * "ser bra ut" är värdelös. Det som gör den användbar är att den pekar ut vad bilderna INTE visar —
 * det är de frågorna köparen ska ställa innan de lägger ett bud.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import { estimatePrice } from "../pricing.js";
import { resolveCategorySlug } from "../butik/catalog.js";
import { submissionDir } from "./store.js";
import type { ConditionGrade } from "../types.js";
import type { AdSubmission, PreliminaryAssessment } from "./types.js";

const GRADES: ConditionGrade[] = ["A", "B", "C", "D", "E", "F"];

const SYSTEM_PROMPT = `Du bedömer en begagnad möbel som någon säljer i en annons, åt en KÖPARE som
funderar på att köpa den. Du ser bara annonsens egna bilder och text — du har inte sett möbeln.

DIN ROLL ÄR ATT VARA KÖPARENS ÖGON, INTE SÄLJARENS. Du ska hjälpa någon att undvika ett dåligt köp.

VAD DU FÅR PÅSTÅ:
- Vad möbeln troligen är (märke, modell, kategori) — men bara när bilderna eller texten ger stöd.

LÄS ANNONSTEXTEN EFTER MODELLNAMN. Säljare skriver nästan alltid ut modellen: "IKEA EKTORP 3-sits",
"Swedese Lamino", "NORDVIKEN barstol". Står ett modellnamn i texten SKA det med i fältet "model",
även om du inte kan se det på bilderna — det är säljarens egen uppgift om sin möbel och den mest
tillförlitliga vi har. Skriv modellen ensam ("EKTORP"), utan märket och utan storleken.
Bara när texten och bilderna INTE ger något modellnamn lämnar du fältet tomt.
- Vad du SER i bilderna: slitage, fläckar, märken, skador. Formulera som iakttagelser
  ("ser ut att ha", "syns ett märke på"), aldrig som konstateranden.
- Hur säker du är. Var ärlig: två suddiga bilder ger låg säkerhet, åtta skarpa ger hög.

VAD DU INTE FÅR GÖRA:
- Aldrig påstå att möbeln är hel eller felfri. Att inte se en skada är inte att se att den saknas —
  och en annonsbild är vald av säljaren, ofta just för att skadan inte syns.
- Aldrig hitta på ett märke eller en modell för att fältet ska bli ifyllt. Utelämna hellre.

FRÅGOR ATT STÄLLA SÄLJAREN är det viktigaste du producerar. De ska handla om det bilderna INTE
visar: vinklar som saknas, delar som är skymda, sådant som brukar gå sönder på just den möbeltypen,
och sådant en bild aldrig kan visa (lukt, gnissel, om den stått i rök eller sol). Konkreta frågor
som går att skicka som de är. Aldrig frågor som bilderna redan besvarar.

VARNINGSFLAGGOR — sätt bara när du har grund:
- Bilderna ser ut att vara tillverkarens katalogbilder, inte foton på den möbel som säljs
  (vit studiobakgrund, perfekt ljus, inget rum omkring).
- Samma möbel fotograferad ur exakt samma vinkel i alla bilder, som om något döljs.
- Bilderna visar en annan möbel än beskrivningen påstår.
Skriv varningarna på svenska, riktade till köparen.

Svara på svenska.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    brand: { type: Type.STRING, description: "Märke, eller tomt om du inte kan se det." },
    model: { type: Type.STRING, description: "Modellnamn, eller tomt." },
    kategori: { type: Type.STRING, description: "Möbeltyp på svenska: soffa, fåtölj, matbord, barstol …" },
    skick: { type: Type.STRING, description: "Ett betyg A–F. A=nyskick, B=mycket bra, C=bra, D=synligt slitage, E=slitet, F=defekt." },
    skickmotivering: { type: Type.STRING, description: "En eller två meningar om vad bilderna visar. Med förbehåll." },
    iakttagelser: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Det du ser. Som iakttagelser, inte konstateranden." },
    sakerhet: { type: Type.STRING, description: "low, medium eller high — hur mycket bilderna faktiskt räcker till." },
    fragor: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Frågor köparen bör ställa säljaren, färdiga att skicka." },
    varningar: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Varningsflaggor, bara med grund." },
  },
} as const;

interface RawAssessment {
  brand?: string;
  model?: string;
  kategori?: string;
  skick?: string;
  skickmotivering?: string;
  iakttagelser?: string[];
  sakerhet?: string;
  fragor?: string[];
  varningar?: string[];
}

function cleanList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string" && s.trim().length > 2 && s.length < 300)
    .map((s) => s.trim())
    .slice(0, max);
}

function cleanText(v: unknown, max = 120): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.length <= max ? s : null;
}

/**
 * Bedömningen av en inlämnad annons.
 *
 * Faller modellanropet returneras en bedömning som SÄGER att den inte kunde göras, i stället för
 * null. Köparen har lagt ner arbete på att ladda upp bilder, och affärsrummet ska gå att skapa ändå
 * — bedömningen är en hjälp, inte en grind.
 */
export async function assessSubmission(
  dealId: string,
  submission: AdSubmission,
): Promise<PreliminaryAssessment> {
  const empty: PreliminaryAssessment = {
    brand: null, model: null, categorySlug: null, categoryNoun: null, grade: null,
    gradeNote: "Vi kunde inte göra en bedömning av annonsens bilder den här gången.",
    observations: [], confidence: "low",
    marketLowSek: null, marketHighSek: null,
    questions: [
      "Kan du skicka fler bilder, gärna rakt framifrån och på baksidan?",
      "Finns det märken, fläckar eller skador som inte syns på bilderna?",
      "Hur gammal är möbeln och har den stått i solljus eller rökig miljö?",
    ],
    redFlags: [],
    assessedAt: new Date().toISOString(),
  };

  const images: ImagePart[] = [];
  for (const rel of submission.imagePaths) {
    try {
      const buf = await readFile(path.join(submissionDir(dealId), rel));
      images.push({ mimeType: "image/jpeg", base64: buf.toString("base64") });
    } catch {
      // En bild som försvunnit ska inte fälla bedömningen av de andra.
    }
  }
  if (images.length === 0 && !submission.description) return empty;

  const context = [
    submission.description ? `ANNONSENS TEXT:\n${submission.description}` : null,
    submission.askingPriceSek ? `BEGÄRT PRIS: ${submission.askingPriceSek} kr` : null,
    `ANTAL BILDER: ${images.length}`,
  ].filter(Boolean).join("\n\n");

  let raw: RawAssessment;
  try {
    const result = await callGeminiStructured<RawAssessment>({
      purpose: "affar_preliminar",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: context || "Bedöm möbeln på bilderna.",
      images,
      responseSchema: SCHEMA,
      // Skador i en annonsbild är små och suddiga nog ändå — en nedskalning till här hade gjort
      // bedömningen till en gissning om färg och form.
      resolution: "high",
      primaryTimeoutMs: 40_000,
      /**
       * Bedömningen cachas i ett dygn, inte för alltid.
       *
       * Samma skäl som butikens AI-sökning: modellen varierar mellan körningar, och en enstaka tunn
       * bedömning ska inte frysas som svaret på just den annonsen. Två köpare som lämnar in samma
       * annons samma dag delar däremot anrop, vilket är precis vad cachen är till för.
       */
      cacheMaxAgeMs: 24 * 60 * 60 * 1000,
    });
    raw = result.data;
  } catch (err) {
    console.warn(`[affär] preliminär bedömning föll för ${dealId}:`, err instanceof Error ? err.message : err);
    return empty;
  }

  const brand = cleanText(raw.brand, 60);
  const model = cleanText(raw.model, 80);
  const kategori = cleanText(raw.kategori, 60);
  const confidence = ["low", "medium", "high"].includes(raw.sakerhet ?? "")
    ? (raw.sakerhet as "low" | "medium" | "high")
    : "low";

  /**
   * Ett betyg kräver att modellen faktiskt sett tillräckligt.
   *
   * Mätt på en skarp bild: en beskuren närbild på ett armstöd gav "D — synligt slitage" med låg
   * säkerhet och en motivering som sade rakt ut att helheten inte gick att bedöma. Betyget är ändå
   * det som fastnar hos en läsare, och ett D på en möbel vi inte sett kan sänka en säljares
   * prisförväntan på ett underlag som inte bär det.
   *
   * Vid låg säkerhet visas därför motiveringen och frågorna, men inget betyg. Det är inte att dölja
   * något — det är att låta bli att påstå det underlaget inte räcker till. Samma regel som gäller
   * i pipelinen: hellre inget värde än ett trovärdigt fel.
   */
  const claimed = GRADES.includes((raw.skick ?? "").toUpperCase() as ConditionGrade)
    ? ((raw.skick ?? "").toUpperCase() as ConditionGrade)
    : null;
  const grade = confidence === "low" ? null : claimed;

  /**
   * Marknadsvärdet hämtas ur samma prismotor som säljflödet.
   *
   * Utan skador i anropet: motorn tar en lista med fynd, och vi HAR inga fynd — vi har iakttagelser
   * ur någon annans bilder. Att mata in dem som skador hade gett ett avdrag med en precision
   * underlaget inte har. Spannet blir därför för möbeln i det uppskattade skicket, och det är också
   * så det ska läsas: ett spann, inte ett pris.
   */
  let marketLowSek: number | null = null;
  let marketHighSek: number | null = null;
  /**
   * Priset kräver en MODELL, inte bara ett märke.
   *
   * Här stod `model ?? brand` som reservvärde, vilket lät motorn söka på "IKEA" och matcha allt de
   * någonsin sålt: spannet blev 300–4 250 kr. Ett så brett spann säger ingenting men LÄSER som en
   * uppgift, och köparen jämför sitt begärda pris mot det. Prismotorn söker på modellnamn i en
   * annonskorpus (se pricing.ts) — utan modell finns inget att söka efter, och då är rätt svar att
   * vi inte vet.
   */
  if (model) {
    try {
      const price = await estimatePrice({ brand, model }, [], gradeToCanonical(grade), images[0]?.base64 ?? null);
      if (price?.status === "ok" && price.low !== null && price.high !== null && usableRange(price.low, price.high, price.matchCount)) {
        marketLowSek = price.low;
        marketHighSek = price.high;
      }
    } catch (err) {
      console.warn(`[affär] prismotorn svarade inte för ${dealId}:`, err instanceof Error ? err.message : err);
    }
  }

  const redFlags = cleanList(raw.varningar, 4);
  // En egen varning, räknad och inte bedömd: ett begärt pris långt under marknadens undre kant är
  // det klassiska tecknet på en annons som inte är vad den utger sig för.
  if (submission.askingPriceSek && marketLowSek && submission.askingPriceSek < marketLowSek * 0.4) {
    redFlags.unshift(
      `Det begärda priset (${submission.askingPriceSek} kr) är påfallande lågt jämfört med vad möbeln brukar säljas för. Var extra noga med att kontrollera att annonsen är äkta.`,
    );
  }

  return {
    brand,
    model,
    categorySlug: kategori ? resolveCategorySlug({ type: kategori, title: model ?? undefined }) : null,
    // Modellens eget ord, i singular och gemener. Det är det som hamnar i meddelandet till säljaren.
    categoryNoun: kategori ? kategori.toLowerCase() : null,
    grade,
    gradeNote: cleanText(raw.skickmotivering, 400) ?? empty.gradeNote,
    observations: cleanList(raw.iakttagelser, 8),
    confidence,
    marketLowSek,
    marketHighSek,
    questions: cleanList(raw.fragor, 6).length ? cleanList(raw.fragor, 6) : empty.questions,
    redFlags,
    assessedAt: new Date().toISOString(),
  };
}

/**
 * Duger spannet som "marknadsvärde"?
 *
 * Två grindar, båda mot samma sak: ett tal som ser ut som en uppgift men är en gissning.
 *
 * BREDDEN: ett spann där den övre kanten är mer än fem gånger den undre beskriver inte en modell,
 * det beskriver en kategori. Köparen jämför sitt begärda pris mot spannet, och ett pris ligger
 * alltid "inom" 300–4 250.
 *
 * UNDERLAGET: motorn räknar på jämförbara annonser, och tre är det minsta antal där ett spann är en
 * observation snarare än ett sammanträffande.
 */
function usableRange(low: number, high: number, matchCount: number): boolean {
  if (matchCount < 3) return false;
  if (low <= 0) return false;
  return high / low <= 5;
}

/** Betyg -> prismotorns skickterm. Samma skala som grade.ts, uttryckt som motorn väntar sig den. */
function gradeToCanonical(grade: ConditionGrade | null): string | null {
  switch (grade) {
    case "A": return "Nyskick";
    case "B": return "Mycket bra skick";
    case "C": return "Bra skick";
    case "D":
    case "E":
    case "F": return "Okej skick";
    default: return null;
  }
}

/**
 * Hur det begärda priset står sig.
 *
 * Egen funktion för att både köparens vy och prisförhandlingen i steg 4 ska läsa samma dom. Två
 * uträkningar av "är det här dyrt?" blir två svar den dagen någon justerar den ena.
 */
export function priceVerdict(
  askingPriceSek: number | null,
  low: number | null,
  high: number | null,
): { verdict: "under" | "inom" | "over" | "okant"; text: string } {
  if (askingPriceSek === null || low === null || high === null) {
    return { verdict: "okant", text: "Vi har inget marknadsvärde att jämföra med för den här modellen." };
  }
  const kr = (n: number) => `${n.toLocaleString("sv-SE")} kr`;
  if (askingPriceSek < low) {
    return { verdict: "under", text: `Begärt: ${kr(askingPriceSek)}. Marknadsvärde: ${kr(low)}–${kr(high)}. Priset ligger under spannet.` };
  }
  if (askingPriceSek > high) {
    return { verdict: "over", text: `Begärt: ${kr(askingPriceSek)}. Marknadsvärde: ${kr(low)}–${kr(high)}. Priset ligger över spannet.` };
  }
  return { verdict: "inom", text: `Begärt: ${kr(askingPriceSek)}. Marknadsvärde: ${kr(low)}–${kr(high)}. Priset ligger inom spannet.` };
}
