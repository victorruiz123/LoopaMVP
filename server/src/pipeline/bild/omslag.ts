/**
 * Produktbildssystemet på jobbnivå: vilken bildruta, vilka filer, och vad som får publiceras.
 *
 * Modulen ovanför (produktbild.ts) svarar på "gör en produktbild av det här fotot". Den här svarar
 * på de tre frågor som bara ett jobb kan svara på: VILKA av säljarens sex bildrutor som ska bli
 * annonsens bilder, VAR filerna hamnar, och OM resultatet är bra nog att visa en köpare utan att en
 * människa tittat först.
 *
 * ETT GALLERI, INTE EN BILD. Annonsen bär upp till `GALLERI_TAK` produktbilder och köparen bläddrar
 * mellan dem. Skälet är att en enda vy inte säljer en begagnad möbel: den som funderar på en soffa
 * för sex tusen vill se ryggen, sitsen och hur benen ser ut, och den frågan besvaras annars av en
 * mejlkonversation eller inte alls. Rutorna är redan filmade — vi lät dem ligga.
 *
 * VITT ÖVERALLT UTOM PÅ FÖRSTA BILDEN, som står i studion (studio.ts). Omslaget är annonsens ansikte
 * och ska se ut som en möbelkatalogs bild; de övriga är vinklar på samma möbel, och mot rent vitt
 * syns det att det ÄR samma urklippta möbel från ett annat håll. Fyra bilder av samma soffa i samma
 * rum, där bara vinkeln skiftar, läser i stället som fyra olika fotograferingar.
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
 *   cover/cover.jpg             OMSLAGET: möbeln i studion (mot vitt om ingen bakgrund finns)
 *   cover/galleri/1.jpg         samma bildruta som omslaget, mot rent vitt
 *   cover/galleri/2..N.jpg      annonsens övriga vinklar, mot rent vitt
 *   cover/transparent.png       omslagets möbel utan bakgrund, mot vilken botten som helst
 *   cover/mask.png              omslagets silhuett, för att kunna granska ett urklipp i efterhand
 *   cover/produktbild.json      metadata per byggd bild: modell, mått, kvalitetsdom, tid
 *
 * `cover.jpg` OCH `galleri/1.jpg` ÄR SAMMA MÖBEL PÅ SAMMA PLATS, med olika botten. Den vita finns
 * kvar som en egen fil därför att den är reserven: går studiobakgrunden förlorad, eller vill en
 * marknadsplats ha rent vitt, ligger den redan byggd i stället för att kräva ett nytt modellvarv.
 *
 * Att spara mask och metadata och inte bara den färdiga bilden är vad som gör ett dåligt omslag
 * möjligt att förstå ett halvår senare. Utan dem är enda felsökningen att köra om och hoppas.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedImage, CoverCutout, GalleryBild } from "../../types.js";
import { MODELLER, valdModell } from "./modeller.js";
import { laddaArbetsbild, kartaFor, modellFinns, tillgangligModell } from "./segmentera.js";
import { forfina } from "./kant.js";
import { ramFor } from "./komposition.js";
import { huvudbildspoang, medModell, type Produktbild } from "./produktbild.js";
import { STUDIO_NAMN } from "./studio.js";

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
 * Hur många produktbilder en annons bär, som mest.
 *
 * FEM, och taket är en kostnadsgräns lika mycket som en smakgräns. Varje bild är ett varv med den
 * stora modellen — en dryg minut på processor — så ett videovarv på åtta rutor vore tio minuter per
 * jobb på en burk som delar minne med prismotorn. Fem täcker en möbel runtom; bild sex och sju är i
 * praktiken grannar till bilder som redan står i galleriet.
 *
 * Bygget ligger utanför säljarens väntan (se pipeline/run.ts), så taket kostar ingen latens åt
 * någon som står och filmar — men det kostar en kö, och kön är gemensam.
 */
const GALLERI_TAK = Math.max(1, Number(process.env.PRODUKTBILD_GALLERI) || 5);

/**
 * Bildrutorna som är värda ett varv med den stora modellen, bäst först.
 *
 * TVÅ SIKTNINGAR, och det är hela poängen med att den lilla modellen finns. Här poängsätts ALLA
 * bildrutor billigt (`rutpoang`, u2netp, ~1 s) och de bästa `tak` går vidare; först de får den stora
 * modellen. Att köra BiRefNet på alla åtta för att sedan kasta tre vore fyra minuter för ingenting.
 *
 * Faller siktningen — ingen liten modell på disk, inga läsbara filer — används filmningsordningen
 * med `reserv` först. Galleriet blir sämre valt, aldrig uteblivet.
 */
