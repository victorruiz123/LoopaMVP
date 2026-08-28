/**
 * Tradera REST API v4 — klienten.
 *
 * Publicerar en färdig Loopa-annons på Loopas eget Tradera-konto. Fyra miljövariabler krävs
 * (se .env.example); saknas någon är hela integrationen frånkopplad i stället för att fela —
 * `traderaConfigured()` är det knappen i truth-cardet frågar innan den visar sig.
 *
 * Ingen npm-beroende. Node 18+ (inbyggd fetch).
 */

const BASE = "https://api.tradera.com/v4";

const APP_VARS = ["TRADERA_APP_ID", "TRADERA_APP_KEY"] as const;
const USER_VARS = ["TRADERA_USER_ID", "TRADERA_USER_TOKEN"] as const;

export class TraderaError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`Tradera svarade ${status} på ${path}: ${body.slice(0, 300)}`);
    this.name = "TraderaError";
  }
}

/** Vilka av de fyra variablerna som saknas. Tom lista = integrationen är på. */
export function missingTraderaEnv(): string[] {
  return [...APP_VARS, ...USER_VARS].filter((name) => !process.env[name]?.trim());
}

export function traderaConfigured(): boolean {
  return missingTraderaEnv().length === 0;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Saknar env-variabel ${name}`);
  return value;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-App-Id": env("TRADERA_APP_ID"),
    "X-App-Key": env("TRADERA_APP_KEY"),
    "X-User-Id": env("TRADERA_USER_ID"),
    "X-User-Token": env("TRADERA_USER_TOKEN"),
  };
}

async function call<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new TraderaError(res.status, path, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- Typer ----------

export interface TraderaImage {
  data: Buffer;
  mime: "image/jpeg" | "image/png";
}

/** Det Loopa skickar in. Byggs i publish.ts ur ett färdigt truth-card. */
export interface TraderaListingInput {
  /** Loopas jobb-id. Sparas som ownReference hos Tradera och är det vi hittar tillbaka på. */
  ownReference: string;
  /** Max 80 tecken, klipps här. */
  title: string;
  /** HTML — Traderas annonstexter renderas som HTML (verifierat mot en publicerad annons). */
  description: string;
  categoryId: number;
  /** SEK, heltal. Utropspris för en auktion, Köp Nu-pris för fast pris. */
  price: number;
  images: TraderaImage[];
  /** Traderas "Skick"-term, t.ex. "Gott skick". Utelämnas om vi inte har ett betyg. */
  condition?: string | null;
  conditionAttributeId?: number | null;
  shippingOptionId: number;
  shippingCost?: number;
  paymentOptionIds?: number[];
  /** Dagar. Ett nytt/privat konto kräver minst 7. */
  durationDays?: number;
  /** "auction" = ren auktion (enda som säkert går på ett nytt konto), "fixed" = Endast Köp Nu. */
  mode?: "auction" | "fixed";
}

export interface PublishResult {
  requestId: number;
  itemId: number;
  url: string;
}

interface QueuedRequestResponse {
  requestId: number;
  itemId: number;
}

/**
 * Så här ser svaret från /listings/request-results FAKTISKT ut enligt v4-specen: requestId,
 * resultCode och message — inget itemId och inget isSuccessful. `resultCode` är en flaggenum
 * (1,2,4,…,256) utan publicerad betydelse, så vi tolkar den inte. Den enda tolkning vi litar på är
 * att annonsen dyker upp bland säljarens artiklar; `message` sparas bara för att kunna säga VARFÖR
 * när den inte gör det.
 */
interface RequestResult {
  requestId: number;
  resultCode?: number;
  message?: string | null;
}

/** Bara de fält vi läser ur en artikel. Item-schemat har ~40 till. */
interface SellerItem {
  id: number;
  ownReferences?: string[] | null;
  itemLink?: string | null;
}

// ---------- Publicering ----------

/**
 * Skapar, bildsätter och publicerar en annons, och väntar tills Tradera behandlat kön.
 *
 * Tre anrop plus ett per bild, sedan pollning: publiceringen är asynkron på Traderas sida och tar
 * 10–60 s. Anropa aldrig det här i ett HTTP-svar.
 */
export async function publishToTradera(listing: TraderaListingInput): Promise<PublishResult> {
  const mode = listing.mode ?? "auction";

  const body: Record<string, unknown> = {
    title: listing.title.slice(0, 80),
    description: listing.description,
    descriptionLanguageCodeIso2: "sv",
    categoryId: listing.categoryId,
    ownReferences: [listing.ownReference],
    acceptedBidderId: 1, // 1 = Sverige
    itemAttributes: [2], // 2 = Begagnad (reference-data/item-field-values)
    shippingOptions: [{ shippingOptionId: listing.shippingOptionId, cost: listing.shippingCost ?? 0 }],
    paymentOptionIds: listing.paymentOptionIds ?? [],
    restarts: 0,
    // Bilderna laddas upp på requestId:t INNAN annonsen får gå live, annars publiceras den bildlös.
    autoCommit: false,
  };

  if (mode === "fixed") {
    body.itemType = 3; // Endast Köp Nu, 30 dagar
    body.buyItNowPrice = Math.round(listing.price);
  } else {
    body.itemType = 1; // Auktion
    body.duration = listing.durationDays ?? 7;
    body.startPrice = Math.round(listing.price);
    // buyItNowPrice utelämnas med flit: ett nytt/privat konto är restricted och avvisas med
    // "only auctions allowed" så fort ett Köp Nu-pris finns med.
  }

  if (listing.condition && listing.conditionAttributeId) {
    body.attributeValues = {
      terms: [{ id: listing.conditionAttributeId, values: [listing.condition] }],
    };
  }

  const queued = await call<QueuedRequestResponse>("POST", "/listings/items", body);

  for (const image of listing.images) {
    await call("POST", `/listings/items/${queued.requestId}/images`, {
      imageData: image.data.toString("base64"),
      imageFormat: image.mime === "image/png" ? 2 : 1,
      hasMega: true,
    });
  }

  await call("POST", `/listings/items/${queued.requestId}/commit`);

  const item = await waitForItem(listing.ownReference, queued.requestId);
  return {
    requestId: queued.requestId,
    itemId: item.id,
    url: item.itemLink || `https://www.tradera.com/item/${item.id}`,
  };
}

