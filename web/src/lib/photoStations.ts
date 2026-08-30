/**
 * Vinklarna fotoguiden ber om, i den ordning man går dem.
 *
 * Fotoguiden är alternativet till att filma ett varv, och skillnaden mot filmen är inte att det blir
 * färre bilder — det är att vi VET vad varje bild visar. Bildrutorna ur en film får medvetet ingen
 * etikett: vinkeln mäts inte där, och en etikett satt på index hade varit ett påstående utan täckning
 * (se encodeSelection i videoFrames). Här är det tvärtom. Säljaren blir ombedd att ställa sig på ett
 * bestämt ställe och trycker av där, så `label` är något vi faktiskt har frågat efter — och den följer
 * med bilden hela vägen in i besiktningsprompten, där den talar om vilken sida modellen tittar på.
 *
 * Ordningen är varvets: `t` växer medsols sett uppifrån, precis som pilarna i filmguiden, vilket för
 * säljaren som står vänd mot framsidan betyder att hen går åt sitt vänster. Därför kommer vänster
 * kortsida före höger — guiden ska beskriva promenaden, inte en uppräkning av väderstreck.
 *
 * Antalet är lika med MAX_IMAGES i CaptureScreen, alltså MAX_IMAGES_PER_JOB på servern. Fler stationer
 * än så hade betytt att säljaren fotograferar vinklar som tyst kastas innan inspektionen.
 */

import { ORBIT_R, type Vantage } from "./guideScene";

export interface PhotoStation {
  id: string;
  /** Etiketten som följer med bilden in i besiktningen. Samma ordlista som resten av appen. */
  label: string;
  /** Rubriken över kameran: vart säljaren ska gå. */
  title: string;
  /** Vad som ska synas i bilden, i en mening. */
  instruction: string;
  /**
   * Utan den här vinkeln saknar besiktningen en hel sida av möbeln.
   *
   * De obligatoriska ÄR varvet: fyra punkter på banan, ett kvarts varv isär. De två frivilliga står
   * utanför den — närmare, högre — och har därför en egen radie i `at`.
   */
  required: boolean;
  at: Vantage;
}

export const PHOTO_STATIONS: PhotoStation[] = [
  {
    id: "front",
    label: "Framifrån",
    title: "Rakt framifrån",
    instruction: "Backa tills hela möbeln syns. Den här blir annonsens omslag.",
    required: true,
    at: { t: 0 },
  },
  {
    id: "left",
    label: "Vänster sida",
    title: "Vänster kortsida",
    instruction: "Ett kvarts varv åt vänster. Armstöd och båda benen ska synas.",
    required: true,
    at: { t: Math.PI / 2 },
  },
  {
    id: "back",
    label: "Bakifrån",
    title: "Baksidan",
    instruction: "Fortsätt runt. Kommer du inte åt baksidan — hoppa över.",
    required: true,
    at: { t: Math.PI },
  },
  {
    id: "right",
    label: "Höger sida",
    title: "Höger kortsida",
    instruction: "Sista kortsidan, mitt emot den du nyss tog.",
    required: true,
    at: { t: (3 * Math.PI) / 2 },
  },
  {
    id: "top",
    label: "Ovanifrån",
    title: "Ovanifrån, ner mot sitsen",
    instruction: "Luta telefonen ner över sitsen — nedsuttna dynor syns bara uppifrån.",
    required: false,
    /** Rakt över sitsen, med skaftet ner till dynan i stället för till golvet — se groundY. */
    at: { t: -0.6, r: ORBIT_R * 0.25, y: 160, groundY: 44 },
  },
  {
    id: "closeup",
    label: "Närbild",
    title: "Närbild på skador och slitage",
    instruction:
      "Fläckar, repor, sprickor, nedsuttet tyg — gå nära det du själv skulle peka på. Finns inget att visa, hoppa över.",
    required: false,
    /**
     * Innanför banan och nära kameran, så markören ritas STOR och delvis över möbeln. Det är avsikten:
     * närbildens instruktion är avståndet, inte platsen. Var på möbeln skadan sitter vet bara
     * säljaren, och en markör ute på banan hade sett likadan ut som de fyra sidorna.
     */
    at: { t: -1.3, r: ORBIT_R * 0.75, y: 72 },
  },
];
