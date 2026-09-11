/**
 * Rättelseloggen: vad AI:n sa, och vad det blev när en människa sett det.
 *
 * DET HÄR ÄR TRÄNINGSDATAN. Varje rad är en märkt miss — eller en märkt träff, för ett bekräftat
 * fynd är lika mycket en etikett som ett avvisat. Jobbet på disk bär bara SLUTRESULTATET: ett fynd
 * säljaren rättade ser efteråt ut precis som ett fynd modellen fick rätt på, med `sellerAction` som
 * enda spår och det ursprungliga värdet överskrivet. Det ursprungliga värdet finns då ingenstans, och
 * en rättelse utan sitt "före" är ingen etikett — det är bara ett faktum om nuet.
 *
 * EN RAD PER RÄTTELSE, ALDRIG ÄNDRAD. Samma val som butikens huvudbok gör (butik/store.ts): det som
 * ska gå att läsa i efterhand får inte ligga i ett fält som kan skrivas över. Att säljaren först
 * avvisade ett fynd och sedan ångrade sig är två rader, inte ett fält som råkar sluta på "confirmed".
 *
 * VEM SOM RÄTTADE STÅR PÅ RADEN. En säljare som säger att repan inte finns säger något om möbeln;
 * en admin som ändrar samma sak i panelen säger något om vår bedömning av annonsen. Att blanda de
 * två hade förgiftat träningsdatan med våra egna redigeringar.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const DATA_KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const FIL = () => path.join(DATA_KATALOG(), "rattelser.jsonl");

/** Vilken del av bedömningen rättelsen gäller. Styr vilken lista i panelen raden hamnar i. */
export type Omrade = "identitet" | "skick" | "betyg" | "pris" | "annons";

/** Vem som gjorde det. Se filens topp för varför skillnaden är strukturell och inte kosmetisk. */
export type Kalla = "saljare" | "admin" | "granskning";

export interface Rattelse {
  at: string;
  jobId: string;
  omrade: Omrade;
  /** Fältet som rättades: "märke", "severity", "betyg", "startpris", "Bredd". */
  falt: string;
  /** Fyndets id när rättelsen gäller ett enskilt fynd. Null annars. */
  fyndId: string | null;
  /** Vad modellen sa. Null när modellen inte sa något alls — då är raden ett TILLÄGG. */
  aiSa: string | null;
  /** Vad det blev. Null betyder att värdet togs bort. */
  manniskanSa: string | null;
  kalla: Kalla;
  /** Fritext när handlingen behöver en förklaring — domslutet i en tvist, admins anteckning. */
  notis: string | null;
}

let kedja: Promise<unknown> = Promise.resolve();
let minne: Rattelse[] | null = null;

async function ladda(): Promise<Rattelse[]> {
  if (minne) return minne;
  const ut: Rattelse[] = [];
  try {
    const raw = await readFile(FIL(), "utf-8");
    for (const rad of raw.split("\n")) {
      if (!rad.trim()) continue;
      try {
        const r = JSON.parse(rad) as Rattelse;
        if (r?.jobId && r.at) ut.push(r);
      } catch {
        continue;
      }
    }
  } catch {
    // Ingen fil än: första rättelsen skapar den.
  }
  minne = ut;
  return ut;
}

/** Ett värde som text, för loggen. Objekt blir JSON — raden ska gå att läsa utan att gissa. */
export function somText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.slice(0, 400);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v).slice(0, 400);
  } catch {
    return String(v).slice(0, 400);
  }
}

/**
 * Skriver en rättelse. Faller aldrig och väntar aldrig på något: loggningen är en bieffekt av det
 * säljaren faktiskt bad om, och ett fel här får inte fälla deras rättelse.
 *
 * IDENTISKA VÄRDEN SKRIVS INTE. En "rättelse" där före och efter är samma sak är inte en etikett, det
 * är ett tryck på en knapp — undantaget är bekräftelser (`aiSa` satt, `manniskanSa` lika), som är
 * hela poängen med ett bekräftat fynd och därför uttryckligen släpps igenom av anropsstället genom
 * att sätta `falt` till "bekräftat".
 */
export async function notera(r: Omit<Rattelse, "at"> & { at?: string }): Promise<void> {
  try {
    const rad: Rattelse = {
      at: r.at ?? new Date().toISOString(),
      jobId: r.jobId,
      omrade: r.omrade,
      falt: r.falt,
      fyndId: r.fyndId ?? null,
      aiSa: r.aiSa ?? null,
      manniskanSa: r.manniskanSa ?? null,
      kalla: r.kalla,
      notis: r.notis ?? null,
    };
    if (!rad.jobId) return;
    (await ladda()).push(rad);
    const text = JSON.stringify(rad) + "\n";
    kedja = kedja
      .then(async () => {
        await mkdir(DATA_KATALOG(), { recursive: true });
        await appendFile(FIL(), text, "utf-8");
      })
      .catch(() => undefined);
    await kedja;
  } catch {
    // Tyst. Se filens topp.
  }
}

/**
 * Flera fälträttelser i ett svep — en redigering av ett fynd rör oftast två eller tre fält.
 *
 * Går igenom `notera` en i taget i stället för att skriva ett block: raderna ska vara läsbara var
 * för sig, och en rättelse av `severity` är en annan etikett än en rättelse av `part` även när de
 * kom i samma tryck.
 */
export async function noteraFalt(
  bas: Omit<Rattelse, "at" | "falt" | "aiSa" | "manniskanSa">,
  fore: Record<string, unknown>,
  efter: Record<string, unknown>,
): Promise<void> {
  for (const [falt, nyttVarde] of Object.entries(efter)) {
    const gammalt = somText(fore[falt]);
    const nytt = somText(nyttVarde);
    if (gammalt === nytt) continue;
    await notera({ ...bas, falt, aiSa: gammalt, manniskanSa: nytt });
  }
}

export async function rattelserFor(jobId: string): Promise<Rattelse[]> {
  return (await ladda()).filter((r) => r.jobId === jobId).sort((a, b) => (a.at < b.at ? -1 : 1));
}

export async function allaRattelser(): Promise<Rattelse[]> {
  return [...(await ladda())];
}

/** Bara för tester. */
export function nollstall(): void {
  minne = null;
}
