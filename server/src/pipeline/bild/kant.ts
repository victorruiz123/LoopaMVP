/**
 * Kanten. Det enda steget som avgör om en köpare ser att bakgrunden är borttagen.
 *
 * DEN GAMLA VÄGEN VAR `threshold(160).blur(sigma)`, och den är fel på två sätt samtidigt.
 *
 * Tröskeln kastar bort halvtransparensen. En tygkant, en frans, en glasruta och en oskarp
 * bordskant är alla PÅ RIKTIGT delvis genomsiktliga, och en modell som svarar 0,4 på en sådan
 * pixel har rätt. Skär man vid 160 blir svaret 0 eller 255 och kanten blir en sax-kant. Suddet
 * efteråt döljer inte det — det gör en skarp sax-kant till en suddig sax-kant, lika bred överallt,
 * lika bred i ett stolsben som i ett armstöd.
 *
 * Och tröskeln sattes högt (160, inte 128) för att dölja ett ANNAT fel: en ljus rand av rummet
 * följde med runt urklippet och syntes som en gloria mot det vita. Den randen är inte maskens fel.
 * Den är att en halvtransparent kantpixel bär BÅDA färgerna — möbelns och rummets — och att lägga
 * den orörd mot vitt behåller rummet i den. Rätt svar är att skatta möbelns egen färg i just de
 * pixlarna (se `dekontaminera`), inte att flytta snittet inåt tills randen råkar hamna utanför.
 *
 * VAD SOM GÖRS I STÄLLET, i ordning:
 *
 *   1. `styrdFilter` — masken snäpps mot bildens EGNA kanter. Modellen svarar i 1024 px och vet
 *      ungefär var stolsbenet går; originalpixlarna vet exakt. Filtret låter de senare bestämma.
 *   2. `rensaOar`  — lösa fläckar bort, möbeln kvar, utan att kapa ben som hänger på en pixel.
 *   3. `mjukTroskel` — de sista tveksamheterna åt sitt håll, med bandet i mitten BEVARAT.
 *   4. `dekontaminera` — rummets färg ur kantpixlarna, så att inget skimmer blir kvar mot vitt.
 *
 * INGET AV DET RÖR MÖBELNS INRE PIXLAR. Steg 4 är det enda som skriver i färgkanalerna alls, och
 * det gör det bara där alfa säger att pixeln är en BLANDNING av möbel och rum — alltså i pixlar som
 * aldrig var möbelns färg att börja med. Allt med alfa över 0,98 går bit för bit orört igenom, och
 * det inkluderar varje repa, fläck och missfärgning kortet ska visa.
 */

import type { Arbetsbild, Karta } from "./segmentera.js";

/**
 * Filtrets radie som andel av bildens längsta sida.
 *
 * Proportionellt och inte i pixlar: en närbild och en helbild ska få lika mjuk kant i förhållande
 * till MÖBELN, inte i förhållande till sensorn. Ett fast tal i pixlar gör närbilden vaxig och
 * helbilden hackig, vilket är exakt vad den gamla `blur(box.width / 260)` gjorde.
 */
const RADIE_ANDEL = 0.006;
/**
 * Hur hårt filtret får jämna ut där bilden är slät.
 *
 * Litet tal = masken följer varje liten kontrastskillnad, även brus i en vägg. Stort tal = masken
 * blir slät och tappar stolsbenet. 1e-4 på 0–1-skalan är det värde He m.fl. anger för just
 * alfaförfining, och det är också vad som mätt gav bäst ben i benchmarken.
 */
const EPSILON = 1e-4;

/** Under detta är pixeln bakgrund så säkert att den får bära skuggan. Över: möbel, orörd. */
export const BAND_LAG = 0.02;
export const BAND_HOG = 0.98;

/**
 * Integralbild (summerad areatabell) i float64.
 *
 * Grunden till att hela förfiningen är O(n) i stället för O(n·r²). En box-summa över vilken
 * rektangel som helst blir fyra uppslagningar. float64 och inte float32 med flit: tabellen
 * ackumulerar miljontals värden och i float32 äter avrundningen upp de sista siffrorna, vilket
 * syns som ett svagt rutmönster i masken.
 */
