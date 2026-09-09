/**
 * ONNX-körningen, i en egen tråd.
 *
 * Här inne finns ingenting annat än modellen: en session per fil, en tensor in, en tensor ut. All
 * bildbehandling — nedskalning, normalisering, uppskalning av masken — ligger kvar i segmentera.ts
 * på huvudtråden, för den kostar tiotals millisekunder. Det är MODELLEN som kostar sekunder till
 * minuter, och det är bara den som behöver flytta.
 *
 * VARFÖR TRÅDEN FINNS. `InferenceSession.run` i onnxruntime-node 1.20.1 lämnar ett löfte, men själva
 * räknandet sker synkront på den tråd som anropade den. En prov (`sample`) på den körande servern
 * visade hela huvudtråden nere i `InferenceSessionWrap::Run` → `MlasGemmBatch`, med 90 % CPU i
 * minuter. Under tiden svarade servern inte på något: ingen pollning, inga timers, inga steg i
 * besiktningen. Skärmen stod kvar på "Bilder förberedda" tills omslaget var färdigt — och det såg ut
 * som att inspektionen hängt sig, fast det var omslaget till FÖRRA jobbet som höll processen.
 */

import { parentPort, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-node";

if (!parentPort) throw new Error("inferensWorker måste köras som worker_thread");
const port = parentPort;

/** Sessioner per modellfil. Att ladda om en 490 MB-fil per bild vore en mätning av disken. */
const sessioner = new Map<string, ort.InferenceSession>();

async function session(fil: string, tradar: number): Promise<ort.InferenceSession> {
  const fanns = sessioner.get(fil);
  if (fanns) return fanns;
  const t0 = Date.now();
  const s = await ort.InferenceSession.create(fil, {
    // Trådarna är fria att vara fler nu: de tar inte längre kärnor från något som betjänar en
    // väntande säljare, för huvudtråden gör ingenting av det här. Taket är ändå kvar i env:en, så
    // en liten burk kan hålla nere det.
    intraOpNumThreads: tradar,
    graphOptimizationLevel: "all",
  });
  sessioner.set(fil, s);
  port.postMessage({ sort: "laddad", fil, ms: Date.now() - t0 });
  return s;
}

type Uppdrag = {
  id: number;
  fil: string;
  tradar: number;
  typ: "float32" | "float16";
  data: Float32Array | Uint16Array;
  dims: number[];
};

port.on("message", async (msg: Uppdrag | { sort: "slapp" }) => {
  if ("sort" in msg) {
    for (const s of sessioner.values()) await s.release().catch(() => {});
    sessioner.clear();
    port.postMessage({ sort: "slappt" });
    return;
  }
  try {
    const s = await session(msg.fil, msg.tradar);
    /**
     * Samma cast som i segmentera.ts, av samma skäl: onnxruntime-common 1.20.1 typar "float16" så
     * att det inte får ta en Uint16Array, medan bindningen kräver exakt det.
     */
    const tensor =
      msg.typ === "float16"
        ? (new (ort.Tensor as unknown as new (t: string, d: Uint16Array, dims: number[]) => ort.Tensor)(
            "float16",
            msg.data as Uint16Array,
            msg.dims,
          ) as ort.Tensor)
        : new ort.Tensor("float32", msg.data as Float32Array, msg.dims);

    const svar = await s.run({ [s.inputNames[0]]: tensor });
    const t = svar[s.outputNames[0]];
    const utTyp = (t as unknown as { type?: string }).type ?? "float32";
    /**
     * En KOPIA skickas tillbaka, inte modellens egen buffert.
     *
     * Överföringen tömmer den buffert den flyttar, och vad onnxruntime gör med sitt utdataminne
     * efteråt är inte vårt att bestämma. Kopian kostar några megabyte en gång; en tömd buffert inne
     * i biblioteket är en krasch som inte går att felsöka.
     */
    const kopia = (t.data as Float32Array | Uint16Array).slice();
    port.postMessage({ id: msg.id, ok: true, typ: utTyp, data: kopia }, [kopia.buffer]);
  } catch (err) {
    port.postMessage({ id: msg.id, ok: false, fel: err instanceof Error ? err.message : String(err) });
  }
});

port.postMessage({ sort: "redo", tradar: (workerData as { tradar?: number } | null)?.tradar ?? 1 });
