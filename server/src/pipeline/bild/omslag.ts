/**
 * Produktbildssystemet på jobbnivå: vilken bildruta, vilka filer, och vad som får publiceras.
 *
 * Modulen ovanför (produktbild.ts) svarar på "gör en produktbild av det här fotot". Den här svarar
 * på de tre frågor som bara ett jobb kan svara på: VILKEN av säljarens sex bildrutor som ska bli
 * omslag, VAR filerna hamnar, och OM resultatet är bra nog att visa en köpare utan att en människa
 * tittat först.
 *
 * TVÅ MODELLER PER JOBB, och det är en avsiktlig obalans.
 *
 * Urvalet körs med den lilla modellen på ALLA bildrutor; själva omslaget byggs med den stora på DEN
 * VALDA. Skälet är att frågorna är olika svåra. "Vilken ruta visar hela möbeln?" behöver veta ungefär
 * var möbeln är och om den går utanför kanten — det klarar u2netp på en sekund. "Var går kanten på
 * stolsbenet?" behöver BiRefNet, som tar en dryg minut. Att köra den stora på sex rutor vore nio
 * minuter för att svara på en fråga den lilla redan svarat rätt på, och att köra den lilla på den
 * valda vore att spara en minut genom att förstöra produkten.
 *
 * FILERNA SOM SKRIVS, per jobb:
 *
 *   originals/<säljarens fil>   RÖRS ALDRIG. Läses, aldrig skrivs.
 *   cover/cover.jpg             produktbilden: möbeln mot rent vitt
 *   cover/transparent.png       möbeln utan bakgrund, mot vilken botten som helst
 *   cover/mask.png              silhuetten, för att kunna granska ett urklipp i efterhand
 *   cover/produktbild.json      metadata: modell, mått, kvalitetsdom, tid
 *
 * Att spara mask och metadata och inte bara den färdiga bilden är vad som gör ett dåligt omslag
 * möjligt att förstå ett halvår senare. Utan dem är enda felsökningen att köra om och hoppas.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedImage, CoverCutout } from "../../types.js";
import { MODELLER, valdModell } from "./modeller.js";
import { laddaArbetsbild, kartaFor, modellFinns, tillgangligModell } from "./segmentera.js";
import { forfina } from "./kant.js";
import { ramFor } from "./komposition.js";
import { medModell } from "./produktbild.js";

/**
 * Modellen som poängsätter bildrutorna.
 *
 * Den lilla med flit — se resonemanget överst. Går den inte att ladda görs urvalet inte alls, och då
 * används den ruta anroparen pekat ut: inspektionens `cover_image_index`, som ombeds visa hela möbeln
 * framifrån. Den är sämre kalibrerad, inte oinformerad.
 */
function urvalsmodell() {
  const namn = process.env.PRODUKTBILD_URVALSMODELL?.trim() || "u2netp";
  return MODELLER[namn] ?? MODELLER.u2netp;
}

/**
 * Hur väl en bildruta duger som PRODUKTBILD — billigt, utan att bygga den.
 *
 * Två frågor, och den andra är den som skiljer en produktbild från ett fotografi:
 *
 * 1. Hur STOR är möbeln i bilden? Bästa täckningen ligger runt en tredjedel. Femton procent är
 *    fotograferat på avstånd och blir grynigt; nittio procent är en närbild PÅ möbeln — allt om
 *    nötningen, ingenting om vilken möbel som säljs.
 * 2. Hur mycket ligger MOT KANTEN? Det är beviset på att möbeln fortsätter utanför bild. Under-
 *    kanten räknas inte: möbler står på golv, och att kräva luft under en soffa hade valt bort varje
 *    bildruta tagen i ögonhöjd.
 */
async function rutpoang(src: string): Promise<number> {
  const m = urvalsmodell();
  if (!(await modellFinns(m.namn))) return 0;
  const bild = await laddaArbetsbild(src);
  if (!bild) return 0;
  const karta = await kartaFor(bild, m);
  if (!karta) return 0;
  const alfa = forfina(bild, karta);
  const ram = ramFor(alfa, bild.bredd, bild.hojd);
  if (!ram) return 0;

  const tackning = ram.yta / (bild.bredd * bild.hojd);
  const ideal = 0.34;
  const passform = 1 - Math.min(1, Math.abs(tackning - ideal) / ideal);

  let kant = 0;
  for (let x = 0; x < bild.bredd; x++) if (alfa[x] > 0.02) kant++;
  for (let y = 0; y < bild.hojd; y++) {
    if (alfa[y * bild.bredd] > 0.02) kant++;
    if (alfa[y * bild.bredd + bild.bredd - 1] > 0.02) kant++;
  }
  const beskuren = Math.min(1, kant / (bild.bredd + 2 * bild.hojd));
  return passform * (1 - beskuren);
}

/**
 * Bildrutan omslaget byggs ur.
 *
 * Faller urvalet — ingen liten modell på disk, inga läsbara filer — används `reserv`, alltså
 * inspektionens egen vy-utpekning. Omslaget blir sämre valt, aldrig uteblivet.
 */