export async function valjRutor(
  dir: string,
  bildrutor: CapturedImage[],
  reserv: string | null,
  tak = GALLERI_TAK,
): Promise<CapturedImage[]> {
  if (bildrutor.length === 0) return [];

  const poang: Array<{ ruta: CapturedImage; p: number }> = [];
  for (const r of bildrutor) {
    try {
      poang.push({ ruta: r, p: await rutpoang(path.join(dir, "originals", r.path)) });
    } catch {
      // En bildruta som inte går att läsa är inget skäl att sluta poängsätta de andra.
      poang.push({ ruta: r, p: 0 });
    }
  }

  /**
   * OMSLAGSBILDEN TAR SIN PLATS UTAN ATT TÄVLA.
   *
   * Den är komponerad på beställning — i möbelns egen höjd, snett framifrån — och ska byggas även om
   * `rutpoang` råkar gilla en bildruta ur filmen bättre. Poängen mäter täckning och beskärning på en
   * grov mask; den kan inte se att den ena bilden är den vi bad om.
   *
   * Att den byggs betyder inte att den blir omslag: det avgörs efter bygget, när kvaliteten är känd.
   */
  const bestalld = poang.find((x) => x.ruta.role === "cover");
  const dugliga = poang
    .filter((x) => x.p > 0 && x.ruta !== bestalld?.ruta)
    .sort((a, b) => b.p - a.p);
  const valda = [...(bestalld ? [bestalld] : []), ...dugliga];
  if (valda.length > 0) return valda.slice(0, tak).map((x) => x.ruta);

  const reservad = bildrutor.find((r) => r.id === reserv);
  const ordning = reservad ? [reservad, ...bildrutor.filter((r) => r !== reservad)] : bildrutor;
  return ordning.slice(0, tak);
}

/** Den enskilt bästa bildrutan. Kvar för anropare som bara vill ha en. */
export async function valjRuta(
  dir: string,
  bildrutor: CapturedImage[],
  reserv: string | null,
): Promise<CapturedImage | null> {
  return (await valjRutor(dir, bildrutor, reserv, 1))[0] ?? null;
}

/** En byggd bild på väg att bli en fil. */
interface Byggd {
  ruta: CapturedImage;
  bild: Produktbild;
  /** Hur väl just den här duger som ANNONSENS FÖRSTA bild. Se `huvudbildspoang`. */
  omslagspoang: number;
}

/**
 * Bygger jobbets galleri och skriver filerna. Null när ingen enda bild gick att göra.
 *
 * `needsReview` STOPPAR INTE BYGGET. Bilderna görs och sparas ändå, och det är hela poängen: en
 * människa ska kunna öppna cover/cover.jpg bredvid originalet och avgöra. Det domen styr är om de
 * får gå ut PUBLIKT av sig själva — se `harGodkantOmslag` och `publikaGalleribilder` nedan, som är
 * de enda platserna den frågan besvaras.
 *
 * EN FLAGGAD BILD STOPPAR INTE HELLER GALLERIET. Att den fjärde vinkeln fick en dålig mask är inget
 * skäl att undanhålla de tre som blev bra — den enskilda bilden faller ur den publika listan och
 * resten står kvar.
 */
