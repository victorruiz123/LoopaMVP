/**
 * Butikens HTTP-vägar.
 *
 * Egen fil och inte fler grenar i server.ts: routern där är redan 180 rader lång och butiken kommer
 * att växa med kassa, leveranser och bevakningar. `handleButikRequest` får segmenten EFTER /api/butik
 * och svarar med true när den tagit hand om anropet.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { deliveryQuote } from "./delivery.js";
import { abandonCheckout, checkoutConfigured, CheckoutError, chooseSlot, fulfilPaidOrder, parseWebhook, startCheckout } from "./checkout.js";
import { getOrder, orderByReference, ordersForUser, updateOrder } from "./orders.js";
import { createBevakning, deleteBevakning, listBevakningar } from "./bevakningar.js";
import { aiSearchAvailable, interpretQuery, rateLimited } from "./aiSearch.js";
import { allProducts, applyFilter, brandFacets, brandFacetsMerged, categoryFacetsOf, productById, typeFacetsMerged } from "./inventory.js";
import { browse, mergedItems } from "./browse.js";
import { CATEGORIES, categoryBySlug, furnitureTypeBySlug, MOBELTYPER } from "./catalog.js";
import { store } from "./store.js";
import { avtryck, spara } from "../analys/store.js";
import type { ConditionGrade } from "../types.js";
import type { ProductFilter, SortKey } from "./types.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const SORTS: SortKey[] = ["relevans", "nyinkommet", "pris_upp", "pris_ner"];
const GRADES: ConditionGrade[] = ["A", "B", "C", "D", "E", "F"];

function num(v: string | null): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Kommaseparerad lista ur frågesträngen: ?marke=IKEA,Swedese */
function list(v: string | null): string[] | null {
  if (!v) return null;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * Filtret ur adressen.
 *
 * Parametrarna är svenska därför att adressen är en del av gränssnittet: den delas, bokmärks och
 * hamnar i sökresultat. `?kategori=stolar&marke=IKEA&maxbredd=80` går att läsa; `?c=3&b=17` gör det
 * inte.
 */
export function filterFromQuery(url: URL): ProductFilter {
  const q = url.searchParams;
  const sort = q.get("sortering") as SortKey | null;
  const grades = list(q.get("skick"))?.filter((g): g is ConditionGrade => GRADES.includes(g as ConditionGrade));
  return {
    q: q.get("q"),
    categorySlug: q.get("kategori"),
    typeSlug: q.get("typ"),
    brands: list(q.get("marke")),
    /**
     * BARA LOOPA-VAROR, om ingen uttryckligen ber om något annat.
     *
     * Förvalet var tvärtom och det gick inte ihop med vad butiken lovar. Köpdelen bär en
     * förtroenderad på varje kort — verifierat skick, hemleverans, pengarna hålls till leverans,
     * pengarna tillbaka om det inte stämmer — och INGET av det gäller en Tradera-annons. De är
     * någon annans möbel, oskickbedömd av oss, med budgivning i stället för pris, egen frakt och
     * ingen retur till oss. Ligger de i samma rutnät är förtroenderaden osann på ungefär halva
     * lagret, och då är den värdelös på hela.
     *
     * `?kalla=alla` släpper in dem igen. Kopplingen mot Tradera är kvar i koden — den behövs för
     * publicering åt våra egna säljare — men den syns inte i butiken.
     */
    onlyLoopa: q.get("kalla") !== "alla",
    minPriceSek: num(q.get("minpris")),
    maxPriceSek: num(q.get("maxpris")),
    grades: grades?.length ? grades : null,
    // Måtten kommer i centimeter från gränssnittet och lagras i millimeter.
    maxWidthMm: num(q.get("maxbredd")) === null ? null : num(q.get("maxbredd"))! * 10,
    maxDepthMm: num(q.get("maxdjup")) === null ? null : num(q.get("maxdjup"))! * 10,
    maxHeightMm: num(q.get("maxhojd")) === null ? null : num(q.get("maxhojd"))! * 10,
    colors: list(q.get("farg")),
    materials: list(q.get("material")),
    homeDeliveryOnly: q.get("leverans") === "hem",
    sort: sort && SORTS.includes(sort) ? sort : "relevans",
    limit: num(q.get("antal")) ?? 24,
    offset: num(q.get("fran")) ?? 0,
  };
}

/** Sökrobotar räknas inte — en annons Googlebot hämtat är inte en annons någon sett. */
const ROBOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|headless/i;

/**
 * En sidvisning av produktsidan.
 *
 * Avtrycket är en hash av adress och webbläsarsträng med ett salt som byts vid varje omstart. Det
 * finns bara för att kunna säga UNIKA visningar och lagras aldrig — se analys/store.ts.
 */
function raknaVisning(id: string, req: IncomingMessage): void {
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
  if (ROBOT.test(ua)) return;
  const vidare = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(vidare) ? vidare[0] : vidare)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  void spara("annons_visning", id, {}, avtryck(ip, ua || null));
}

