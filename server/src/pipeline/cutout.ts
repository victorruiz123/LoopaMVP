/**
 * Omslaget: säljarens egen möbel, fri från rummet den råkade stå i.
 *
 * Kortet bar förut tillverkarens katalogbild — en NY exemplar av modellen. Den svarar snabbt på
 * "vad är det här?" och lika snabbt fel på "vad är det jag köper?": en fläckfri studiosoffa ovanför
 * ett pris som gäller en tio år gammal. Ett kort som annars räknar upp varje skråma har då det
 * största påståendet på sig — bilden — hämtat någon annanstans ifrån.
 *
 * Men säljarens bild är tagen i ett rum, och rummet säljer ingenting. Bildrutan som utlöste det här
 * arbetet är en barstol framför ett kylskåp, med läskbackar, sopsäckar och en dörrmatta omkring —
 * samma stol som i katalogen, fast omöjlig att se. Skillnaden mellan ett foto och en produktbild är
 * inte kameran, det är bakgrunden. Alltså klipps möbeln ur och läggs på vitt.
 *
 * TVÅ HALVOR, och bara den ena är en modell:
 *
 * 1. SILHUETTEN kommer från Gemini, som svarar med möbelns mask (segmentering). Det är den enda
 *    delen som kan ha fel, och därför den enda som prövas: en mask som täcker halva bilden eller
 *    nästan ingenting alls är inte en möbel, och då blir det inget urklipp (se maskGodtagbar).
 * 2. EFTERBEHANDLINGEN är aritmetik i sharp — tröskel, mjuk kant, beskärning till möbelns egen
 *    ram, centrering på vitt och en kontaktskugga byggd ur silhuetten själv. Ingenting av det kan
 *    hitta på något: det är samma pixlar, flyttade.
 *
 * VAD SOM INTE GÖRS: ingen färg rörs. Ingen uppljusning, ingen mättnad, ingen retusch. Loopas
 * kort sätter ut skadorna i stället för att sudda dem, och ett omslag som "fixats till" vore samma
 * lögn i bildform. Möbeln byter bakgrund, ingenting annat.
 *
 * Anropet ligger UTANFÖR säljarens väntan: det startas när inspektionen är klar och skrivs till disk
 * när det blir klart, medan säljaren fortfarande väljer modell. Blir det inte klart, eller blir det
 * inte bra, visar kortet säljarens bildruta som den är — se ListingView.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Type, callGeminiStructured, type ImagePart } from "../gemini.js";
import { loadImageAsBase64 } from "../imageUtils.js";
import type { CoverCutout } from "../types.js";

/** Omslagets sida i pixlar. Kvadratiskt, som varje produktbild i varje butik. */
export const COVER_SIZE = 1400;
/** Luften runt möbeln, som andel av rutan. Under det ser bilden trång ut, över det ser den tom ut. */
const MARGIN = 0.075;
/**
 * Var i rutan möbeln står. Något ovanför mitten: skuggan behöver plats under sig, och en möbel som
 * står exakt mitt i en kvadrat ser ut att sväva.
 */
const LIFT = 0.035;
/** Kontaktskuggans höjd, som andel av möbelns egen höjd. */
const SHADOW_HEIGHT = 0.055;
const SHADOW_OPACITY = 0.22;

/**
 * Var silhuettens kant går i sannolikhetskartan.
 *
 * Högre än mitten med flit. Masken kommer tillbaka som en gråskala, och de svagaste pixlarna längs
 * kanten är rummet bakom möbeln, inte möbeln. Skär man vid 128 följer en ljus rand av bakgrunden
 * med runt hela urklippet och syns som en gloria mot det vita — 160 lägger snittet strax innanför
 * kanten i stället, vilket är fel man inte ser.
 */
const MASK_THRESHOLD = 160;

/** Masken får inte vara nästan hela bilden (då är det rummet) eller nästan ingenting (då är det brus). */
const MIN_AREA_FRACTION = 0.03;
const MAX_AREA_FRACTION = 0.9;
/** En silhuett smalare än så är inte en möbel, hur säker modellen än är. */
const MIN_SIDE_FRACTION = 0.08;

