// Local, deterministic video -> best-view selection, one per time bucket. No AI involved.
// so the analysis SLA clock (which starts once the seller confirms the views) stays untouched.

export interface ExtractedFrame {
  dataUrl: string;
  bucketIndex: number;
  blurScore: number;
  usable: boolean;
  hash: number[]; // 8x8 average-hash bits, for cheap perceptual similarity
}

/**
 * Hur många vyer möbeln bedöms från. Sex sedan 2026-08-28, tidigare åtta.
 *
 * En ren latensavvägning, tagen med kostnaden känd. Bildrutorna går i ETT inspektionsanrop, och
 * antalet driver svarstiden mätbart:
 *
 *   4 bildrutor   7 194 prompt-tokens   21,2 s
 *   8 bildrutor  11 626 prompt-tokens   36,9 s
 *
 * Sex ligger däremellan. Priset är två vyer färre av möbeln — en skada som bara syns från ett håll
 * har nu färre chanser att hamna i en vald bildruta. Det är en verklig kvalitetskostnad och inte en
 * gratis optimering; den är vald med öppna ögon och mätningen som stänger den är ännu inte gjord.
 *
 * Styr BARA videovägens urval. Taket för hur många bilder ett jobb får skicka är en egen konstant,
 * MAX_IMAGES_PER_JOB i server/src/config.ts, och de två ska kunna röra sig var för sig.
 */
const DEFAULT_BUCKETS = 6;

/**
 * `?buckets=N` sätter antalet vyer för EN körning.
 *
 * Finns för A/B-mätningen på inspelningsdagen: samma film ska kunna köras med sex och åtta vyer i
 * samma sittning, så att Googles dagsform slår lika på båda. Utan det hade jämförelsen krävt en
 * ombyggnad mellan körningarna, och då jämför man två olika dagar lika mycket som två inställningar.
 *
 * Standardvärdet är oförändrat — parametern måste sättas i URL:en, och klamras så en felskrivning
 * inte kan be om fyrtio vyer.
 */
function bucketsFromUrl(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get("buckets");
    if (!raw) return DEFAULT_BUCKETS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(2, Math.min(10, n)) : DEFAULT_BUCKETS;
  } catch {
    return DEFAULT_BUCKETS;
  }
}

const NUM_BUCKETS = bucketsFromUrl();
const MAX_UPLOAD_WIDTH = 1280;
const HASH_SIZE = 8;
const SIMILARITY_HAMMING_THRESHOLD = 6; // out of 64 bits — below this, treat as a near-duplicate
const MIN_FRAMES = 4; // never hand back fewer than this, even if the source barely changes

/**
 * Vad som räknas som en bildruta värd att lämna ifrån sig.
 *
 * DET HÄR ÄR FELET de fångar: den första bildrutan ur en inspelning är ofta kameran innan den
 * exponerat — HELT svart. Mätt över alla 152 sparade jobb var första bildrutan svart i 45 av dem
 * (30 %), och i 4 fall gällde det även den andra. Från och med den tredje: aldrig. Den bildrutan gick
 * vidare som en av sex vyer till besiktningen, låg först i filmningsordningen överallt där bilderna
 * visas, och blev annonsens omslag tills servern började välja bort den.
 *
 * Nedviktningen i `score` räckte inte som spärr: en svart bildruta får 0 i poäng och blir ändå bäst i
 * sin vy när ingen annan bildruta i den vyn är bättre än 0 — och i vy noll, den första sjättedelen av
 * filmen, är det precis vad som händer.
 *
 * Samma tre tal som duglighetsspärren i server/src/pipeline/cover.ts, medvetet: den mäter samma sak
 * (medelluminans och spridning i gråskala) på samma bild, och två olika svar på "duger den här?" hade
 * betytt att telefonen laddar upp bildrutor som servern sedan vägrar visa.
 *
 * Gränserna kan inte slå fel på verklig film i det underlaget: ingen enda sparad bildruta ligger
 * mellan dem och det uppenbart dugliga — allt är antingen exakt mean 0,00 / stdev 0,00 eller över
 * mean 60 / stdev 25.
 */
const MIN_MEAN_LUMINANCE = 25;
const MAX_MEAN_LUMINANCE = 235;
const MIN_STDEV = 8;

