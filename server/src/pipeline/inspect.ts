import path from "node:path";
import { callGeminiStructured, Type, type ImagePart } from "../gemini.js";
import { loadImageAsBase64 } from "../imageUtils.js";
import type {
  AffectedExtent,
  PartInspection,
  CallMeta,
  CapturedImage,
  CoverageState,
  Damage,
  DamageType,
  EvidenceMark,
  Impact,
  OverallCondition,
  Severity,
  WearLevel,
} from "../types.js";

export const DAMAGE_TYPES: DamageType[] = [
  "scratch", "scuff", "abrasion", "chip", "dent", "crack", "tear", "hole",
  "stain", "discoloration", "fading", "rust", "corrosion",
  "pilling", "worn_material", "fraying", "compressed_upholstery", "peeling_flaking",
  "deformation", "loose_component", "broken_component", "missing_part", "sagging", "structural_damage",
  "general_wear", "other",
];

const WEAR_LEVELS: WearLevel[] = ["minimal", "light", "moderate", "heavy", "severe"];
const EXTENTS: AffectedExtent[] = ["isolated", "moderate", "widespread"];

/** The defect object shape, shared with the review pass so a newly found defect is identical in form. */
export const DEFECT_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: DAMAGE_TYPES },
    part: { type: Type.STRING, description: "Möbeldel, på svenska, t.ex. 'vänster armstöd', 'sitsens ovansida'." },
    semantic_location: { type: Type.STRING, description: "Finare läge inom delen, på svenska, t.ex. 'främre kanten', 'nedre vänstra hörnet'." },
    severity: { type: Type.STRING, enum: ["S1", "S2", "S3", "S4"] },
    impact: { type: Type.STRING, enum: ["cosmetic", "functional", "structural"] },
    description: {
      type: Type.STRING,
      description:
        "Kort, konkret visuellt bevis på svenska. Mörk yta: 'Ljus linjär repa som bryter den mörka ytfinishen.' Ljus yta: 'Gråaktigt skavmärke där den vita färgen nötts bort på benets överkant.' Inget mer.",
    },
    confidence: {
      type: Type.NUMBER,
      description:
        "0-100: hur säkert det är att detta är verklig fysisk skada och inte en bildartefakt. Under 65 skickas fyndet vidare till en andra granskning, så använd låga värden fritt i stället för att utelämna ett fynd.",
    },
    evidence: {
      type: Type.ARRAY,
      description: "One entry per image where THIS SAME physical defect is visible.",
      items: {
        type: Type.OBJECT,
        properties: {
          image_index: { type: Type.INTEGER, description: "0-based index into the supplied images." },
          mark_kind: {
            type: Type.STRING,
            enum: ["box", "line"],
            description:
              "Rutan ska TÄTT omsluta den synliga skadan, inte ett allmänt område av möbeln. Går det inte att placera en ruta som faktiskt innehåller något synligt avvikande, ska fyndet inte rapporteras alls.",
          },
          x: { type: Type.NUMBER, description: "normalized 0-1" },
          y: { type: Type.NUMBER, description: "normalized 0-1" },
          w: { type: Type.NUMBER, description: "box only" },
          h: { type: Type.NUMBER, description: "box only" },
          x2: { type: Type.NUMBER, description: "line only" },
          y2: { type: Type.NUMBER, description: "line only" },
        },
        required: ["image_index", "mark_kind", "x", "y"],
      },
    },
  },
  required: ["type", "part", "semantic_location", "severity", "impact", "description", "confidence", "evidence"],
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    furniture_type: { type: Type.STRING, description: "e.g. 'stol', 'soffa'" },
    inspection_coverage: {
      type: Type.STRING,
      enum: ["INSPECTED_CLEAR", "INSPECTED_DAMAGE", "NOT_SUFFICIENTLY_VISIBLE"],
      description: "NOT_SUFFICIENTLY_VISIBLE only if large parts of the furniture were never clearly visible in ANY image. Never use this just because damage was found.",
    },
    coverage_note: { type: Type.STRING, description: "One sentence if coverage is insufficient (which side/part), else empty string." },
    defects: {
      type: Type.ARRAY,
      description:
        "Uttömmande lista över VARJE distinkt fysisk defekt, inklusive svaga och osäkra — uttryck tvivel med låg confidence, aldrig genom att utelämna. En använd möbel har ofta 6-15 poster här, och färre än 5 betyder ofta att du slutat leta för tidigt. Men det är en FÖRVÄNTAN, aldrig en kvot: en välhållen möbel har legitimt få poster, och en kort lista är alltid rätt svar jämfört med att fylla ut den med ytor där du inte kan peka på något synligt. Varje post måste svara på frågan: vad skiljer just det här stället från ytan runt omkring? Kan du inte svara, hör posten inte hemma i listan. Samma fysiska defekt i flera bilder ska vara EN post med flera evidence-rader, aldrig separata defekter.",
      items: DEFECT_ITEM_SCHEMA,

    },
    parts_inspected: {
      type: Type.ARRAY,
      description:
        "Redovisning av svepet: EN rad per möbeldel du granskat, ÄVEN delar helt utan skador. Varje ben, fot och stolpe var för sig. En del som saknas här räknas som ogranskad.",
      items: {
        type: Type.OBJECT,
        properties: {
          part: { type: Type.STRING, description: "Möbeldel på svenska, varje ben för sig: 'vänster framben', 'höger bakben'." },
          visible: { type: Type.BOOLEAN, description: "false om delen aldrig syns tydligt i någon bild." },
          defects_found: { type: Type.INTEGER, description: "Antal defekter du rapporterat på just denna del i defects-listan." },
        },
        required: ["part", "visible", "defects_found"],
      },
    },
    overall_condition: {
      type: Type.OBJECT,
      description: "Holistic visual impression across ALL images, independent of the individual defects list above.",
      properties: {
        overall_wear_level: { type: Type.STRING, enum: WEAR_LEVELS },
        affected_extent: { type: Type.STRING, enum: EXTENTS },
        functionality_affected: { type: Type.BOOLEAN },
        structural_integrity_ok: { type: Type.BOOLEAN },
        clearly_used_appearance: { type: Type.BOOLEAN },
        observations: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Short phrases, Swedish, e.g. 'blekt tyg på armstöd', 'repor spridda över sitsen'.",
        },
      },
      required: ["overall_wear_level", "affected_extent", "functionality_affected", "structural_integrity_ok", "clearly_used_appearance", "observations"],
    },
  },
  required: ["furniture_type", "inspection_coverage", "coverage_note", "defects", "parts_inspected", "overall_condition"],
};