function integral(src: Float64Array, b: number, h: number): Float64Array {
  const s = new Float64Array((b + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rad = 0;
    for (let x = 0; x < b; x++) {
      rad += src[y * b + x];
      s[(y + 1) * (b + 1) + x + 1] = s[y * (b + 1) + x + 1] + rad;
    }
  }
  return s;
}

/** Medelvärdet i en kvadrat med radien r runt varje pixel. Kanten hanteras genom att ytan krymps. */
function boxMedel(src: Float64Array, b: number, h: number, r: number): Float64Array {
  const s = integral(src, b, h);
  const ut = new Float64Array(b * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < b; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(b, x + r + 1);
      const summa =
        s[y1 * (b + 1) + x1] - s[y0 * (b + 1) + x1] - s[y1 * (b + 1) + x0] + s[y0 * (b + 1) + x0];
      ut[y * b + x] = summa / ((y1 - y0) * (x1 - x0));
    }
  }
  return ut;
}

/**
 * Styrt filter (He, Sun, Tang) med FÄRGSTYRNING.
 *
 * Vad det gör: masken skrivs om som en lokalt linjär funktion av bildens egna pixlar. Där bilden är
 * slät blir masken slät; där bilden har en kant får masken samma kant, på exakt samma pixel. Det är
 * så en 1024-pixlars gissning blir en kant som följer ett stolsben genom en mönstrad matta.
 *
 * FÄRG OCH INTE GRÅSKALA, och det är hela skillnaden på ett av de svåra fallen. En beige soffa mot
 * en beige vägg har nästan ingen kant i luminans — i gråskala är de två samma yta och filtret drar
 * masken tvärs över gränsen. I färg är de två olika, och 3×3-matrisen nedan ser det. Priset är nio
 * kovarianser i stället för en, och en symmetrisk 3×3-invers per pixel. Det är ungefär en halv
 * sekund på en mobilbild, vilket är rätt pris för att lösa ett fall som annars inte går att lösa.
 *
 * Inversen är skriven med kofaktorer i stället för en allmän lösare: matrisen är symmetrisk och
 * positivt definit (den är en kovariansmatris plus eps·I), så det finns inget pivoterande att göra
 * och determinanten kan inte bli noll.
 */
export function styrtFilter(
  guide: Buffer,
  p: Float32Array,
  b: number,
  h: number,
  radie: number,
  eps: number,
): Float32Array {
  const n = b * h;
  const I = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    I[0][i] = guide[i * 3] / 255;
    I[1][i] = guide[i * 3 + 1] / 255;
    I[2][i] = guide[i * 3 + 2] / 255;
  }
  const P = new Float64Array(n);
  for (let i = 0; i < n; i++) P[i] = p[i];

  const mI = I.map((k) => boxMedel(k, b, h, radie));
  const mP = boxMedel(P, b, h, radie);

  // Kovarianserna mellan varje färgkanal och masken.
  const cov: Float64Array[] = [];
  for (let k = 0; k < 3; k++) {
    const prod = new Float64Array(n);
    for (let i = 0; i < n; i++) prod[i] = I[k][i] * P[i];
    const m = boxMedel(prod, b, h, radie);
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = m[i] - mI[k][i] * mP[i];
    cov.push(c);
  }

  // Guidens egen kovariansmatris: sex tal per pixel, eftersom den är symmetrisk.
  const par: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  const varI = par.map(([k, l]) => {
    const prod = new Float64Array(n);
    for (let i = 0; i < n; i++) prod[i] = I[k][i] * I[l][i];
    const m = boxMedel(prod, b, h, radie);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = m[i] - mI[k][i] * mI[l][i];
    return v;
  });

  const a = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const bb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rr = varI[0][i] + eps;
    const rg = varI[1][i];
    const rb = varI[2][i];
    const gg = varI[3][i] + eps;
    const gb = varI[4][i];
    const bl = varI[5][i] + eps;

    const c0 = gg * bl - gb * gb;
    const c1 = gb * rb - rg * bl;
    const c2 = rg * gb - gg * rb;
    const det = rr * c0 + rg * c1 + rb * c2;
    // Ett degenererat fönster (en helt platt yta) ger determinant nära noll. Då finns ingen kant
    // att snäppa mot, och rätt svar är maskens eget medelvärde — inte en division som exploderar.
    if (Math.abs(det) < 1e-12) {
      a[0][i] = a[1][i] = a[2][i] = 0;
      bb[i] = mP[i];
      continue;
    }
    const inv = 1 / det;
    const i00 = c0 * inv;
    const i01 = c1 * inv;
    const i02 = c2 * inv;
    const i11 = (rr * bl - rb * rb) * inv;
    const i12 = (rg * rb - rr * gb) * inv;
    const i22 = (rr * gg - rg * rg) * inv;

    const c = [cov[0][i], cov[1][i], cov[2][i]];
    a[0][i] = i00 * c[0] + i01 * c[1] + i02 * c[2];
    a[1][i] = i01 * c[0] + i11 * c[1] + i12 * c[2];
    a[2][i] = i02 * c[0] + i12 * c[1] + i22 * c[2];
    bb[i] = mP[i] - (a[0][i] * mI[0][i] + a[1][i] * mI[1][i] + a[2][i] * mI[2][i]);
  }

  const ma = a.map((k) => boxMedel(k, b, h, radie));
  const mb = boxMedel(bb, b, h, radie);
  const ut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ma[0][i] * I[0][i] + ma[1][i] * I[1][i] + ma[2][i] * I[2][i] + mb[i];
    ut[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return ut;
}

