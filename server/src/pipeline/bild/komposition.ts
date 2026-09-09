/**
 * Möbeln på sin plats i en vit ruta. Ingen modell inblandad — bara aritmetik på pixlar.
 *
 * Det här steget kan inte hitta på något, och det är med flit: allt som avgör hur bilden SER UT som
 * produktbild — beskärning, skala, marginal, var möbeln står, hur skuggan faller — sitter här och
 * ingen annanstans. Byts segmenteringsmodellen ut ser omslagen likadana ut ändå. Ett omslag som
 * skiljer sig beroende på vilken modell som råkade svara är inte ett omslag, det är två.
 */

import sharp from "sharp";
import { BAND_LAG } from "./kant.js";

/**
 * Slutrutans mått.
 *
 * KVADRAT, inte 1600×1200. Den liggande rutan är en vanlig e-handelsstorlek och hade gått lika bra
 * i ett vakuum — men Loopas rutnät i butiken, kortets bildyta (`.listing-stage-cutout` i styles.css)
 * och exporten till Tradera är alla byggda för en kvadrat, och en garderob i en liggande ruta blir
 * en garderob med två breda vita fält bredvid sig. Kvadraten är dessutom det som gör rutnätet till
 * en jämförelse mellan MÖBLER: alla kort lika stora, alla möbler lika högt räknade.
 *
 * 1600 och inte 1400 som förut: Traderas galleri visar 1200 px brett på en skärm med dubbel
 * pixeltäthet, och 1400 räckte inte hela vägen dit.
 */
export const RUTA = 1600;

/** Luften vid sidorna, som andel av rutan. */
const MARGINAL = 0.075;
/**
 * Luften ÖVER möbeln — större än den under. Det är hela "nedtyngd".
 *
 * En möbel som står exakt mitt i en kvadrat läses som svävande; en som står något under mitten läses
 * som stående på ett golv. Varje möbelkatalog gör samma sak och ingen av dem skriver ut varför.
 *
 * DE HÄR TVÅ TALEN LÅG TVÄRTOM i första versionen — 0,075 över och 0,11 under — och det var fel åt
 * precis fel håll. Tanken var rätt (skuggan behöver plats att tona ut i) men konsekvensen var att en
 * hög möbel, som fyller innerrutans höjd, fick 120 px luft över sig och 176 under: den svävade, av
 * regeln som skulle få den att stå. Testet i tests/produktbild.test.ts mäter numera just det
 * förhållandet, för felet är osynligt på en låg soffa och tydligt på en garderob.
 *
 * Skuggan får sin plats ändå: 0,075 av 1600 är 120 px under nederkanten, och kontaktskuggan är
 * några procent av möbelns höjd.
 */
const MARGINAL_OVER = 0.11;
/** Luften under möbeln. Mindre än den över — se ovan. */
const MARGINAL_UNDER = 0.075;

/** Kontaktskuggan. Diskret nog att man inte ser den, tydlig nog att möbeln står på något. */
const SKUGGA_HOJD = 0.045;
const SKUGGA_OPACITET = 0.20;
/**
 * Hur stor del av möbelns nederkant skuggan formas ur.
 *
 * Den gamla koden klämde ihop HELA silhuetten till en remsa, vilket gav en stol en skugga formad
 * som en stol — en mörk klick lika bred som ryggstödet, under benen. En riktig kontaktskugga är
 * formad som det som NUDDAR GOLVET. De nedersta åtta procenten är benen, medarna eller sockeln.
 */
const SKUGGA_UR_NEDERSTA = 0.08;

/** Möbelns ram i alfakanalen, plus hur många pixlar den täcker. Ett svep, ingen bildbehandling. */
export interface Ram {
  vanster: number;
  topp: number;
  bredd: number;
  hojd: number;
  yta: number;
}