interface RawEvidence {
  image_index: number;
  mark_kind: "box" | "line";
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
}

export interface RawDefect {
  type: DamageType;
  part: string;
  semantic_location: string;
  severity: Severity;
  impact: Impact;
  description: string;
  confidence: number;
  evidence: RawEvidence[];
}

interface RawOverallCondition {
  overall_wear_level: WearLevel;
  affected_extent: AffectedExtent;
  functionality_affected: boolean;
  structural_integrity_ok: boolean;
  clearly_used_appearance: boolean;
  observations: string[];
}

interface RawPartInspection {
  part: string;
  visible: boolean;
  defects_found: number;
}

interface RawInspectionResponse {
  furniture_type: string;
  inspection_coverage: CoverageState;
  coverage_note: string;
  defects: RawDefect[];
  parts_inspected: RawPartInspection[];
  overall_condition: RawOverallCondition;
}

const TAXONOMY_BLOCK = `SKADEFAMILJER att systematiskt gå igenom:

Ytskador: scratch (repa), scuff (skrapmärke), abrasion (nötning), chip (flisa/spån ur ytan), dent (buckla),
crack (spricka), tear (reva), hole (hål)

Färg/finish: stain (fläck), discoloration (missfärgning), fading (blekning), rust (rost), corrosion (korrosion)
— peeling_flaking täcker även färg-/lackförlust och flagnande finish.

Materialslitage: pilling (nopprighet), worn_material (slitet material, nötta kanter), fraying (fransning),
compressed_upholstery (nertryckt/plattad stoppning), peeling_flaking (flagnande/bubblande yta)

Form/struktur: deformation, loose_component (lös komponent), broken_component (trasig komponent),
missing_part (saknad del), sagging (nedsjunken), structural_damage (strukturell skada)

Allmänt: general_wear (lokalt slitage du KAN SE och beskriva, men som inte passar någon annan kategori)
— den är INTE en platshållare för "den här ytan är nog använd". Kan du inte säga vad som skiljer just
det stället från ytan runt omkring, finns det inget fynd att rapportera. other (annat)`;