export async function byggOmslag(
  jobId: string,
  dir: string,
  bildrutor: CapturedImage[],
  reservRutaId: string | null,
): Promise<CoverCutout | null> {
  const t0 = Date.now();
  const tag = jobId.slice(0, 8);
  const modell = await tillgangligModell();
  if (!modell) {
    console.info("[omslag] ingen segmenteringsmodell på disk — se scripts/fetch-models.sh");
    return null;
  }

  const rutor = await valjRutor(dir, bildrutor, reservRutaId);
  if (rutor.length === 0) return null;

  /**
   * SEKVENTIELLT, och det är aritmetik och inte försiktighet. Modellen är samma session och håller
   * ett par gigabyte medan den räknar; fem parallella är fem gånger minnet för att bli klara lika
   * fort som en tråd med fem uppgifter — på en burk som delar minne med prismotorn är det
   * skillnaden mellan långsamt och nere.
   */
  const byggda: Byggd[] = [];
  for (const ruta of rutor) {
    const src = path.join(dir, "originals", ruta.path);
    // `studio: true` på alla: vilken som blir omslag avgörs först nedan, när kvaliteten är känd, och
    // studioversionen är ren aritmetik på ett urklipp som redan finns. Se `Val` i produktbild.ts.
    const bild = await medModell(src, modell, Date.now(), { studio: true }).catch(() => null);
    if (!bild) {
      console.info(`[omslag] ${tag} ingen produktbild ur ${ruta.path}`);
      continue;
    }
    byggda.push({ ruta, bild, omslagspoang: await huvudbildspoang(src, bild) });
  }
  if (byggda.length === 0) return null;

  /**
   * OMSLAGET VÄLJS EFTER BYGGET, bland de bilder som faktiskt blev bra.
   *
   * `rutpoang` ovan gissade utifrån en grov mask vilka rutor som var värda ett varv. Den gissningen
   * kan slå fel på just den ruta där den stora modellen sedan tappar ett bordsben — och den bilden
   * ska då inte vara annonsens ansikte bara för att den såg lovande ut innan.
   *
   * TRE LED, i fallande styrka:
   *
   *   1. GODKÄND före flaggad, oavsett allt annat. En granskningsflagga är en mätt invändning, inte
   *      en nyans, och en beställd bild som klipptes sönder är fortfarande sönderklippt.
   *   2. BESTÄLLD före hittad. Är omslagsbilden godkänd vinner den — säljaren ställde sig i möbelns
   *      höjd och komponerade den, och ingen poängsättning av en filmruta väger upp det.
   *   3. Poängen, för resten.
   */
  byggda.sort((a, b) => {
    if (a.bild.needsReview !== b.bild.needsReview) return a.bild.needsReview ? 1 : -1;
    const aBestalld = a.ruta.role === "cover";
    const bBestalld = b.ruta.role === "cover";
    if (aBestalld !== bBestalld) return aBestalld ? -1 : 1;
    return b.omslagspoang - a.omslagspoang;
  });
  const omslag = byggda[0];

  const ut = path.join(dir, "cover");
  const galleriDir = path.join(ut, "galleri");
  await mkdir(galleriDir, { recursive: true });

  /**
   * Omslaget mot studiobakgrunden — eller mot vitt när ingen bakgrund ligger på disk.
   *
   * `cover.jpg` är adressen varje läsare redan känner (porten, butikens rutnät, Tradera-exporten),
   * och den ska fortsätta bära annonsens ansikte oavsett vilken botten det råkar ha. Att i stället
   * lägga studion på en ny adress hade tvingat varenda läsare att välja, och en av dem hade valt
   * fel.
   */
  await writeFile(path.join(ut, "cover.jpg"), omslag.bild.studioImage ?? omslag.bild.processedImage);
  await writeFile(path.join(ut, "transparent.png"), omslag.bild.transparent);
  await writeFile(path.join(ut, "mask.png"), omslag.bild.mask);

  const gallery: GalleryBild[] = [];
  for (let i = 0; i < byggda.length; i++) {
    const b = byggda[i];
    const fil = path.posix.join("galleri", `${i + 1}.jpg`);
    await writeFile(path.join(ut, fil), b.bild.processedImage);
    gallery.push({
      fil,
      sourceImageId: b.ruta.id,
      qualityScore: b.bild.qualityScore,
      needsReview: b.bild.needsReview,
    });
  }

  await writeFile(
    path.join(ut, "produktbild.json"),
    JSON.stringify(
      {
        ...omslag.bild.metadata,
        bakgrund: omslag.bild.studioImage ? STUDIO_NAMN : null,
        galleri: byggda.map((b, i) => ({
          fil: path.posix.join("galleri", `${i + 1}.jpg`),
          bildruta: b.ruta.path,
          omslagspoang: Number(b.omslagspoang.toFixed(3)),
          ...b.bild.metadata,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.info(
    `[omslag] ${tag} modell=${modell.namn} bilder=${byggda.length}/${rutor.length} ` +
      `omslag=${omslag.ruta.path} botten=${omslag.bild.studioImage ? STUDIO_NAMN : "vitt"} ` +
      `poäng=${omslag.bild.qualityScore.toFixed(2)} ` +
      `${omslag.bild.needsReview ? "GRANSKNING" : "godkänd"} ms=${Date.now() - t0}`,
  );

  return {
    sourceImageId: omslag.ruta.id,
    label: null,
    provider: modell.namn,
    createdAt: omslag.bild.metadata.skapad,
    qualityScore: omslag.bild.qualityScore,
    needsReview: omslag.bild.needsReview,
    anmarkningar: omslag.bild.metadata.kvalitet.anmarkningar.map((a) => a.kod),
    backdrop: omslag.bild.studioImage ? STUDIO_NAMN : null,
    gallery,
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

/**
 * Galleriets bilder som FÅR visas publikt, omslaget först. Tom lista när inget galleri finns.
 *
 * EN ENDA PLATS svarar på den frågan, precis som `harGodkantOmslag` gör för omslaget, och av samma
 * skäl: kortet, butiken och serverporten frågar alla här. Skulle de svara olika hade kortet ritat en
 * miniatyr för en bild porten vägrar lämna ut, och varje sådan miniatyr blivit en trasig bild.
 *
 * SAMMA KRAV PER BILD SOM PÅ OMSLAGET: ett faktiskt mätt betyg, och ingen granskningsflagga. Ett
 * saknat betyg läses som nej — se resonemanget i `harGodkantOmslag`, som den regeln kostade en hel
 * butik att lära sig.
 *
 * OMSLAGET STYR HELA GALLERIET. Duger inte annonsens första bild visar kortet inget galleri alls,
 * även om bild tre råkar vara godkänd: en bläddring som börjar i en bild vi inte står för är värre
 * än ingen bläddring, och kortet faller då tillbaka på samma enda bild som före galleriet.
 */
export function publikaGalleribilder(cutout: CoverCutout | null): GalleryBild[] {
  if (!harGodkantOmslag(cutout)) return [];
  return (cutout?.gallery ?? []).filter(
    (b) => typeof b.qualityScore === "number" && b.needsReview === false,
  );
}

/** Modellen som skulle användas här och nu. För loggar och för skriptens rapporter. */
export function omslagsmodell(): string {
  return valdModell().namn;
}