/**
 * Lösa fläckar bort — men inte möbelben.
 *
 * `keepLargestBlob` i den gamla segment.ts gjorde nästan det här och hade en dyr bieffekt: den
 * körde på en HÅRT tröskad mask, där ett stolsben som hänger ihop med sitsen via några
 * halvtransparenta pixlar redan var avklippt. Benet blev då en egen liten form, mindre än sitsen,
 * och raderades — av koden som skulle rädda bilden.
 *
 * Här räknas sammanhanget på ett LÅGT golv (0,08 i stället för 0,5). Det som knappt hänger ihop
 * räknas som ihophängande, vilket är rätt: en modell som är osäker på ett stolsben är fortfarande
 * säker på att benet sitter på stolen. Sedan raderas bara det som är både litet och skilt.
 *
 * Bredd-först med egen kö, inte rekursion: en sammanhängande yta kan vara miljontals pixlar och en
 * rekursiv flodfyllning spräcker anropsstacken på just de bilder som fungerar bäst.
 */
export function rensaOar(alfa: Float32Array, b: number, h: number): void {
  const n = b * h;
  const PA = 0.08;
  const etikett = new Int32Array(n).fill(-1);
  const ko = new Int32Array(n);
  const storlekar: number[] = [];
  let storst = -1;
  let storstStorlek = 0;

  for (let start = 0; start < n; start++) {
    if (alfa[start] <= PA || etikett[start] !== -1) continue;
    const id = storlekar.length;
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
      if (x > 0 && alfa[p - 1] > PA && etikett[p - 1] === -1) { etikett[p - 1] = id; ko[svans++] = p - 1; }
      if (x < b - 1 && alfa[p + 1] > PA && etikett[p + 1] === -1) { etikett[p + 1] = id; ko[svans++] = p + 1; }
      if (y > 0 && alfa[p - b] > PA && etikett[p - b] === -1) { etikett[p - b] = id; ko[svans++] = p - b; }
      if (y < h - 1 && alfa[p + b] > PA && etikett[p + b] === -1) { etikett[p + b] = id; ko[svans++] = p + b; }
    }
    storlekar.push(storlek);
    if (storlek > storstStorlek) { storstStorlek = storlek; storst = id; }
  }

  if (storlekar.length <= 1) return;

  /**
   * En form får stanna om den är minst en tjugondel av den största.
   *
   * Inte bara den största: en säng med en lös gavel, ett bord med en avskild hylla och en soffa
   * fotograferad så att ett ben skyms på mitten är alla EN möbel i två former. Att alltid behålla
   * exakt en form gör den sortens möbel halv, och en halv möbel mot vitt ser trasig ut på ett sätt
   * ett rumsfoto aldrig gör.
   *
   * En tjugondel är samtidigt långt över vad en spegling, en tavla eller en stol i bakgrunden
   * brukar mäta när möbeln fyller bilden — de faller.
   */
  const golv = storstStorlek / 20;
  const behall = new Uint8Array(storlekar.length);
  for (let i = 0; i < storlekar.length; i++) behall[i] = storlekar[i] >= golv || i === storst ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const e = etikett[i];
    if (e === -1 || !behall[e]) alfa[i] = 0;
  }
}

/**
 * De sista tveksamheterna åt sitt håll — utan att platta till bandet.
 *
 * En smoothstep och inte en tröskel. Allt under `lag` blir rent 0 (annars ligger en svag dimma av
 * rummet över hela den vita duken), allt över `hog` blir rent 1 (annars är möbelns inre svagt
 * genomskinligt och det vita lyser igenom en mörk soffa). MELLAN dem behålls övergången, mjukt
 * omskalad — det är där tygkanten, glaset och den oskarpa bordskanten bor.
 */
