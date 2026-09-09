/**
 * Inferensen: bild in, sannolikhetskarta ut. Vet ingenting om vilken modell den kör.
 *
 * Allt som skiljer U2Net från BiRefNet — indatasida, normalisering, passform, hur utdata läses,
 * flyttalsbredd — står i modeller.ts och läses härifrån. Det är hela skälet filen finns: den gamla
 * segment.ts hade fyra av de sakerna som konstanter i sin egen kropp, och att byta modell var
 * därför en omskrivning.
 *
 * VAD SOM KOMMER UT: en karta över hur mycket av varje pixel som är möbel. Inga pixlar hittas på,
 * inga färger rörs, ingenting målas om. Möbeln går orörd genom hela kedjan och det enda som byts är
 * vad som ligger bakom den. Det är skillnaden mot en generativ bildmodell, och på ett kort som
 * räknar upp varje skråma är den skillnaden hela produkten.
 */

import path from "node:path";
import { access } from "node:fs/promises";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { MODELLER, RESERVKEDJA, valdModell, type Modell } from "./modeller.js";
import { korModell, slappTraden } from "./inferens.js";

const MODELLKATALOG = path.resolve(import.meta.dirname, "..", "..", "..", "models");

/**
 * Taket för hur stor bild resten av kedjan arbetar på.
 *
 * Kantförfiningen (kant.ts) sveper över varje pixel flera gånger, och en obeskuren mobilbild är
 * fyra tusen pixlar bred. Slutbilden är 1600, så allt över ungefär det dubbla är arbete som ändå
 * skalas bort — men marginalen behövs: förfiningen ska ha fler pixlar att arbeta med än
 * slutbilden har, annars syns dess egna avrundningar i den färdiga rutan.
 */
export const ARBETSSIDA = 2048;

/** En sannolikhetskarta i en känd storlek. Värden 0–1, där 1 är säkert möbel. */
export interface Karta {
  data: Float32Array;
  bredd: number;
  hojd: number;
}

/** Bilden som allt räknas på: nedskalad till ARBETSSIDA, tre kanaler, orörda färger. */
export interface Arbetsbild {
  rgb: Buffer;
  bredd: number;
  hojd: number;
  /** Originalets mått, för att kunna säga hur mycket som skalats bort. */
  originalBredd: number;
  originalHojd: number;
}

/**
 * Trådar åt modellen. En i drift som förut — men numera i EN EGEN TRÅD (inferens.ts), så den enda
 * kärnan den tar är inte den som svarar säljaren. Benchmarken sätter fler via PRODUKTBILD_TRADAR.
 */
const TRADAR = Number(process.env.PRODUKTBILD_TRADAR ?? 1);

function modellfil(namn: string): string {
  return path.join(MODELLKATALOG, `${namn}.onnx`);
}

export async function modellFinns(namn: string): Promise<boolean> {
  try {
    await access(modellfil(namn));
    return true;
  } catch {
    return false;
  }
}

/**
 * Modellen som faktiskt går att köra här.
 *
 * Den valda om filen finns, annars den bästa som finns i RESERVKEDJA. Null bara när ingen modell
 * alls ligger på disk — då blir det inget urklipp, och kortet visar bildrutan som den är.
 *
 * Att falla nedåt i stället för att kasta är medvetet: en burk utan de tunga filerna ska ge ett
 * sämre omslag, inte ett kraschat jobb. Vilken som faktiskt kördes skrivs in i metadatan, så ett
 * omslag som ser fel ut går att härleda till sin modell.
 */
export async function tillgangligModell(): Promise<Modell | null> {
  const vald = valdModell();
  if (await modellFinns(vald.namn)) return vald;
  for (const namn of RESERVKEDJA) {
    if (namn !== vald.namn && (await modellFinns(namn))) {
      console.info(`[produktbild] ${vald.namn} saknas på disk — kör ${namn} i stället`);
      return MODELLER[namn];
    }
  }
  return null;
}