/**
 * Fast-forward multiplier for the playback pass. Browsers clamp silently, so the value we set is a
 * request, not a promise — the effective rate is read back and decides whether this path is worth
 * taking at all.
 */
const PLAYBACK_RATE = 16;
/** Below this, a linear pass through a long clip is no faster than seeking, so seeking wins. */
const MIN_USEFUL_RATE = 3;
/** What this should cost. Reported, not enforced — see EXTRACTION_CEILING_MS. */
export const EXTRACTION_TARGET_MS = 5000;
/**
 * The absolute ceiling for the whole module, shared by every pass.
 *
 * ONE deadline for the lot, not one per phase, because the failure this replaces was phases ADDING
 * UP: a playback pass abandoned on a 13.5 s prediction, followed by a fresh 40-seek pass whose own
 * per-seek timeout was 8 s — 320 s in the worst case, minutes in the ordinary one. A budget that can
 * be spent twice is not a budget.
 */
const EXTRACTION_CEILING_MS = 20000;
/** No new frame for this long means the decoder has stopped, not that it is slow. */
const PLAYBACK_STALL_MS = 2500;
/** Metadata that never arrives must not become an unbounded wait. */
const OPEN_TIMEOUT_MS = 8000;
/** A seek that never fires `seeked` used to hang the whole extraction forever. */
const SEEK_TIMEOUT_MS = 2500;
/**
 * Långt bortom vilken film som helst, men inom det en video-tagg tar emot. Att söka hit är det som
 * tvingar fram längden ur en fil som inte har den skriven i huvudet. Se usableDuration.
 */
const SEEK_PAST_END = 1e7;
/** Längdsonderingen får inte bli en ny obegränsad väntan. */
const DURATION_PROBE_MS = 3000;

/** A scored candidate. `frame` holds the full-res pixels ONLY while it leads its bucket. */
interface Candidate {
  index: number;
  bucketIndex: number;
  blurScore: number;
  usable: boolean;
  hash: number[];
  frame: HTMLCanvasElement;
}

/** Skärpa, nedviktad när bildrutan inte duger att visa. Se MIN_MEAN_LUMINANCE för varför det bara är
 * en viktning och inte spärren. */
function score(c: { blurScore: number; usable: boolean }): number {
  return c.blurScore * (c.usable ? 1 : 0.3);
}

interface PlaybackOutcome {
  buckets: Candidate[];
  framesSeen: number;
  effectiveRate: number | null;
}

/**
 * Frames out of a walkaround, without seeking.
 *
 * Seeking was the entire cost of this module: 345 ms per seek, 40 seeks, 12.8 s — because
 * MediaRecorder writes almost no keyframes, so each seek decodes forward from a distant one and most
 * of that work is thrown away. Playing the clip once at speed decodes every frame exactly once
 * instead, and `requestVideoFrameCallback` hands us each frame as it is presented.
 *
 * Measured on a 30 s 1280x960 recording:
 *
 *   seeking, 40 candidates    12.8 s   mean sharpness 12.86
 *   playback 4x, 271 seen      7.5 s   mean sharpness 12.99
 *   playback 8x, 150 seen      4.8 s   mean sharpness 12.96
 *   playback 16x, 93 seen      3.7 s   mean sharpness 12.91
 *
 * Faster AND sharper, which is not a trade: the pass sees two to seven times as many candidates as
 * the 40 the seek version sampled, so the best-in-bucket it picks is drawn from a larger pool.
 *
 * Returns whatever buckets it managed — never null, never nothing. It stops on `ended`, on the shared
 * deadline, or when no frame has arrived for PLAYBACK_STALL_MS. The earlier version gave up on a
 * PREDICTION instead ("this should have taken 13.5 s"), threw away every frame it had already
 * decoded, and handed the job to a full 40-seek pass. A decoder that is merely slower than the guess
 * is still making progress, and progress is the only thing worth interrupting for.
 */
