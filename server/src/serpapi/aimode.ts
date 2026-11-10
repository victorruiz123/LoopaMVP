/**
 * Flödet mot Googles AI-läge via SerpApi — en port av appskalets main.js (scripts/loopa-app-prototype/, där frågorna bor) (prepare, identify, askSpecs, findImages), steg för steg:
 *
 *   prepare   omslagsbilden läggs ut på en kortlivad adress (appskalet lade in den i AI-lägets ruta)
 *   identify  fråga 1 = PROMPT (+ bilden), därefter högst två "fler förslag"-frågor i SAMMA samtal så länge färre än fyra förslag namngetts (MORE_PROMPT); bildsökningarna startar så fort
 *             modellerna är namngivna, parallellt med uppföljningarna (som appskalet gör)
 *   askSpecs  fråga efter valet = SPEC_PROMPT i samma samtal, två försök om AI-läget inte svarar
 *   findImages  bildsökning per modell, alla parallellt (SerpApis google_images i stället för skalets dolda fönster)
 *
 * FRÅGORNA är de från main.js, ord för ord (prompts.ts är genererad ur den filen). Servern efter detta (strukturering, kort, specsteg, kontroller) är SAMMA kod som för appskalet:
 * webben anropar den som förut, bara bryggen under (web/src/lib/serpApiBridge.ts) pratar med de här funktionerna i stället för med Electron.
 */

import fs from "node:fs";
import path from "node:path";
import { SerpApiError, http, serpApiSearch, withoutKey, type SerpApiJson, type SerpApiParams } from "./client.js";
import { MORE_PROMPT, PROMPT, SPEC_PROMPT, countProposals, proposalNames, undertypUr } from "./prompts.js";
import { referensKedjaPa } from "../referensbild.js";
import { NO_ANSWER, answerText, collectLinks, imageRows, referenceSection } from "./render.js";
import {
  MAX_AI_CALLS_PER_SESSION,
  MAX_IMAGE_CALLS_PER_SESSION,
  chargeOwnerSession,
  chargeSearch,
  createSession,
  endSession,
  getImage,
  publicBase,
  storeImage,
  type ImageRowsGroup,
  type Session,
} from "./session.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[serpapi]", ...a);

/** Skiljelinjen mellan första svaret och svar på uppföljningsfrågor: SAMMA text som main.js lägger in, så att servern (externalIdentify.ts SYSTEM) och countProposals läser den som förut. */
export const MORE_SEPARATOR = "\n\n=== FLER FÖRSLAG (svar på en uppföljningsfråga) ===\n";

/**
 * AI-LÄGET får INGEN `location` som förval (mätt 2026-11-07, Sits-fåtölj, samma foto och samma fråga, direkt mot SerpApi): med `location=Stockholm, Sweden` (som SerpApi kodar till en uule) kom
 * Impulse i 0 av 7 körningar och källorna var ofta brittiska; utan `location` (bara hl=sv, med eller utan gl=se) kom Impulse i 4 av 4, som på webben. Landet sätts i stället med `gl=se`.
 * SERPAPI_AI_LOCATION sätter en plats ändå (för att mäta om); utan den skickas ingen.
 */
const AI_LOCATION = (): string | undefined => process.env.SERPAPI_AI_LOCATION?.trim() || undefined;

/** Plats för bildsökningarna (google_images): Sverige (Stockholm) som förval; SERPAPI_LOCATION åsidosätter, SERPAPI_LOCATION=none skickar ingen plats. */
const LOCATION = (): string | undefined => {
  const v = process.env.SERPAPI_LOCATION?.trim();
  if (v?.toLowerCase() === "none") return undefined;
  return v || "Stockholm, Sweden";
};

// --- Loggen: varje sökning och dess svar sparas, så att man kan granska vad AI-läget faktiskt sade (motsvarar skalets "Visa Googles vy") -----------------------------------------------

/**
 * Sparas bara när det är påbett: LOOPA_SERPAPI_LOG_DIR (en katalog) eller LOOPA_SERPAPI_LOG=1 (server/data/serpapi-log). Ett svar är 10–70 kB och ett samtal har ett tiotal, så i drift fyller det
 * disken utan att någon läser det; konsolraderna `[serpapi]`, `[referens]` och `[bild]` räcker för felsökning. Lokalt slår start-serpapi.cmd på det.
 */
const logDir = (): string | null => {
  const dir = process.env.LOOPA_SERPAPI_LOG_DIR?.trim();
  if (dir) return dir;
  return process.env.LOOPA_SERPAPI_LOG === "1" ? path.join(process.cwd(), "data", "serpapi-log") : null;
};

