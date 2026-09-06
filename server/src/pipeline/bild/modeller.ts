/**
 * Vilka segmenteringsmodeller som finns, och vad var och en behöver för att svara rätt.
 *
 * REGISTRET ÄR HELA POÄNGEN. Den gamla vägen hade U2Net inbakad i koden — indatasidan 320,
 * ImageNet-normaliseringen och min-max-skalningen låg som konstanter mitt i inferensen (se
 * pipeline/segment.ts). Det gjorde modellvalet till en omskrivning i stället för en rad, och det är
 * därför den aldrig byttes trots att den var mätbart sämst av de tillgängliga.
 *
 * Här är en modell DATA. Att lägga till en ny är att lägga till ett objekt och en rad i
 * scripts/fetch-models.sh; att byta den som driftar är att ändra PRODUKTBILD_MODELL. Inferensen i
 * segmentera.ts läser det här och vet ingenting om vilken modell den kör.
 *
 * VARFÖR JUST DE HÄR FYRA, och varför inte de andra som stod på listan:
 *
 * - SAM 2 / SAM 3 / Grounded SAM svarar på fel fråga. De är utpekningsmodeller: mata dem en punkt
 *   eller en ruta och de säger vilket FÖREMÅL som menas, med en binär mask. Ett urklipp mot vitt
 *   behöver motsatsen — en mjuk alfakanal längs kanten, för det är den som avgör om en fransad
 *   tygkant ser klippt eller riktig ut. SAM:s styrka (vilket föremål?) har vi dessutom redan svar
 *   på från Gemini-ramen. Att lägga till en 350 MB-modell för att lösa det lösta och samtidigt
 *   få sämre kanter är fel byte.
 *
 * - RMBG-1.4 (BRIA) är den enda modellen som mätbart tävlar med BiRefNet, och den får inte
 *   användas: licensen är BRIA:s egen, icke-kommersiell utan avtal. Loopa säljer möbler. Den står
 *   därför inte i registret alls — inte ens som jämförelse, för en modell i registret är en modell
 *   någon kan råka sätta i drift.
 *
 * - rembg är inte en modell utan ett pythonbibliotek som kör precis de ONNX-filer som står nedan.
 *   Vi kör dem redan, i noden vi ändå har.
 */

/** Hur bilden får plats i modellens kvadrat. */
export type Passform =
  /**
   * Kläm ihop till kvadrat. Vad rembg och referensimplementationerna gör.
   *
   * Fördelen är att hela modellrutan används på möbeln. Nackdelen är att bilden förvrängs, och
   * förvrängningen är olika i x och y — ett stolsben blir bredare i en liggande bild och smalare i
   * en stående. Vilket som blir bäst går inte att resonera sig till, så båda finns och benchmarken
   * avgör (scripts/bild-bench.ts).
   */
  | "fyll"
  /** Behåll proportionerna och fyll ut med neutral grå. Möbeln får färre pixlar men rätt form. */
  | "brevlada";

/** Hur modellens utdata ska läsas som en sannolikhet 0–1. */
export type Utdata =
  /**
   * Sträck kartan mot sitt EGET spann.
   *
   * Vad U2Net och ISNet kräver: de svarar med logits vars faktiska omfång varierar mellan bilder,
   * och klipps de rakt av mot 0–1 blir masken på en svag bild nästan svart. Priset är att en bild
   * UTAN möbel också sträcks till fullt utslag — bruset blir en silhuett. Kvalitetsspärren i
   * kvalitet.ts finns bland annat för det.
   */
  | "minmax"
  /** Kartan ÄR redan en sannolikhet. Att sträcka den vore att kasta bort modellens kalibrering. */
  | "sannolikhet";

export interface Modell {
  /** Nyckeln i registret och namnet i loggen. Samma som filnamnet utan .onnx. */
  namn: string;
  /** Modellens indatasida i pixlar. Kvadratisk för alla fyra. */
  sida: number;
  passform: Passform;
  /** Per kanal, på 0–1-skalan. */
  medel: [number, number, number];
  avvikelse: [number, number, number];
  utdata: Utdata;
  /** Sant när ONNX-filen tar float16 in. segmentera.ts konverterar då tensorn. */
  fp16: boolean;
  /** Ungefärlig filstorlek, för fetch-models.sh och för att välja på en burk med lite RAM. */
  megabyte: number;
  licens: string;
  /** Varför den finns i registret — och vad den är dålig på. Läses av benchmarkens rapport. */
  anteckning: string;
}

