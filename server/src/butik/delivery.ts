/**
 * Hemleveransen: zoner, pris och tider.
 *
 * LIGGER PÅ SERVERN, och det är inte en organisationsfråga. Leveransavgiften är en post på ett
 * belopp som dras från ett kort. Räknas den i webbläsaren räknas den på en sida köparen kan öppna
 * konsolen i, och då är priset ett förslag. Klienten frågar; servern svarar och är den enda som
 * summerar (se checkout.ts).
 *
 * STOCKHOLM ÄR EN FÖRUTSÄTTNING, INTE ETT FILTER. Ett postnummer utanför länet får därför ett svar
 * om var gränsen går och vad man kan göra i stället — inte "inga träffar".
 */

export interface DeliveryZone {
  id: string;
  name: string;
  feeSek: number;
  /** Vardagar innan första möjliga leverans. Budfirman behöver framförhållning. */
  leadDays: number;
}

export interface DeliverySlot {
  /** ISO-datum, det som sparas på ordern. */
  date: string;
  /** "onsdag 3 sep", för människan. */
  label: string;
  /** "08–12" eller "12–17". Budfirman kör två pass. */
  window: string;
}

/**
 * EN FRAKTAVGIFT, SAMMA I HELA LÄNET: 600 kr.
 *
 * Zonerna var prissatta 495/695/895 efter avstånd, vilket är sant om vad en budfirma kostar och
 * osant om vad köparen får höra. Annonserna på Tradera säger "Hemleveransen kostar 600 kr och är
 * redan inräknad i priset" — ett tal som står i annonstexten OCH i annonspriset (se
 * SHIPPING_INCLUDED_SEK) och som inte kan variera med ett postnummer vi inte känner till när
 * annonsen skrivs. Med zonpriser kvar betalade Loopa mellanskillnaden i Storstockholm och tog en
 * övervinst i innerstan, och köpsidans "frakt från 495 kr" sa dessutom något annat än annonsen.
 *
 * ZONERNA FINNS KVAR ändå, för de bär också LEVERANSTIDEN: budfirman behöver längre framförhållning
 * längre ut, och det är en operativ sanning som inte försvinner av att priset blev ett.
 */
const FRAKT_SEK = 600;

