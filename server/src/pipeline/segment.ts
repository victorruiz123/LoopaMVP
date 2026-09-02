/**
 * Silhuetten — räknad här, inte frågad efter.
 *
 * VARFÖR EN EGEN MODELL. Urklippet bad tidigare Gemini om masken, och den vägen levererar inte
 * pixlar. Mätt 2026-09-01 mot tre skarpa jobb svarade den med COCO-liknande RLE på två av dem
 * (`i^V13a010?K01O1000…`, som varken bär ett `size`-fält eller summerar till någon rimlig bildyta)
 * och på det tredje med ett korrekt PNG-huvud följt av skräp — samma hallucination som
 * cutout.ts redan beskriver. Noll av 172 jobb fick ett urklipp under hela den tiden, och felet syns
 * inte som ett fel: masken underkänns, undantaget sväljs, och kortet faller tillbaka på katalogbilden.
 *
 * U2Net gör en sak och gör den varje gång. Den är dessutom rätt sorts verktyg för uppgiften: en
 * segmenteringsmodell räknar en alfamask ur bilden, medan en språkmodell beskriver vad den ser. Det
 * som behövdes var aldrig en beskrivning.
 *
 * INGA PIXLAR HITTAS PÅ. Modellen producerar bara en mask — en gråskala som säger hur mycket av
 * varje pixel som är möbel. Möbelns egna färger går orörda genom hela kedjan; det enda som byts är
 * vad som ligger bakom den. Det är skillnaden mot att låta en bildmodell "måla om" fotot, och den
 * skillnaden är hela poängen på ett kort som annars pekar ut varje skråma.
 */

import path from "node:path";
import { access } from "node:fs/promises";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

/**
 * Modellens indatasida. U2Net är tränad på 320×320 och tappar kvalitet vid andra storlekar — masken
 * skalas i stället upp till originalet efteråt, vilket är vad även referensimplementationen gör.
 */
const INPUT_SIZE = 320;

/** ImageNet-normaliseringen U2Net tränades med. Fel värden ger en mask som ser nästan rätt ut. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const MODELS_DIR = path.resolve(import.meta.dirname, "..", "..", "models");

/**
 * Vilken modell som körs.
 *
 * `u2netp` är den lilla (4,4 MB), `u2net` den fulla (168 MB). Förvalet är den lilla med flit: den
 * här servern delar maskin med prismotorn, och 168 MB modellvikter i RAM är en verklig kostnad på en
 * Oracle-burk. Byt med SEGMENT_MODEL=u2net om kvaliteten kräver det — se tests/segment-jämförelsen
 * som togs fram när valet gjordes.
 */
function modelName(): string {
  return process.env.SEGMENT_MODEL?.trim() || "u2netp";
}

let session: ort.InferenceSession | null = null;
let loadedName: string | null = null;

