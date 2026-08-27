// Local, deterministic video -> 6-8 best-view selection. No AI involved — this must run in under ~2s
// so the analysis SLA clock (which starts once the seller confirms the views) stays untouched.

export interface ExtractedFrame {
  dataUrl: string;
  bucketIndex: number;
  blurScore: number;
  exposureOk: boolean;
  hash: number[]; // 8x8 average-hash bits, for cheap perceptual similarity
}

// 40, not 20: a walkaround is soft throughout — measured across eight selected frames the sharpness
// spread was only 7.3 to 11.8, so the selector was choosing the best of two or three per bucket and
// none of them were sharp. More candidates means more chances to catch a moment where the phone was
// briefly still. Costs about twice the seeking, still local canvas work, still no AI.
const CANDIDATE_COUNT = 40;
const NUM_BUCKETS = 8;
const MAX_UPLOAD_WIDTH = 1280;
const HASH_SIZE = 8;
const SIMILARITY_HAMMING_THRESHOLD = 6; // out of 64 bits — below this, treat as a near-duplicate
const MIN_FRAMES = 4; // never hand back fewer than this, even if the source barely changes

export async function extractBestFrames(videoBlob: Blob): Promise<{ dataUrl: string; viewLabel: string | null }[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(videoBlob);
  video.src = url;

  try {
    await waitFor(video, "loadedmetadata");
    const duration = video.duration;
    if (!duration || !isFinite(duration)) throw new Error("Kunde inte läsa videons längd.");

    const scoreCanvas = document.createElement("canvas");
    const scoreCtx = scoreCanvas.getContext("2d", { willReadFrequently: true })!;
    const captureCanvas = document.createElement("canvas");
    const captureCtx = captureCanvas.getContext("2d")!;

    const candidates: ExtractedFrame[] = [];
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      const t = ((i + 0.5) / CANDIDATE_COUNT) * duration;
      await seekTo(video, t);
      const { blurScore, exposureOk, hash } = analyzeFrame(video, scoreCanvas, scoreCtx);
      const dataUrl = captureFrame(video, captureCanvas, captureCtx);
      const bucketIndex = Math.min(NUM_BUCKETS - 1, Math.floor((i / CANDIDATE_COUNT) * NUM_BUCKETS));
      candidates.push({ dataUrl, bucketIndex, blurScore, exposureOk, hash });
    }

    const perBucket: (ExtractedFrame | null)[] = Array.from({ length: NUM_BUCKETS }, () => null);
    for (const c of candidates) {
      const current = perBucket[c.bucketIndex];
      const cScore = c.blurScore * (c.exposureOk ? 1 : 0.3);
      const curScore = current ? current.blurScore * (current.exposureOk ? 1 : 0.3) : -1;
      if (cScore > curScore) perBucket[c.bucketIndex] = c;
    }

    let selected: ExtractedFrame[] = [];
    for (const frame of perBucket) {
      if (!frame) continue;
      const isDuplicate = selected.some((s) => hammingDistance(s.hash, frame.hash) < SIMILARITY_HAMMING_THRESHOLD);
      if (!isDuplicate) selected.push(frame);
    }
    // Similarity dedup collapsing to almost nothing means the source had very little visible change
    // (e.g. the seller paused mid-scan) — better to keep temporal spread than to hand back one photo.
    if (selected.length < MIN_FRAMES) {
      selected = perBucket.filter((f): f is ExtractedFrame => f !== null);
    }

    // No view label. The old code spread eight compass names ("Framifrån", "Bak-höger", ...) across the
    // selected frames by INDEX, so a half-circle sweep still produced a frame confidently labelled
    // "Bakifrån". Those labels went straight into the inspection prompt, telling the model which side it
    // was looking at based on nothing. Angle is not measured here, so nothing honest can be said about it
    // — the frames stay in filming order, which the prompt already states.
    return selected.map((f) => ({ dataUrl: f.dataUrl, viewLabel: null }));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      video.removeEventListener(event, onEvent);
      resolve();
    };
    video.addEventListener(event, onEvent);
    video.addEventListener("error", () => reject(new Error("Kunde inte läsa videon.")), { once: true });
  });
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): string {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, MAX_UPLOAD_WIDTH / vw);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** One pass: downscaled sharpness (gradient magnitude), exposure (mean luminance), and an 8x8 average-hash. */
function analyzeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { blurScore: number; exposureOk: boolean; hash: number[] } {
  const w = 48;
  const h = 48;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const lum = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    lum[i] = l;
    sum += l;
  }
  const mean = sum / (w * h);

  let gradSum = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      gradSum += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + w] - lum[i]);
    }
  }
  const blurScore = gradSum / (w * h);
  const exposureOk = mean > 20 && mean < 235;

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

  return { blurScore, exposureOk, hash };
}

function hammingDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
