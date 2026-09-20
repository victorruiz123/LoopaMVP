/**
 * MÅTTMINNET: det säljare mätt upp med tumstock, buret vidare till nästa möbel av samma modell.
 *
 * Måtten kommer i dag tre vägar, alla maskinella: sökningen skriver dem i löptext, sidskörden läser
 * dem ur produktsidans HTML, och när ingen av dem gav något fyller generatorn på med typiska mått för
 * möbeltypen. Mätt på 138 sparade annonser saknade 37 belagda mått — de gick ut som uppskattningar.
 *
 * Den fjärde vägen har hela tiden funnits och kastats: säljaren som står bredvid möbeln med ett
 * måttband och rättar måttsteget. Rättelsen sparades på JOBBET (se `behallSaljarensRattelser`) och i
 * rättelseloggen som träningsdata — men nästa säljare med samma NORDVIKEN fick samma uppskattning som
 * den förra just rättat. En uppmätt EKTORP är inte ett faktum om ett exemplar, den är ett faktum om
 * modellen.
 *
 * EN RAD PER MÄTNING, ALDRIG ÄNDRAD. Samma val som rättelseloggen och butikens huvudbok gör: det som
 * ska gå att läsa i efterhand får inte ligga i ett fält som kan skrivas över. Att tio säljare mätt
 * samma soffa är tio rader, och det är just antalet som gör talet värt något.
 *
 * MEDIANEN, INTE DEN SENASTE. En enda felskrivning — 812 i stället för 81 — hade annars flyttat måttet
 * för varje kommande säljare av modellen, och ingen av dem hade sett varifrån talet kom. Medianen är
 * dessutom ALLTID ETT TAL NÅGON FAKTISKT MÄTT: vid jämnt antal tas det nedre av de två mittersta i
 * stället för ett medelvärde ingen mätt upp.
 *
 * FYLLER BARA LUCKOR. Minnet går före en uppskattning och före ingenting alls, men aldrig före en
 * uppgift som är belagd mot en källa, och aldrig före vad DEN här säljaren själv skrivit in om DEN
 * här möbeln. Se `mergeSpecs` i specHarvest.ts, där ordningen står skriven en gång för alla källor.
 *
 * MÄRKS PÅ KORTET. Ett mått härifrån är varken belagt eller uppskattat — det är någon annans mätning
 * av samma modell, och `fromSellers` säger det rakt ut i stället för att låna någons trovärdighet.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./jobStore.js";
import type { ListingAttribute } from "./types.js";

/**
 * Var minnet ligger. En FUNKTION och inte en konstant, av samma skäl som `kandidatbilderDir`: utan
 * den möjligheten hade testkörningen skrivit påhittade mått i driftens register, och nästa säljare
 * med en NORDVIKEN fått ett tal ur ett test.
 */
const FIL = () => path.join(process.env.LOOPA_MATTMINNE_DIR?.trim() || path.join(DATA_DIR, "data"), "mattminne.jsonl");

/** Enheterna ett mått kan bäras i. Allt annat är inte ett mått utan en text som råkar innehålla en siffra. */
type Enhet = "cm" | "kg";

export interface MattRad {
  at: string;
  jobId: string;
  /** Normaliserad nyckel: märke och modell ihop, gemener, utan skiljetecken. Se `modellNyckel`. */
  modell: string;
  /** Måttets rad: "bredd", "djup", "hojd", "sitthojd", "sittdjup", "langd", "diameter", "vikt". */
  key: string;
  /** Etiketten som den stod på kortet — det är den säljaren läste när hen mätte. */
  label: string;
  tal: number;
  enhet: Enhet;
}

/**
 * Måtten minnet bär, och ingenting annat.
 *
 * Material, färg och nypris rättas också av säljare, men de är inte mätningar: "ek" på en möbel säger
 * inget om nästa exemplar av samma modell på det sätt ett tal gör, och ett nypris är dessutom färskvara.
 * Minnet håller sig till det en tumstock och en våg kan svara på.
 */