/** Släpper alla modeller ur minnet. För skript som kör en gång och ska avslutas. */
export async function slappModeller(): Promise<void> {
  await slappTraden();
}

/**
 * Originalbilden nedskalad till arbetsstorlek, som rå RGB.
 *
 * `removeAlpha` och tre kanaler med flit: resten av kedjan väver alfakanalen för hand, pixel för
 * pixel, och en indata med fyra kanaler hade gjort varje sådan slinga fel utan att kasta.
 * Originalfilen rörs aldrig — den ligger kvar i originals/ precis som den laddades upp.
 */
export async function laddaArbetsbild(src: string | Buffer): Promise<Arbetsbild | null> {
  const meta = await sharp(src).metadata();
  const ob = meta.width ?? 0;
  const oh = meta.height ?? 0;
  if (!ob || !oh) return null;

  const { data, info } = await sharp(src)
    .rotate() // EXIF-rotationen bakas in. Utan den ligger masken på tvären mot bilden.
    .removeAlpha()
    .resize(ARBETSSIDA, ARBETSSIDA, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) return null;
  return { rgb: data, bredd: info.width, hojd: info.height, originalBredd: ob, originalHojd: oh };
}

/**
 * Bilden in i modellens kvadrat, normaliserad, som en NCHW-tensor.
 *
 * NCHW betyder alla röda först, sedan alla gröna, sedan alla blå — inte pixel för pixel. Ett fel
 * här kastar inte: modellen svarar, bara med en mask som ser ut som en gissning.
 *
 * `brevlada` fyller ut med neutral grå i stället för att klämma ihop bilden. Vilket som blir bäst
 * går inte att resonera fram — ett stolsben blir bredare av att en liggande bild kläms till kvadrat,
 * och smalare av att en stående gör det — så registret bär valet per modell och benchmarken avgör.
 */
async function tillTensor(
  bild: Arbetsbild,
  m: Modell,
): Promise<{ tensor: ort.Tensor; skala: number; padX: number; padY: number }> {
  const rå = sharp(bild.rgb, { raw: { width: bild.bredd, height: bild.hojd, channels: 3 } });

  let data: Buffer;
  let skala = 1;
  let padX = 0;
  let padY = 0;

  if (m.passform === "fyll") {
    data = await rå.resize(m.sida, m.sida, { fit: "fill" }).raw().toBuffer();
  } else {
    skala = Math.min(m.sida / bild.bredd, m.sida / bild.hojd);
    const b = Math.max(1, Math.round(bild.bredd * skala));
    const h = Math.max(1, Math.round(bild.hojd * skala));
    padX = Math.floor((m.sida - b) / 2);
    padY = Math.floor((m.sida - h) / 2);
    data = await rå
      .resize(b, h, { fit: "fill" })
      // Neutral grå, inte svart eller vit: en svart kant kan läsas som föremål och en vit som
      // studiobakgrund. 114 är samma val som varje detektionsmodell gör av samma skäl.
      .extend({
        top: padY,
        left: padX,
        bottom: m.sida - h - padY,
        right: m.sida - b - padX,
        background: { r: 114, g: 114, b: 114 },
      })
      .raw()
      .toBuffer();
  }

  const n = m.sida * m.sida;
  const flat = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    flat[i] = (data[i * 3] / 255 - m.medel[0]) / m.avvikelse[0];
    flat[n + i] = (data[i * 3 + 1] / 255 - m.medel[1]) / m.avvikelse[1];
    flat[2 * n + i] = (data[i * 3 + 2] / 255 - m.medel[2]) / m.avvikelse[2];
  }

  const dims = [1, 3, m.sida, m.sida];
  /**
   * Casten runt float16 är biblioteksversionens fel, inte vår.
   *
   * onnxruntime-common 1.20.1 typar Tensor-konstruktorn så att "float16" inte får ta en Uint16Array,
   * medan den nativa bindningen kräver exakt det. Ingen av typerna beskriver alltså vad som
   * faktiskt fungerar. Casten är smal med flit — den sitter på ETT anrop och inte på variabeln — så
   * att den dagen ORT rättar sina typer syns raden här och kan tas bort.
   *
   * Ingen modell i registret kör fp16 i dag (se modeller.ts om varför BiRefNet är fullvikt). Vägen
   * står kvar för att den blir rätt igen så snart en burk kan köra ORT 1.29.
   */
  const tensor = m.fp16
    ? (new (ort.Tensor as unknown as new (t: string, d: Uint16Array, dims: number[]) => ort.Tensor)(
        "float16",
        tillFloat16(flat),
        dims,
      ) as ort.Tensor)
    : new ort.Tensor("float32", flat, dims);
  return { tensor, skala, padX, padY };
}

