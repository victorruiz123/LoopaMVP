/**
 * Mätningen: en rad per händelse, och summorna per annons.
 *
 * VARFÖR DEN HÄR FILEN FINNS. `track()` i webbappen (web/src/butik/components/Bits.tsx) skriver till
 * `window.dataLayer` och ingenting annat. Det betyder att de 25 anropsställen som redan finns —
 * `view_item`, `outbound_tradera`, `begin_checkout` — försvinner i samma sekund som fliken stängs.
 * Adminpanelen kan därför inte svara på "hur många har sett den här soffan", och ingen mängd
 * efterhandsanalys kan rädda data som aldrig skrevs.
 *
 * EN LOGGRAD, INTE EN ANALYSTJÄNST — samma val som efterlysning/analytics.ts gjorde och av samma
 * skäl: att välja verktyg är inte den här filens beslut, men att inte mäta förrän någon valt ett
 * hade betytt att de första månadernas data inte finns. Formatet är en rad JSON per händelse.
 *
 * SUMMORNA HÅLLS I MINNET och byggs om ur filen vid start. Panelen frågar efter alla annonsers tal
 * på en gång, och att läsa en växande loggfil per sidladdning hade gjort mätningen till det
 * långsammaste i panelen. Filen är sanningen, minnet är indexet — precis som butik/inventory.ts
 * förhåller sig till jobben.
 *
 * INGEN IDENTITET. Raden bär händelse, tidpunkt, annons och några få vitlistade egenskaper. Ingen
 * e-post, inget användar-id, ingen IP. Avtrycket som skiljer två besökare åt (se `avtryck`) räknas
 * fram i minnet för att kunna säga UNIKA visningar och skrivs aldrig till disk — det är därför
 * mätningen inte behöver något samtycke och inte sätter någon kaka.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const ANALYS_DIR = () => process.env.ANALYS_DATA_DIR?.trim() || path.join(DATA_DIR, "analys");
const EVENTS_FILE = () => path.join(ANALYS_DIR(), "handelser.jsonl");

/**
 * Händelser som får skrivas.
 *
 * VITLISTAN ÄR SÄKERHETEN. `POST /api/analys` är öppen — den måste vara det, en utloggad besökare
 * som tittar på en möbel är själva mätobjektet — och en öppen väg som tar emot vilket namn som helst
 * är en gratis skrivbar disk för vem som helst på internet. Listan speglar de anrop som faktiskt
 * finns i webbappen; ett nytt `track()`-namn måste läggas till här för att räknas.
 */
export const KLIENTHANDELSER = new Set([
  "view_item",
  "outbound_tradera",
  "begin_checkout",
  "purchase",
  "search",
  "ai_search",
  "filter_use",
  "bevakning_created",
  "elsewhere_link_submitted",
  "sell_cta_click",
  "sticky_cta_click",
  "hero_submit",
  "hero_paste_start",
  "leta_bland_produkter",
  "utbudsrad_click",
  "wanted_page_visit",
  "wanted_page_visit_sell_click",
  "animation_completed_views",
  "animation_kliv_visat",
  "logga_in_fraga",
  "efterlysning_saved",
  "notification_clicked",
  "deadline_valve_clicked",
]);

/** Händelser servern skriver själv. Kan inte komma utifrån — en besökare får inte påstå en visning. */
export const SERVERHANDELSER = new Set(["annons_visning", "kort_visning"]);

/**
 * Egenskaper som får följa med. Allt annat kastas.
 *
 * Snålheten är avsiktlig: en öppen väg som sparar godtyckliga fält blir förr eller senare den plats
 * där någon råkar skicka in en e-postadress, och då har mätningen blivit ett personregister utan att
 * någon beslutat det.
 */
const TILLATNA_PROPS = new Set([
  "item_id",
  "produkt",
  "plats",
  "kategori",
  "categorySlug",
  "brand",
  "host",
  "q",
  "value",
  "currency",
  "price",
  "delivery",
  "from",
  "via",
  "anledning",
  "keys",
  "varv",
  "max_price",
  "parse_method",
  "transaction_id",
]);

export interface AnalysHandelse {
  event: string;
  at: string;
  /** Loopa-ID:t händelsen handlar om, när den handlar om en enskild annons. */
  annons: string | null;
  props: Record<string, string | number | boolean>;
}

/**
 * Vad en annons har varit med om.
 *
 * `visningar` och `unikaVisningar` skiljs åt för att de svarar på olika frågor: den första säger hur
 * mycket trafik annonsen fått, den andra ungefär hur många människor. Ingen av dem är sann på egen
 * hand — en säljare som laddar om sin egen annons tio gånger syns i den ena men inte i den andra.
 */
