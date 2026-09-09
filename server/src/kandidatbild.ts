import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./jobStore.js";

/**
 * Modellväljarens miniatyrer, hämtade EN gång och sedan våra egna.
 *
 * Kandidatbilderna pekade tidigare rakt på butikernas egna adresser: servern letade upp en
 * produktsida, plockade ut `og:image`, och skickade den adressen till telefonen. Säljaren fick
 * därmed hämta bilden själv, från ett CDN vi inte råder över, över mobilnätet — och det är det som
 * gör att rutorna står och snurrar.
 *
 * TRE SAKER GICK FEL PÅ DEN VÄGEN, och alla tre försvinner här:
 *
 *   1. STORLEKEN. En produktbild i butikens katalog är ofta 2000 px bred och ett par megabyte. Rutan
 *      den ritas i är under 200 px. Säljaren väntade alltså på hundra gånger fler bytes än skärmen
 *      kan visa.
 *   2. TYSTNADEN. Ett CDN som inte svarar ger varken fel eller bild — anslutningen är inte bruten,
 *      bara stum — och webbläsaren väntar utan tidsgräns. Väljarskärmen har en egen på tolv sekunder
 *      just därför, och tolv sekunders skimmer är precis den upplevelse som ska bort.
 *   3. LÄNKSKYDDET. Flera butiker vägrar lämna ut bilder till en främmande sida. Servern har ingen
 *      sådan spärr mot sig: den hämtar med sidans egen adress som `referer`, alltså som en läsare
 *      som redan står på produktsidan.
 *
 * HÄMTNINGEN ÄR OCKSÅ KONTROLLEN. Förut ställdes en HEAD-fråga för att se om adressen levde, och
 * sedan hoppades det bästa. Nu är beviset att bilden faktiskt ligger på disk: går den inte att hämta
 * eller att avkoda finns den inte, och kandidaten får nästa adress i stället för en tom ruta hos
 * säljaren.
 *
 * Cachen är innehållsadresserad på källadressen. Samma soffa som skannas av tio säljare hämtas en
 * gång; de nio andra får filen som redan ligger där.
 */

/**
 * Var miniatyrerna ligger. En FUNKTION och inte en konstant, för att testerna ska kunna peka om den.
 *
 * Utan den möjligheten skrev testkörningen påhittade modeller — "Sits NORDVIKEN" — i driftens
 * register, och nästa säljare som råkade ha en NORDVIKEN hade fått en bild ur ett test. Ett test som
 * kan förorena driften är värre än inget test.
 */
export function kandidatbilderDir(): string {
  return process.env.LOOPA_KANDIDATBILDER_DIR || path.join(DATA_DIR, "kandidatbilder");
}

/** Adressen klienten får. Serveras av `/api/kandidatbild/:fil` — en ren filutlämning, se server.ts. */
const URL_PREFIX = "/api/kandidatbild";

/**
 * Miniatyrens största sida.
 *
 * Rutan i väljaren är under 200 px bred. 400 räcker för dubbel pixeltäthet och lämnar marginal om
 * rutan växer; en jpeg i den storleken landar på 15–30 kB, vilket är storleksordningen "syns direkt"
 * även på ett svagt mobilnät.
 */
const MINIATYR_PX = 400;

/** Så länge en hämtning får hålla på. Bilden ligger inte på någons kritiska väg, men den får inte hänga. */
const HAMTA_TIMEOUT_MS = 6000;

/**
 * Minsta sida på en bild som får duga som produktbild — MÄTT, inte utläst.
 *
 * Sidorna bär `width`-attribut som säger vad som helst, och den gamla spärren i candidateImages
 * kunde bara tro på dem: stod ingen storlek passerade bilden. Följden var att en 58 × 58 pixlar stor
 * butiksikon från ikea.com.tw blev SÖDERHAMNs kandidatbild, uppblåst i väljaren.
 *
 * Här är bilden redan hämtad och avkodad, så frågan går att ställa till pixlarna. En bild vars
 * största sida är under 200 px är en ikon, en logotyp eller en spårpixel — aldrig en möbel — och
 * anroparen får ta nästa adress på sidan i stället.
 */
const MIN_SIDA_PX = 200;

/**
 * Taket för vad vi läser in. Produktbilder är sällan över några megabyte; en sida som skickar mer
 * skickar något annat än en bild, och den ska inte få äta minne medan den bevisar det.
 */