function saveCall(s: Session, label: string, params: SerpApiParams, resp: SerpApiJson | null, error?: string): void {
  try {
    const base = logDir();
    if (!base) return;
    const dir = path.join(base, s.id);
    fs.mkdirSync(dir, { recursive: true });
    const n = String(fs.readdirSync(dir).length + 1).padStart(2, "0");
    // Svaret sparas som det kom (utan nyckeln: den finns inte i svaret) och parametrarna utan nyckeln.
    fs.writeFileSync(path.join(dir, `${n}-${label.replace(/\W+/g, "-")}.json`), JSON.stringify({ at: new Date().toISOString(), params: withoutKey(params), error: error ?? null, response: resp }, null, 2));
  } catch {
    /* loggen får aldrig fälla ett anrop */
  }
}

// --- Frågorna till AI-läget ----------------------------------------------------------------------------------------------------------------------------------------------------------

interface Asked {
  text: string;
  links: string[];
  sources: string;
}

/**
 * EN fråga till AI-läget och svaret som ren text. Första frågan bär bilden (`image_url`); varje fråga därefter fortsätter samtalet med token från förra svaret. Samma kontroller som skalets
 * `ask`: AI-lägets eget "Det verkar inte finnas något svar" och ett svar under 200 tecken är inget svar.
 */
async function ask(s: Session, text: string, o: { label: string; continues: boolean }): Promise<Asked> {
  if (s.aiCalls >= MAX_AI_CALLS_PER_SESSION) throw new SerpApiError(`Taket för frågor till AI-läget per samtal (${MAX_AI_CALLS_PER_SESSION}) är nått.`);
  if (o.continues && !s.token) throw new SerpApiError("AI-läget gav ingen token att fortsätta samtalet med (subsequent_request_token saknas i förra svaret).");
  if (!o.continues && !s.imageUrl) throw new SerpApiError("bilderna är inte iläggda (prepare saknas)");
  const params: SerpApiParams = {
    engine: "google_ai_mode",
    q: text,
    hl: "sv",
    gl: "se",
    location: AI_LOCATION(),
    continuable: true,
    // Ett färskt svar varje gång, som när skalet frågar Google: SerpApi cachar identiska sökningar i en timme, och ett cachat svar är inte en ny körning.
    no_cache: process.env.SERPAPI_NO_CACHE === "0" ? undefined : true,
    ...(o.continues ? { subsequent_request_token: s.token, ...(process.env.SERPAPI_FOLLOWUP_IMAGE === "1" ? { image_url: s.imageUrl } : {}) } : { image_url: s.imageUrl }),
  };
  chargeSearch();
  s.aiCalls += 1;
  const t0 = Date.now();
  let resp: SerpApiJson;
  try {
    resp = await serpApiSearch(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.turns.push({ label: o.label, question: text, answer: "", searchId: null, googleUrl: null, ms: Date.now() - t0, continued: o.continues, withImage: !o.continues, error: msg });
    saveCall(s, o.label, params, null, msg);
    throw err;
  }
  const ms = Date.now() - t0;
  const answer = answerText(resp);
  const meta = (resp.search_metadata ?? {}) as Record<string, unknown>;
  s.turns.push({
    label: o.label,
    question: text,
    answer,
    searchId: typeof meta.id === "string" ? meta.id : null,
    googleUrl: typeof meta.google_url === "string" ? meta.google_url : null,
    ms,
    continued: o.continues,
    withImage: !o.continues,
  });
  saveCall(s, o.label, params, resp);
  // Token för nästa fråga sparas bara när SerpApi gav en: ett svar utan token (ett misslyckat svar) ska inte bryta samtalet för det som redan finns.
  if (typeof resp.subsequent_request_token === "string" && resp.subsequent_request_token) s.token = resp.subsequent_request_token;
  log(`${o.label}: ${answer.length} tecken på ${Math.round(ms / 1000)} s${s.token ? "" : " (ingen token)"}`);
  if (NO_ANSWER.test(answer)) throw new Error("Googles AI-läge hade inget svar på frågan");
  if (answer.length < 200) throw new Error("inget svar från AI-läget inom tiden");
  const links = collectLinks(resp, answer);
  for (const l of links) if (!s.links.includes(l)) s.links.push(l);
  return { text: answer, links, sources: referenceSection(resp) };
}

/** Frågorna går i tur och ordning per samtal: en uppföljning bygger på förra svarets token. */
function enqueue<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const run = s.queue.catch(() => undefined).then(fn);
  s.queue = run.catch(() => undefined);
  return run;
}

const withSources = (a: Asked): string => (a.sources ? `${a.text}\n\n${a.sources}` : a.text);

// --- Etapp 1a: prepare ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Går bilden att hämta utifrån? Upp till fem försök med tre sekunders mellanrum: en tunnel som tappar kontakten en kort stund (cloudflared omregistrerar sig på 15–20 s, mätt 2026-11-09, då en
 * uppladdning föll mitt i glappet) ska inte fälla ett flöde som hade gått igenom en stund senare. Med en stabil adress lyckas första försöket och kontrollen kostar ett anrop.
 */
