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

/**
 * OMSLAGSBILDEN: den enda bild säljaren blir ombedd att komponera, tagen efter varvet.
 *
 * VARFÖR DEN FINNS. Bildrutor ur ett varv är tagna med telefonen i brösthöjd, riktad snett NEDÅT mot
 * möbeln — det är så man håller en telefon när man går. Mot rent vitt syns det inte. Mot annonsens
 * studiobakgrund, som är fotograferad i ögonhöjd med en horisont, syns det direkt: möbeln är sedd
 * uppifrån och rummet bakom den rakt framifrån, och två kamerahöjder i samma bild läser som falskt
 * hur bra urklippet än är. Ingen bildruta ur varvet kan lösa det, för hela varvet lutar likadant.
 *
 * DÄRFÖR ÄR HÖJDEN INSTRUKTIONEN, inte vinkeln. De sex stationerna ovan säger var man ska STÅ; den
 * här säger var telefonen ska HÅLLAS, och det är den uppgift som saknades. `y` ligger vid möbelns
 * egen mitthöjd i stället för `PHONE_Y`, så markören i guiden sjunker synligt ner mot sitshöjd — det
 * är skillnaden man ska härma.
 *
 * SNETT FRAMIFRÅN och inte rakt: en möbel rakt framifrån blir en rektangel utan djup. Ett drygt
 * trettiondels varv åt sidan visar framsidan och ena kortsidan samtidigt, vilket är vinkeln varenda
 * möbelkatalog använder — och den som får en soffa att se ut som en möbel i stället för som en fasad.
 */
export const OMSLAGSSTATION: PhotoStation = {
  id: "cover",
  label: "Omslagsbild",
  title: "Ta annonsens omslagsbild",
  instruction:
    "Håll telefonen i höjd med möbelns mitt — inte i brösthöjd — och luta den inte nedåt. Ställ dig snett framför så att framsidan och ena kortsidan syns.",
  required: false,
  /**
   * Snett framifrån, i möbelns egen höjd.
   *
   * NEGATIVT `t`, alltså åt andra hållet än varvet går. Scenen ritar soffan vriden med `YAW = -0.62`
   * (guideScene.ts), och den här vinkeln är samma vridning från andra sidan: telefonen hamnar mitt i
   * rutan framför den sida av möbeln som redan är vänd mot betraktaren. Spegelvinkeln `+0.62` är
   * geometriskt lika god men projiceras ut i vänsterkanten, 30 px från ramen — markören klämmer sig
   * då mot kanten i stället för att stå framför möbeln, vilket läser som en vinkel man inte kommer åt.
   *
   * `y: 46` ligger vid möbelns egen midja (soffan i scenen är 82 cm hög) mot brösthöjdens 112. Det är
   * den skillnaden som är hela instruktionen, och den syns: skaftet ner till golvet blir 29 px i
   * stället för 73.
   */
  at: { t: -0.62, y: 46 },
};
