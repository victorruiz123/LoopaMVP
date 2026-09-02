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

const ZONES: Array<DeliveryZone & { prefixes: string[] }> = [
  {
    id: "innerstad",
    name: "Stockholms innerstad",
    feeSek: 495,
    leadDays: 2,
    prefixes: ["100", "101", "102", "103", "104", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129"],
  },
  {
    id: "narforort",
    name: "Närförort",
    feeSek: 695,
    leadDays: 3,
    prefixes: ["130", "131", "132", "133", "134", "135", "136", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "161", "162", "163", "164", "165", "167", "168", "169", "170", "171", "172", "175", "176", "177"],
  },
  {
    id: "storstockholm",
    name: "Storstockholm",
    feeSek: 895,
    leadDays: 4,
    prefixes: ["178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "191", "192", "193", "194", "195", "196", "197"],
  },
];

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
 * Nästa lediga tider.
 *
 * Söndagar hoppas över — budfirman kör inte då. Tiderna är ÖPPNA i den meningen att flera köpare kan
 * se samma tid: kapacitetsbokning är en operativ funktion vi inte har än, och att låtsas om ett
 * bokningssystem hade varit värre än att säga "vi bekräftar tiden". Det står i bekräftelsen.
 */
export function slotsFor(zone: DeliveryZone, from: Date = new Date(), count = 6): DeliverySlot[] {
  const slots: DeliverySlot[] = [];
  const day = new Date(from);
  day.setDate(day.getDate() + zone.leadDays);
  for (let i = 0; slots.length < count && i < 30; i++) {
    const d = new Date(day);
    d.setDate(day.getDate() + i);
    if (d.getDay() === 0) continue;
    const date = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" });
    for (const window of ["08–12", "12–17"]) {
      if (slots.length < count) slots.push({ date, label, window });
    }
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