const SYSTEM_PROMPT = `Du är ett segmenteringsverktyg för produktbilder. Du får ETT foto av en möbel som
någon vill sälja, taget hemma eller i en lokal, med allt annat som råkar finnas i rummet omkring.

Din enda uppgift: peka ut MÖBELN SOM SÄLJS och lämna tillbaka dess silhuett som mask.

VAD SOM ÄR MÖBELN:
- Den möbel som står i bildens förgrund och är fotograferad med avsikt — den som fyller mest av
  bilden och som bilden uppenbart handlar om.
- HELA möbeln, inklusive ben, fötter, medar, stolpar, armstöd, ryggstöd och de kuddar som ligger i
  eller på den och hör till den. Smala delar är lätta att missa och är just de som gör silhuetten
  till en möbel i stället för en klump: ta med varje ben ända ned till golvet.

VAD SOM INTE ÄR MÖBELN:
- Golv, matta, vägg, tak, dörr, fönster, garderob, kyl, hyllor och varor på dem.
- Andra möbler i rummet, även om de står tätt intill.
- Föremål som ligger löst ovanpå och inte hör till möbeln (kaffekopp, väska, kläder, verktyg).
- Möbelns skugga på golvet eller väggen.

Hittar du ingen sådan möbel: svara found=false och lämna box_2d tom och mask som tom sträng.`;

const SEGMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    found: { type: Type.BOOLEAN, description: "true om en möbel i förgrunden kunde pekas ut" },
    box_2d: {
      type: Type.ARRAY,
      items: { type: Type.INTEGER },
      description: "Möbelns omslutande rektangel som [y0, x0, y1, x1], normaliserad till 0-1000.",
    },
    mask: {
      type: Type.STRING,
      description:
        "Möbelns mask INOM rektangeln, som en PNG i base64 på formen 'data:image/png;base64,...'. " +
        "Vit = möbel, svart = allt annat. Masken ska täcka exakt rektangelns yta.",
    },
    label: { type: Type.STRING, description: "Vad möbeln är, ett eller två ord: 'barstol', 'soffa'." },
  },
  required: ["found", "box_2d", "mask", "label"],
};

interface Segmentation {
  found: boolean;
  box_2d: number[];
  mask: string;
  label: string;
}

/** Möbelns ram i pixlar i originalbilden. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Bygger omslaget för en bildruta och skriver det till `<jobbmapp>/cover/cover.jpg`.
 *
 * Returnerar null när det inte gick — och det är ett fullgott utfall. Kortet har en väg till en bild
 * ändå (säljarens bildruta som den är), och ett halvt urklipp är sämre än inget: en soffa med ett
 * avklippt ben mot vitt ser trasig ut på ett sätt ett vardagsrumsfoto aldrig gör.
 */
export async function buildCover(
  jobId: string,
  dir: string,
  imageId: string,
  imagePath: string,
): Promise<CoverCutout | null> {
  const startedAt = Date.now();
  const src = path.join(dir, "originals", imagePath);
  const meta = await sharp(src).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;

  const part = await loadImageAsBase64(src);
  const segmented = await segment(part);
  if (!segmented) return null;

  const box = pixelBox(segmented.box_2d, width, height);
  if (!box) return null;

  const cover = await composeCutout(src, maskBuffer(segmented.mask), box, width, height);
  if (!cover) {
    console.info(`[omslag] ${jobId.slice(0, 8)} masken underkänd — kortet får bildrutan som den är`);
    return null;
  }

  await mkdir(path.join(dir, "cover"), { recursive: true });
  await sharp(cover).toFile(path.join(dir, "cover", "cover.jpg"));

  console.info(
    `[omslag] ${jobId.slice(0, 8)} urklipp=${segmented.label || "möbel"} ms=${Date.now() - startedAt}`,
  );
  return { sourceImageId: imageId, label: segmented.label || null, createdAt: new Date().toISOString() };
}

/**
 * Den halva som inte kan hitta på något: bild in, mask in, produktbild ut.
 *
 * Bruten ut ur buildCover för att den går att pröva utan att fråga en modell — se tests/cutout.test.ts,
 * som ritar en känd figur, maskar den och mäter var i rutan den hamnade. Returnerar null när masken
 * inte duger som möbel, och det är hela kvalitetsspärren: den sitter på silhuetten, aldrig på
 * modellens självförtroende.
 */
