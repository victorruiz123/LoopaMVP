/**
 * Kvalitetskontrollen. Frågar inte modellen hur säker den är — mäter resultatet.
 *
 * VARFÖR INTE MODELLENS EGET SJÄLVFÖRTROENDE: en segmenteringsmodell som pekat ut en matta i stället
 * för en soffa är precis lika säker som när den har rätt. Det gick att se på den gamla vägen, där
 * enda spärren var tre mått på silhuettens storlek — en mask som täckte halva rummet passerade så
 * länge den inte täckte hela.
 *
 * Måtten nedan svarar var för sig på en fråga någon faktiskt skulle ställa om bilden, och de flesta
 * av dem är fel som INTE syns i en miniatyr: en soffa som saknar ett ben, en kant som bär rummets
 * färg, en mask som tagit med väggen. Faller något av dem tillräckligt lågt sätts
 * `behoverGranskning`, och då publiceras inte omslaget automatiskt — originalbilden ligger kvar och
 * en människa får titta. Det är hela poängen med steget: hellre säljarens rumsfoto än ett urklipp
 * som visar en halv möbel.
 *
 * TVÅ AV MÅTTEN ÄR INVARIANTER, inte bedömningar. `fargdrift` och `inreOrord` mäter om möbelns egna
 * pixlar kommit igenom orörda, och svaret ska vara ja per konstruktion — kedjan skriver bara i
 * kantbandet (se kant.ts). Att mäta det ändå är hela skälet Loopa får säga att bilden visar möbeln
 * som den är: ett löfte som bara kontrolleras av att koden är rätt är ett löfte tills någon råkar
 * ändra i koden.
 */

import { BAND_HOG, BAND_LAG } from "./kant.js";
import type { Ram } from "./komposition.js";

export interface Anmarkning {
  kod: string;
  /** Sant när den ensam räcker för att inte publicera automatiskt. */
  blockerande: boolean;
  varde: number;
  text: string;
}

export interface Kvalitet {
  /** 0–1. Sammanvägt, för att kunna sortera fram de sämsta ur ett helt lager. */
  poang: number;
  behoverGranskning: boolean;
  anmarkningar: Anmarkning[];
  matt: {
    /** Andel av bilden som är möbel. */
    tackning: number;
    /** Andel av silhuettens kantpixlar som ligger mot bildens vänster-, höger- eller överkant. */
    beskuren: number;
    /** Andel av möbelytan som är halvtransparent. Högt = modellen är osäker på hela möbeln. */
    bandandel: number;
    /** Andel av möbelytan som ligger utanför den största sammanhängande formen. */
    fragment: number;
    /** Hur mycket av silhuetten i bildens nedersta åttondel som förfiningen tog bort. Ben. */
    benforlust: number;
    /** Största färgavvikelse i en pixel som är helt möbel. Ska vara 0. */
    fargdrift: number;
    /** Andel helt-möbel-pixlar som är bit för bit identiska med originalet. Ska vara 1. */
    inreOrord: number;
  };
}

/** Under detta är möbeln för liten i bilden för att bli en vettig produktbild. */
const MIN_TACKNING = 0.02;
/** Över detta är det rummet som pekats ut, inte möbeln. */
const MAX_TACKNING = 0.92;
/** Över detta fortsätter möbeln utanför bild och urklippet blir en halv möbel. */
const MAX_BESKUREN = 0.22;
/** Över detta är masken en dimma snarare än en silhuett. */
const MAX_BANDANDEL = 0.35;
/** Över detta ligger möbeln i lösa bitar. */
const MAX_FRAGMENT = 0.25;
/** Över detta har förfiningen ätit upp benen. */
const MAX_BENFORLUST = 0.55;

/**
 * Hur mycket av silhuetten som ligger mot bildens kant.
 *
 * UNDERKANTEN RÄKNAS INTE. Möbler står på golv och golvet är där bilden slutar; att kräva luft under
 * en soffa hade underkänt varje bildruta tagen i ögonhöjd, vilket är alla.
 *
 * Mätt mot bildens omkrets och inte mot möbelns yta: en stor möbel har fler kantpixlar bara för att
 * den är stor, och ska inte straffas för sin storlek.
 */
function beskurenAndel(alfa: Float32Array, b: number, h: number): number {
  let kant = 0;
  for (let x = 0; x < b; x++) if (alfa[x] > BAND_LAG) kant++;
  for (let y = 0; y < h; y++) {
    if (alfa[y * b] > BAND_LAG) kant++;
    if (alfa[y * b + b - 1] > BAND_LAG) kant++;
  }
  return Math.min(1, kant / (b + 2 * h));
}