export async function handleButikRequest(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== "GET") return false;

  // GET /api/butik/produkter — rutnätet.
  if (segments[0] === "produkter" && segments.length === 1) {
    json(res, 200, await browse(filterFromQuery(url)));
    return true;
  }

  // GET /api/butik/produkter/:id — produktsidan.
  if (segments[0] === "produkter" && segments.length === 2) {
    const product = await productById(segments[1]);
    if (!product) {
      json(res, 404, { error: "Varan finns inte." });
      return true;
    }
    /**
     * Visningen räknas HÄR, där produktsidan ändå hämtar sin data.
     *
     * Serverräknad och inte klientmätt: anropet sker en gång per öppnad produktsida, det kan inte
     * påstås av en besökare, och det kräver varken kaka eller samtycke — se analys/store.ts.
     * Väntas aldrig in; en mätning får inte ligga i vägen för svaret.
     */
    raknaVisning(product.id, req);
    // Huvudboken följer med: produktsidan ska kunna säga att möbeln är såld och när.
    const events = await store().events(product.id);
    json(res, 200, { product, events });
    return true;
  }

  // GET /api/butik/kategorier — brickorna på landningssidan, med antal.
  if (segments[0] === "kategorier" && segments.length === 1) {
    // Räknar båda källorna: brickan ska säga samma sak som rutnätet bakom den.
    const { items } = await mergedItems();
    const counts = categoryFacetsOf(items);
    json(res, 200, {
      categories: CATEGORIES.map((c) => ({ ...c, count: counts[c.slug] ?? 0 })),
    });
    return true;
  }

  // GET /api/butik/leverans?postnummer=11223 — zon, pris och tider. Publik: den ska gå att fråga
  // innan man loggar in, annars är leveransbeskedet gömt bakom en inloggning man inte gjort än.
  /**
   * GET /api/butik/avgifter — vad ett köp via Loopa kostar utöver möbeln.
   *
   * FINNS FÖR ATT SIFFRORNA INTE SKA HÅRDKODAS I KLIENTEN. Serviceavgiften bor i affar/fees.ts och
   * fraktzonerna i delivery.ts; en siffra skriven en gång till i en React-komponent är en siffra som
   * en dag säger något annat än kassan gör — och just den sidan lovar "inga överraskningar".
   */
  if (segments[0] === "avgifter" && segments.length === 1) {
    const { SERVICE_FEE_SEK } = await import("../affar/fees.js");
    const { ZONE_FEES } = await import("./delivery.js");
    return json(res, 200, {
      serviceavgiftSek: SERVICE_FEE_SEK,
      fraktFranSek: Math.min(...ZONE_FEES),
      fraktTillSek: Math.max(...ZONE_FEES),
    }), true;
  }

  if (segments[0] === "leverans" && segments.length === 1) {
    json(res, 200, { ...deliveryQuote(url.searchParams.get("postnummer") ?? ""), checkoutConfigured: checkoutConfigured() });
    return true;
  }

  /**
   * GET /api/butik/marken — märkena som FAKTISKT finns i lagret, båda källorna räknade.
   *
   * Listan driver märkesbrickorna på förstasidan, och där är antalet inte en dekoration: en bricka
   * som leder till en tom sida är ett löfte som bryts i samma klick. Därför räknas det sammanslagna
   * lagret, och därför står det bara märken med minst en vara.
   */
  if (segments[0] === "marken" && segments.length === 1) {
    const { items } = await mergedItems();
    // Räkningen bor i inventory.ts: talen är ett löfte om vad märkessidan innehåller, och ett löfte
    // som bara finns i en HTTP-hanterare går inte att pröva. Se brandFacetsMerged.
    const brands = brandFacetsMerged(items);
    json(res, 200, { brands });
    return true;
  }

  /**
   * GET /api/butik/mobeltyper — typbrickorna på startsidan, med antal per källa.
   *
   * Bara typer med minst en vara, och HELA katalogposten följer med: rubriken och ingressen typsidan
   * visar kommer härifrån, så att det React ritar är samma text som seo.ts redan skrev in i skalet.
   * Två texter om samma sida är två sanningar, och sökmotorn läser båda.
   */
  if (segments[0] === "mobeltyper" && segments.length === 1) {
    const { items } = await mergedItems();
    const facets = typeFacetsMerged(items);
    const types = facets.map((f) => ({ ...furnitureTypeBySlug(f.slug)!, ...f }));
    json(res, 200, { types });
    return true;
  }

  // GET /api/butik/mobeltyper/:slug — typsidan: katalogposten, kategorin den hör till och rutnätet.
  if (segments[0] === "mobeltyper" && segments.length === 2) {
    const type = furnitureTypeBySlug(segments[1]);
    if (!type) {
      json(res, 404, { error: "Möbeltypen finns inte." });
      return true;
    }
    const filter = { ...filterFromQuery(url), typeSlug: type.slug };
    const category = categoryBySlug(type.categorySlug) ?? null;
    const siblings = MOBELTYPER.filter((t) => t.categorySlug === type.categorySlug && t.slug !== type.slug);
    json(res, 200, { type, category, siblings, ...(await browse(filter)) });
    return true;
  }

  // GET /api/butik/kategorier/:slug — kategorisidan.
  if (segments[0] === "kategorier" && segments.length === 2) {
    const category = categoryBySlug(segments[1]);
    if (!category) {
      json(res, 404, { error: "Kategorin finns inte." });
      return true;
    }
    const filter = { ...filterFromQuery(url), categorySlug: category.slug };
    json(res, 200, { category, ...(await browse(filter)) });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Kassan och ordern
// ---------------------------------------------------------------------------

const MAX_BODY = 1024 * 64;

/** Kroppen som RÅA bytes. Webhooken behöver dem oförändrade — signaturen räknas på dem. */
function rawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("För stor kropp"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await rawBody(req);
  return raw.length ? (JSON.parse(raw.toString("utf-8")) as T) : ({} as T);
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Skrivande butiksvägar.
 *
 * Skilda från de läsande ovan därför att de har olika grind: rutnätet är publikt, kassan är det inte
 * — utom webhooken, som Stripe anropar utan att kunna logga in och som i stället bevisar sig med en
 * signatur.
 */
export async function handleButikWrite(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  identity: { userId: string | null; email: string | null } | null,
): Promise<boolean> {
  // POST /api/butik/webhook — Stripe. INGEN inloggning, men en verifierad signatur.
  if (segments[0] === "webhook" && req.method === "POST") {
    try {
      const signature = header(req, "stripe-signature");
      if (!signature) return json(res, 400, { error: "Saknar stripe-signature." }), true;
      const event = parseWebhook(await rawBody(req), signature);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as { client_reference_id?: string | null; metadata?: Record<string, string> };
        const orderId = session.client_reference_id ?? session.metadata?.orderId;
        if (orderId) await fulfilPaidOrder(orderId);
      } else if (event.type === "checkout.session.expired") {
        const session = event.data.object as { client_reference_id?: string | null };
        // Betalfönstret gick ut. Möbeln tillbaka i butiken direkt, utan att vänta på städningen.
        if (session.client_reference_id) await abandonCheckout(session.client_reference_id);
      }
      // 200 på allt annat också: en okänd händelsetyp är inget fel, och ett fel får Stripe att
      // skicka om i timmar.
      json(res, 200, { received: true });
    } catch (err) {
      const status = err instanceof CheckoutError ? err.status : 400;
      console.warn("[butik] webhook avvisad:", err instanceof Error ? err.message : err);
      json(res, status, { error: err instanceof Error ? err.message : "Ogiltig webhook." });
    }
    return true;
  }

  // POST /api/butik/kassa — starta ett köp. Kräver inloggning: ordern ska ha en ägare.
  if (segments[0] === "kassa" && req.method === "POST") {
    if (!identity) return json(res, 401, { error: "Logga in för att köpa." }), true;
    try {
      const body = await jsonBody<{ produkt?: string; postnummer?: string }>(req);
      if (!body.produkt) return json(res, 400, { error: "produkt krävs." }), true;
      const result = await startCheckout({
        productId: body.produkt,
        postalCode: body.postnummer ?? "",
        userId: identity.userId,
        email: identity.email,
      });
      json(res, 200, { orderId: result.order.id, reference: result.order.reference, checkoutUrl: result.checkoutUrl });
    } catch (err) {
      const status = err instanceof CheckoutError ? err.status : 500;
      json(res, status, { error: err instanceof Error ? err.message : "Kassan föll." });
    }
    return true;
  }

  // POST /api/butik/order/:id/leverans — välj tid efter betalningen.
  if (segments[0] === "order" && segments.length === 3 && segments[2] === "leverans" && req.method === "POST") {
    if (!identity) return json(res, 401, { error: "Logga in." }), true;
    try {
      const order = await getOrder(segments[1]);
      // 404 och inte 403: ett annat svar hade avslöjat att ordern finns.
      if (!order || (order.userId && order.userId !== identity.userId)) return json(res, 404, { error: "Ordern finns inte." }), true;
      const body = await jsonBody<{ datum?: string; tid?: string }>(req);
      if (!body.datum || !body.tid) return json(res, 400, { error: "datum och tid krävs." }), true;
      const updated = await chooseSlot(order.id, body.datum, body.tid);
      json(res, 200, { order: updated });
    } catch (err) {
      const status = err instanceof CheckoutError ? err.status : 500;
      json(res, status, { error: err instanceof Error ? err.message : "Kunde inte boka tiden." });
    }
    return true;
  }

  /**
   * POST /api/butik/tolka — fritext till filter.
   *
   * PUBLIK, som resten av bläddrandet: att söka ska inte kräva ett konto. Priset för det är att
   * slutpunkten kostar ett Gemini-anrop per frågande, så den har ett tak per avsändare — se
   * rateLimited. Över taket faller den tillbaka på ordmatchning i stället för att avvisa: köparen
   * ska få träffar, inte ett felmeddelande om vår kvot.
   */
  if (segments[0] === "tolka" && segments.length === 1 && req.method === "POST") {
    const body = await jsonBody<{ fraga?: string }>(req);
    const question = (body.fraga ?? "").trim();
    if (!question) return json(res, 400, { error: "fraga krävs." }), true;

    const who = header(req, "x-forwarded-for")?.split(",")[0]?.trim() || req.socket.remoteAddress || "okänd";
    if (rateLimited(who)) {
      json(res, 200, { filter: { q: question.slice(0, 80) }, query: { q: question.slice(0, 80) }, summary: `Sökning: ${question.slice(0, 60)}`, aiUsed: false, throttled: true });
      return true;
    }

    // Märkeslistan skickas in så modellen bara kan föreslå märken vi har i lager.
    const brands = (await brandFacets()).map((b) => b.brand);
    const interpretation = await interpretQuery(question, brands);
    json(res, 200, { ...interpretation, available: aiSearchAvailable() });
    return true;
  }

  // POST /api/butik/bevakningar — spara en sökning.
  if (segments[0] === "bevakningar" && segments.length === 1 && req.method === "POST") {
    if (!identity?.userId) return json(res, 401, { error: "Logga in för att lägga en bevakning." }), true;
    const b = await jsonBody<{
      kategori?: string | null; marke?: string | null; maxpris?: number | null;
      maxbredd?: number | null; maxdjup?: number | null; maxhojd?: number | null;
    }>(req);
    // Måtten kommer i centimeter från gränssnittet och lagras i millimeter, som allt annat.
    const mm = (cm: number | null | undefined) => (typeof cm === "number" && cm > 0 ? Math.round(cm * 10) : null);
    const saved = await createBevakning({
      userId: identity.userId,
      email: identity.email,
      categorySlug: b.kategori ?? null,
      brand: b.marke ?? null,
      maxPriceSek: typeof b.maxpris === "number" && b.maxpris > 0 ? Math.round(b.maxpris) : null,
      maxWidthMm: mm(b.maxbredd),
      maxDepthMm: mm(b.maxdjup),
      maxHeightMm: mm(b.maxhojd),
    });
    json(res, 200, { bevakning: saved });
    return true;
  }

  // DELETE /api/butik/bevakningar/:id
  if (segments[0] === "bevakningar" && segments.length === 2 && req.method === "DELETE") {
    if (!identity?.userId) return json(res, 401, { error: "Logga in." }), true;
    const ok = await deleteBevakning(segments[1], identity.userId);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Bevakningen finns inte." });
    return true;
  }

  // POST /api/butik/order/:id/retur — returbegäran. Manuell hantering bakom kulisserna.
  if (segments[0] === "order" && segments.length === 3 && segments[2] === "retur" && req.method === "POST") {
    if (!identity) return json(res, 401, { error: "Logga in." }), true;
    const order = await getOrder(segments[1]);
    if (!order || (order.userId && order.userId !== identity.userId)) return json(res, 404, { error: "Ordern finns inte." }), true;
    if (order.status !== "delivered" && order.status !== "scheduled" && order.status !== "paid") {
      return json(res, 409, { error: "Ordern kan inte returneras i sitt nuvarande läge." }), true;
    }
    const updated = await updateOrder(order.id, { status: "return_requested" });
    console.info(`[butik] Retur begärd för order ${order.reference} (${order.productId}) — boka upphämtning.`);
    json(res, 200, { order: updated });
    return true;
  }

  return false;
}

/** Läsande ordervägar. Egen funktion för att de kräver inloggning men inte är skrivande. */
export async function handleButikOrderRead(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  identity: { userId: string | null; email: string | null } | null,
): Promise<boolean> {
  if (segments[0] === "bevakningar" && segments.length === 1 && req.method === "GET") {
    if (!identity?.userId) return json(res, 401, { error: "Logga in." }), true;
    json(res, 200, { bevakningar: await listBevakningar(identity.userId) });
    return true;
  }

  /**
   * GET /api/butik/order — mina köp.
   *
   * Fanns inte förrän nu, och frånvaron var ett hål: ordern hade alltid ett `userId`, men den enda
   * vägen till den gick via id:t i adressfältet. Köparen som stängde fliken efter betalningen kom
   * aldrig tillbaka till sitt köp — kvittot låg i databasen och ingenstans annars, för
   * e-postavsändaren är inte byggd.
   *
   * Möbeln följer med per order. En orderrad utan bild och rubrik är ett belopp och ett datum, och
   * det är inte vad någon öppnar sina köp för att titta på.
   */
  if (segments[0] === "order" && segments.length === 1 && req.method === "GET") {
    if (!identity?.userId) return json(res, 401, { error: "Logga in." }), true;
    const mine = await ordersForUser(identity.userId);
    const rows = await Promise.all(
      mine.map(async (order) => ({ order, product: await productById(order.productId) })),
    );
    json(res, 200, { orders: rows });
    return true;
  }

  if (segments[0] === "order" && segments.length === 2 && req.method === "GET") {
    if (!identity) return json(res, 401, { error: "Logga in." }), true;
    const order = (await getOrder(segments[1])) ?? (await orderByReference(segments[1]));
    if (!order || (order.userId && order.userId !== identity.userId)) return json(res, 404, { error: "Ordern finns inte." }), true;
    const product = await productById(order.productId);
    json(res, 200, { order, product });
    return true;
  }
  return false;
}