export async function composeCutout(
  src: string | Buffer,
  mask: Buffer,
  box: Box,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const alpha = await buildAlpha(mask, box, width, height);
  if (!alpha) return null;

  const bounds = alphaBounds(alpha, width, height);
  if (!bounds || !maskAcceptable(bounds, width, height)) return null;

  return await compose(src, alpha, width, height, bounds);
}

/** Masken kommer som "data:image/png;base64,…" ur modellen och som rena bytes ur ett test. */
function maskBuffer(mask: string): Buffer {
  const base64 = mask.includes(",") ? mask.slice(mask.indexOf(",") + 1) : mask;
  return Buffer.from(base64, "base64");
}

/** Silhuetten från modellen. Ett anrop, inga omförsök utöver wrapperns egna — omslaget är inte kritiskt. */
async function segment(part: ImagePart): Promise<Segmentation | null> {
  try {
    const { data } = await callGeminiStructured<Segmentation>({
      purpose: "cover_cutout",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: "Peka ut möbeln som säljs i den här bilden och lämna dess mask enligt schemat.",
      images: [part],
      responseSchema: SEGMENT_SCHEMA,
      // Masken ÄR upplösningen: en silhuett räknad ur en nedskalad bild tappar stolsben.
      resolution: "high",
      primaryTimeoutMs: 30_000,
    });
    return data?.found && data.mask ? data : null;
  } catch {
    return null;
  }
}

/** [y0, x0, y1, x1] i tusendelar → pixlar, klippt mot bildens kant. */
export function pixelBox(box2d: number[], width: number, height: number): Box | null {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const [y0, x0, y1, x1] = box2d;
  const left = Math.max(0, Math.min(width - 1, Math.round((Math.min(x0, x1) / 1000) * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round((Math.min(y0, y1) / 1000) * height)));
  const right = Math.max(0, Math.min(width, Math.round((Math.max(x0, x1) / 1000) * width)));
  const bottom = Math.max(0, Math.min(height, Math.round((Math.max(y0, y1) / 1000) * height)));
  const w = right - left;
  const h = bottom - top;
  return w > 8 && h > 8 ? { left, top, width: w, height: h } : null;
}

/**
 * Maskens gråskala, utlagd på en duk i originalets storlek.
 *
 * Modellen svarar med en mask som täcker RAMEN, inte bilden — den skalas alltså in på sin plats och
 * resten av duken är svart. Sedan tröskel och en mjuk kant: masken kommer tillbaka i låg upplösning
 * och en rak uppskalning ger trappsteg längs varje kant. Suddet är proportionellt mot ramens bredd,
 * så en närbild och en helbild får lika mjuk kant i förhållande till möbeln.
 */
async function buildAlpha(mask: Buffer, box: Box, width: number, height: number): Promise<Buffer | null> {
  let maskRaw: Buffer;
  try {
    maskRaw = await sharp(mask)
      .greyscale()
      .resize(box.width, box.height, { fit: "fill" })
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
  if (maskRaw.length !== box.width * box.height) return null;

  const canvas = Buffer.alloc(width * height, 0);
  for (let y = 0; y < box.height; y++) {
    maskRaw.copy(canvas, (box.top + y) * width + box.left, y * box.width, (y + 1) * box.width);
  }

  const sigma = Math.max(0.6, box.width / 260);
  // extractChannel efter tröskeln, inte före: sharp trösklar via gråskala och lämnar tillbaka TRE
  // band, så en rå buffert härifrån är tre gånger för lång. Läst som en kanal blir masken en
  // meningslös remsa — och felet syns inte som ett fel, bara som ett urklipp som alltid underkänns.
  const alpha = await sharp(canvas, { raw: { width, height, channels: 1 } })
    .threshold(MASK_THRESHOLD)
    .blur(sigma)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return alpha.length === width * height ? alpha : null;
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
}

/** Möbelns egen ram i masken, plus hur många pixlar den täcker. Ett svep, ingen bildbehandling. */
function alphaBounds(alpha: Buffer, width: number, height: number): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] <= 40) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
}