/** Andelen av möbelytan som ligger utanför den största sammanhängande formen. */
function fragmentAndel(alfa: Float32Array, b: number, h: number, yta: number): number {
  if (yta === 0) return 0;
  const n = b * h;
  const etikett = new Int32Array(n).fill(-1);
  const ko = new Int32Array(n);
  let storst = 0;
  let id = 0;
  for (let start = 0; start < n; start++) {
    if (alfa[start] <= BAND_LAG || etikett[start] !== -1) continue;
    let huvud = 0;
    let svans = 0;
    ko[svans++] = start;
    etikett[start] = id;
    let storlek = 0;
    while (huvud < svans) {
      const p = ko[huvud++];
      storlek++;
      const x = p % b;
      const y = (p - x) / b;
      if (x > 0 && alfa[p - 1] > BAND_LAG && etikett[p - 1] === -1) { etikett[p - 1] = id; ko[svans++] = p - 1; }
      if (x < b - 1 && alfa[p + 1] > BAND_LAG && etikett[p + 1] === -1) { etikett[p + 1] = id; ko[svans++] = p + 1; }
      if (y > 0 && alfa[p - b] > BAND_LAG && etikett[p - b] === -1) { etikett[p - b] = id; ko[svans++] = p - b; }
      if (y < h - 1 && alfa[p + b] > BAND_LAG && etikett[p + b] === -1) { etikett[p + b] = id; ko[svans++] = p + b; }
    }
    if (storlek > storst) storst = storlek;
    id++;
  }
  return Math.max(0, 1 - storst / yta);
}

/**
 * Hur mycket silhuett förfiningen tog bort i bildens nedersta åttondel.
 *
 * Där sitter benen, medarna och sockeln — det som är smalast och alltså det första en förfining
 * äter upp om den är för hård. Måttet finns för att det felet är osynligt i varje annan siffra:
 * en soffa utan ben har fortfarande rätt täckning, rätt kantandel och en enda sammanhängande form.
 * Den ser bara ut att sväva.
 */
function benforlustAndel(ra: Float32Array, forfinad: Float32Array, b: number, h: number): number {
  const start = Math.floor(h * 0.875);
  let fore = 0;
  let efter = 0;
  for (let y = start; y < h; y++) {
    for (let x = 0; x < b; x++) {
      const i = y * b + x;
      if (ra[i] > 0.5) fore++;
      if (forfinad[i] > BAND_LAG) efter++;
    }
  }
  if (fore === 0) return 0;
  return Math.max(0, 1 - efter / fore);
}

/**
 * Möbelns egna pixlar, jämförda med originalet.
 *
 * BARA DÄR ALFA SÄGER HELT MÖBEL. Kantbandet är per definition en blandning av möbel och rum och
 * har med flit skrivits om (se `dekontaminera` i kant.ts); att mäta drift där vore att mäta det man
 * just gjorde. Allt innanför bandet är möbelns yta — varje repa, fläck, spricka och missfärgning
 * kortet ska visa — och där ska svaret vara exakt noll.
 *
 * Största avvikelsen och inte medelvärdet: ett medelvärde över miljontals orörda pixlar döljer att
 * hundra av dem ändrats. Det är just de hundra som skulle vara en bortsuddad skada.
 */
function fargkontroll(
  original: Buffer,
  efter: Buffer,
  alfa: Float32Array,
): { drift: number; orord: number } {
  let drift = 0;
  let inre = 0;
  let lika = 0;
  for (let i = 0; i < alfa.length; i++) {
    if (alfa[i] < BAND_HOG) continue;
    inre++;
    const d =
      Math.abs(original[i * 3] - efter[i * 3]) +
      Math.abs(original[i * 3 + 1] - efter[i * 3 + 1]) +
      Math.abs(original[i * 3 + 2] - efter[i * 3 + 2]);
    if (d === 0) lika++;
    else if (d > drift) drift = d;
  }
  return { drift, orord: inre === 0 ? 1 : lika / inre };
}

/**
 * Alla mått, en dom.
 *
 * `ra` är modellens karta som den kom, `forfinad` är alfakanalen efter kant.ts. Båda behövs:
 * flera av felen syns bara som en SKILLNAD mellan dem, och den skillnaden är förfiningens eget
 * arbete — det steg som annars ingen kontrollerar.
 */
