/**
 * Adressförslagen i registreringen: gatuadressen man skriver blir postnummer och ort.
 *
 * GENOM VÅR SERVER OCH INTE DIREKT FRÅN WEBBLÄSAREN. Google Places går att anropa från sidan med en
 * nyckel begränsad till vår domän, men en sådan nyckel står i klartext i bundeln och en Referer är
 * ett huvud vem som helst kan skriva. Varje förslag kostar pengar på ett konto med betalkort. Här
 * ligger nyckeln kvar på servern, och taket nedan är vårt och inte en inställning i Googles konsol
 * som ingen minns att den finns. Det ger dessutom läsaren en sak till: det är serverns IP-adress
 * Google ser, inte säljarens.
 *
 * SESSIONEN. Google tar betalt per session och inte per tangenttryck när förslagen och detaljanropet
 * bär samma sessionToken. Webbläsaren skapar token när man börjar skriva och byter den efter varje
 * val; servern skickar den bara vidare.
 *
 * STOCKHOLM ÄR EN BIAS, INTE ETT FILTER. Hemleveransen finns bara i länet (se butik/delivery.ts), men
 * kontot delas med Vips och en adress i Göteborg är inte fel att ha. Förslagen lutar mot Stockholm så
 * att "Storgatan 12" inte börjar i Skellefteå.
 *
 * Utan GOOGLE_MAPS_API_KEY svarar förslagen med en tom lista, och formuläret är precis det det var
 * innan: tre fält man fyller i själv.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Läses vid anrop: server.ts laddar server/.env i sin modulkropp, efter att den här modulen lästs in. */
const nyckel = () => process.env.GOOGLE_MAPS_API_KEY?.trim() || null;

const TIMEOUT_MS = 5_000;
const STOCKHOLM = { latitude: 59.3293, longitude: 18.0686 };
/** Places tillåter högst 50 km i en cirkel. Täcker länet med marginal. */
const BIAS_RADIE_M = 50_000;

const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const PLATS_ID = /^[A-Za-z0-9_-]{10,400}$/;

/**
 * Taket.
 *
 * Per IP för att en människa som skriver en adress gör några tiotal anrop, inte hundratals — och
 * webbläsaren väntar redan en kvarts sekund mellan tangenttrycken. Globalt för att taket per IP inte
 * hjälper mot någon som byter adress (samma resonemang som chattens, server.ts): det är det globala
 * taket som faktiskt sätter ett tak på fakturan.
 */
const FONSTER_MS = 60_000;
const PER_IP = 40;
const GLOBALT = 600;
const perIp = new Map<string, number[]>();
let globala: number[] = [];

function strypt(req: IncomingMessage): boolean {
  const now = Date.now();
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.socket.remoteAddress || "okänd";
  const egna = (perIp.get(ip) ?? []).filter((t) => now - t < FONSTER_MS);
  globala = globala.filter((t) => now - t < FONSTER_MS);
  if (egna.length >= PER_IP || globala.length >= GLOBALT) return true;
  egna.push(now);
  globala.push(now);
  perIp.set(ip, egna);
  if (perIp.size > 1000) for (const [k, v] of perIp) if (v.every((t) => now - t >= FONSTER_MS)) perIp.delete(k);
  return false;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface AdressForslag {
  id: string;
  /** "Storgatan 12" — det som hamnar i fältet. */
  huvud: string;
  /** "Stockholm, Sverige" — det som skiljer två Storgatan 12 åt. */
  rest: string | null;
}

export interface AdressTraff {
  gatuadress: string | null;
  /** Fem siffror utan mellanslag, eller null när Google inte har något. */
  postnummer: string | null;
  ort: string | null;
}

interface Komponent {
  longText?: string;
  types?: string[];
}

async function forslag(input: string, sessionToken: string, key: string): Promise<AdressForslag[]> {
  const svar = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
    },
    body: JSON.stringify({
      input,
      sessionToken,
      languageCode: "sv",
      regionCode: "se",
      includedRegionCodes: ["se"],
      // Bara sådant som har ett husnummer. En gata utan nummer har inget postnummer att ge — en lång
      // gata har flera — och ett förslag som inte fyller i något är sämre än inget förslag.
      includedPrimaryTypes: ["street_address", "premise", "subpremise"],
      locationBias: { circle: { center: STOCKHOLM, radius: BIAS_RADIE_M } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!svar.ok) throw new Error(`Places autocomplete ${svar.status}: ${(await svar.text()).slice(0, 300)}`);
  const data = (await svar.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      };
    }>;
  };
  return (data.suggestions ?? []).flatMap((s) => {
    const p = s.placePrediction;
    const huvud = p?.structuredFormat?.mainText?.text;
    if (!p?.placeId || !huvud) return [];
    return [{ id: p.placeId, huvud, rest: p.structuredFormat?.secondaryText?.text ?? null }];
  });
}