async function extractByPlayback(
  url: string,
  sink: HTMLVideoElement[],
  deadline: number,
  hintMs?: number,
): Promise<PlaybackOutcome> {
  const empty: PlaybackOutcome = { buckets: [], framesSeen: 0, effectiveRate: null };
  if (typeof HTMLVideoElement === "undefined" || !("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    return empty;
  }
  let video: HTMLVideoElement;
  try {
    video = await openVideo(url);
  } catch {
    return empty; // sökvägen får sin egen chans att öppna filen
  }
  sink.push(video);
  const duration = await usableDuration(video, hintMs);
  if (!duration) return empty;

  video.playbackRate = PLAYBACK_RATE;
  const effectiveRate = video.playbackRate;
  if (effectiveRate < MIN_USEFUL_RATE) return empty;

  const scoreCanvas = document.createElement("canvas");
  const scoreCtx = scoreCanvas.getContext("2d", { willReadFrequently: true })!;
  const best = new Map<number, Candidate>();
  let index = 0;
  let framesSeen = 0;
  let lastFrameAt = Date.now();

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearInterval(watchdog);
      resolve();
    };
    // Tittar på FRAMSTEG, inte på klockan ensam: bildrutor slutade komma, eller så är den delade
    // deadline passerad. Båda är verkliga skäl att sluta; "långsammare än väntat" är det inte.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt > PLAYBACK_STALL_MS || Date.now() > deadline) done();
    }, 250);

    video.addEventListener("ended", done, { once: true });
    video.addEventListener("error", done, { once: true });

    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (settled) return;
      framesSeen++;
      lastFrameAt = Date.now();
      const { blurScore, usable, hash } = analyzeFrame(video, scoreCanvas, scoreCtx);
      const bucketIndex = Math.min(NUM_BUCKETS - 1, Math.floor((meta.mediaTime / duration) * NUM_BUCKETS));
      const current = best.get(bucketIndex);
      if (!current || score({ blurScore, usable }) > score(current)) {
        best.set(bucketIndex, {
          index: index++,
          bucketIndex,
          blurScore,
          usable,
          hash,
          // The element keeps playing, so the pixels have to be taken inside this callback — the
          // frame it is showing now is the one that was just scored.
          frame: grabFrame(video, current?.frame),
        });
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(done);
  });

  video.pause();
  return { buckets: [...best.values()], framesSeen, effectiveRate };
}

export interface ExtractionReport {
  method: "playback" | "playback+seek" | "seek";
  ms: number;
  /** Vyer som faktiskt lämnas ifrån sig — efter att odugliga bildrutor sorterats bort. */
  buckets: number;
  /** Hur många vyer som föll på duglighetsspärren. Nästan alltid den svarta första. */
  dropped: number;
  framesSeen: number;
  effectiveRate: number | null;
}

/**
 * `?frames=seek` tvingar fram sökvägen.
 *
 * Finns för DEMO, inte för produktion. Uppspelningsvägen tar emot de bildrutor webbläsaren råkar
 * presentera, och vilka det blir varierar några millisekunder mellan körningar — mätt skiljde sig 4
 * av 8 bildrutor mellan två körningar av samma film. Olika bildrutor betyder olika bytes, och
 * Gemini-cachen slår på bytes, så en förvärmd film missar cachen nästa gång.
 *
 * Sökvägen är deterministisk: samma tidsstämplar varje gång, samma bildrutor, cacheträff. Den kostar
 * någon sekund mer i uttaget och är den urvalsväg som gällde före uppspelningen, alltså redan
 * välsignad. Standardvärdet är oförändrat — flaggan måste sättas i URL:en.
 */
function deterministicRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("frames") === "seek";
  } catch {
    return false;
  }
}

