/**
 * Rangordningen: vilken möbel som ska stå först när ingen sagt något annat.
 *
 * REN FUNKTION, INGA SIDOEFFEKTER, VIKTERNA UTBRUTNA. Det är hela poängen med filen. Sorteringen
 * är den mest justerade raden i en butik — den ändras varje gång någon tittar på lagret — och en
 * viktkonstant som ligger inbakad i en jämförelsefunktion mitt i ett filtreringssvep går inte att
 * ändra utan att röra allt annat. Här är varje vikt ett namngivet tal och varje delpoäng en egen
 * funktion som går att pröva ensam.
 *
 * VAD SOM INTE FINNS HÄR: personalisering, "sponsrat", och en boost för gamla annonser. Det sista är
 * uttryckligen bortvalt. En möbel som legat länge lyfts när den faktiskt blivit BILLIGARE — det gör
 * den av sig själv, för prisstegen sänker 15 % i veckan och sänkningen syns i fyndpoängen. Åldern i
 * sig ger bara en liten knuff så att ingenting begravs helt.
 */

import type { Product } from "./types.js";

/**
 * Vikterna. Summerar till 1 så att slutpoängen ligger i 0–1 och går att läsa som en procent.
 *
 * FYND VÄGER TYNGST för att det är den enda delpoängen som säger något om VARAN och inte om
 * annonsen. En möbel som ligger under vad den är värd är ett skäl att öppna kortet; en möbel med
 * sex bilder är bara välfotograferad.
 *
 * ENGAGEMANG VÄGER LÄTT MED FLIT, och ska stå kvar lätt tills lagret har volym. En klickräknare på
 * ett lager med femtio varor mäter mest vad som råkade ligga överst i går — den blir en spegel som
 * bekräftar sin egen sortering. Först när det finns tusentals visningar per vara säger den något om
 * varan i stället för om rutnätet.
 */
export const VIKTER = {
  fynd: 0.45,
  kvalitet: 0.25,
  engagemang: 0.15,
  alder: 0.15,
} as const;

/**
 * Rabatten som räknas som fullt fynd.
 *
 * 40 % under prismotorns uppskattning. Över det slår poängen i taket i stället för att fortsätta
 * växa, och det är avsiktligt: skillnaden mellan 45 % och 70 % under värdet är oftast inte ett
 * bättre fynd utan en möbel med något fel på — och det felet står i skickavsnittet, inte i priset.
 */
const FULLT_FYND = 0.4;

/** Antal bilder som räknas som en komplett bildsvit. Fler ger inte mer. */
const NOG_MED_BILDER = 6;

/**
 * Antal dagar då ålderspoängen slår i taket.
 *
 * 60 dagar, och taket är det viktiga: utan det växer åldern obegränsat och en möbel som legat ett
 * halvår vinner över allt annat bara genom att ha legat kvar. Med taket är ålderns hela bidrag
 * VIKTER.alder — femton procent — vilket räcker för att lyfta något ur glömskan och aldrig för att
 * placera det först.
 */
const ALDER_TAK_DAGAR = 60;

/** Visningar som räknas som fullt engagemang. Se resonemanget vid VIKTER. */
const NOG_MED_VISNINGAR = 500;
const NOG_MED_SPARNINGAR = 20;

export interface Engagemang {
  visningar: number;
  sparningar: number;
}

export interface Rangdelar {
  fynd: number;
  kvalitet: number;
  engagemang: number;
  alder: number;
  total: number;
}

function klam(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Hur mycket möbeln understiger sitt uppskattade värde, 0–1.
 *
 * MOT PRISMOTORNS UPPSKATTNING, inte mot nypriset. Nypriset säger vad en NY kostar, och varje
 * begagnad möbel ligger långt under det — räknat så blir allt ett lika stort fynd och delpoängen
 * säger ingenting. Uppskattningen tar hänsyn till modell, skick och skador, så en möbel under den
 * är billig även jämfört med andra begagnade.
 *
 * Saknas uppskattningen blir det NOLL, inte ett medelvärde. En vara vi inte kunnat värdera ska inte
 * lånas fyndpoäng av de som gick att värdera.
 */
export function fyndpoang(p: Product): number {
  const varde = p.estimatedValueSek;
  const pris = p.priceSek;
  if (varde === null || pris === null || varde <= 0) return 0;
  return klam((varde - pris) / varde / FULLT_FYND);
}

/**
 * Hur komplett annonsen är, 0–1. Tre lika delar: bilder, mått, granskat skick.
 *
 * Mäter ANNONSEN och inte möbeln, och det är därför den väger medel och inte tungt. En möbel med få
 * bilder kan vara ett utmärkt köp; den är bara svårare att bestämma sig för. Delpoängen finns för
 * att en köpare som klickar på en tom annons backar ut igen, och det är ett sämre utfall än att den
 * annonsen låg några rader ner.
 */
export function kvalitetspoang(p: Product): number {
  const bilder = klam(p.imageCount / NOG_MED_BILDER);
  const matt = p.hasMeasurements ? 1 : 0;
  // Ett granskat skick, inte ett bra skick. Ett ärligt "Slitet skick" är en komplett annons.
  const skick = p.condition ? 1 : 0;
  return (bilder + matt + skick) / 3;
}

/**
 * Åldern som en liten knuff uppåt, 0–1, mättad vid ALDER_TAK_DAGAR.
 *
 * `listedAtKnown` krävs. En vara vars listningsdatum vi bara gissat ska inte få åldersknuffen — det
 * var precis så Tradera-annonser tog över "Nyinkommet" en gång (se listedAtKnown i types.ts), och
 * samma gissning får inte komma in bakvägen genom sorteringen.
 */
export function alderspoang(p: Product, nu: Date = new Date()): number {
  if (!p.listedAtKnown) return 0;
  const t = Date.parse(p.listedAt);
  if (!Number.isFinite(t)) return 0;
  const dagar = (nu.getTime() - t) / 86_400_000;
  return klam(dagar / ALDER_TAK_DAGAR);
}

/** Klick och sparningar, 0–1. Noll när vi inte har någon mätning — se VIKTER. */
export function engagemangspoang(e: Engagemang | null | undefined): number {
  if (!e) return 0;
  return (klam(e.visningar / NOG_MED_VISNINGAR) + klam(e.sparningar / NOG_MED_SPARNINGAR)) / 2;
}

/**
 * Delpoängen var för sig plus summan. Exporterad för att den ÄR felsökningen.
 *
 * En sortering som bara ger ett tal går inte att ifrågasätta: "varför ligger den där?" har inget
 * svar. Med delarna framme är svaret en rad siffror, och den som vill flytta något vet vilken vikt
 * som ska röras.
 */
export function rangdelar(p: Product, e?: Engagemang | null, nu?: Date): Rangdelar {
  const fynd = fyndpoang(p);
  const kvalitet = kvalitetspoang(p);
  const engagemang = engagemangspoang(e);
  const alder = alderspoang(p, nu);
  return {
    fynd,
    kvalitet,
    engagemang,
    alder,
    total:
      fynd * VIKTER.fynd +
      kvalitet * VIKTER.kvalitet +
      engagemang * VIKTER.engagemang +
      alder * VIKTER.alder,
  };
}

/** Slutpoängen, 0–1. Högre står först. */
export function rankScore(p: Product, e?: Engagemang | null, nu?: Date): number {
  return rangdelar(p, e, nu).total;
}