export const MODELLER: Record<string, Modell> = {
  /**
   * Den som driftade fram till nu. Står kvar som GOLV i benchmarken, inte som kandidat.
   *
   * 320×320 är hela problemet. En soffa i en 3000 pixlar bred bildruta får sin silhuett räknad i en
   * ruta mindre än en ikon, och skalas sedan upp nittio gånger i yta. Vad som helst smalare än ett
   * armstöd — stolsben, medar, fransar — finns helt enkelt inte i de 320 pixlarna att skala upp.
   */
  u2netp: {
    namn: "u2netp",
    sida: 320,
    passform: "fyll",
    medel: [0.485, 0.456, 0.406],
    avvikelse: [0.229, 0.224, 0.225],
    utdata: "minmax",
    fp16: false,
    megabyte: 5,
    licens: "Apache-2.0 (U^2-Net, Qin m.fl.)",
    anteckning: "Snabb och liten. Upplösningen räcker inte till möbelben.",
  },

  /** Samma arkitektur, full storlek. Bättre än u2netp, samma tak: 320 pixlar. */
  u2net: {
    namn: "u2net",
    sida: 320,
    passform: "fyll",
    medel: [0.485, 0.456, 0.406],
    avvikelse: [0.229, 0.224, 0.225],
    utdata: "minmax",
    fp16: false,
    megabyte: 168,
    licens: "Apache-2.0 (U^2-Net, Qin m.fl.)",
    anteckning: "168 MB för samma 320-pixlarsmask. Dålig affär i RAM.",
  },

  /**
   * IS-Net, tränad på DIS5K — datamängden som finns just för att objekt har HÅL och TUNNA DELAR.
   *
   * Tre gånger sidan mot U2Net, alltså tio gånger ytan att beskriva ett stolsben i. Normaliseringen
   * är en annan än U2Net:s och det är inte en detalj: matas den med ImageNet-siffrorna svarar den
   * fortfarande, bara sämre, och felet ser ut som en modell som är lite oskarp.
   */
  "isnet-general-use": {
    namn: "isnet-general-use",
    sida: 1024,
    passform: "fyll",
    medel: [0.5, 0.5, 0.5],
    avvikelse: [1.0, 1.0, 1.0],
    utdata: "minmax",
    fp16: false,
    megabyte: 179,
    licens: "Apache-2.0 (DIS/IS-Net, Qin m.fl.)",
    anteckning: "1024 px och tränad på hålighet. Rimlig kompromiss RAM/kvalitet.",
  },

  /**
   * BiRefNet — den bästa vi får köra, och den enda som är byggd för just det här.
   *
   * Två strömmar: en som ser hela bilden och en som ser kanten. Det andra är vad ett urklipp lever
   * och dör på. Den kostar 490 MB och tiotals sekunder per bild på processor, och det är rätt pris
   * här: omslaget byggs utanför säljarens väntan (se run.ts) och en mask som tappar ett bordsben är
   * dyrare än en minut.
   *
   * FULLVIKT, 973 MB, MOT VÅR VILJA. fp16-filen är halva storleken och skulle vara rätt val på en
   * burk som delar minne med prismotorn. Den går inte att köra här: onnxruntime-node 1.20.1 har två
   * valideringslager som säger emot varandra om float16 — JS-konstruktorn kräver Node 24:s
   * Float16Array, den nativa bindningen kräver Uint16Array, och ingen tensor kan vara båda.
   * Uppgradering till 1.29 löser det och tar bort de färdiga binärerna för darwin/x64, alltså
   * utvecklingsdatorn. Kvar blir fp32.
   *
   * Det är också skälet RESERVKEDJAN finns: en burk som inte har en gigabyte att avvara sätter
   * PRODUKTBILD_MODELL=isnet-general-use och får 179 MB och en mask som är näst bäst.
   */
  "birefnet-general": {
    namn: "birefnet-general",
    sida: 1024,
    passform: "brevlada",
    medel: [0.485, 0.456, 0.406],
    avvikelse: [0.229, 0.224, 0.225],
    utdata: "sannolikhet",
    fp16: false,
    megabyte: 973,
    licens: "MIT (BiRefNet, ZhengPeng7)",
    anteckning: "Bäst kant. Tung på processor — körs utanför säljarens väntan.",
  },
};

/**
 * Modellen som driftar.
 *
 * En miljövariabel och inte en konstant: burken i drift och datorn under utveckling har olika mycket
 * minne, och en modell som inte finns på disk ska ge en sämre bild — inte ett kraschat jobb.
 * segmentera.ts faller ned genom `RESERVKEDJA` när filen saknas.
 */
export function valdModell(): Modell {
  const namn = process.env.PRODUKTBILD_MODELL?.trim() || "birefnet-general";
  return MODELLER[namn] ?? MODELLER["isnet-general-use"];
}

/**
 * Ordningen att falla nedåt i när modellfilen saknas.
 *
 * Uppifrån och ner i kvalitet. En burk utan de tunga filerna får u2netp och ett sämre omslag, vilket
 * är hela skillnaden mot i dag då en saknad fil betydde inget omslag alls.
 */
export const RESERVKEDJA = ["birefnet-general", "isnet-general-use", "u2net", "u2netp"] as const;