const SOFT_WEAR_CUES = `VISUELLA KÄNNETECKEN för det slitage som oftast missas på stoppade möbler. Det här är
inte extra kategorier utan hur man SER dem:

NEDSUTTEN STOPPNING (compressed_upholstery) — det avgörande kännetecknet är att TYGET INTE ÄR SLÄTT OCH
RAKT. Leta efter veck, rynkor och skrynklor i sittytan, en sits som buktar nedåt eller är ojämn i höjd,
och dynor som tappat sin fyllighet. Jämför: sitsens mitt mot dess kanter, den använda sitsen mot ryggstöd
eller andra ytor som ingen suttit på, och på en soffa sittplatserna mot varandra. Är den ena slät och
spänd och den andra veckad och insjunken är det nedsuttenhet — inte tygets normala drapering.

NEDSJUNKEN (sagging) — hela sitsen eller ryggen hänger lägre än sin ram, alltså inte bara veckad utan
faktiskt sjunken under konstruktionens linje.

MISSFÄRGNING (discoloration / stain / fading) — ojämn färg över en yta som borde vara enfärgad. Mörkare
partier där kroppen haft kontakt: nackstödets höjd, armstödens ovansidor, sitsens mitt. Ljusare partier
från sol. En fläck har en avgränsad kant, en missfärgning tonar ut — rapportera båda, och välj stain när
kanten är tydlig och discoloration när den inte är det.

BLANKSLITNING OCH NÖTNING (worn_material) — fibrer som ligger nedtryckta och glansiga i stället för
uppresta och matta, typiskt på armstödens ovansidor och sitsens framkant.

NOPPRIGHET (pilling) — små fiberbollar och luddig yta, syns tydligast längs tygets kanter och sömmar.

Slitage samlas där kroppen tar i: sitsens mitt och framkant, armstödens ovansidor, nackstödets höjd.
Titta där först och särskilt noga.

HUR EN SKADA SYNS BEROR PÅ YTANS FÄRG. På mörka ytor framträder repor och nötning som LJUSARE märken —
det är det lättaste fallet. På ljusa och målade ytor är det tvärtom: skadan syns som MÖRKARE partier,
gråaktiga skavmärken, blottat underlag under färgen, eller avslagen färg vid kanter och ändar. En vit
möbel som ser fläckfri ut på avstånd har nästan alltid gråa skav vid kanter, hörn och benändar. Leta
efter BÅDA polariteterna — inte bara ljust mot mörkt.`;