export function mjukTroskel(alfa: Float32Array, lag = 0.06, hog = 0.94): void {
  const spann = hog - lag || 1;
  for (let i = 0; i < alfa.length; i++) {
    const t = (alfa[i] - lag) / spann;
    alfa[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }
}

/**
 * Rummets färg ur kantpixlarna.
 *
 * PROBLEMET, konkret: en pixel i kanten av en vit soffa framför en mörk vägg är kanske 50 % soffa.
 * Kameran registrerade en GRÅ pixel — blandningen. Lägger man den grå pixeln mot vitt med alfa 0,5
 * får man en grå rand runt hela soffan. Det är glorian, och den gamla koden dolde den genom att
 * skära bort kanten helt (tröskel 160), vilket kostade själva kanten.
 *
 * LÖSNINGEN är att skatta vad SOFFANS egen färg var i den pixeln, och lägga den mot vitt i stället.
 * Skattningen tas ur möbeln själv: ett alfaviktat medelvärde av de närliggande pixlar som är säkert
 * möbel. Det är inte påhittad färg — det är möbelns färg, hämtad någon pixel bort.
 *
 * VAD DET INTE ÄR: en retusch. Det körs BARA där alfa ligger mellan 0,02 och 0,98, alltså i pixlar
 * som per definition är en blandning av möbel och rum och därför aldrig bar möbelns riktiga färg.
 * Varje pixel över 0,98 — hela möbelns yta, varje repa, fläck, spricka och missfärgning kortet ska
 * visa — går bit för bit orörd igenom. Det är den gränsen som gör det här till kompositering och
 * inte till bildredigering, och den är därför en konstant och inte en inställning.
 *
 * Spridningen görs med samma boxmedel som filtret ovan: möbelns färg viktad med alfa³, delat med
 * alfa³. Kuben och inte alfa rakt av för att de SÄKRA pixlarna ska dominera skattningen — en
 * granne som själv är halvt rum ska knappt räknas.
 */
export function dekontaminera(rgb: Buffer, alfa: Float32Array, b: number, h: number, radie: number): void {
  const n = b * h;
  const vikt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alfa[i];
    vikt[i] = a >= BAND_HOG ? a * a * a : 0;
  }
  const mVikt = boxMedel(vikt, b, h, radie);

  const kanaler: Float64Array[] = [];
  for (let k = 0; k < 3; k++) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = vikt[i] * rgb[i * 3 + k];
    kanaler.push(boxMedel(v, b, h, radie));
  }

  for (let i = 0; i < n; i++) {
    const a = alfa[i];
    if (a <= BAND_LAG || a >= BAND_HOG) continue;
    const w = mVikt[i];
    // Ingen säker möbelpixel inom räckhåll — då finns ingenting att skatta ur, och den observerade
    // pixeln får stå kvar. Hellre en svag rand på ett ställe än en påhittad färg.
    if (w < 1e-6) continue;
    for (let k = 0; k < 3; k++) {
      const f = kanaler[k][i] / w;
      rgb[i * 3 + k] = f < 0 ? 0 : f > 255 ? 255 : Math.round(f);
    }
  }
}

/**
 * Hela kantförfiningen, i ordning. Ändrar `karta.data` och `bild.rgb` på plats.
 *
 * Att skriva på plats och inte returnera nytt är medvetet: buffertarna är tiotals megabyte och
 * varje kopia är en till. Anroparen äger dem och vet att de ändras — se produktbild.ts.
 */
export function forfina(bild: Arbetsbild, karta: Karta): Float32Array {
  const radie = Math.max(4, Math.round(Math.max(bild.bredd, bild.hojd) * RADIE_ANDEL));
  const alfa = styrtFilter(bild.rgb, karta.data, bild.bredd, bild.hojd, radie, EPSILON);
  rensaOar(alfa, bild.bredd, bild.hojd);
  mjukTroskel(alfa);
  // Dekontamineringen läser en STÖRRE omgivning än filtret: den ska hitta säker möbelfärg, och
  // närmaste säkra pixel kan ligga längre bort än kanten är bred.
  dekontaminera(bild.rgb, alfa, bild.bredd, bild.hojd, radie * 2);
  return alfa;
}
