/**
 * SerpApi-klienten. Ett anrop i taget mot https://serpapi.com/search.json, för två motorer: `google_ai_mode` (identifiering och mått) och `google_images` (referensbilder).
 *
 * NYCKELN (SERPAPI_API_KEY i server/.env) läses vid varje anrop — server.ts laddar .env först i sin modulkropp, efter att den här modulen lästs in — och hamnar ALDRIG i ett felmeddelande, en logg
 * eller en sparad sökning: adressen med nyckeln byggs bara här och skrivs aldrig ut.
 *
 * Inget annat än transporten: vilka frågor som ställs och hur svaret läses ligger i aimode.ts och render.ts.
 */

export class SerpApiError extends Error {
  /** HTTP-status om SerpApi svarade, annars undefined (nätfel, tidsgräns). */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SerpApiError";
    this.status = status;
  }
}

/** Så nås nätet. Ett eget objekt så att testerna kan byta ut det utan att röra globalThis. */
export const http: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const ENDPOINT = "https://serpapi.com/search.json";
const ACCOUNT_ENDPOINT = "https://serpapi.com/account.json";
/** Bara för test mot en låtsas-SerpApi (SERPAPI_ENDPOINT=http://127.0.0.1:9996/search.json). Nyckeln skickas dit den pekar: sätt den aldrig till något du inte själv kör. */
const endpoint = (): string => process.env.SERPAPI_ENDPOINT?.trim() || ENDPOINT;

export const serpApiKey = (): string | null => process.env.SERPAPI_API_KEY?.trim() || null;

/** Saknas nyckeln ska ingen fråga gå iväg: felet säger var den ska stå. */
export function requireKey(): string {
  const key = serpApiKey();
  if (!key) throw new SerpApiError("SERPAPI_API_KEY saknas. Lägg raden SERPAPI_API_KEY=… i server/.env och starta om servern.");
  return key;
}

export type SerpApiParams = Record<string, string | number | boolean | null | undefined>;
export type SerpApiJson = Record<string, any>;

/** Parametrarna utan nyckeln, för loggar och sparade sökningar. */
export const withoutKey = (p: SerpApiParams): SerpApiParams => {
  const { api_key: _k, ...rest } = p;
  void _k;
  return rest;
};

/** SerpApis svar på fel är JSON med fältet `error` ("Google hasn't returned any results for this query."). Texten används som den är, men utan adressen (som bär nyckeln). */
const felText = (body: unknown, fallback: string): string => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" && e.trim() ? e.trim().slice(0, 300) : fallback;
};

/**
 * Ett sökanrop. Ett omförsök efter två sekunder för nätfel, 429 och 5xx (ett tillfälligt fel hos SerpApi är inget svar från AI-läget); aldrig för 4xx, som är vårt eget fel (nyckel, parametrar,
 * slut på sökningar) och som ett omförsök bara skulle upprepa. Svarar med SerpApis JSON.
 */
export async function serpApiSearch(params: SerpApiParams, opts: { timeoutMs?: number } = {}): Promise<SerpApiJson> {
  const key = requireKey();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  qs.set("api_key", key);
  const url = `${endpoint()}?${qs.toString()}`;
  let last: SerpApiError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await http.fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000), headers: { Accept: "application/json" } });
      const text = await res.text();
      let body: SerpApiJson | null = null;
      try {
        body = text ? (JSON.parse(text) as SerpApiJson) : null;
      } catch {
        /* inte JSON: hanteras nedan */
      }
      if (!res.ok) {
        const err = new SerpApiError(`SerpApi svarade ${res.status}: ${felText(body, "inget felmeddelande")}`, res.status);
        if (res.status === 429 || res.status >= 500) {
          last = err;
          if (attempt === 1) {
            await http.sleep(2000);
            continue;
          }
        }
        throw err;
      }
      if (!body) throw new SerpApiError("SerpApi svarade med något som inte är JSON.", res.status);
      // 200 med `error` och status "Error": SerpApi fick ingen träff eller Google avvisade frågan.
      if (typeof body.error === "string" && body.error.trim()) throw new SerpApiError(`SerpApi: ${felText(body, "fel")}`, res.status);
      if (body.search_metadata?.status === "Error") throw new SerpApiError("SerpApi: sökningen markerades som fel.", res.status);
      return body;
    } catch (err) {
      if (err instanceof SerpApiError) throw err;
      // Nätfel eller tidsgräns. Meddelandet från fetch nämner ibland adressen: det byts mot en egen text.
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      last = new SerpApiError(timeout ? "SerpApi svarade inte inom tidsgränsen." : "Det gick inte att nå SerpApi.");
      if (attempt === 1 && !timeout) {
        await http.sleep(2000);
        continue;
      }
      throw last;
    }
  }
  throw last ?? new SerpApiError("SerpApi gav inget svar.");
}

/**
 * Kontot: sökningar kvar och använda den här månaden. Kostar ingen sökning. Används för att MÄTA vad en körning kostar (före och efter), aldrig för att styra något.
 */
export async function serpApiAccount(): Promise<{ planSearchesLeft: number | null; thisMonthUsage: number | null; searchesPerMonth: number | null; plan: string | null }> {
  const key = requireKey();
  const res = await http.fetch(`${ACCOUNT_ENDPOINT}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
  const b = (await res.json().catch(() => null)) as SerpApiJson | null;
  if (!res.ok || !b) throw new SerpApiError(`SerpApi-kontot gick inte att läsa (${res.status}).`, res.status);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { planSearchesLeft: num(b.plan_searches_left), thisMonthUsage: num(b.this_month_usage), searchesPerMonth: num(b.searches_per_month), plan: typeof b.plan_name === "string" ? b.plan_name : null };
}