/**
 * Float32 → IEEE 754 halvprecision, som de råa 16-bitarsmönstren i en Uint16Array.
 *
 * BiRefNet-filen är exporterad i fp16 för att halvera 973 MB, och tar därför fp16 in.
 *
 * NODE 24 HAR Float16Array, OCH DEN GÅR INTE ATT ANVÄNDA HÄR. Den vägen provades först och är den
 * uppenbara: `Float16Array.from(flat)` rakt in i tensorn. onnxruntime-common i den version servern
 * kör känner bara igen Uint16Array som bärare av float16 och avvisar den nya typen —
 * "must be a typed array (4) ... but got typed array (11)". Bitmönstren är identiska; det är
 * etiketten biblioteket inte känner igen. Raden går att byta tillbaka den dag ORT hunnit ikapp.
 *
 * Subnormaler och oändligheter hanteras, inte för att de kan uppstå i en normaliserad bildpixel
 * (det kan de inte) utan för att en tyst avrundning åt fel håll här hade sett ut som en modell
 * som gissar — och det är en gåta man letar länge efter.
 */
export function tillFloat16(src: Float32Array): Uint16Array {
  const ut = new Uint16Array(src.length);
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = i32[0];
    const tecken = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mantissa = x & 0x7fffff;
    if (exp === 0xff) {
      ut[i] = tecken | 0x7c00 | (mantissa ? 0x200 : 0);
      continue;
    }
    const e = exp - 127 + 15;
    if (e >= 0x1f) {
      ut[i] = tecken | 0x7c00;
    } else if (e <= 0) {
      if (e < -10) ut[i] = tecken;
      else {
        mantissa |= 0x800000;
        ut[i] = tecken | (mantissa >> (14 - e));
      }
    } else {
      ut[i] = tecken | (e << 10) | (mantissa >> 13);
    }
  }
  return ut;
}

/** Halvprecision tillbaka till float32. Utdata kommer i samma bredd som indata gick in. */
export function franFloat16(src: Uint16Array): Float32Array {
  const ut = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i];
    const tecken = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exp === 0) ut[i] = tecken * mantissa * 2 ** -24;
    else if (exp === 0x1f) ut[i] = mantissa ? NaN : tecken * Infinity;
    else ut[i] = tecken * (1 + mantissa / 1024) * 2 ** (exp - 15);
  }
  return ut;
}

/**
 * Kartan ur modellsvaret, läst enligt registrets `utdata`.
 *
 * `minmax` sträcker mot kartans eget spann — nödvändigt för U2Net och ISNet, som svarar med logits
 * vars omfång varierar mellan bilder. `sannolikhet` låter kartan vara: BiRefNet har redan en sigmoid
 * i grafen, och att sträcka en kalibrerad sannolikhet vore att kasta bort just det som gör den bra.
 */
