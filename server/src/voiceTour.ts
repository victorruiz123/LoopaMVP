import type { ServerResponse } from "node:http";

/**
 * Röstrundans transkriberingsproxy: webbsidan skickar hela rundans ljud hit, servern skickar det
 * vidare till Aqua Voice (Avalon API) och returnerar text + segment-tidsstämplar.
 *
 * Proxy av samma skäl som Gemini: nyckeln får aldrig ligga i webbappen. Avalon är OpenAI-kompatibelt
 * och BATCH-ONLY (stream=false är enda accepterade värdet), så det här anropet görs en gång när
 * rundan är avslutad — inte medan säljaren pratar.
 *
 * Utan AQUA_API_KEY svarar vi 503 med klartext. Ett transkript hittas aldrig på.
 */

const AQUA_URL = "https://api.aquavoice.com/v1/audio/transcriptions";
const AQUA_MODEL = "avalon-v1.5";
/** Avalons filgräns. Kollas här så felet blir vårt och begripligt, inte ett 400 från tredje part. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Ordförrådshint till transkriberingen. Avalon tar en `prompt` med kontext/vokabulär; svenska
 * möbel- och skadetermer är precis det en generell taligenkännare hör fel på.
 */
const VOCAB_PROMPT =
  "Svensk beskrivning av begagnade möbler och deras skador. Vanliga ord: repa, repor, fläck, " +
  "fanér, fanérsläpp, nopprig, blekt, vattenring, spricka, gångjärn, sarg, rygg, sits, karm, " +
  "underrede, IKEA, Norrgavel, Dux, Lamino, teak, ek, björk, valnöt.";

/**
 * Filändelsen Avalon ska se, härledd ur mime-typen. Bara format Avalon dokumenterar att den tar:
 * flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. Okända subtyper faller på "webm" — den vanligaste
 * containern från MediaRecorder, och ett bättre försök än en ändelse Avalon säkert avvisar.
 */
function extensionFor(mimeType: string): string {
  const sub = mimeType.split("/")[1]?.split(";")[0]?.replace(/^x-/, "") ?? "";
  const map: Record<string, string> = {
    webm: "webm",
    mp4: "mp4",
    "mp4a-latm": "mp4",
    m4a: "m4a",
    aac: "m4a",
    wav: "wav",
    wave: "wav",
    mpeg: "mp3",
    mp3: "mp3",
    mpga: "mp3",
    ogg: "ogg",
    opus: "ogg",
    flac: "flac",
  };
  return map[sub] ?? "webm";
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscribeBody {
  /** data:audio/webm;base64,... — hela rundans ljudspår i en fil. */
  audioDataUrl: string;
  /** ISO 639-1. Standard "sv". */
  language?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

export async function handleTranscribeTour(
  body: TranscribeBody,
  res: ServerResponse,
): Promise<void> {
  const apiKey = process.env.AQUA_API_KEY ?? "";
  if (!apiKey) {
    return sendJson(res, 503, {
      error:
        "AQUA_API_KEY saknas i server/.env — transkribering är avstängd. Hämta en nyckel på aquavoice.com/avalon-api.",
    });
  }

  // Även videocontainrar: på iOS klarar Safari bara EN MediaRecorder åt gången, så rundan spelas in
  // som video+ljud i samma fil och hela klippet skickas hit. Avalon läser ljudspåret ur mp4/webm.
  const match = /^data:((?:audio|video)\/[\w.+-]+)(?:;codecs=[\w.,+-]+)?;base64,(.+)$/.exec(
    body.audioDataUrl ?? "",
  );
  if (!match) {
    return sendJson(res, 400, { error: "audioDataUrl måste vara en base64 data-URL med ljud eller video (webm/mp4)." });
  }
  const [, mimeType, base64] = match;
  const audio = Buffer.from(base64, "base64");
  if (audio.byteLength === 0) return sendJson(res, 400, { error: "Tom ljudfil." });
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return sendJson(res, 400, {
      error: `Ljudfilen är ${(audio.byteLength / 1024 / 1024).toFixed(1)} MiB — Avalon tar max 25 MiB. Kortare runda krävs.`,
    });
  }

  /**
   * Byggs om per försök. En FormData som redan skickats är inte säkert återanvändbar — kroppen kan
   * ha konsumerats — och ett omförsök som tyst skickar en tom kropp vore värre än inget omförsök.
   */
  const buildForm = () => {
    const form = new FormData();
    // Avalon läser formatet ur FILÄNDELSEN och avvisar en den inte känner igen (400 "invalid
    // request"), så den måste följa den faktiska typen. En hårdkodad ".webm" eller ett ".bin" för
    // allt utanför de två vanliga fallen fäller uppladdningen — mätt med en wav-fil.
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `tour.${extensionFor(mimeType)}`);
    form.append("model", AQUA_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("language", body.language?.trim() || "sv");
    form.append("prompt", VOCAB_PROMPT);
    return form;
  };

  const startedAt = Date.now();

  /**
   * Ett omförsök vid NÄTVERKSFEL, och bara då.
   *
   * Motiverat av vad ett misslyckande kostar: ljudet finns bara i webbläsarens minne, och en
   * säljare som filmat ett varv och berättat om möbeln kan inte göra om det — möbeln kanske inte
   * ens står kvar. Det är en dyrare förlust än ett Gemini-fel, där bildrutorna åtminstone ligger
   * sparade och går att spela upp igen. Mätt en gång under röktestet: `fetch failed` mot en tjänst
   * som svarade normalt en minut senare.
   *
   * Ett HTTP-SVAR görs aldrig om, hur trasigt det än är: 400 på ett format Avalon inte tar och 401
   * på fel nyckel blir inte bättre av att skickas igen, bara dubbelt så dyra i tid.
   */
  let upstream: Response | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      upstream = await fetch(AQUA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildForm(),
        // Synkrona anropet väntar upp till 210 s hos Avalon; en 3-minutersrunda transkriberas långt
        // snabbare än så, men taket ska vara vårt så en hängning inte blir en evig spinner.
        signal: AbortSignal.timeout(180_000),
      });
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[voiceTour] försök ${attempt + 1} mot Aqua föll: ${lastError}`);
    }
  }
  if (!upstream) {
    return sendJson(res, 502, { error: `Kunde inte nå Aqua Voice: ${lastError}` });
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    // Avalon svarar med OpenAI-formens felkuvert; skicka vidare budskapet, inte hela kuvertet.
    let message = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* råtexten duger */
    }
    return sendJson(res, 502, { error: `Aqua Voice svarade ${upstream.status}: ${message}` });
  }

  let parsed: {
    text?: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 502, { error: "Aqua Voice svarade med något som inte är JSON." });
  }

  const segments: TranscriptSegment[] = (parsed.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: (s.text ?? "").trim(),
  }));

  console.info(
    `[voiceTour] transkriberade ${(audio.byteLength / 1024).toFixed(0)} kB på ${Date.now() - startedAt} ms — ${segments.length} segment, ${parsed.duration ?? "?"} s ljud`,
  );

  return sendJson(res, 200, {
    text: (parsed.text ?? "").trim(),
    language: parsed.language ?? null,
    duration: parsed.duration ?? null,
    segments,
  });
}

export type { TranscribeBody };