const MAX_BYTES = 8 * 1024 * 1024;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Filnamnet för en källadress. Innehållsadresserat, så samma bild aldrig hämtas två gånger. */
function filnamn(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.jpg`;
}

/**
 * Hämtningar som pågår, per filnamn.
 *
 * Fyra kandidater kan peka på samma bild, och identifieringen prövar dessutom om bilden när färgen
 * blivit känd. Utan den här skulle samma adress hämtas flera gånger parallellt och skriva över sig
 * själv medan den lästes.
 */
const pagar = new Map<string, Promise<string | null>>();

/**
 * Källadress in, lokal adress ut. Null när bilden inte gick att hämta eller inte var en bild.
 *
 * NULL ÄR ETT SVAR OCH INTE ETT FEL: anroparen tar nästa bildadress på sidan. Det är hela skillnaden
 * mot förut, då en oprövad adress skickades vidare och blev säljarens problem.
 */
export async function lokalKandidatbild(url: string, referer: string | null = null): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const namn = filnamn(url);
  const abs = path.join(kandidatbilderDir(), namn);

  // Redan hämtad. Det vanliga fallet så fort en modell setts en gång tidigare.
  if (existsSync(abs)) return `${URL_PREFIX}/${namn}`;

  const pagaende = pagar.get(namn);
  if (pagaende) return await pagaende;

  const arbete = hamta(url, referer, abs, namn).finally(() => pagar.delete(namn));
  pagar.set(namn, arbete);
  return await arbete;
}

async function hamta(url: string, referer: string | null, abs: string, namn: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(HAMTA_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        "user-agent": UA,
        /**
         * INGEN AVIF, och det är inte en smaksak.
         *
         * sharp bär en libheif som inte klarar IKEA:s AVIF-ström: `Bitstream not supported by this
         * decoder`. Butikerna innehållsförhandlar — samma adress som slutar på `.jpg` lämnar ut AVIF
         * så fort vi säger att vi tar emot det — så varenda IKEA-bild föll på avkodningen, och IKEA
         * är det vanligaste märket i listan. Mätt på samma adress: med avif 519 kB som inte gick att
         * avkoda, utan avif 482 kB webp som blev en 28 kB miniatyr.
         *
         * Att be om mindre är alltså att få mer. Vill man ha AVIF tillbaka är det libheif som ska
         * bytas, inte den här raden.
         */
        accept: "image/webp,image/jpeg,image/png,image/*;q=0.8",
        // Butikens egen sida som avsändare. Det är den som gör att länkskyddade CDN:er svarar.
        ...(referer ? { referer } : {}),
      },
    });
    if (!res.ok) return null;

    const langd = Number(res.headers.get("content-length"));
    if (Number.isFinite(langd) && langd > MAX_BYTES) return null;

    const ra = Buffer.from(await res.arrayBuffer());
    if (ra.length === 0 || ra.length > MAX_BYTES) return null;

    /**
     * SHARP ÄR KONTROLLEN. En felsida med statuskod 200 — den vanligaste döda bilden av alla — är
     * HTML, och HTML går inte att avkoda som en bild. Att fråga efter innehållstypen hade varit att
     * lita på ett påstående; det här är ett försök.
     *
     * `withoutEnlargement` för att en liten källbild inte ska skalas upp till suddighet, och
     * `flatten` mot vitt för att en png med genomskinlighet annars blir svart som jpeg.
     */
    const bild = sharp(ra);
    const matt = await bild.metadata();
    // Mätt storlek, inte påstådd. Se MIN_SIDA_PX.
    if (Math.max(matt.width ?? 0, matt.height ?? 0) < MIN_SIDA_PX) return null;

    const miniatyr = await bild
      .resize(MINIATYR_PX, MINIATYR_PX, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 80 })
      .toBuffer();

    await mkdir(kandidatbilderDir(), { recursive: true });
    /**
     * Skrivs under ett tillfälligt namn och byter namn sist.
     *
     * `existsSync` ovan är hela cachens uppslagning. Skrevs filen på plats direkt skulle en samtidig
     * läsare kunna se ett halvskrivet namn som "färdigt" och servera en trasig bild. Namnbytet är
     * atomärt: filen finns antingen inte, eller finns hel.
     */
    const tmp = `${abs}.${process.pid}.tmp`;
    await writeFile(tmp, miniatyr);
    await rename(tmp, abs);
    return `${URL_PREFIX}/${namn}`;
  } catch {
    // Timeout, avbruten anslutning, något som inte var en bild. Alla betyder samma sak för anroparen.
    return null;
  }
}

/**
 * REGISTRET: märke och modell → färdig miniatyr.
 *
 * Cachen ovan sparar en HÄMTNING; det här sparar hela LETANDET. Att hitta bilden till en modell tar
 * fem till tjugo sekunder — sidor ska hämtas, sökmotorer frågas, träffar rangordnas — och den tiden
 * står säljaren och tittar på ett skimmer. Men samma soffa skannas om och om igen: IKEA EKTORP är
 * inte en möbel utan en modell som tusen personer säljer. Andra gången någon ser den ska bilden vara
 * framme direkt, och det är den enda vägen till "direkt" som finns — själva letandet går inte att
 * göra snabbt.
 *
 * NYCKELN ÄR NORMALISERAD men annars ordagrann. "Ektorp", "EKTORP" och " ektorp " är samma modell;
 * "EKTORP 3-sits" är det inte, och ska inte heller vara det — en variant kan ha en annan bild.
 *
 * MISSLYCKANDEN SPARAS INTE. En modell som inte gav någon bild i dag kan ge en i morgon, när sidan
 * finns eller sökmotorn svarar. Att skriva ned ett nej hade gjort en tillfällig tystnad permanent.
 */
const REGISTER_FIL = () => path.join(kandidatbilderDir(), "register.json");

let register: Map<string, string> | null = null;

/** Glömmer det inlästa registret. För tester, som byter katalog mellan körningar. */
export function slappKandidatbildsregister(): void {
  register = null;
}

function nyckel(brand: string | null | undefined, model: string): string {
  return `${(brand ?? "").trim().toLowerCase()}|${model.trim().toLowerCase()}`;
}

async function laddaRegister(): Promise<Map<string, string>> {
  if (register) return register;
  try {
    const rå: unknown = JSON.parse(await readFile(REGISTER_FIL(), "utf8"));
    const poster = Object.entries(rå as Record<string, unknown>).filter(
      (p): p is [string, string] => typeof p[1] === "string",
    );
    register = new Map(poster);
  } catch {
    // Finns inte än, eller är trasig. Ett register som inte går att läsa är ett tomt register —
    // det kostar en långsam omgång, aldrig ett fel.
    register = new Map();
  }
  return register;
}

/** Modellens miniatyr, om någon hittat den förut. Null betyder "leta". */
export async function registreradKandidatbild(
  brand: string | null | undefined,
  model: string,
): Promise<string | null> {
  const träff = (await laddaRegister()).get(nyckel(brand, model));
  if (!träff) return null;
  /**
   * Filen måste ligga kvar. Registret pekar på disk, och disken kan ha städats — en post som pekar
   * på en borttagen fil är värre än ingen post: den ger säljaren en trasig ruta i stället för ett
   * letande som hade kunnat lyckas.
   */
  return existsSync(path.join(kandidatbilderDir(), path.basename(träff))) ? träff : null;
}

/** Skriver ned det som hittats. Tyst vid fel: ett register som inte kan skrivas är en långsam nästa gång. */
export async function registreraKandidatbilder(
  poster: Array<{ brand: string | null | undefined; model: string; url: string }>,
): Promise<void> {
  const reg = await laddaRegister();
  let nytt = false;
  for (const p of poster) {
    if (!p.url.startsWith(URL_PREFIX)) continue;
    const k = nyckel(p.brand, p.model);
    if (reg.get(k) === p.url) continue;
    reg.set(k, p.url);
    nytt = true;
  }
  if (!nytt) return;
  try {
    await mkdir(kandidatbilderDir(), { recursive: true });
    const fil = REGISTER_FIL();
    const tmp = `${fil}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(reg), null, 0), "utf8");
    await rename(tmp, fil);
  } catch {
    /* se doc-kommentaren */
  }
}

/**
 * Är filnamnet ett vi själva kan ha skrivit?
 *
 * Porten tar ett filnamn ur adressen, och en adress är något vem som helst skriver. Namnen är
 * sha1-summor med känd form, så kravet kan ställas exakt i stället för att leta efter `..` — allt
 * som inte är fyrtio hexadecimaler och `.jpg` är inte vårt, oavsett vad det försöker vara.
 */
export function giltigtKandidatbildsnamn(namn: string): boolean {
  return /^[0-9a-f]{40}\.jpg$/.test(namn);
}