export interface AnnonsStatistik {
  /** Sidvisningar: produktsidan i butiken plus det publika kortet. Räknade på servern. */
  visningar: number;
  /** Samma, men ett avtryck per halvtimme räknas en gång. Se `avtryck`. */
  unikaVisningar: number;
  /** Gånger annonsen visats i ett rutnät eller en rad, alltså exponeringar. */
  listvisningar: number;
  /** Alla klick som handlar om just den här annonsen. */
  klick: number;
  /** Påbörjade utcheckningar. */
  kassor: number;
  /** Genomförda köp. */
  kop: number;
  /** Klick vidare till Tradera. */
  utgaende: number;
  /** Rå räkning per händelsenamn — det panelen visar när den visar "allt". */
  perHandelse: Record<string, number>;
  forsta: string | null;
  senaste: string | null;
}

export function tomStatistik(): AnnonsStatistik {
  return {
    visningar: 0,
    unikaVisningar: 0,
    listvisningar: 0,
    klick: 0,
    kassor: 0,
    kop: 0,
    utgaende: 0,
    perHandelse: {},
    forsta: null,
    senaste: null,
  };
}

/**
 * Vilken hink varje händelse hamnar i.
 *
 * Uppslaget och inte en if-kedja, av samma skäl som ALLOWED_TRANSITIONS i butik/types.ts: tabellen ÄR
 * regeln, och den läses av både panelen och testerna.
 */
const HINKAR: Record<string, keyof Pick<AnnonsStatistik, "visningar" | "listvisningar" | "klick" | "kassor" | "kop" | "utgaende">> = {
  annons_visning: "visningar",
  kort_visning: "visningar",
  view_item: "listvisningar",
  utbudsrad_click: "klick",
  outbound_tradera: "utgaende",
  begin_checkout: "kassor",
  purchase: "kop",
};

// ---------------------------------------------------------------------------
// Minnet
// ---------------------------------------------------------------------------

const summor = new Map<string, AnnonsStatistik>();
/** Händelser utan annons — sökningar, hero-inskick. Räknas för helheten, inte per möbel. */
const globala = new Map<string, number>();
let laddad: Promise<void> | null = null;

/**
 * Skrivningen ställer sig i en kedja.
 *
 * `appendFile` är atomiskt per anrop för korta rader på POSIX, men två parallella anrop kan ändå
 * flätas ihop på en volym som inte lovar det. En kedja kostar ingenting här — mätningen ligger aldrig
 * i någons väg — och gör loggen läsbar rad för rad även när trafiken kommer i klasar.
 */
let kedja: Promise<unknown> = Promise.resolve();

function rakna(handelse: AnalysHandelse, unik: boolean): void {
  const namn = handelse.event;
  if (!handelse.annons) {
    globala.set(namn, (globala.get(namn) ?? 0) + 1);
    return;
  }
  let s = summor.get(handelse.annons);
  if (!s) {
    s = tomStatistik();
    summor.set(handelse.annons, s);
  }
  s.perHandelse[namn] = (s.perHandelse[namn] ?? 0) + 1;
  const hink = HINKAR[namn];
  if (hink) s[hink] += 1;
  if (hink === "visningar" && unik) s.unikaVisningar += 1;
  // Ett klick är ett klick oavsett vilken knapp det var: allt som inte är en visning räknas också in
  // i `klick`, så att panelen kan visa en tratt utan att känna till varje händelsenamn.
  if (hink !== "visningar" && hink !== "listvisningar") s.klick += 1;
  if (!s.forsta || handelse.at < s.forsta) s.forsta = handelse.at;
  if (!s.senaste || handelse.at > s.senaste) s.senaste = handelse.at;
}

/**
 * Läser loggen en gång och bygger summorna.
 *
 * En trasig rad hoppas över i stället för att fälla läsningen: filen skrivs av en process som kan bli
 * dödad mitt i en rad, och en halv rad från i förrgår får inte betyda att panelen aldrig mer visar
 * någon statistik.
 */
async function ladda(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(EVENTS_FILE(), "utf-8");
  } catch {
    return;
  }
  for (const rad of raw.split("\n")) {
    if (!rad.trim()) continue;
    try {
      const h = JSON.parse(rad) as AnalysHandelse;
      if (!h?.event || !h.at) continue;
      /**
       * Unika visningar går INTE att bygga om ur filen — avtrycket skrevs aldrig dit, med flit. Efter
       * en omstart är `unikaVisningar` därför lika med `visningar` för det som redan låg i loggen.
       * Det är avsiktligt: hellre ett tal som är för högt på ett sätt som går att förklara än ett
       * avtryck per besökare sparat på disk.
       */
      rakna(h, true);
    } catch {
      continue;
    }
  }
}

export function redo(): Promise<void> {
  laddad ??= ladda();
  return laddad;
}

// ---------------------------------------------------------------------------
// Avtrycket
// ---------------------------------------------------------------------------