export function bedom(
  ra: Float32Array,
  forfinad: Float32Array,
  originalRgb: Buffer,
  efterRgb: Buffer,
  b: number,
  h: number,
  ram: Ram | null,
): Kvalitet {
  const anm: Anmarkning[] = [];
  const n = b * h;

  if (!ram || ram.yta === 0) {
    return {
      poang: 0,
      behoverGranskning: true,
      anmarkningar: [{ kod: "ingen_mobel", blockerande: true, varde: 0, text: "Ingen silhuett alls — modellen hittade ingen möbel." }],
      matt: { tackning: 0, beskuren: 0, bandandel: 0, fragment: 0, benforlust: 0, fargdrift: 0, inreOrord: 1 },
    };
  }

  const tackning = ram.yta / n;
  const beskuren = beskurenAndel(forfinad, b, h);
  const fragment = fragmentAndel(forfinad, b, h, ram.yta);
  const benforlust = benforlustAndel(ra, forfinad, b, h);
  const { drift, orord } = fargkontroll(originalRgb, efterRgb, forfinad);

  let band = 0;
  for (let i = 0; i < n; i++) if (forfinad[i] > BAND_LAG && forfinad[i] < BAND_HOG) band++;
  const bandandel = band / ram.yta;

  const matt = { tackning, beskuren, bandandel, fragment, benforlust, fargdrift: drift, inreOrord: orord };

  if (tackning < MIN_TACKNING)
    anm.push({ kod: "for_liten", blockerande: true, varde: tackning, text: "Möbeln fyller för lite av bilden — urklippet blir grynigt." });
  if (tackning > MAX_TACKNING)
    anm.push({ kod: "for_stor", blockerande: true, varde: tackning, text: "Masken täcker nästan hela bilden — troligen rummet, inte möbeln." });
  if (beskuren > MAX_BESKUREN)
    anm.push({ kod: "beskuren", blockerande: true, varde: beskuren, text: "Möbeln fortsätter utanför bildkanten — urklippet blir en halv möbel." });
  if (bandandel > MAX_BANDANDEL)
    anm.push({ kod: "osaker_mask", blockerande: true, varde: bandandel, text: "Stor del av möbeln är halvtransparent — masken är en dimma, inte en silhuett." });
  if (fragment > MAX_FRAGMENT)
    anm.push({ kod: "fragmenterad", blockerande: true, varde: fragment, text: "Möbeln ligger i lösa bitar — delar saknas eller hör inte ihop." });
  if (benforlust > MAX_BENFORLUST)
    anm.push({ kod: "tappade_ben", blockerande: true, varde: benforlust, text: "Förfiningen tog bort det mesta längst ned — möbeln ser ut att sväva." });

  /**
   * Invarianterna är ALLTID blockerande, och de går inte att ställa in.
   *
   * Ett brott mot dem är inte en dålig bild utan en trasig kedja: någon har börjat skriva i pixlar
   * som skulle vara orörda. Då är det inte längre säljarens möbel som visas, och det är hela
   * skillnaden mellan Loopas kort och en tillrättalagd annons. Bilden ska stoppas, och felet ska
   * synas i loggen.
   */
  if (drift > 0)
    anm.push({ kod: "fargdrift", blockerande: true, varde: drift, text: `Möbelns egna pixlar har ändrats (max ${drift} av 765) — kedjan skriver där den inte får.` });
  if (orord < 1)
    anm.push({ kod: "inre_andrat", blockerande: true, varde: orord, text: `Bara ${(orord * 100).toFixed(2)} % av möbelns yta är bit för bit orörd.` });

  /**
   * Poängen: hur långt varje mått ligger från sin gräns, sämsta måttet räknat hårdast.
   *
   * Ett medelvärde hade låtit fem bra mått dölja ett katastrofalt — en soffa utan ben med perfekt
   * täckning, kant och sammanhang får 0,8 av ett medelvärde. Produkten nedan låter det sämsta måttet
   * dra ner allt, vilket är hur en människa tittar på bilden.
   */
  const delar = [
    klam(tackning / MIN_TACKNING),
    klam((MAX_TACKNING - tackning) / (MAX_TACKNING - 0.4)),
    klam((MAX_BESKUREN - beskuren) / MAX_BESKUREN),
    klam((MAX_BANDANDEL - bandandel) / MAX_BANDANDEL),
    klam((MAX_FRAGMENT - fragment) / MAX_FRAGMENT),
    klam((MAX_BENFORLUST - benforlust) / MAX_BENFORLUST),
  ];
  const poang = anm.some((a) => a.blockerande) ? Math.min(0.49, delar.reduce((a, b2) => a * b2, 1)) : delar.reduce((a, b2) => a * b2, 1);

  return { poang, behoverGranskning: anm.some((a) => a.blockerande), anmarkningar: anm, matt };
}

function klam(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