/**
 * Väntar tills annonsen syns bland säljarens artiklar.
 *
 * Sanningskällan är säljarens artikellista, inte kösvaret: matchar ownReferences vet vi att annonsen
 * finns, och vi får både id och den riktiga länken. Kösvarets `message` läses bara för att kunna
 * lämna en orsak i felet när den aldrig dyker upp.
 */
async function waitForItem(ownReference: string, requestId: number, maxWaitMs = 120_000): Promise<SellerItem> {
  const startedAt = Date.now();
  let delay = 2000;
  let lastMessage: string | null = null;

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 10_000);

    try {
      const results = await call<RequestResult[]>("GET", `/listings/request-results?requestIds=${requestId}`);
      const message = results?.find((r) => r.requestId === requestId)?.message?.trim();
      if (message) lastMessage = message;
    } catch {
      // Kön svarar ibland 404 innan den hunnit registrera requestet. Artikellistan avgör ändå.
    }

    const item = await findItemByOwnReference(ownReference);
    if (item) return item;
  }

  throw new Error(
    lastMessage
      ? `Tradera publicerade inte annonsen: ${lastMessage}`
      : `Tradera hann inte publicera annonsen inom ${Math.round(maxWaitMs / 1000)} s. Kolla Developer Center → Application log.`,
  );
}

async function findItemByOwnReference(ownReference: string): Promise<SellerItem | null> {
  const items = await call<SellerItem[]>("GET", "/listings/seller-items");
  return items?.find((i) => (i.ownReferences ?? []).includes(ownReference)) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Underhåll ----------

/** Ta bort annonsen — t.ex. när möbeln sålts någon annanstans. */
export async function endTraderaItem(itemId: number): Promise<void> {
  await call("DELETE", `/listings/items/${itemId}`);
}

/** Ändra pris utan att byta annonstyp. */
export async function updateTraderaPrice(itemId: number, price: number, mode: "auction" | "fixed"): Promise<void> {
  const body = mode === "fixed" ? { binPrice: Math.round(price) } : { openingPrice: Math.round(price) };
  await call("PUT", `/listings/items/${itemId}/price`, body);
}

/** Lägg upp en utgången, osåld auktion igen. */
export async function restartTraderaItem(itemId: number): Promise<number> {
  const result = await call<{ isSuccessful: boolean; itemId?: number; validationError?: string }>(
    "POST",
    `/listings/items/${itemId}/restart`,
  );
  if (!result.isSuccessful) throw new Error(`Kunde inte starta om annonsen: ${result.validationError ?? "okänt fel"}`);
  return result.itemId!;
}

/** Hämta annonsen som Tradera ser den — för synk och felsökning. */
export async function getTraderaItem(itemId: number): Promise<unknown> {
  return call("GET", `/listings/items/${itemId}`);
}