const SYSTEM_PROMPT = `Du är en mycket noggrann möbelbesiktare för en svensk secondhandmarknad (Vips). Du agerar
som en SYSTEMATISK BESIKTNINGSPROTOKOLL — inte en generell bildbeskrivare.

Du får flera bilder av SAMMA möbel, tagna från olika håll (video-vyer och/eller manuellt tagna foton,
i den ordning de listas). Vissa bilder kan visa samma yta från olika vinklar.

${TAXONOMY_BLOCK}

${SOFT_WEAR_CUES}

METOD:
1. Identifiera FÖRST möbelns delar, och gå sedan igenom dem EN I TAGET över samtliga bilder. Att bara
   svepa efter skadetyper räcker inte — utan en dellista fastnar uppmärksamheten på de stora,
   framträdande ytorna och de små delarna blir aldrig granskade.
   För sittmöbler: ben och fötter · underrede och sarg · sitsens ovansida, framkant och undersida ·
   ryggstödets fram- och baksida · armstödens ovansida, ut- och insida · fogar, skarvar och beslag.
   Anpassa listan till den möbel du faktiskt ser.
   BEN, STOLPAR, FÖTTER OCH UNDERREDE missas nästan alltid: de är små i bild, ofta i skugga, och är
   samtidigt där skrapor och nötning sitter tätast — möbeln har stött emot golv, vägg, dammsugare och
   andra möbler. Granska varje ben och varje stolpe för sig, inte underredet som en klump.
   BÅDA ÄNDARNA, alltid: nederdelen närmast golvet OCH överdelen. På stolar tar ryggstolparnas
   ÖVERSTA del stryk av bordskanter, händer och andra stolar, och den änden är minst lika utsatt som
   den nedre. Har du tittat på ett bens nedre del är det halva jobbet gjort.
   Syns en del aldrig tydligt i någon bild, skriv vilken i coverage_note i stället för att tyst
   hoppa över den.
   Glöm inte att en dels KANTER och ÄNDAR hör till delen: benens över- och nederkant, framkanter,
   hörn, armstödsändar. De ska granskas utöver ytorna, aldrig i stället för dem.
   SMALA DELAR upptar få pixlar och läses lätt som bakgrund: ben, stolpar, spjälor, lister, ramverk,
   handtag. Följ varje sådant element från ände till ände i stället för att låta blicken svepa förbi
   det. En smal del är inte mindre viktig för att den är smal i bild.
   ATT DU HITTAT EN SKADA PÅ EN DEL BETYDER INTE ATT DELEN ÄR KLAR. Skador uppträder i kluster — där
   det finns en repa finns det oftast fler intill. Innan du lämnar en del: gå tillbaka över hela ytan
   och fråga dig om du rapporterat ALLA skador där, eller bara den mest iögonfallande. Två jämnstora
   skador bredvid varandra ska båda med, var och en som en egen post.
   FYRA FYND ÄR INGEN NATURLIG STOPPUNKT. En möbel som använts i flera år bär normalt fler synliga
   spår än en handfull. Stanna när du gått igenom varje del i parts_inspected och inte hittar mer —
   aldrig för att listan känns lagom lång. Fyll samtidigt aldrig på med sådant du inte kan peka ut.
   Alla påminnelser ovan gäller UTÖVER en fullständig genomgång av varje dels hela yta — mitten av en
   sits, en skiva eller en ryggpanel är lika viktig som dess kanter. Påminnelserna pekar ut det som
   brukar glömmas, de begränsar aldrig var du letar.
2. Rapportera VARJE distinkt FYSISK defekt du kan se — även svaga, diffusa och tveksamma. Utelämna
   ALDRIG ett fynd för att du är osäker: rapportera det med LÅG confidence i stället. En separat andra
   granskning tittar på varje osäkert fynd och plockar bort det som inte håller, så ett tveksamt fynd
   kostar ingenting medan ett utelämnat fynd är förlorat för gott.
   Missa särskilt inte MJUKT SLITAGE, som är lätt att förbise men är det vanligaste på begagnade
   möbler: fläckar och missfärgningar i tyg, nedsutten eller hoptryckt stoppning, nopprighet,
   blankslitna eller nötta ytor, urtvättad färg, och allmänt slitage på armstöd, sitsar, ryggstöd och
   kanter. Ett sittmöbel som använts har nästan alltid något av detta.
   Det som INTE är skador: träets naturliga ådring, avsiktliga designdetaljer, sömmar och normal
   konstruktion. Är du osäker på om något är en skugga eller en fläck — rapportera det med låg
   confidence och låt granskningen avgöra, hoppa inte över det.
3. KRITISKT — två fel som är LIKA allvarliga, blanda dem aldrig:
   a) SAMMA fysiska skada sedd i flera bilder (t.ex. samma repa framifrån och från sidan) ska vara EN
      post med en evidence-rad per bild där den syns. Skapa ALDRIG flera defekter för samma skada.
   b) OLIKA fysiska skador ska vara SKILDA poster, även när de sitter tätt intill varandra på samma
      del. Slå ALDRIG ihop två skador för att de liknar varandra, sitter nära, eller "hör ihop".
   Testet är enkelt: kan du peka på ETT ställe på möbeln är det en skada. Behöver du peka på två
   ställen är det två — även om de är någon decimeter isär, ser likadana ut och sitter på samma yta.
   Ge då var och en sitt eget läge i semantic_location.
4. Hitta aldrig på bevis. Att rapportera något du faktiskt ser men är osäker på är RÄTT; att beskriva
   en skada du inte kan peka ut i bilden är FEL. Skillnaden går vid om du kan sätta en ruta runt den.
5. Gör dessutom EN helhetsbedömning (overall_condition) av det allmänna visuella intrycket, oberoende av
   den enskilda defektlistan: hur använd ser möbeln ut, är slitaget isolerat eller utbrett, verkar
   funktion/struktur påverkad. En möbel med MÅNGA små spridda tecken på användning kan vara tydligt sliten
   även om ingen enskild defekt är allvarlig — fånga det här.
   Reservera "minimal" för möbler som verkligen framstår som OANVÄNDA. En möbel som uppenbart har
   använts ska inte få "minimal" bara för att ingen enskild skada sticker ut, och clearly_used_appearance
   ska då vara true.

Svara koncist. Inget resonemang i klartext — bara det strukturerade resultatet enligt schemat. Ange alltid
image_index och normaliserade koordinater (0-1) för varje evidence-post.`;


