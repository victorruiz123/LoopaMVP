/**
 * Anropet som RITAR studiobakgrunden. Körs för hand, aldrig i drift.
 *
 * Skild fil från studio.ts med flit. Driften ska kunna läsa bakgrunden utan att någonsin kunna
 * generera en: den här modulen drar in Gemini-klienten, och en import som bara finns i ett skript
 * har inget att göra i den kedja som bygger omslag. Skulle någon en dag kalla på generering från
 * pipelinen är det ett steg som ska synas i en diff, inte något som råkar gå för att funktionen låg
 * i samma fil.
 *
 * Se studio.ts för varför bakgrunden är EN incheckad fil och inte ett anrop per jobb.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  HORISONT,
  HORISONT_TOLERANS,
  PROMPT,
  STUDIO_BESKRIVNING,
  STUDIO_FIL,
  STUDIO_KATALOG,
  fogen,
  normalisera,
  slappStudio,
} from "./studio.js";
import { RUTA } from "./komposition.js";

const MODELL = process.env.STUDIO_BILDMODELL?.trim() || "gemini-3-pro-image";

export interface Forslag {
  bild: Buffer;
  /** Var fogen hamnade, som andel uppifrån. Null när ingen tydlig fog finns. */
  fog: number | null;
}

function klient(): GoogleGenAI {
  const nyckel = process.env.GEMINI_API_KEY;
  if (!nyckel) throw new Error("GEMINI_API_KEY saknas — se server/.env");
  return new GoogleGenAI({ apiKey: nyckel });
}

/** Ett anrop, ett förslag. Null när modellen svarade utan bilddel. */
export async function genereraForslag(): Promise<Forslag | null> {
  const svar = await klient().models.generateContent({
    model: MODELL,
    contents: [{ role: "user", parts: [{ text: PROMPT }] }],
    config: { imageConfig: { aspectRatio: "1:1" } },
  });
  for (const del of svar.candidates?.[0]?.content?.parts ?? []) {
    if (!del.inlineData?.data) continue;
    const bild = await normalisera(Buffer.from(del.inlineData.data, "base64"));
    return { bild, fog: await fogen(bild) };
  }
  return null;
}

export interface Utfall {
  skrivet: boolean;
  fog: number | null;
  forsok: number;
  fel: string | null;
}

/**
 * Skriver bakgrunden och sidofilen bredvid den.
 *
 * SIDOFILEN ÄR INTE VALFRI. Bakgrunden ligger under varenda annons i butiken, och frågan "hur kom
 * den till?" har bara ett ärligt svar om prompten, modellen och den uppmätta fogen står bredvid
 * bilden. Utan den är enda vägen tillbaka att gissa sig till vad som en gång skrevs.
 */
async function skriv(bild: Buffer, fog: number, ursprung: string): Promise<void> {
  await mkdir(STUDIO_KATALOG, { recursive: true });
  await writeFile(STUDIO_FIL, bild);
  await writeFile(
    STUDIO_BESKRIVNING,
    JSON.stringify(
      {
        modell: MODELL,
        prompt: PROMPT,
        ruta: RUTA,
        horisontMal: HORISONT,
        horisontMatt: Number(fog.toFixed(4)),
        ursprung,
        skapad: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  slappStudio();
}

/**
 * Installerar ett förslag som någon tittat på.
 *
 * Vägen som faktiskt används. `--prov` ger några rum bredvid varandra och ett mänskligt öga väljer;
 * det som skiljer dem åt är sådant ingen mätning fångar — om golvet läser som ett plan, om
 * ljuspoolen hamnar bakom möbeln, om väggen har en ton som klär trä. Fogen kontrolleras ändå, för
 * den ena egenskapen som ÄR mätbar ska inte förloras bara för att en människa var med.
 */
export async function valjStudiobakgrund(kalla: string): Promise<Utfall> {
  if (!existsSync(kalla)) return { skrivet: false, fog: null, forsok: 0, fel: `${kalla} finns inte` };
  const bild = await normalisera(await readFile(kalla));
  const fog = await fogen(bild);
  if (fog === null) return { skrivet: false, fog: null, forsok: 0, fel: "ingen tydlig fog i bilden" };
  if (Math.abs(fog - HORISONT) > HORISONT_TOLERANS) {
    return {
      skrivet: false,
      fog,
      forsok: 0,
      fel:
        `fogen ligger på ${(fog * 100).toFixed(1)} %, utanför ${(HORISONT * 100).toFixed(0)} ± ` +
        `${(HORISONT_TOLERANS * 100).toFixed(0)} % — möbeln skulle stå på väggen`,
    };
  }
  await skriv(bild, fog, path.basename(kalla));
  return { skrivet: true, fog, forsok: 0, fel: null };
}

/**
 * Genererar tills fogen sitter rätt, och skriver då filen plus dess sidofil.
 *
 * TRE FÖRSÖK OCH SEDAN UPPGIVET, utan att skriva något. En bakgrund med fogen på 85 % lägger
 * möbelns fötter på väggen, och det felet syns på varje annons i butiken samtidigt — vilket är
 * värre än ingen bakgrund alls: utan fil faller omslaget tillbaka på rent vitt precis som förut.
 */
export async function byggStudiobakgrund(om: boolean): Promise<Utfall> {
  if (existsSync(STUDIO_FIL) && !om) {
    return { skrivet: false, fog: null, forsok: 0, fel: "finns redan" };
  }

  for (let forsok = 1; forsok <= 3; forsok++) {
    const forslag = await genereraForslag();
    if (!forslag) {
      console.info(`[studio] försök ${forsok}: modellen svarade utan bild`);
      continue;
    }
    if (forslag.fog === null) {
      console.info(`[studio] försök ${forsok}: ingen tydlig fog — förkastat`);
      continue;
    }
    const avvikelse = Math.abs(forslag.fog - HORISONT);
    const godkand = avvikelse <= HORISONT_TOLERANS;
    console.info(
      `[studio] försök ${forsok}: fog på ${(forslag.fog * 100).toFixed(1)} % ` +
        `(ville ha ${(HORISONT * 100).toFixed(0)} %) — ${godkand ? "godkänd" : "förkastad"}`,
    );
    if (!godkand) continue;

    await skriv(forslag.bild, forslag.fog, `automatiskt val, försök ${forsok}`);
    return { skrivet: true, fog: forslag.fog, forsok, fel: null };
  }

  return { skrivet: false, fog: null, forsok: 3, fel: "ingen bakgrund med fogen på rätt höjd" };
}

/**
 * Provläget: flera förslag till en mapp, ingenting i drift ändrat.
 *
 * Bakgrunden hamnar under varenda annons i butiken. Att välja den blint på ett anrop är att låta
 * tärningen bestämma hur hela lagret ser ut — några stycken bredvid varandra tar minuter, och är
 * den enda gången ett mänskligt öga behöver vara med i den här kedjan.
 */
export async function provaStudiobakgrunder(ut: string, antal: number): Promise<string[]> {
  await mkdir(ut, { recursive: true });
  const filer: string[] = [];
  for (let i = 1; i <= antal; i++) {
    const forslag = await genereraForslag();
    if (!forslag) {
      console.info(`[studio] förslag ${i}: modellen svarade utan bild`);
      continue;
    }
    const mal = path.join(ut, `forslag-${i}.jpg`);
    await writeFile(mal, forslag.bild);
    console.info(
      `[studio] förslag ${i}: ${mal}  fog=${forslag.fog === null ? "ingen tydlig" : `${(forslag.fog * 100).toFixed(1)} %`}`,
    );
    filer.push(mal);
  }
  return filer;
}