async function reachable(url: string): Promise<boolean> {
  for (let försök = 1; försök <= 5; försök++) {
    const ok = await http
      .fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000) })
      .then((r) => r.ok && /^image\//i.test(r.headers.get("content-type") ?? ""))
      .catch(() => false);
    if (ok) return true;
    if (försök < 5) await http.sleep(3_000);
  }
  return false;
}

/**
 * Lägger ut omslagsbilden och kontrollerar att SerpApi kan nå den. Kontrollen hämtar adressen som en utomstående gör (via serverns publika adress): den kostar ingen sökning och sparar en
 * betald fråga som annars hade gett ett svar utan bild — det vore en gissning som ser ut som en identifiering.
 */
export async function prepare(owner: string, images: string[]): Promise<{ sid: string; imageUrl: string }> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(images[0] ?? "");
  if (!m) throw new Error("bilderna saknas eller har fel format");
  const base = publicBase();
  if (!base) throw new SerpApiError("SerpApi måste kunna hämta bilden från en publik adress. Sätt SERPAPI_PUBLIC_URL i server/.env till serverns adress utifrån (till exempel en tunnel) och starta om servern.");
  chargeOwnerSession(owner);
  const s = createSession(owner);
  const name = storeImage(Buffer.from(m[2], "base64"), m[1]);
  s.imageName = name;
  s.imageUrl = `${base}/api/serpapi/img/${name}`;
  if (process.env.SERPAPI_SKIP_REACHABILITY !== "1" && !(await reachable(s.imageUrl))) {
    // Bilden ska inte ligga kvar på en adress ingen kan nå, och samtalet inte räknas som ett pågående.
    endSession(s.id);
    throw new SerpApiError(`Bilden går inte att nå utifrån på ${base}. SerpApi hämtar den därifrån; kontrollera SERPAPI_PUBLIC_URL (tunneln måste peka på den här servern).`);
  }
  log(`prepare: bilden ligger på ${base}/api/serpapi/img/… (${Math.round(Buffer.byteLength(m[2], "base64") / 1024)} kB), samtal ${s.id.slice(0, 8)}`);
  return { sid: s.id, imageUrl: s.imageUrl };
}

// --- Bildsökningarna ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ImageQuery {
  model: string;
  productType: string | null;
  undertyp?: string | null;
  retry?: boolean;
}

const imgKey = (brand: string, q: ImageQuery): string =>
  [brand, q.model, q.undertyp || q.productType || "", q.retry ? "retry" : ""].join("|").toLowerCase().replace(/[^\p{L}\p{N}|]+/gu, "");

/** EN modells bildsökning. Frågan är skalets: märke, modell, undertyp eller typ, och vid andra försöket "produktbild". Faller sökningen lämnas modellen utan rader, som skalet gör vid captcha. */
async function searchOne(s: Session, brand: string, q: ImageQuery): Promise<ImageRowsGroup> {
  // Kedjan (referensbild.ts): "produktbild framifrån" i frågan ger katalogliknande träffar (din observation 2026-11-09; mätt på 10 modeller var förstabilden ändå fel typ/märke/begagnat i 7, därför väljer reglerna
  // och det jämförande valet och inte förstabilden). Utan kedjan gäller skalets fråga: bara vid andra försöket "produktbild".
  const text = [brand, q.model, q.undertyp || q.productType || "", referensKedjaPa() ? "produktbild framifrån" : q.retry ? "produktbild" : ""].join(" ").replace(/\s+/g, " ").trim();
  const params: SerpApiParams = { engine: "google_images", q: text, hl: "sv", gl: "se", location: LOCATION() };
  const t0 = Date.now();
  try {
    if (s.imageCalls >= MAX_IMAGE_CALLS_PER_SESSION) throw new SerpApiError(`Taket för bildsökningar per samtal (${MAX_IMAGE_CALLS_PER_SESSION}) är nått.`);
    chargeSearch();
    s.imageCalls += 1;
    const resp = await serpApiSearch(params, { timeoutMs: 60_000 });
    const rows = imageRows(resp);
    saveCall(s, `bildsok-${q.model}${q.retry ? "-retry" : ""}`, params, { search_metadata: resp.search_metadata, rows: rows.length, images_results: (resp.images_results ?? []).slice(0, 40) });
    log(`bildsök "${text}": ${rows.length} miniatyrer på ${Date.now() - t0} ms`);
    return { model: q.model, rows };
  } catch (err) {
    log(`bildsök "${text}" föll:`, String(err instanceof Error ? err.message : err).slice(0, 100));
    saveCall(s, `bildsok-${q.model}-fel`, params, null, String(err instanceof Error ? err.message : err));
    return { model: q.model, rows: [] };
  }
}