/** Sant när modellfilen finns. Utan den är urklippet frånkopplat i stället för trasigt. */
export async function segmenterAvailable(): Promise<boolean> {
  try {
    await access(path.join(MODELS_DIR, `${modelName()}.onnx`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sessionen, laddad en gång och delad.
 *
 * Att ladda om modellen per bild kostar sekunder och lika mycket minne igen. Den hålls därför kvar
 * — och `loadedName` finns för att en ändrad SEGMENT_MODEL ska byta modell i stället för att tyst
 * fortsätta köra den gamla.
 */
async function getSession(): Promise<ort.InferenceSession> {
  const name = modelName();
  if (session && loadedName === name) return session;
  const file = path.join(MODELS_DIR, `${name}.onnx`);
  session = await ort.InferenceSession.create(file, {
    // En tråd: servern kör besiktningar parallellt, och en modell som tar alla kärnor gör varje
    // annat anrop långsammare för att den här bilden ska bli några tiondelar snabbare.
    intraOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  loadedName = name;
  console.info(`[segment] modell ${name} laddad`);
  return session;
}

/**
 * Möbelns mask som en PNG i originalets storlek.
 *
 * Returnerar en gråskale-PNG där vitt är möbel och svart är bakgrund — exakt det format
 * `composeCutout` i cutout.ts redan väntar sig och redan har tester för. Den aritmetiken rörs inte:
 * tröskel, mjuk kant, beskärning, centrering och kontaktskugga är samma kod som förut, bara matad
 * med en mask som faktiskt är en mask.
 */
export async function segmentToMask(src: string | Buffer): Promise<Buffer | null> {
  if (!(await segmenterAvailable())) return null;

  const meta = await sharp(src).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;

  // Bilden till modellens ruta. `fill` och inte `inside`: masken skalas tillbaka till originalets
  // proportioner efteråt, och en bevarad aspekt här hade betytt svarta fält modellen tolkar som yta.
  const { data } = await sharp(src)
    .removeAlpha()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    // NCHW: alla röda först, sedan gröna, sedan blå — inte pixel för pixel.
    input[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0];
    input[pixels + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * pixels + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const sess = await getSession();
  const feeds = { [sess.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
  const output = await sess.run(feeds);
  // U2Net lämnar sju kartor (d0–d6) — d0 är den sammanvägda och den enda som ska användas.
  const map = output[sess.outputNames[0]].data as Float32Array;
  if (map.length < pixels) return null;

  /**
   * Kartan normaliseras mot sitt EGET spann, inte mot 0–1.
   *
   * Modellen svarar med logits vars faktiska omfång varierar mellan bilder. Klipps de rakt av mot
   * 0–1 blir en mask på en svag bild nästan svart och underkänns av kvalitetsspärren i cutout.ts —
   * en möbel som modellen faktiskt hittade skulle då se ut som ett misslyckande.
   */
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels; i++) {
    const v = map[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;

  const gray = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) gray[i] = Math.round(((map[i] - min) / span) * 255);

  keepLargestBlob(gray, INPUT_SIZE, INPUT_SIZE);

  return await sharp(gray, { raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 } })
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
}

/**
 * Behåller den STÖRSTA sammanhängande formen och suddar resten.
 *
 * U2Net letar framträdande objekt, inte möbler, och ett vardagsrum har fler än ett. Mätt på en
 * skarp bildruta klippte den ut soffan OCH tavlan ovanför den — två fläckar mot vitt, där kortet
 * ska visa en möbel. Möbeln som säljs är den som fotografiet handlar om, och i en bildruta tagen
 * för att sälja den är den alltid den största formen i bild.
 *
 * Görs på 320×320-masken, före uppskalningen: 102 400 pixlar är en försumbar genomgång, medan samma
 * arbete på originalet hade varit miljontals.
 *
 * En bredd-först-genomgång med en egen kö, inte rekursion: en sammanhängande yta kan vara tiotusentals
 * pixlar stor, och en rekursiv flodfyllning spräcker anropsstacken på precis de bilder som fungerar
 * bäst.
 */
export function keepLargestBlob(gray: Buffer, width: number, height: number): void {
  const n = width * height;
  // Samma golv som alphaBounds i cutout.ts räknar yta med, så formen här är den som mäts där.
  const ON = 40;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let best = -1;
  let bestSize = 0;
  let current = 0;

  for (let start = 0; start < n; start++) {
    if (gray[start] <= ON || label[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = current;
    let size = 0;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % width;
      const y = (p - x) / width;
      // Fyra grannar räcker: en silhuett som bara hänger ihop diagonalt är en kant, inte en möbel.
      if (x > 0 && gray[p - 1] > ON && label[p - 1] === -1) { label[p - 1] = current; queue[tail++] = p - 1; }
      if (x < width - 1 && gray[p + 1] > ON && label[p + 1] === -1) { label[p + 1] = current; queue[tail++] = p + 1; }
      if (y > 0 && gray[p - width] > ON && label[p - width] === -1) { label[p - width] = current; queue[tail++] = p - width; }
      if (y < height - 1 && gray[p + width] > ON && label[p + width] === -1) { label[p + width] = current; queue[tail++] = p + width; }
    }
    if (size > bestSize) { bestSize = size; best = current; }
    current++;
  }

  // En enda form, eller ingen alls: ingenting att välja mellan.
  if (current <= 1) return;
  for (let i = 0; i < n; i++) if (label[i] !== best) gray[i] = 0;
}

/**
 * Hur väl en bildruta duger som PRODUKTBILD.
 *
 * Omslagsrutan väljs i dag av `resolveCoverImageId` (cover.ts) efter vad som visar SKICKET bäst, och
 * det är rätt kriterium för skickrapporten. Det är fel kriterium för ett omslag: en närbild på ett
 * armstöd säger allt om nötningen och ingenting om vilken möbel som säljs. Mätt på lagret gav det
 * urklipp där soffan var halv, med en korg eller en hylla som råkade sitta ihop med den.
 *
 * Två frågor, och den andra är den som skiljer en produktbild från ett fotografi:
 *
 * 1. Hur STOR är möbeln i bilden? En möbel som fyller femton procent av rutan är fotograferad på
 *    avstånd, och urklippet blir litet och grynigt.
 * 2. Hur mycket av den ligger MOT KANTEN? Det är beviset på att den fortsätter utanför bild. En
 *    möbel som är helt med i rutan rör inte vänsterkanten, högerkanten eller överkanten.
 *
 * Underkanten straffas INTE: möbler står på golv, och golvet är där bilden slutar. Att kräva luft
 * under en soffa hade valt bort varje bildruta tagen i ögonhöjd.
 */
export interface FrameScore {
  /** Andel av bilden som är möbel, 0–1. */
  coverage: number;
  /** Andel av silhuettens kant som ligger mot bildens kant, 0–1. Lägre är bättre. */
  clipped: number;
  /** Sammanvägt. Högre är bättre; 0 betyder oanvändbar. */
  score: number;
}

export async function scoreFrame(src: string | Buffer): Promise<FrameScore | null> {
  const mask = await segmentToMask(src);
  if (!mask) return null;
  const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const ON = 40;

  let area = 0;
  let edge = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] <= ON) continue;
      area++;
      // Vänster, höger och över — inte under. Se resonemanget ovan.
      if (x === 0 || x === width - 1 || y === 0) edge++;
    }
  }
  if (area === 0) return null;

  const coverage = area / (width * height);
  // Kantandelen mäts mot silhuettens omkrets och inte mot ytan: en stor möbel har fler kantpixlar
  // bara för att den är stor, och den ska inte straffas för sin storlek.
  const perimeter = 2 * (width + height);
  const clipped = Math.min(1, edge / perimeter);

  /**
   * En möbel som fyller nästan hela rutan är oftast en närbild PÅ möbeln, inte en bild AV den.
   * Bästa täckningen ligger runt en tredjedel; både mycket mindre och mycket större är sämre.
   */
  const ideal = 0.34;
  const fit = 1 - Math.min(1, Math.abs(coverage - ideal) / ideal);
  const score = fit * (1 - clipped);
  return { coverage, clipped, score };
}

/** Släpper modellen ur minnet. För skript som kör en gång och ska avslutas. */
export async function releaseSegmenter(): Promise<void> {
  await session?.release();
  session = null;
  loadedName = null;
}