export function ramFor(alfa: Float32Array, b: number, h: number): Ram | null {
  let minX = b;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let yta = 0;
  for (let y = 0; y < h; y++) {
    const rad = y * b;
    for (let x = 0; x < b; x++) {
      if (alfa[rad + x] <= BAND_LAG) continue;
      yta++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { vanster: minX, topp: minY, bredd: maxX - minX + 1, hojd: maxY - minY + 1, yta };
}

/**
 * RGBA-bufferten: säljarens pixlar plus den räknade alfakanalen, beskuren till möbelns ram.
 *
 * Vävd för hand, pixel för pixel, i stället för med sharps `joinChannel`. Två tysta fällor gjorde
 * den vägen obrukbar i den gamla koden och båda kostade en bild som SÅG ut att fungera:
 * `removeAlpha()` körs efter kanalskarven i sharps egen ordning och tog bort just den kanal den
 * nyss fått, och `extract()` i samma kedja som en skarv görs aldrig — beskärningen ligger i det
 * förberedande steget, före skarven, och faller tyst bort. Utfallet i båda fallen är originalbilden
 * med hela rummet kvar, utan ett enda felmeddelande.
 *
 * Slingan nedan har ingen ordning att missförstå: RGB in, alfa in, RGBA ut.
 */
function tillRgba(rgb: Buffer, alfa: Float32Array, b: number, h: number, ram: Ram): Buffer {
  const ut = Buffer.alloc(ram.bredd * ram.hojd * 4);
  for (let y = 0; y < ram.hojd; y++) {
    const kalla = (ram.topp + y) * b + ram.vanster;
    const mal = y * ram.bredd;
    for (let x = 0; x < ram.bredd; x++) {
      const s = kalla + x;
      const d = (mal + x) * 4;
      ut[d] = rgb[s * 3];
      ut[d + 1] = rgb[s * 3 + 1];
      ut[d + 2] = rgb[s * 3 + 2];
      ut[d + 3] = Math.round(alfa[s] * 255);
    }
  }
  return ut;
}

/**
 * Möbeln utan bakgrund, som en PNG med alfa. Det som sparas som `mask`-produktens andra hälft.
 *
 * Egen funktion och inte ett mellansteg i `komponera`, för att den transparenta bilden är en egen
 * leverans: den går att lägga mot vilken bakgrund som helst senare — ett annat rutnät, ett
 * nyhetsbrev, en annan marknadsplats — utan att omslaget behöver byggas om.
 */
export async function tillTransparent(
  rgb: Buffer,
  alfa: Float32Array,
  b: number,
  h: number,
  ram: Ram,
): Promise<Buffer> {
  return await sharp(tillRgba(rgb, alfa, b, h, ram), {
    raw: { width: ram.bredd, height: ram.hojd, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Skuggan: möbelns FÖTTER, hoptryckta till en remsa och suddade till en fläck.
 *
 * Räknas ur alfakanalen och läggs UNDER möbeln i kompositionen. Den rör alltså aldrig en enda pixel
 * av möbeln — den ligger bakom den, som en riktig skugga gör. Det är skillnaden mot att "lägga på
 * en skugga" i en bildeditor, och den skillnaden är varför skuggan får finnas på ett kort som lovar
 * att inte redigera möbeln.
 *
 * Marginalen runt remsan finns för att sharp inte suddar utanför duken: utan den klipps det som
 * skulle tona ut av vid remsans kant, och skuggan får två raka sidor.
 */
async function byggSkugga(
  skalad: Buffer,
  bredd: number,
  hojd: number,
): Promise<{ bild: Buffer; bredd: number; hojd: number; pad: number } | null> {
  const fotterHojd = Math.max(1, Math.round(hojd * SKUGGA_UR_NEDERSTA));
  const remsaHojd = Math.max(5, Math.round(hojd * SKUGGA_HOJD));
  const pad = Math.max(8, Math.round(bredd / 12));
  const sb = bredd + pad * 2;
  const sh = remsaHojd + pad * 2;

  try {
    const alfa = await sharp(skalad)
      .extractChannel(3)
      // Bara fötterna. Se SKUGGA_UR_NEDERSTA.
      .extract({ left: 0, top: hojd - fotterHojd, width: bredd, height: fotterHojd })
      .resize(bredd, remsaHojd, { fit: "fill" })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
      .blur(Math.max(3, bredd / 18))
      .linear(SKUGGA_OPACITET, 0)
      .extractChannel(0)
      .raw()
      .toBuffer();
    if (alfa.length !== sb * sh) return null;
    const bild = await sharp({
      // Varm mörk grå, inte svart: en ren svart skugga mot rent vitt läser som ett hål i duken.
      create: { width: sb, height: sh, channels: 3, background: { r: 26, g: 22, b: 18 } },
    })
      .joinChannel(alfa, { raw: { width: sb, height: sh, channels: 1 } })
      .png()
      .toBuffer();
    return { bild, bredd: sb, hojd: sh, pad };
  } catch {
    // Ingen skugga är ett fullgott utfall. Möbeln mot vitt utan skugga är en produktbild; en
    // felaktig skugga är ett fel man ser.
    return null;
  }
}

/**
 * Den färdiga produktbilden: möbeln, skuggan, och en botten.
 *
 * BOTTEN ÄR RENT #FFFFFF NÄR INGEN ANNAN GES, och det är fortfarande normalfallet — varenda bild i
 * annonsens galleri utom den första ligger mot vitt. Konventionen finns av ett skäl: den gör
 * jämförelsen mellan två kort till en jämförelse mellan två möbler och ingenting annat. Ett tidigare
 * försök la möbeln på säljarens EGEN bildruta, suddad och dämpad, i tron att rummet bär ljus och
 * storlek. Utfallet var att varje kort blev en bild av ett hem med en möbel i, och rutnätet såg ut
 * som en samling privata foton i stället för som en butik.
 *
 * `botten` FINNS FÖR STUDION, och skiljer sig från det försöket på den enda punkt som gjorde det
 * dåligt: bakgrunden är inte säljarens rum, den är INTE OLIKA FRÅN GÅNG TILL GÅNG. Det är en enda
 * incheckad bild av ett tomt fotostudiogolv, samma pixlar under varje annons i butiken (se
 * studio.ts). Rutnätet blir därför fortfarande en jämförelse mellan möbler — alla står i samma rum,
 * på samma golv, i samma ljus — precis som det vita gjorde, men med ett golv att stå på.
 *
 * Bufferten ska vara rå RGB i exakt RUTA×RUTA. Är den något annat faller bilden tillbaka på vitt i
 * stället för att bli fel: en bakgrund i fel storlek ger en fog som inte är vågrät, och det ser
 * värre ut än ingen studio alls.
 *
 * MÖBELN KAPAS ALDRIG. Skalningen är `fit: "inside"` mot innerrutan, alltså den största skala där
 * HELA möbeln får plats. Proportionerna behålls; ingen beskärning görs utöver den mot möbelns egen
 * ram, som per definition inte tar bort någon möbel.
 */
export async function komponera(
  rgb: Buffer,
  alfa: Float32Array,
  b: number,
  h: number,
  ram: Ram,
  botten: Buffer | null = null,
): Promise<Buffer | null> {
  const rgba = tillRgba(rgb, alfa, b, h, ram);

  const innerBredd = Math.round(RUTA * (1 - 2 * MARGINAL));
  const innerHojd = Math.round(RUTA * (1 - MARGINAL_OVER - MARGINAL_UNDER));
  const skalad = await sharp(rgba, { raw: { width: ram.bredd, height: ram.hojd, channels: 4 } })
    .resize({ width: innerBredd, height: innerHojd, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const ob = skalad.info.width;
  const oh = skalad.info.height;

  const vanster = Math.round((RUTA - ob) / 2);
  // Nederkanten på sin plats, inte mitten: möbeln ska stå på golvet i rutan. En låg soffa och en hög
  // garderob får då samma golv, vilket är vad som gör ett rutnät av kort till en hylla.
  const topp = Math.round(RUTA * (1 - MARGINAL_UNDER)) - oh;

  const lager: sharp.OverlayOptions[] = [];
  const skugga = await byggSkugga(skalad.data, ob, oh);
  if (skugga) {
    lager.push({
      input: skugga.bild,
      left: Math.max(0, Math.min(RUTA - skugga.bredd, vanster - skugga.pad)),
      top: Math.max(
        0,
        Math.min(RUTA - skugga.hojd, topp + oh - Math.round(oh * SKUGGA_HOJD * 0.55) - skugga.pad),
      ),
    });
  }
  lager.push({ input: skalad.data, left: vanster, top: Math.max(0, topp) });

  /**
   * Duken: studiobakgrunden när den finns och håller måttet, annars rent vitt.
   *
   * Storleken prövas HÄR och inte hos den som skickar in. Skälet är att det här är det enda stället
   * som vet vad en duk måste vara, och en bakgrund som är 1024 px hade tyst skalats av sharp till
   * något annat än det granskade rummet — med en fog som inte längre ligger där möbelns fötter
   * står.
   */
  const duk =
    botten && botten.length === RUTA * RUTA * 3
      ? sharp(botten, { raw: { width: RUTA, height: RUTA, channels: 3 } })
      : sharp({
          create: { width: RUTA, height: RUTA, channels: 3, background: { r: 255, g: 255, b: 255 } },
        });

  return await duk
    .composite(lager)
    // 4:4:4 utan färgunderabtastning: en möbelkant mot rent vitt är precis det mönster 4:2:0 gör
    // fransigt, och det syns som en färgad rand runt tunna ben.
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