/**
 * Saltet byts vid varje start och lämnar aldrig processen.
 *
 * Det är det som gör avtrycket omöjligt att vända tillbaka till en IP-adress, även för den som får
 * tag i minnet efteråt: utan saltet är hashen inte kopplingsbar, och saltet finns ingenstans annat än
 * i den här processens RAM.
 */
const SALT = randomBytes(16).toString("hex");
const AVTRYCK_FONSTER_MS = 30 * 60 * 1000;
const sedda = new Map<string, number>();

/**
 * Ett ogenomskinligt avtryck av besökaren, giltigt en halvtimme.
 *
 * Finns BARA för att kunna säga "unika visningar". Adressen och webbläsarsträngen går in i en hash
 * med ett slumpat salt och kommer aldrig ut igen; kartan städas när den blir stor, så den växer inte
 * med trafiken.
 */
export function avtryck(ip: string | null, userAgent: string | null): string {
  return createHash("sha256").update(`${SALT}|${ip ?? ""}|${userAgent ?? ""}`).digest("hex").slice(0, 16);
}

function forstaGangen(nyckel: string | null, nu: number): boolean {
  if (!nyckel) return true;
  const tidigare = sedda.get(nyckel);
  sedda.set(nyckel, nu);
  if (sedda.size > 20_000) {
    for (const [k, t] of sedda) if (nu - t > AVTRYCK_FONSTER_MS) sedda.delete(k);
  }
  return tidigare === undefined || nu - tidigare > AVTRYCK_FONSTER_MS;
}

// ---------------------------------------------------------------------------
// Skrivningen
// ---------------------------------------------------------------------------

function stada(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const ut: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!TILLATNA_PROPS.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) ut[k] = v;
    else if (typeof v === "boolean") ut[k] = v;
    // Taket är inte kosmetik: en öppen väg utan längdgräns är en fil som växer tills disken tar slut.
    else if (typeof v === "string" && v.length <= 120) ut[k] = v;
    else if (Array.isArray(v)) ut[k] = v.slice(0, 8).map(String).join(",").slice(0, 120);
  }
  return ut;
}

/**
 * Skriver en händelse. Faller aldrig — en analysrad får inte fälla det den mäter.
 *
 * `avtryckNyckel` skickas in av visningsvägarna och är det enda som avgör om visningen räknas som
 * unik. Utelämnad betyder unik, vilket är rätt för klienthändelser: ett klick är ett klick.
 */
export async function spara(
  event: string,
  annons: string | null,
  props: Record<string, unknown> = {},
  avtryckNyckel: string | null = null,
): Promise<void> {
  try {
    await redo();
    const handelse: AnalysHandelse = {
      event,
      at: new Date().toISOString(),
      annons: annons?.trim() || null,
      props: stada(props),
    };
    rakna(handelse, forstaGangen(avtryckNyckel, Date.now()));
    const rad = JSON.stringify(handelse) + "\n";
    kedja = kedja
      .then(async () => {
        await mkdir(ANALYS_DIR(), { recursive: true });
        await appendFile(EVENTS_FILE(), rad, "utf-8");
      })
      .catch(() => undefined);
    await kedja;
  } catch {
    // Tyst. Se filens topp.
  }
}

// ---------------------------------------------------------------------------
// Läsningen
// ---------------------------------------------------------------------------

export async function statistikFor(annons: string): Promise<AnnonsStatistik> {
  await redo();
  return summor.get(annons) ?? tomStatistik();
}

/** Alla annonsers tal på en gång — panelens lista frågar en gång, inte en gång per rad. */
export async function allStatistik(): Promise<Map<string, AnnonsStatistik>> {
  await redo();
  return new Map(summor);
}

/** Händelser som inte hör till en enskild annons: sökningar, hero-inskick, inloggningsfrågor. */
export async function globalStatistik(): Promise<Record<string, number>> {
  await redo();
  return Object.fromEntries(globala);
}

/**
 * De senaste händelserna för en annons, nyast först.
 *
 * Läses ur FILEN och inte ur minnet: minnet bär summor, inte historik, och tidslinjen i panelen vill
 * ha raderna. Läsningen sker bara när någon öppnar en enskild annons.
 */
export async function handelserFor(annons: string, tak = 200): Promise<AnalysHandelse[]> {
  let raw: string;
  try {
    raw = await readFile(EVENTS_FILE(), "utf-8");
  } catch {
    return [];
  }
  const ut: AnalysHandelse[] = [];
  for (const rad of raw.split("\n")) {
    if (!rad.includes(annons)) continue;
    try {
      const h = JSON.parse(rad) as AnalysHandelse;
      if (h.annons === annons) ut.push(h);
    } catch {
      continue;
    }
  }
  return ut.slice(-tak).reverse();
}

/** Bara för tester: glöm allt och läs om vid nästa fråga. */
export function nollstall(): void {
  summor.clear();
  globala.clear();
  sedda.clear();
  laddad = null;
}