/**
 * Duger masken som möbel?
 *
 * Tre frågor, alla ställda på silhuetten och inte på modellens självförtroende: täcker den nästan
 * hela bilden är det rummet som pekats ut, täcker den nästan ingenting är det brus, och är den
 * smalare än en tumsbredd av bilden är det en detalj — inte möbeln.
 */
function maskAcceptable(bounds: Bounds, width: number, height: number): boolean {
  const fraction = bounds.area / (width * height);
  if (fraction < MIN_AREA_FRACTION || fraction > MAX_AREA_FRACTION) return false;
  return bounds.width / width >= MIN_SIDE_FRACTION && bounds.height / height >= MIN_SIDE_FRACTION;
}

/**
 * Möbeln, urklippt och satt på vitt.
 *
 * Skuggan är byggd ur silhuetten själv, ihoptryckt och suddad: en oval hade legat lika bred under
 * ett stolsben som under en soffa, och det som gör en produktbild trovärdig är just att skuggan
 * känner igen formen ovanför sig. Den läggs FÖRE möbeln, annars ligger den ovanpå fötterna.
 */
async function compose(
  src: string | Buffer,
  alpha: Buffer,
  width: number,
  height: number,
  bounds: Bounds,
): Promise<Buffer | null> {
  /**
   * Masken vävs in för hand, pixel för pixel, i stället för med sharps `joinChannel`.
   *
   * Två tysta fällor gjorde den vägen obrukbar, och båda kostade en bild som SÅG ut att fungera:
   * `removeAlpha()` körs EFTER kanalskarven i sharps egen ordning och tog alltså bort just den
   * kanal den nyss fått, och `extract()` i samma kedja som en skarv görs aldrig — beskärningen
   * ligger i det förberedande steget, före skarven, och faller tyst bort. Utfallet i båda fallen är
   * originalbilden med hela rummet kvar, utan ett enda felmeddelande.
   *
   * Slingan nedan har ingen ordning att missförstå: RGB in, alfa in, RGBA ut. Den kostar ett svep
   * över bilden, någon millisekund, och den kan bara göra en sak.
   */
  const rgb = await sharp(src).removeAlpha().raw().toBuffer();
  // Tre kanaler är vad en jpeg ur kameran ger. Något annat är en bild vi inte tänkt oss här, och
  // då blir det inget urklipp — hellre säljarens bildruta som den är än ett gissat urklipp.
  if (rgb.length !== width * height * 3) return null;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const cut = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .png()
    .toBuffer();

  const content = Math.round(COVER_SIZE * (1 - 2 * MARGIN));
  const scaled = await sharp(cut)
    .resize({ width: content, height: content, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const objectWidth = scaled.info.width;
  const objectHeight = scaled.info.height;

  const left = Math.round((COVER_SIZE - objectWidth) / 2);
  const top = Math.round((COVER_SIZE - objectHeight) / 2 - COVER_SIZE * LIFT);

  // Skuggan: samma silhuett, hoptryckt till en remsa och suddad till en fläck.
  const shadowHeight = Math.max(6, Math.round(objectHeight * SHADOW_HEIGHT));
  const shadowAlpha = await sharp(scaled.data)
    .extractChannel(3)
    .resize(objectWidth, shadowHeight, { fit: "fill" })
    .blur(Math.max(2, objectWidth / 45))
    .linear(SHADOW_OPACITY, 0)
    .extractChannel(0)
    .raw()
    .toBuffer();
  const shadow = await sharp({
    create: { width: objectWidth, height: shadowHeight, channels: 3, background: { r: 20, g: 17, b: 13 } },
  })
    .joinChannel(shadowAlpha, { raw: { width: objectWidth, height: shadowHeight, channels: 1 } })
    .png()
    .toBuffer();

  return await sharp({
    create: { width: COVER_SIZE, height: COVER_SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: shadow, left, top: Math.min(COVER_SIZE - shadowHeight, top + objectHeight - Math.round(shadowHeight / 2)) },
      { input: scaled.data, left, top },
    ])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