const RADER: Array<{ key: string; label: string; re: RegExp; enhet: Enhet }> = [
  { key: "langd", label: "Längd", re: /^(längd|langd|length)/i, enhet: "cm" },
  { key: "bredd", label: "Bredd", re: /^(bredd|width)/i, enhet: "cm" },
  { key: "djup", label: "Djup", re: /^(djup|depth)/i, enhet: "cm" },
  { key: "hojd", label: "Höjd", re: /^(total)?(höjd|hojd|height)/i, enhet: "cm" },
  { key: "sitthojd", label: "Sitthöjd", re: /^(sitthöjd|sitshöjd|seat height)/i, enhet: "cm" },
  { key: "sittdjup", label: "Sittdjup", re: /^(sittdjup|seat depth)/i, enhet: "cm" },
  { key: "diameter", label: "Diameter", re: /^diameter/i, enhet: "cm" },
  { key: "vikt", label: "Vikt", re: /^(vikt|weight)/i, enhet: "kg" },
];

/**
 * Vilken rad en etikett är, om någon.
 *
 * Läses på ETIKETTEN och inte på nyckeln: nyckeln kommer ur generatorn och heter ömsom "bredd",
 * ömsom "width", ömsom något den hittat på. Etiketten är det säljaren läste. "Mått: 81 x 92 x 82 cm"
 * matchar med flit ingenting — vilket tal som är bredden går inte att veta, och ett minne som gissar
 * är värre än inget minne.
 */
function radFor(attr: { key: string; label: string }): (typeof RADER)[number] | null {
  return RADER.find((r) => r.re.test(attr.label.trim()) || r.re.test(attr.key.trim())) ?? null;
}

/** Vad en möbel rimligen mäter och väger. Utanför det är talet ett skrivfel, inte en mätning. */
const GRANSER: Record<Enhet, [number, number]> = { cm: [3, 500], kg: [0.2, 300] };

/**
 * Talet ur det säljaren skrev, i radens egen enhet.
 *
 * Säljaren skriver in fritext i fältet: "92", "92 cm", "92,5 cm", "920 mm", "0,9 m". Alla fyra är
 * samma mått, och minnet ska bära talet och inte skrivsättet. Ett intervall ("80–82 cm") avvisas —
 * det är inte en mätning, det är källans osäkerhet, och den tillhör inte minnet.
 */