const ZONES: Array<DeliveryZone & { prefixes: string[] }> = [
  {
    id: "innerstad",
    name: "Stockholms innerstad",
    feeSek: FRAKT_SEK,
    leadDays: 2,
    prefixes: ["100", "101", "102", "103", "104", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129"],
  },
  {
    id: "narforort",
    name: "Närförort",
    feeSek: FRAKT_SEK,
    leadDays: 3,
    prefixes: ["130", "131", "132", "133", "134", "135", "136", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "161", "162", "163", "164", "165", "167", "168", "169", "170", "171", "172", "175", "176", "177"],
  },
  {
    id: "storstockholm",
    name: "Storstockholm",
    feeSek: FRAKT_SEK,
    leadDays: 4,
    prefixes: ["178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "191", "192", "193", "194", "195", "196", "197"],
  },
];

/**
 * Zonernas avgifter, i stigande ordning.
 *
 * Finns som en egen export för att köpsidan skriver ut fraktpriset och den siffran måste komma
 * härifrån. Skriven en gång till i en komponent hade den en dag sagt något annat än kassan gör.
 * Numera är alla zoner lika dyra, så listan är ett tal långt — den står kvar som lista därför att
 * zonpriser är en sak vi kan komma att vilja tillbaka till, och `Math.min`/`Math.max` hos anroparna
 * fortsätter fungera oavsett.
 */
export const ZONE_FEES: readonly number[] = ZONES.map((z) => z.feeSek).sort((a, b) => a - b);

/** Bara siffrorna. "112 23", "11223" och "112-23" är samma postnummer. */
export function normalizePostal(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 5);
}

/**
 * Zonen för ett postnummer, eller null när vi inte kör dit.
 *
 * Matchar på de tre första siffrorna. Fem siffror krävs för att svara alls: "11" räcker för att
 * gissa innerstad, men ett halvt postnummer ska inte ge ett helt löfte om en leveransavgift.
 */
export function zoneFor(postal: string): DeliveryZone | null {
  const digits = normalizePostal(postal);
  if (digits.length < 5) return null;
  const prefix = digits.slice(0, 3);
  const hit = ZONES.find((z) => z.prefixes.includes(prefix));
  if (!hit) return null;
  const { prefixes, ...zone } = hit;
  return zone;
}

/**
 * De två passen. Budfirman kör förmiddag eller eftermiddag — smalare än så går inte att lova, och en
 * utlovad timme som spricker är värre än ett halvdagsfönster som håller.
 */
export const DELIVERY_WINDOWS = ["08–12", "12–18"] as const;

/** Så många ARBETSDAGAR framåt tiderna sträcker sig. Fem är en arbetsvecka. */
export const DELIVERY_DAYS = 5;

/**
 * Tiderna köparen väljer bland: fem arbetsdagar, med start dagen efter köpet.
 *
 * DAGEN EFTER, inte efter zonens `leadDays`. Framförhållningen var 2–4 dagar beroende på hur långt
 * ut möbeln skulle, vilket är sant om vad en budfirma vill ha och fel om vad köparen ska mötas av:
 * den som just betalat vill se i morgon och veckan ut, inte fyra tomma dagar först. Zonen bär
 * fortfarande sin `leadDays` — den säger något verkligt om bokningen — men den gör det inför OSS,
 * inte i köparens lista.
 *
 * LÖRDAG OCH SÖNDAG HOPPAS ÖVER. "Arbetsdagar" är budfirmans vecka, och en tid vi inte kan boka ska
 * inte gå att kryssa i.
 *
 * `from` är KÖPETS dag och inte dagens datum: listan hör till en order, och den som öppnar sin
 * orderskärm tre dagar senare ska inte kunna välja en tid som redan varit. Dagar som passerat
 * sållas därför bort mot `today`.
 *
 * Tiderna är ÖPPNA i den meningen att flera köpare kan se samma tid: kapacitetsbokning är en
 * operativ funktion vi inte har än, och att låtsas om ett bokningssystem hade varit värre än att
 * säga "vi bekräftar tiden". Det står i bekräftelsen.
 */
export function slotsFor(zone: DeliveryZone, from: Date = new Date(), days = DELIVERY_DAYS): DeliverySlot[] {
  void zone; // Zonen avgör inte längre tiderna. Se resonemanget ovan.
  const slots: DeliverySlot[] = [];
  const idag = new Date();
  const arbetsdag = (d: Date) => d.getDay() >= 1 && d.getDay() <= 5;
  /** Dagens datum som ISO, i lokal tid. `toISOString` går via UTC och tappar en dag om kvällen. */
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const forsta = iso(new Date(idag.getTime() + 86_400_000));

  /**
   * Vandringen börjar vid KÖPET eller I DAG, det som ligger senast.
   *
   * Utan `max` räknade en order från förra veckan fram sina fem dagar bakåt i tiden, sållade bort
   * dem alla mot `forsta` och lämnade en tom lista — en orderskärm utan tider att välja.
   */
  const d = new Date(Math.max(new Date(from).getTime(), idag.getTime()));
  // Taket på 14 varv räcker för fem arbetsdagar även över en helg med röda dagar omkring.
  for (let i = 0; slots.length < days * DELIVERY_WINDOWS.length && i < 14; i++) {
    d.setDate(d.getDate() + 1);
    if (!arbetsdag(d)) continue;
    const date = iso(d);
    if (date < forsta) continue;
    const label = d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" });
    for (const window of DELIVERY_WINDOWS) slots.push({ date, label, window });
  }
  return slots;
}

/** Allt klienten behöver för att visa leveransrutan på en produktsida. */
export function deliveryQuote(postal: string): {
  deliverable: boolean;
  zone: DeliveryZone | null;
  slots: DeliverySlot[];
  message: string;
} {
  const digits = normalizePostal(postal);
  if (digits.length < 5) {
    return { deliverable: false, zone: null, slots: [], message: "Skriv hela postnumret, fem siffror." };
  }
  const zone = zoneFor(digits);
  if (!zone) {
    return {
      deliverable: false,
      zone: null,
      slots: [],
      message:
        "Vi kör bara inom Stockholms län än så länge. Du kan fortfarande köpa möbeln och hämta den själv — vi hör av oss om upphämtning efter köpet.",
    };
  }
  return {
    deliverable: true,
    zone,
    slots: slotsFor(zone),
    message: `Vi levererar till ${zone.name} för ${zone.feeSek} kr.`,
  };
}