export async function valjRuta(
  dir: string,
  bildrutor: CapturedImage[],
  reserv: string | null,
): Promise<CapturedImage | null> {
  if (bildrutor.length === 0) return null;
  let bast: CapturedImage | null = null;
  let bastPoang = 0;
  for (const r of bildrutor) {
    try {
      const p = await rutpoang(path.join(dir, "originals", r.path));
      if (p > bastPoang) {
        bastPoang = p;
        bast = r;
      }
    } catch {
      // En bildruta som inte går att läsa är inget skäl att sluta välja bland de andra.
    }
  }
  return bast ?? bildrutor.find((r) => r.id === reserv) ?? bildrutor[0];
}

/**
 * Bygger jobbets omslag och skriver filerna. Null när det inte gick alls.
 *
 * `needsReview` STOPPAR INTE BYGGET. Bilden görs och sparas ändå, och det är hela poängen: en
 * människa ska kunna öppna cover/cover.jpg bredvid originalet och avgöra. Det domen styr är om
 * omslaget får gå ut PUBLIKT av sig självt — se `harGodkantOmslag` nedan, som är den enda platsen
 * den frågan besvaras.
 */
export async function byggOmslag(
  jobId: string,
  dir: string,
  bildrutor: CapturedImage[],
  reservRutaId: string | null,
): Promise<CoverCutout | null> {
  const t0 = Date.now();
  const modell = await tillgangligModell();
  if (!modell) {
    console.info("[omslag] ingen segmenteringsmodell på disk — se scripts/fetch-models.sh");
    return null;
  }

  const ruta = await valjRuta(dir, bildrutor, reservRutaId);
  if (!ruta) return null;

  const src = path.join(dir, "originals", ruta.path);
  const res = await medModell(src, modell);
  const tag = jobId.slice(0, 8);
  if (!res) {
    console.info(`[omslag] ${tag} ingen produktbild ur ${ruta.path}`);
    return null;
  }

  const ut = path.join(dir, "cover");
  await mkdir(ut, { recursive: true });
  await writeFile(path.join(ut, "cover.jpg"), res.processedImage);
  await writeFile(path.join(ut, "transparent.png"), res.transparent);
  await writeFile(path.join(ut, "mask.png"), res.mask);
  await writeFile(path.join(ut, "produktbild.json"), JSON.stringify(res.metadata, null, 2), "utf8");

  console.info(
    `[omslag] ${tag} modell=${modell.namn} ruta=${ruta.path} poäng=${res.qualityScore.toFixed(2)} ` +
      `${res.needsReview ? "GRANSKNING" : "godkänd"} ms=${Date.now() - t0}`,
  );

  return {
    sourceImageId: ruta.id,
    label: null,
    provider: modell.namn,
    createdAt: res.metadata.skapad,
    qualityScore: res.qualityScore,
    needsReview: res.needsReview,
    anmarkningar: res.metadata.kvalitet.anmarkningar.map((a) => a.kod),
  };
}

/**
 * Får omslaget visas för en köpare utan att någon tittat på det?
 *
 * EN ENDA PLATS svarar på den frågan, och alla som behöver veta frågar här: det publika kortet,
 * butikens rutnät och serverporten. Skulle de svara olika hade rutnätet pekat på en bild som porten
 * vägrar lämna ut, och varje sådan ruta blivit en trasig bild.
 *
 * ETT MÄTT BETYG KRÄVS. Inte "saknar invändningar" — ett faktiskt `qualityScore`, satt av
 * kvalitetskontrollen i den här kedjan.
 *
 * Skillnaden är inte teoretisk, den kostade hela butiken. Första versionen av den här funktionen
 * frågade bara `needsReview !== true`, med motiveringen att gamla urklipp "redan ligger ute och
 * redan har setts". Båda leden var fel. De 45 live-annonser som bar ett urklipp hade det från den
 * GAMLA kedjan (320-pixlarsmask, hård tröskel, ingen kantförfining), de saknar fälten helt, och
 * `undefined !== true` är sant — så de godkändes allihop. Samtidigt lyfte `imageUrlOf` urklippet
 * till förstahandsval före katalogbilden. Nettot: den sämsta bilden i systemet befordrades från
 * gömd till omslag på varje kort, i samma ändring som skulle göra omslagen bra.
 *
 * Ett saknat betyg är alltså inte ett tyst godkännande utan frånvaron av en kontroll, och ska läsas
 * som nej. Gör om dem med scripts/bygg-produktbilder.ts --gammal; tills dess visar korten
 * katalogbilden eller säljarens bildruta, precis som innan produktbildssystemet fanns.
 */
export function harGodkantOmslag(cutout: CoverCutout | null): boolean {
  if (!cutout) return false;
  if (typeof cutout.qualityScore !== "number") return false;
  return cutout.needsReview === false;
}

/** Modellen som skulle användas här och nu. För loggar och för skriptens rapporter. */
export function omslagsmodell(): string {
  return valdModell().namn;
}