export async function extractBestFrames(
  videoBlob: Blob,
  onReport?: (report: ExtractionReport) => void,
  /** Hur länge inspelningen pågick, när den som anropar vet det. Se usableDuration. */
  hintMs?: number,
): Promise<{ dataUrl: string; viewLabel: string | null }[]> {
  const url = URL.createObjectURL(videoBlob);
  const videosToClose: HTMLVideoElement[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + EXTRACTION_CEILING_MS;
  try {
    const playback = deterministicRequested()
      ? { buckets: [], framesSeen: 0, effectiveRate: null }
      : await extractByPlayback(url, videosToClose, deadline, hintMs);
    const found = new Map(playback.buckets.map((c) => [c.bucketIndex, c]));

    // Sökning fyller bara HÅL, den gör inte om jobbet. Uppspelningens bildrutor är redan avkodade
    // och betalda; att kasta dem för att börja om var hela felet.
    //
    // En vy vars bästa bildruta är svart räknas som ett HÅL, inte som fylld: där finns inget att
    // bevara, och resten av vyn är filmad efter att kameran hunnit exponera. Sökningen träffar vy noll
    // först en bit in i den (offsets nedan börjar på 0,5), vilket är precis förbi det svarta.
    let method: ExtractionReport["method"] = "playback";
    const filled = () => [...found.values()].filter((c) => c.usable).length;
    if (filled() < NUM_BUCKETS && Date.now() < deadline) {
      method = filled() === 0 ? "seek" : "playback+seek";
      await fillGapsBySeeking(url, videosToClose, found, deadline, startedAt + EXTRACTION_TARGET_MS, hintMs);
    }

    const perBucket = Array.from({ length: NUM_BUCKETS }, (_, b) => found.get(b)).filter(
      (c): c is Candidate => c !== undefined,
    );

    // Odugliga bildrutor stannar HÄR, på telefonen. Fem vyer är bättre än sex där en är svart: den
    // svarta visar ingenting för besiktningen, kostar ändå sin plats i inspektionsanropet, och är det
    // första en köpare ser i annonsen.
    //
    // Duger ingen enda behålls listan orörd — en analys på dåliga bildrutor är fortfarande bättre än
    // "kunde inte läsa någon bildruta ur videon" för någon som redan filmat klart.
    const presentable = perBucket.filter((c) => c.usable);
    const views = presentable.length > 0 ? presentable : perBucket;

    const report: ExtractionReport = {
      method,
      ms: Date.now() - startedAt,
      buckets: views.length,
      dropped: perBucket.length - views.length,
      framesSeen: playback.framesSeen,
      effectiveRate: playback.effectiveRate,
    };
    // Loggat OCH rapporterat: när det här är segt hos någon annan är det första frågan vilken väg
    // som togs, och den ska gå att läsa av utan att bygga om något.
    console.info(
      `[videoFrames] ${report.method} · ${(report.ms / 1000).toFixed(1)}s · ${report.buckets}/${NUM_BUCKETS} vyer · ` +
        `${report.framesSeen} bildrutor sedda · fart ${report.effectiveRate ?? "–"}x` +
        (report.dropped > 0 ? ` · ${report.dropped} oduglig(a) bortsorterad(e)` : ""),
    );
    onReport?.(report);
    return encodeSelection(views);
  } finally {
    for (const v of videosToClose) {
      v.removeAttribute("src");
      v.load();
    }
    URL.revokeObjectURL(url);
  }
}

/**
 * Dedup by perceptual hash, then encode — the only JPEG work in the module, and only for what survives.
 *
 * Tar emot vyer som redan passerat duglighetsspärren, så MIN_FRAMES-reserven nedan kan inte plocka
 * tillbaka en svart bildruta som just sorterats bort.
 */
function encodeSelection(views: Candidate[]): { dataUrl: string; viewLabel: string | null }[] {
  let selected: Candidate[] = [];
  for (const frame of views) {
    const isDuplicate = selected.some((s) => hammingDistance(s.hash, frame.hash) < SIMILARITY_HAMMING_THRESHOLD);
    if (!isDuplicate) selected.push(frame);
  }
  // Similarity dedup collapsing to almost nothing means the source had very little visible change
  // (e.g. the seller paused mid-scan) — better to keep temporal spread than to hand back one photo.
  if (selected.length < MIN_FRAMES) selected = views;
  if (selected.length === 0) throw new Error("Kunde inte läsa någon bildruta ur videon.");

  // No view label. The old code spread eight compass names ("Framifrån", "Bak-höger", ...) across the
  // selected frames by INDEX, so a half-circle sweep still produced a frame confidently labelled
  // "Bakifrån". Those labels went straight into the inspection prompt, telling the model which side it
  // was looking at based on nothing. Angle is not measured here, so nothing honest can be said about it
  // — the frames stay in filming order, which the prompt already states.
  return selected.map((f) => ({ dataUrl: f.frame.toDataURL("image/jpeg", 0.85), viewLabel: null }));
}

/**
 * Fills buckets the playback pass did not reach, breadth first and under the shared deadline.
 *
 * Breadth first matters: one candidate at the centre of every missing bucket comes before a second
 * candidate anywhere, so coverage of the furniture is secured before sharpness within a view is
 * improved. Time left buys more candidates; time gone still leaves every bucket represented.
 *
 * This replaces a fixed 40-seek sweep that ran from scratch whenever playback was abandoned. On a
 * phone recording, where seeks cost hundreds of milliseconds each, that sweep was the difference
 * between four seconds and several minutes.
 */
async function fillGapsBySeeking(
  url: string,
  videos: HTMLVideoElement[],
  found: Map<number, Candidate>,
  deadline: number,
  qualityDeadline: number,
  hintMs?: number,
): Promise<void> {
  // Oduglig räknas som saknad: en svart bildruta har 0 i poäng, så vad sökningen än hittar slår den.
  const missing = Array.from({ length: NUM_BUCKETS }, (_, b) => b).filter((b) => !found.get(b)?.usable);
  if (missing.length === 0) return;

  const video = await openVideo(url);
  videos.push(video);
  const duration = await usableDuration(video, hintMs);
  if (!duration) return;
  const scoreCanvas = document.createElement("canvas");
  const scoreCtx = scoreCanvas.getContext("2d", { willReadFrequently: true })!;

  // Sweep 0 hits each bucket's centre, sweep 1 its first quarter, and so on.
  const offsets = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875];
  let index = 10_000;
  for (const [sweep, offset] of offsets.entries()) {
    // Täckning får kosta ända upp till taket; SKÄRPA får bara kosta det som ryms i målbudgeten.
    // Utan den skillnaden fortsatte den söka i sjutton sekunder efter att alla åtta vyer redan var
    // fyllda, för en marginell förbättring ingen bad om.
    for (const bucket of missing) {
      if (Date.now() > deadline) return;
      // Prövas per SÖKNING, inte per svep: ett svep som startade precis innan budgeten tog slut
      // körde annars klart alla åtta och drog över med flera sekunder.
      if (sweep > 0 && Date.now() > qualityDeadline) return;
      const t = ((bucket + offset) / NUM_BUCKETS) * duration;
      try {
        await seekTo(video, t);
      } catch {
        continue; // one unreachable timestamp must not cost the whole walkaround
      }
      const { blurScore, usable, hash } = analyzeFrame(video, scoreCanvas, scoreCtx);
      const current = found.get(bucket);
      if (current && score(current) >= score({ blurScore, usable })) continue;
      found.set(bucket, {
        index: index++,
        bucketIndex: bucket,
        blurScore,
        usable,
        hash,
        frame: grabFrame(video, current?.frame),
      });
    }
  }
}