export function talUr(varde: string, enhet: Enhet): number | null {
  const text = varde.trim().toLowerCase();
  if (/\d\s*[-–—]\s*\d/.test(text)) return null;
  const m = text.match(/^(?:ca\.?\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*(mm|cm|m|g|kg|kilo)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const skriven = m[2];
  let tal = n;
  if (enhet === "cm") {
    if (skriven === "mm") tal = n / 10;
    else if (skriven === "m") tal = n * 100;
    else if (skriven && skriven !== "cm") return null;
  } else {
    if (skriven === "g") tal = n / 1000;
    else if (skriven && skriven !== "kg" && skriven !== "kilo") return null;
  }
  const [min, max] = GRANSER[enhet];
  if (tal < min || tal > max) return null;
  return Math.round(tal * 10) / 10;
}

/** Talet tillbaka till ett värde som kan stå på kortet: "92 cm", "92,5 cm", "8,4 kg". */
const varde = (tal: number, enhet: Enhet) => `${String(tal).replace(".", ",")} ${enhet}`;

/**
 * Märke och modell ihop till en nyckel.
 *
 * BÅDA KRÄVS. En modellrad utan märke är ofta generisk — "stol", "soffa", "matbord" — och att slå
 * ihop varje märkeslös stol i landet till ett minne hade gett ett tal som gäller ingen möbel alls.
 * Saknas märket lagras raden inte; det säljaren rättade står ändå kvar på sin egen annons.
 */
export function modellNyckel(brand: string | null | undefined, model: string | null | undefined): string | null {
  const tvatta = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const m = tvatta(model ?? "");
  const b = tvatta(brand ?? "");
  if (!b || m.length < 2) return null;
  // Märket står ofta redan i modellnamnet ("IKEA NORDVIKEN"). Två nycklar för samma möbel är två minnen.
  return m.startsWith(`${b} `) || m === b ? m : `${b} ${m}`;
}

let kedja: Promise<unknown> = Promise.resolve();
let minne: MattRad[] | null = null;

async function ladda(): Promise<MattRad[]> {
  if (minne) return minne;
  const ut: MattRad[] = [];
  try {
    const raw = await readFile(FIL(), "utf-8");
    for (const rad of raw.split("\n")) {
      if (!rad.trim()) continue;
      try {
        ut.push(JSON.parse(rad) as MattRad);
      } catch {
        // En trasig rad är en rad, inte ett register. Resten av minnet ska läsas ändå.
      }
    }
  } catch {
    // Ingen fil än: minnet är tomt, vilket är ett giltigt tillstånd och inte ett fel.
  }
  minne = ut;
  return ut;
}

/**
 * Säljarens mått, skrivet till minnet.
 *
 * Tyst i alla lägen där raden inte är en mätning: fel etikett, obegripligt tal, orimligt tal, okänd
 * modell. Anroparen har redan gjort det viktiga — sparat rättelsen på annonsen — och minnet får
 * aldrig kunna fälla den vägen.
 */
export async function noteraMatt(input: {
  jobId: string;
  brand: string | null | undefined;
  model: string | null | undefined;
  attr: { key: string; label: string; value: string };
}): Promise<void> {
  const rad = radFor(input.attr);
  if (!rad) return;
  const modell = modellNyckel(input.brand, input.model);
  if (!modell) return;
  const tal = talUr(input.attr.value, rad.enhet);
  if (tal === null) return;
  const post: MattRad = {
    at: new Date().toISOString(),
    jobId: input.jobId,
    modell,
    key: rad.key,
    label: input.attr.label.trim() || rad.label,
    tal,
    enhet: rad.enhet,
  };
  kedja = kedja.then(async () => {
    const fil = FIL();
    await mkdir(path.dirname(fil), { recursive: true });
    await appendFile(fil, `${JSON.stringify(post)}\n`, "utf-8");
    (minne ??= []).push(post);
  });
  await kedja.catch(() => {});
}

/**
 * Hur många mätningar bakåt som räknas.
 *
 * Möbler ritas om utan att byta namn — samma modellnamn, ny höjd — och ett minne som räknar in varje
 * mätning sedan starten hade låst måttet vid den gamla möbeln för alltid. Fönstret gör att nya
 * mätningar till slut tar över, utan att en enstaka avvikare kan göra det på egen hand.
 */
const FONSTER = 20;

/**
 * Vad säljare mätt upp på den här modellen, som annonsrader.
 *
 * Medianen per mått, av de senaste mätningarna. En enda mätning duger — den är fortfarande ett
 * måttband mot möbeln, vilket är mer än en uppskattning för möbeltypen — men den kan aldrig ta
 * platsen från något belagt: det avgörs av `mergeSpecs`, inte här.
 */
export async function mattminnetsRader(
  brand: string | null | undefined,
  model: string | null | undefined,
): Promise<ListingAttribute[]> {
  const modell = modellNyckel(brand, model);
  if (!modell) return [];
  const rader = (await ladda()).filter((r) => r.modell === modell);
  if (rader.length === 0) return [];
  const ut: ListingAttribute[] = [];
  for (const { key, label, enhet } of RADER) {
    const tal = rader
      .filter((r) => r.key === key)
      .slice(-FONSTER)
      .map((r) => r.tal)
      .sort((a, b) => a - b);
    if (tal.length === 0) continue;
    // Nedre mitten vid jämnt antal: ett tal någon mätt, inte ett medelvärde ingen mätt.
    const median = tal[Math.floor((tal.length - 1) / 2)];
    ut.push({
      key,
      label: rader.find((r) => r.key === key)?.label ?? label,
      value: varde(median, enhet),
      sourceUrl: null,
      estimated: false,
      fromSellers: true,
    });
  }
  return ut;
}

/** Bara för testerna: glöm det som lästs in, så att en ompekad katalog verkligen läses om. */
export function glomMattminnet(): void {
  minne = null;
}