/** Turns one raw defect from the model into a Damage. Shared with the review pass so a defect found by
 *  the second inspector is indistinguishable in shape from one found by the first. */
export function mapRawDefect(d: RawDefect, images: CapturedImage[], idBase: string): Damage {
  return {
    id: `${idBase}_${Math.random().toString(36).slice(2, 8)}`,
    type: d.type,
    part: d.part,
    semanticLocation: d.semantic_location,
    severity: d.severity,
    impact: d.impact,
    description: d.description,
    confidence: d.confidence,
    verification: "UNCERTAIN",
    verificationReason: "",
    recaptureRequested: false,
    sellerAction: null,
    sellerAdded: false,
    evidence: d.evidence
      .filter((e) => e.image_index >= 0 && e.image_index < images.length)
      .map((e) => {
        const mark: EvidenceMark =
          e.mark_kind === "box"
            ? { kind: "box", x: e.x, y: e.y, w: e.w ?? 0.1, h: e.h ?? 0.1 }
            : { kind: "line", x: e.x, y: e.y, x2: e.x2 ?? e.x, y2: e.y2 ?? e.y };
        return { imageId: images[e.image_index].id, mark };
      }),
  };
}

export interface InspectionResult {
  furnitureType: string;
  partsInspected: PartInspection[];
  coverage: CoverageState;
  coverageNote: string | null;
  defects: Damage[];
  overallCondition: OverallCondition;
  callMeta: CallMeta;
}

export async function inspectFurniture(images: CapturedImage[], jobDir: string, productContext: string | null): Promise<InspectionResult> {
  const originalsDir = path.join(jobDir, "originals");
  const parts: ImagePart[] = [];
  for (const img of images) {
    parts.push(await loadImageAsBase64(path.join(originalsDir, img.path)));
  }

  const imageList = images.map((img, i) => `Bild ${i}: ${img.source === "manual" ? "manuellt foto" : "video-vy"}${img.viewLabel ? ` (${img.viewLabel})` : ""}`).join(", ");
  const contextLine = productContext ? `\nKänd produktinfo (kan vara ofullständig): ${productContext}` : "";
  const userPrompt = `Här är ${images.length} bilder av samma möbel: ${imageList}.${contextLine}\nInspektera systematiskt enligt instruktionerna och rapportera enligt schemat.`;

  const { data, tokensUsed, cached, modelUsed, latencyMs } = await callGeminiStructured<RawInspectionResponse>({
    purpose: "main_inspection",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    images: parts,
    responseSchema: RESPONSE_SCHEMA,
    resolution: "high",
    // Successful inspections land at 12-17s, so a 60s ceiling never bites a healthy call — it only
    // stops us from cutting off a slow one. 30s was still too tight on an 8-image run while Google was
    // returning 503/504 across models. The 30s product SLA is not reachable under that load; a slow
    // answer beats no answer while we are evaluating.
    primaryTimeoutMs: 60_000,
    fallbackTimeoutMs: 30_000,
  });

  const defects: Damage[] = data.defects.map((d, idx) => mapRawDefect(d, images, `def_${idx}`));

  const overallCondition: OverallCondition = {
    overallWearLevel: data.overall_condition.overall_wear_level,
    affectedExtent: data.overall_condition.affected_extent,
    functionalityAffected: data.overall_condition.functionality_affected,
    structuralIntegrityOk: data.overall_condition.structural_integrity_ok,
    clearlyUsedAppearance: data.overall_condition.clearly_used_appearance,
    observations: data.overall_condition.observations,
  };

  return {
    furnitureType: data.furniture_type,
    partsInspected: (data.parts_inspected ?? []).map((x) => ({
      part: x.part,
      visible: x.visible,
      defectsFound: x.defects_found,
    })),
    coverage: data.inspection_coverage,
    coverageNote: data.coverage_note || null,
    defects,
    overallCondition,
    callMeta: { purpose: "main_inspection", tokensUsed, cached, modelUsed, latencyMs },
  };
}