/**
 * Filmens längd, även när filen inte påstår någon.
 *
 * DET HÄR VAR FELET som gjorde att varje inspelning i appen slutade med "kunde inte läsa någon
 * bildruta ur videon": MediaRecorder skriver ingen längd i webm-huvudet — den vet ju inte hur lång
 * filmen blir när den börjar — så `video.duration` är Infinity. Båda uttagsvägarna började med att
 * bomma ut på just det: uppspelningen behöver längden för att fördela bildrutorna i vyer, sökningen
 * för att veta vart den ska söka. Noll vyer, varje gång, för varje film som spelats in i appen.
 * Uppladdade filmer från kamerarullen har längden skriven och gick igenom, vilket är därför felet
 * kunde ligga och gömma sig ända tills inspelning blev enda vägen in.
 *
 * Att söka bortom slutet tvingar webbläsaren att läsa igenom filen och räkna ut längden. Sedan MÅSTE
 * uppspelningen ställas tillbaka till noll — annars står den vid filmens slut och `play()` avslutas
 * direkt, med noll bildrutor sedda.
 *
 * `hintMs` är sista utvägen: den som spelade in filmen vet hur länge den höll på, och en längd på en
 * halv sekund fel är oändligt mycket bättre än ingen längd alls.
 */
async function usableDuration(video: HTMLVideoElement, hintMs?: number): Promise<number> {
  if (video.duration > 0 && isFinite(video.duration)) return video.duration;
  const probed = await probeDuration(video);
  if (probed > 0) return probed;
  return hintMs && hintMs > 0 ? hintMs / 1000 : 0;
}