function searchCached(s: Session, brand: string, q: ImageQuery): Promise<ImageRowsGroup> {
  const k = imgKey(brand, q);
  let p = s.imgCache.get(k);
  if (!p) {
    p = searchOne(s, brand, q);
    s.imgCache.set(k, p);
  }
  return p;
}

/** Bildsökningarna börjar nu, medan uppföljningsfrågan och serverns tolkning pågår (som skalets prefetchImages). */
function prefetchImages(s: Session, brand: string, furnitureType: string | null, answer: string): void {
  for (const name of proposalNames(answer, brand)) {
    const q: ImageQuery = { model: name, productType: furnitureType || null, undertyp: undertypUr(answer, name) };
    if (!s.imgCache.has(imgKey(brand, q))) log(`bildsök i förväg: "${[brand, name, q.undertyp || q.productType || ""].join(" ").trim()}"`);
    void searchCached(s, brand, q);
  }
}

export async function findImages(s: Session, brand: string, queries: ImageQuery[]): Promise<ImageRowsGroup[]> {
  return Promise.all(queries.map((q) => searchCached(s, brand, q)));
}

// --- Etapp 1b: identify -----------------------------------------------------------------------------------------------------------------------------------------------------------------

export async function identify(s: Session, brand: string, furnitureType: string | null): Promise<{ answer: string; links: string[] }> {
  return enqueue(s, async () => {
    log(`identify: märke ${brand}, typ ${furnitureType || "okänd"}`);
    if (!s.imageUrl) throw new Error("bilderna är inte iläggda (prepare saknas)");
    const first = await ask(s, PROMPT(brand, furnitureType), { label: "identifiering", continues: false });
    // `pure` är svaren utan källistor (det countProposals och proposalNames läser, som skalets svarstext); `full` är det som går till servern.
    let pure = first.text;
    let full = withSources(first);
    log(`identifiering klar: ${first.text.length} tecken, ${countProposals(pure, brand)} förslag: ${proposalNames(pure, brand).join(", ")}`);
    prefetchImages(s, brand, furnitureType, first.text);
    // Gav AI-läget färre än fyra förslag ber vi om resten i samma samtal (högst två gånger), som skalet. Ett svar utan nya modeller läggs inte till.
    for (let varv = 0; varv < 2 && countProposals(pure, brand) < 4; varv++) {
      try {
        const kanda = proposalNames(pure, brand);
        const more = await ask(s, MORE_PROMPT(brand, furnitureType, kanda), { label: "fler förslag", continues: true });
        const nya = proposalNames(more.text, brand).filter((n) => !kanda.some((k) => k.toLowerCase() === n.toLowerCase()));
        log(`fler förslag: ${nya.length} nya${nya.length ? ": " + nya.join(", ") : ""}`);
        if (!nya.length) break;
        pure = `${pure}${MORE_SEPARATOR}${more.text}`;
        full = `${full}${MORE_SEPARATOR}${withSources(more)}`;
        prefetchImages(s, brand, furnitureType, more.text);
      } catch (err) {
        log("uppföljningen om fler förslag gav inget svar:", String(err instanceof Error ? err.message : err).slice(0, 100));
        break;
      }
    }
    return { answer: full, links: s.links.slice(0, 60) };
  });
}

// --- Etapp 2: askSpecs ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Frågan efter valet, i samma samtal. Två försök om AI-läget inte svarar (skalet mätte att det händer ibland). */
export async function askSpecs(s: Session, brand: string, model: string, furnitureType: string | null): Promise<{ answer: string; links: string[] }> {
  return enqueue(s, async () => {
    if (!s.token) throw new Error("inget samtal att fortsätta på");
    let got: Asked | null = null;
    for (let försök = 1; försök <= 2 && !got; försök++) {
      try {
        got = await ask(s, SPEC_PROMPT(brand, model, furnitureType), { label: "mått", continues: true });
      } catch (err) {
        log(`måttfrågan gav inget svar (försök ${försök}):`, String(err instanceof Error ? err.message : err).slice(0, 120));
      }
    }
    if (!got) throw new Error("måttfrågan gav inget svar");
    log(`mått klara: ${got.text.length} tecken`);
    return { answer: withSources(got), links: s.links.slice(0, 60) };
  });
}

/** Samtalet hittills, för granskning i appen (frågorna som skickats och svaren). */
export function transcript(s: Session) {
  return {
    sid: s.id,
    imageUrl: s.imageUrl,
    aiCalls: s.aiCalls,
    imageCalls: s.imageCalls,
    turns: s.turns.map((t) => ({ label: t.label, question: t.question, answer: t.answer, searchId: t.searchId, googleUrl: t.googleUrl, ms: t.ms, continued: t.continued, withImage: t.withImage, error: t.error ?? null })),
  };
}

export { getImage, createSession };