async function detalj(id: string, sessionToken: string, key: string): Promise<AdressTraff> {
  const params = new URLSearchParams({ languageCode: "sv", regionCode: "se", sessionToken });
  const svar = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?${params}`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "addressComponents" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!svar.ok) throw new Error(`Places details ${svar.status}: ${(await svar.text()).slice(0, 300)}`);
  const { addressComponents = [] } = (await svar.json()) as { addressComponents?: Komponent[] };
  return tolka(addressComponents);
}

/** Gata, postnummer och ort ur Googles adressdelar. Places och Geocoding delar typerna. */
function tolka(komponenter: Komponent[]): AdressTraff {
  const del = (typ: string) => komponenter.find((k) => k.types?.includes(typ))?.longText?.trim() || null;

  const gata = del("route");
  const nummer = del("street_number");
  const siffror = del("postal_code")?.replace(/\D/g, "") ?? "";
  return {
    gatuadress: gata ? (nummer ? `${gata} ${nummer}` : gata) : null,
    postnummer: siffror.length === 5 ? siffror : null,
    // Postorten och inte kommunen: "Bromma" står på brevet, "Stockholm" är kommunen. Places lägger
    // postorten i postal_town i Sverige; locality är reserven där den saknas.
    ort: del("postal_town") ?? del("locality"),
  };
}

/**
 * Adressen där säljaren står, för knappen "Använd min nuvarande adress".
 *
 * Geocoding API och inte Places: Places gör inte om koordinater till en adress. Samma nyckel, men
 * API:t måste vara påslaget på den (se .env.example).
 *
 * DET FÖRSTA SVARET ÄR INTE ALLTID EN ADRESS. Google lägger gärna ett byggnads- eller konstverksnamn
 * först — mitt på Sergels torg är det "Kristallvertikalaccent", utan husnummer. Det ska inte hamna i
 * fältet. Vi tar det första svaret som har både gata och nummer, och i andra hand det första som
 * åtminstone har ett postnummer.
 */
async function franPosition(lat: number, lng: number, key: string): Promise<AdressTraff | null> {
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    language: "sv",
    result_type: "street_address|premise|subpremise",
    key,
  });
  const svar = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!svar.ok) throw new Error(`Geocoding ${svar.status}`);
  const data = (await svar.json()) as {
    status?: string;
    error_message?: string;
    results?: Array<{ address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }> }>;
  };
  if (data.status === "ZERO_RESULTS") return null;
  if (data.status !== "OK") throw new Error(`Geocoding ${data.status}: ${data.error_message ?? ""}`);
  // Landet enligt Google, inte enligt rutan nedan: rutan är ett grovt filter som sparar anrop, och Oslo
  // ligger innanför den.
  const iSverige = (data.results ?? []).filter((r) =>
    r.address_components?.some((k) => k.types?.includes("country") && k.short_name === "SE"),
  );
  const traffar = iSverige.map((r) =>
    tolka((r.address_components ?? []).map((k) => ({ longText: k.long_name, types: k.types }))),
  );
  return traffar.find((t) => t.gatuadress && /\d/.test(t.gatuadress)) ?? traffar.find((t) => t.postnummer) ?? null;
}

/** Sverige med marginal — ett grovt förfilter så att en position i Berlin aldrig blir ett anrop. Landet avgörs av Googles svar. */
const inomSverige = (lat: number, lng: number) => lat >= 55 && lat <= 69.2 && lng >= 10.5 && lng <= 24.3;

/** Segmenten EFTER /api/adress. Publik: registreringen sker innan det finns en inloggning. */
export async function handleAdress(segments: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET" || segments.length !== 1) return false;
  if (segments[0] !== "forslag" && segments[0] !== "detalj" && segments[0] !== "har") return false;

  const url = new URL(req.url ?? "/", "http://lokal");
  const session = url.searchParams.get("session") ?? "";
  const key = nyckel();

  if (segments[0] === "har") {
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (!key) {
      json(res, 404, { error: "Adressökningen är inte påkopplad." });
      return true;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inomSverige(lat, lng)) {
      json(res, 200, { traff: null });
      return true;
    }
    if (strypt(req)) {
      json(res, 429, { error: "För många adressökningar just nu." });
      return true;
    }
    try {
      json(res, 200, { traff: await franPosition(lat, lng, key) });
    } catch (err) {
      console.error("[adress] position:", err instanceof Error ? err.message : err);
      json(res, 502, { error: "Adressen kunde inte hämtas." });
    }
    return true;
  }

  if (segments[0] === "forslag") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const ort = (url.searchParams.get("ort") ?? "").trim().slice(0, 60);
    // Tomt svar och inte ett fel: utan nyckel, eller för kort för att vara en adress, finns det
    // helt enkelt inga förslag, och formuläret fungerar som vanligt.
    if (!key || q.length < 4 || q.length > 120 || !SESSION.test(session)) {
      json(res, 200, { forslag: [] });
      return true;
    }
    if (strypt(req)) {
      json(res, 429, { error: "För många adressökningar just nu." });
      return true;
    }
    try {
      json(res, 200, { forslag: await forslag(ort ? `${q}, ${ort}` : q, session, key) });
    } catch (err) {
      console.error("[adress] förslag:", err instanceof Error ? err.message : err);
      json(res, 502, { error: "Adressförslagen svarar inte." });
    }
    return true;
  }

  const id = url.searchParams.get("id") ?? "";
  if (!key) {
    json(res, 404, { error: "Adressökningen är inte påkopplad." });
    return true;
  }
  if (!PLATS_ID.test(id) || !SESSION.test(session)) {
    json(res, 400, { error: "Ogiltig adress." });
    return true;
  }
  if (strypt(req)) {
    json(res, 429, { error: "För många adressökningar just nu." });
    return true;
  }
  try {
    json(res, 200, await detalj(id, session, key));
  } catch (err) {
    console.error("[adress] detalj:", err instanceof Error ? err.message : err);
    json(res, 502, { error: "Adressen kunde inte slås upp." });
  }
  return true;
}
