/**
 * Samtalen i "Hur fungerar det?" — frågan och svaret, ord för ord.
 *
 * VARFÖR DE SPARAS. Flödesmätningen vet att någon frågade något i ett visst steg och grovt vad det
 * handlade om ("pris", "leverans"). Det räcker för en stapel och för ingenting annat. Den som ska
 * skriva om startsidan behöver den faktiska meningen: "måste jag vara hemma när ni hämtar" och "vad
 * händer om den inte blir såld" är två invändningar med två olika svar, och båda hamnar i kategorin
 * "process". En kategori säger att folk undrar. Texten säger vad de undrar över.
 *
 * DET ÄR OCKSÅ EN FACITLISTA. Boten svarar ur en faktaruta (saljChat.ts). Utan de sparade svaren
 * finns ingen väg att se när den svarat fel, tunt eller gissat — och en bot som står först i
 * säljflödet och ingen läser är ett oövervakat löfte till kunden.
 *
 * SPARAS PÅ SERVERN, DÄR SAMTALET ÄNDÅ PASSERAR. Frågan går redan hit för att kunna besvaras; att
 * skriva ned den är ett `appendFile` och inte en ny väg in. Klienten skickar bara ett samtals-id,
 * så att tio frågor i rad blir ETT samtal att läsa och inte tio lösryckta rader.
 *
 * DET HÄR ÄR FRITEXT SKRIVEN AV MÄNNISKOR, till skillnad från allt annat i data/. Någon kommer förr
 * eller senare att skriva sin adress eller sitt telefonnummer i rutan. Därför: bara admin läser
 * filen, raderna bär inget annat om personen än kontots id när det finns, och taket per samtal är
 * hårt. Ingen e-post, ingen IP, ingen webbläsarsträng.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const DATA_KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const SAMTAL_FIL = () => path.join(DATA_KATALOG(), "samtal.jsonl");

/**
 * Chattarna som får skriva hit.
 *
 * "start" är "Hur fungerar det?" på startsidan. Listan är en vitlista av samma skäl som allt annat
 * här: vägen in är öppen — den som ställer frågan har per definition inget konto än.
 */
export const CHATTAR = new Set(["start"]);

const MAX_FRAGA = 500;
const MAX_SVAR = 4000;
/** Turer per samtal. En människa som ställt trettio frågor har slutat fråga och börjat testa boten. */
const MAX_TURER = 40;
/** Samtal i minnet. Filen är sanningen, minnet är indexet panelen läser — som i flode.ts. */
const SAMTALSTAK = 5_000;

export interface SamtalsRad {
  at: string;
  /** Samtalet. Slumpat i webbläsaren när arket öppnas; ett ark = ett samtal. */
  samtal: string;
  /** Flödessessionen, så att samtalet går att lägga bredvid stegen det ställdes i. */
  sess: string | null;
  /** Kontot, när säljaren hunnit logga in. Oftast null: arket öppnas före grinden. */
  uid: string | null;
  chatt: string;
  /** Steget säljaren stod i. Null när klienten inte visste. */
  steg: string | null;
  fraga: string;
  svar: string;
  /** Sant när boten föll och säljaren fick ett fel i stället för ett svar. */
  fel: boolean;
}

export interface Samtal {
  id: string;
  sess: string | null;
  uid: string | null;
  chatt: string;
  start: string;
  slut: string;
  turer: Array<{ at: string; steg: string | null; fraga: string; svar: string; fel: boolean }>;
}

// ---------------------------------------------------------------------------
// Minnet
// ---------------------------------------------------------------------------

const samtalen = new Map<string, SamtalsRad[]>();
let laddad: Promise<void> | null = null;
let kedja: Promise<unknown> = Promise.resolve();

function skrivIn(rad: SamtalsRad): void {
  let rader = samtalen.get(rad.samtal);
  if (!rader) {
    if (samtalen.size >= SAMTALSTAK) {
      // Insättningsordnad karta: första nyckeln är det äldsta samtalet.
      const aldst = samtalen.keys().next().value;
      if (aldst !== undefined) samtalen.delete(aldst);
    }
    rader = [];
    samtalen.set(rad.samtal, rader);
  }
  if (rader.length < MAX_TURER) rader.push(rad);
}

async function ladda(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(SAMTAL_FIL(), "utf-8");
  } catch {
    return;
  }
  for (const rad of raw.split("\n")) {
    if (!rad.trim()) continue;
    try {
      const r = JSON.parse(rad) as SamtalsRad;
      if (!r?.samtal || !r.at || typeof r.fraga !== "string") continue;
      skrivIn(r);
    } catch {
      // En halv rad från en process som dog mitt i en skrivning fäller inte hela läsningen.
      continue;
    }
  }
}

export function redo(): Promise<void> {
  laddad ??= ladda();
  return laddad;
}

// ---------------------------------------------------------------------------
// Skrivningen
// ---------------------------------------------------------------------------

function id(varde: unknown, langd = 64): string | null {
  if (typeof varde !== "string") return null;
  const rent = varde.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(rent) && rent.length <= langd ? rent : null;
}

/**
 * Skriver en tur. Faller aldrig — ett samtal ska inte gå sönder för att anteckningen om det gjorde det.
 *
 * Anropas efter att svaret gått iväg till säljaren, så att en långsam disk inte blir en långsam chatt.
 */
export async function spara(input: {
  samtal: unknown;
  sess?: unknown;
  uid?: unknown;
  chatt?: unknown;
  steg?: unknown;
  fraga: string;
  svar: string;
  fel?: boolean;
}): Promise<void> {
  try {
    const samtal = id(input.samtal);
    if (!samtal) return;
    const chatt = typeof input.chatt === "string" && CHATTAR.has(input.chatt) ? input.chatt : "start";
    const fraga = input.fraga.trim().slice(0, MAX_FRAGA);
    if (!fraga) return;
    await redo();
    const rad: SamtalsRad = {
      at: new Date().toISOString(),
      samtal,
      sess: id(input.sess),
      uid: id(input.uid),
      chatt,
      steg: typeof input.steg === "string" && input.steg.length <= 40 ? input.steg : null,
      fraga,
      svar: (input.svar ?? "").trim().slice(0, MAX_SVAR),
      fel: !!input.fel,
    };
    skrivIn(rad);
    const text = JSON.stringify(rad) + "\n";
    kedja = kedja
      .then(async () => {
        await mkdir(DATA_KATALOG(), { recursive: true });
        await appendFile(SAMTAL_FIL(), text, "utf-8");
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

/** Alla samtal, nyast först, med turerna i den ordning de ställdes. */
export async function allaSamtal(): Promise<Samtal[]> {
  await redo();
  const ut: Samtal[] = [];
  for (const [samtalsId, rader] of samtalen) {
    if (!rader.length) continue;
    const sorterade = [...rader].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    ut.push({
      id: samtalsId,
      // Sessionen och kontot står på de rader som hade dem: inloggningen kan ske mitt i ett samtal.
      sess: sorterade.find((r) => r.sess)?.sess ?? null,
      uid: sorterade.find((r) => r.uid)?.uid ?? null,
      chatt: sorterade[0].chatt,
      start: sorterade[0].at,
      slut: sorterade[sorterade.length - 1].at,
      turer: sorterade.map((r) => ({ at: r.at, steg: r.steg, fraga: r.fraga, svar: r.svar, fel: r.fel })),
    });
  }
  return ut.sort((a, b) => (a.slut < b.slut ? 1 : -1));
}

/** Bara för tester: glöm allt och läs om vid nästa fråga. */
export function nollstall(): void {
  samtalen.clear();
  laddad = null;
}