function lasKarta(rå: Float32Array, sida: number, m: Modell): Float32Array {
  const n = sida * sida;
  const ut = new Float32Array(n);
  if (m.utdata === "sannolikhet") {
    for (let i = 0; i < n; i++) ut[i] = Math.min(1, Math.max(0, rå[i]));
    return ut;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = rå[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const spann = max - min || 1;
  for (let i = 0; i < n; i++) ut[i] = (rå[i] - min) / spann;
  return ut;
}

/**
 * Möbelns sannolikhetskarta i arbetsbildens storlek.
 *
 * Uppskalningen görs bilinjärt via sharp på en 8-bitars mellanform. Att gå via byte kostar ett steg
 * i precision som ingen kant kan bära vidare — kantförfiningen som följer arbetar ändå i flyttal på
 * originalpixlarna, och det är den som avgör var kanten hamnar.
 */
export async function kartaFor(bild: Arbetsbild, m: Modell): Promise<Karta | null> {
  const { tensor, skala, padX, padY } = await tillTensor(bild, m);
  /**
   * Modellen körs i en EGEN TRÅD, och det är inte en optimering utan en förutsättning.
   *
   * `run` räknar synkront på den tråd som anropar den. Låg den kvar här blockerade den hela servern
   * i minuter — pollning, timers, nästa besiktning — och den enda symptomen säljaren såg var en
   * skärm som stod kvar på "Bilder förberedda". Se inferens.ts.
   *
   * FÖRSTA UTGÅNGEN läses där borta, alltid — och det är inte självklart: ISNet lämnar tolv kartor
   * och U2Net sju (d0–d6). Bara den första är den sammanvägda; resten är mellansteg från olika djup
   * i nätet, användbara under träning och missvisande här. En modell som plötsligt ser suddig ut är
   * oftast en modell där fel utgång lästes.
   */
  const t = await korModell(modellfil(m.namn), TRADAR, {
    typ: m.fp16 ? "float16" : "float32",
    data: tensor.data as Float32Array | Uint16Array,
    dims: [1, 3, m.sida, m.sida],
  });
  // Typen läses ur svaret: en modell som svarar i halvprecision ska breddas, en som svarar i
  // float32 ska inte röras.
  const rå = t.typ === "float16" ? franFloat16(t.data as Uint16Array) : (t.data as Float32Array);
  const n = m.sida * m.sida;
  if (rå.length < n) return null;

  const karta = lasKarta(rå, m.sida, m);

  // Kartan till 8 bitar för uppskalningen. Brevlådans grå fält skärs bort först, annars skalas
  // utfyllnaden in i bilden och möbeln flyttar sig några pixlar åt vänster.
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.round(karta[i] * 255);

  let bild8 = sharp(bytes, { raw: { width: m.sida, height: m.sida, channels: 1 } });
  if (m.passform === "brevlada") {
    const b = Math.max(1, Math.round(bild.bredd * skala));
    const h = Math.max(1, Math.round(bild.hojd * skala));
    bild8 = bild8.extract({ left: padX, top: padY, width: b, height: h });
  }

  const upp = await bild8.resize(bild.bredd, bild.hojd, { fit: "fill" }).raw().toBuffer();

  /**
   * KANALBREDDEN LÄSES, den antas inte.
   *
   * sharp lämnar TRE band tillbaka från en enkanalig resize — samma fälla som `buildAlpha` i den
   * gamla cutout.ts redan bär en kommentar om, och den kostade en timme här också. Felet kastar
   * inte: bufferten är tre gånger för lång, läses den som en kanal blir masken en meningslös remsa
   * som alltid underkänns, och det ser ut som att modellen inte hittade någon möbel.
   *
   * Att räkna fram klivet ur längden kan inte ha fel oavsett vad sharp bestämmer sig för i nästa
   * version. Banden är ändå identiska — det är en gråskala som fått sällskap av sig själv.
   */
  const n2 = bild.bredd * bild.hojd;
  const kliv = Math.round(upp.length / n2);
  if (kliv < 1 || upp.length !== n2 * kliv) return null;

  const data = new Float32Array(n2);
  for (let i = 0; i < n2; i++) data[i] = upp[i * kliv] / 255;
  return { data, bredd: bild.bredd, hojd: bild.hojd };
}
