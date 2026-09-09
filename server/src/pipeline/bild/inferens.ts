/**
 * Huvudtrådens sida av modellkörningen: skicka en tensor, få en tillbaka.
 *
 * Tråden startas vid första bilden och hålls kvar — modellfilen tar sekunder att läsa in och
 * hundratals megabyte att bära, och att göra om det per bild vore att byta en blockerad server mot
 * en långsam. Efter en stunds tystnad släpps den ändå: se SLAPP_EFTER_MS.
 *
 * Faller tråden — slut på minne, en trasig modellfil — avvisas de uppdrag som väntar med sitt fel,
 * och nästa anrop startar en ny. Ett omslag som uteblir ska kosta omslaget, aldrig servern.
 */

import path from "node:path";
import { Worker } from "node:worker_threads";

/** Filen bredvid den här, med samma ändelse: .ts under tsx, .js om bygget någon gång kompileras. */
const WORKERFIL = new URL(`./inferensWorker${path.extname(import.meta.filename)}`, import.meta.url);

/**
 * Hur länge tråden får ligga kvar sysslolös innan modellen släpps ur minnet.
 *
 * Servern mättes till 5,8 GB residentminne med BiRefNet inläst, på en burk som också ska bära
 * prismotorn och besiktningen. Tre minuter är längre än glappet mellan två bilder i samma jobb och
 * kortare än glappet mellan två säljare.
 */
const SLAPP_EFTER_MS = 180_000;

type Svar = { id: number; ok: true; typ: string; data: Float32Array | Uint16Array } | { id: number; ok: false; fel: string };

let worker: Worker | null = null;
let nastaId = 1;
const vantande = new Map<number, { klar: (s: { typ: string; data: Float32Array | Uint16Array }) => void; fel: (e: Error) => void }>();
let slappTimer: NodeJS.Timeout | null = null;

function avbrytAlla(orsak: string): void {
  for (const { fel } of vantande.values()) fel(new Error(orsak));
  vantande.clear();
}

function planeraSlapp(): void {
  if (slappTimer) clearTimeout(slappTimer);
  slappTimer = setTimeout(() => {
    if (vantande.size > 0) return planeraSlapp();
    const w = worker;
    worker = null;
    void w?.terminate();
    console.info("[produktbild] modelltråden släppt efter tystnad — minnet tillbaka");
  }, SLAPP_EFTER_MS);
  slappTimer.unref?.();
}

function tråd(tradar: number): Worker {
  if (worker) return worker;
  const w = new Worker(WORKERFIL, { workerData: { tradar } });
  /**
   * Tråden håller processen vid liv BARA medan den har något att göra.
   *
   * Utan `unref` hade ett skript som väntar in sin sista bild aldrig tagit slut — tråden ligger kvar
   * och lyssnar. Utan `ref` i andra änden hade samma skript kunnat avslutas MITT i en körning, för
   * ett väntande löfte från en unref:ad tråd räcker inte för att hålla loopen igång. Alltså båda:
   * ref när ett uppdrag skickas, unref när det sista svarat.
   */
  w.unref();
  w.on("message", (m: Svar | { sort: string; fil?: string; ms?: number }) => {
    if ("sort" in m) {
      if (m.sort === "laddad") console.info(`[produktbild] modell ${path.basename(m.fil ?? "")} laddad på ${m.ms} ms (egen tråd)`);
      return;
    }
    const v = vantande.get(m.id);
    if (!v) return;
    vantande.delete(m.id);
    if (vantande.size === 0) w.unref();
    if (m.ok) v.klar({ typ: m.typ, data: m.data });
    else v.fel(new Error(m.fel));
  });
  w.on("error", (err) => {
    worker = null;
    avbrytAlla(`modelltråden föll: ${err.message}`);
  });
  w.on("exit", (kod) => {
    if (worker === w) worker = null;
    if (vantande.size > 0) avbrytAlla(`modelltråden avslutades (${kod}) med uppdrag kvar`);
  });
  worker = w;
  return w;
}

/**
 * Kör modellen på en tensor. Kastar hellre än att svara fel — anroparen faller tillbaka på ingen
 * mask alls, vilket ger en bildruta utan urklipp i stället för ett urklipp av ingenting.
 */
export function korModell(
  fil: string,
  tradar: number,
  indata: { typ: "float32" | "float16"; data: Float32Array | Uint16Array; dims: number[] },
): Promise<{ typ: string; data: Float32Array | Uint16Array }> {
  const w = tråd(tradar);
  const id = nastaId++;
  return new Promise((klar, fel) => {
    vantande.set(id, { klar, fel });
    w.ref();
    // Bufferten flyttas i stället för att kopieras: tensorn är 3 × 1024² flyttal, och den behövs
    // inte här efter att den skickats.
    // Casten är typdeklarationens fel: `TypedArray.buffer` skrivs som ArrayBufferLike, alltså även
    // SharedArrayBuffer, och en sådan går inte att flytta. Våra tensorer är alltid vanliga buffertar.
    w.postMessage({ id, fil, tradar, typ: indata.typ, data: indata.data, dims: indata.dims }, [
      indata.data.buffer as ArrayBuffer,
    ]);
    planeraSlapp();
  });
}

/** Släpper modellerna och avslutar tråden. För skript som kör en gång och ska ta slut. */
export async function slappTraden(): Promise<void> {
  const w = worker;
  worker = null;
  if (slappTimer) clearTimeout(slappTimer);
  if (!w) return;
  /**
   * Vänta in bekräftelsen, men bara en stund — sedan bryts tråden ändå.
   *
   * Timern får INTE vara unref:ad: när tråden är sysslolös är den redan unref:ad, och ett skript vars
   * enda kvarvarande arbete är den här väntan hade då tagit slut mitt i den. Löftet blev aldrig
   * infriat och Node klagade på "unsettled top-level await" i stället för att städa.
   */
  await new Promise<void>((klar) => {
    const timer = setTimeout(klar, 2000);
    w.once("message", (m: { sort?: string }) => {
      if (m?.sort === "slappt") {
        clearTimeout(timer);
        klar();
      }
    });
    w.postMessage({ sort: "slapp" });
  });
  await w.terminate();
}