function probeDuration(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (value: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("durationchange", onChange);
      video.removeEventListener("timeupdate", onChange);
      try {
        await seekTo(video, 0);
      } catch {
        // Går den inte att spola tillbaka är den inte heller värd att spela upp; nollan säger det.
        resolve(0);
        return;
      }
      resolve(value);
    };
    const onChange = () => {
      if (video.duration > 0 && isFinite(video.duration)) void finish(video.duration);
    };
    const timer = window.setTimeout(() => void finish(0), DURATION_PROBE_MS);
    video.addEventListener("durationchange", onChange);
    video.addEventListener("timeupdate", onChange);
    try {
      video.currentTime = SEEK_PAST_END;
    } catch {
      void finish(0);
    }
  });
}

/**
 * Bounded on purpose. `loadedmetadata` is not guaranteed to fire — a container the browser half
 * recognises can leave the element sitting there with no event and no error, and this was the last
 * await in the module with no way out. "Bearbetar video…" forever is the worst failure the capture
 * flow has, because the walkaround is already filmed and there is nothing on screen to act on.
 */
function openVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Videon gick inte att öppna i tid."));
    }, OPEN_TIMEOUT_MS);
    const ok = () => {
      cleanup();
      resolve(video);
    };
    const fail = () => {
      cleanup();
      reject(new Error("Kunde inte läsa videon."));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", ok);
    video.addEventListener("error", fail);
  });
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Sökningen i videon tog för lång tid."));
    }, SEEK_TIMEOUT_MS);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

/** Full-resolution copy of the current frame. Reuses the outgoing leader's canvas when there is one. */
function grabFrame(video: HTMLVideoElement, reuse?: HTMLCanvasElement): HTMLCanvasElement {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, MAX_UPLOAD_WIDTH / vw);
  const canvas = reuse ?? document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * One pass: downscaled sharpness (gradient magnitude), usability (mean luminance and spread), and an
 * 8x8 average-hash.
 *
 * Mätt på 48x48-nedskalningen, inte på originalet: blockmedelvärdena jämnar ut fina detaljer och drar
 * ner spridningen något. Marginalen tål det med råge — samma aritmetik körd på 307 sparade bildrutor
 * lägger de svarta på mean 0,00 / stdev 0,00 och den SVAGASTE verkliga bildrutan på 105,5 / 30,9, mot
 * gränserna 25 / 8. Ingen verklig bildruta i underlaget hamnar ens i närheten av spärren.
 */
function analyzeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { blurScore: number; usable: boolean; hash: number[] } {
  const w = 48;
  const h = 48;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const lum = new Float32Array(w * h);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    lum[i] = l;
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / (w * h);
  // Spridningen, ur samma svep: en bildruta kan ligga mitt i exponeringsspannet och ändå visa en
  // enfärgad yta. Kostar en multiplikation per pixel på 48x48.
  const stdev = Math.sqrt(Math.max(0, sumSq / (w * h) - mean * mean));

  let gradSum = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      gradSum += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + w] - lum[i]);
    }
  }
  const blurScore = gradSum / (w * h);
  const usable = mean >= MIN_MEAN_LUMINANCE && mean <= MAX_MEAN_LUMINANCE && stdev >= MIN_STDEV;

  // Downsample the same 48x48 buffer to HASH_SIZE x HASH_SIZE by block-averaging, then threshold vs mean.
  const block = w / HASH_SIZE;
  const small = new Float32Array(HASH_SIZE * HASH_SIZE);
  for (let by = 0; by < HASH_SIZE; by++) {
    for (let bx = 0; bx < HASH_SIZE; bx++) {
      let s = 0;
      let n = 0;
      for (let y = Math.floor(by * block); y < Math.floor((by + 1) * block); y++) {
        for (let x = Math.floor(bx * block); x < Math.floor((bx + 1) * block); x++) {
          s += lum[y * w + x];
          n++;
        }
      }
      small[by * HASH_SIZE + bx] = s / n;
    }
  }
  const smallMean = small.reduce((a, b) => a + b, 0) / small.length;
  const hash = Array.from(small, (v) => (v > smallMean ? 1 : 0));

  return { blurScore, usable, hash };
}

function hammingDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
