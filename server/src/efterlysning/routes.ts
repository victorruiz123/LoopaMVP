/**
 * Efterlysningens vägar.
 *
 * TVÅ HALVOR, och gränsen mellan dem är hela konverteringsmodellen:
 *
 *   PUBLIKT   tolka en mening, se ett direktsvep. Kostar oss ett modellanrop och ett Tradera-anrop,
 *             och ger köparen svaret på "kan de här något?" innan de bestämt sig om oss.
 *   INLOGGAT  SPARA. Först då finns det någon att höra av sig till, och först då bevakar vi.
 *
 * Ordningen är vald: att kräva ett konto för att få se om tjänsten fungerar är att be om betalning
 * före leverans. Att däremot bevaka åt någon vi inte kan nå är att lova något vi inte kan hålla.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as store from "./store.js";
import { parse, followUps, applyAnswer, summarize, type ParsedSpec } from "./parse.js";
import { sweep } from "./sweep.js";
import type { Efterlysning } from "./types.js";
import { EXPIRY_DAYS } from "./types.js";
import { inbox, markRead } from "./notify.js";
import { demandCountFor, demandDashboard, toCsv, wall } from "./wall.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // En efterlysning är text. Ett anrop på en megabyte är inte en efterlysning.
    if (size > 200_000) throw new Error("För stor kropp.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

/** Specen som den skickas till klienten och tillbaka. Samma form åt båda hållen. */
function specOf(e: Efterlysning): ParsedSpec {
  return {
    filter: e.filter,
    styleTags: e.styleTags,
    deadline: e.deadline,
    urgency: e.urgency,
    note: e.note,
    summary: e.summary,
    aiUsed: true,
  };
}

// ---------------------------------------------------------------------------
// Publika vägar
// ---------------------------------------------------------------------------

export async function handleEfterlysningPublic(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  /**
   * POST /api/efterlysning/tolka — en mening in, en spec ut.
   *
   * Svarar ALLTID med en spec, även när modellen faller: `aiUsed: false` betyder att klienten ska
   * visa formuläret i stället för sammanfattningen. Ett trasigt flöde är sämre än ett tråkigt.
   */
  if (segments[0] === "tolka" && req.method === "POST") {
    const body = await readBody<{ text?: string; svar?: { field: string; answer: string }[]; spec?: ParsedSpec }>(req);
    let spec: ParsedSpec;
    if (body.spec) {
      spec = body.spec;
    } else {
      const text = (body.text ?? "").trim().slice(0, 500);
      if (!text) return json(res, 400, { error: "Skriv vad du letar efter." }), true;
      spec = await parse(text);
    }
    // Svar på följdfrågor vävs in ett i taget, utan att hela meningen tolkas om.
    for (const s of body.svar ?? []) {
      spec = await applyAnswer(spec, s.field as never, s.answer);
    }
    spec.summary = summarize(spec);
    json(res, 200, { spec, fragor: followUps(spec) });
    return true;
  }

  /**
   * POST /api/efterlysning/svep — direktsvepet, utan att spara något.
   *
   * Anonym åtkomst med flit: köparen ska se att vi hittar saker innan de skapar konto. Efterlysningen
   * som skapas här har `userId: null` och är därmed osynlig för väggen, sveparen och notiserna — den
   * finns bara för att bära svepets loggning (scannedCount, matchningar) så statistiken blir sann.
   */
  if (segments[0] === "svep" && req.method === "POST") {
    const body = await readBody<{ spec?: ParsedSpec }>(req);
    if (!body.spec) return json(res, 400, { error: "Ingen spec att söka på." }), true;
    const draft = await store.create({
      userId: null, email: null, filter: body.spec.filter, styleTags: body.spec.styleTags ?? [],
      deadline: body.spec.deadline ?? null, urgency: body.spec.urgency ?? "none", note: body.spec.note ?? null,
      summary: body.spec.summary ?? "", parseMethod: "chat", area: null, state: "paused",
    });
    const result = await sweep(draft);
    json(res, 200, {
      traffar: result.candidates.map((c) => ({
        produkt: c.product, kalla: c.source, typ: c.kind, passform: c.fitNote,
      })),
      lasta: result.scanned,
      traderaDegraded: result.traderaDegraded,
      prognos: result.forecast,
    });
    return true;
  }

  /**
   * POST /api/efterlysning/enkel — fångaren på köpsidan.
   *
   * TRE FÄLT OCH INGEN MODELL. Kategori, maxpris, e-post. Ingen tolkning, inget LLM-anrop, ingen
   * följdfråga — sidan finns för att fånga en avsikt hos någon som är på väg någon annanstans, och
   * varje sekund den kostar är en avsikt som hinner rinna bort.
   *
   * PUBLIK OCH UTAN KONTO. E-postadressen ÄR vägen att nå personen, och det var alltid vad kravet
   * handlade om (se `nabar` i types.ts). Att kräva ett konto för ett enrads-formulär hade flyttat
   * konverteringen till fel ställe.
   */
  if (segments[0] === "enkel" && req.method === "POST") {
    const body = await readBody<{ kategori?: string; maxpris?: number; epost?: string }>(req);
    const epost = (body.epost ?? "").trim().toLowerCase();
    // Snäll validering: felet ska hjälpa, inte skälla. Ett saknat @ är det enda vi kan veta säkert.
    if (!epost || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(epost)) {
      return json(res, 400, { error: "Skriv en e-postadress vi kan nå dig på." }), true;
    }
    const { CATEGORIES } = await import("../butik/catalog.js");
    const kategori = CATEGORIES.find((c) => c.slug === body.kategori)?.slug ?? null;
    if (!kategori) return json(res, 400, { error: "Välj vilken sorts möbel du letar efter." }), true;
    const maxpris = Number(body.maxpris);
    const row = await store.create({
      userId: null,
      email: epost.slice(0, 200),
      filter: { categorySlug: kategori, maxPriceSek: Number.isFinite(maxpris) && maxpris > 0 ? Math.round(maxpris) : null },
      styleTags: [], deadline: null, urgency: "none", note: null,
      summary: summarize({
        filter: { categorySlug: kategori, maxPriceSek: Number.isFinite(maxpris) && maxpris > 0 ? Math.round(maxpris) : null },
        styleTags: [], deadline: null, urgency: "none", note: null, summary: "", aiUsed: false,
      }),
      // Egen märkning: varken chattad eller ifylld i det stora formuläret. Håller måttet på hur folk
      // faktiskt skapar efterlysningar ärligt.
      parseMethod: "form",
      area: null,
    });
    json(res, 201, { efterlysning: { id: row.id, summary: row.summary }, dagar: EXPIRY_DAYS });
    return true;
  }

  /**
   * GET /api/efterlysning/vagg — den publika efterlysningsväggen.
   *
   * PUBLIK och riktad till SÄLJARE. Aggregerad och anonym: två personer som söker samma hylla blir
   * en rad, vilket både skyddar dem och är ett starkare säljargument än två rader. Se wall.ts för
   * de tre reglerna som håller köparen oidentifierbar.
   */
  if (segments[0] === "vagg" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://x");
    json(res, 200, { poster: await wall(url.searchParams.get("kategori")) });
    return true;
  }

  /**
   * GET /api/efterlysning/efterfragan?kategori=&marke=&pris= — säljarkroken.
   *
   * Svarar med ETT ANTAL och ingenting annat. En säljare som ser "någon i Vasastan söker en grön
   * sammetssoffa max 6 000" vet både var köparen bor och vad de har råd med — en förhandlings-
   * position vi gett bort gratis.
   */
  if (segments[0] === "efterfragan" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://x");
    const pris = Number(url.searchParams.get("pris"));
    json(res, 200, {
      antal: await demandCountFor({
        categorySlug: url.searchParams.get("kategori"),
        brand: url.searchParams.get("marke"),
        priceSek: Number.isFinite(pris) && pris > 0 ? pris : null,
      }),
    });
    return true;
  }

  /**
   * GET /api/efterlysning/bevis — remsan på köpsidan.
   *
   * BARA RIKTIGA SIFFROR. Uppfyllda efterlysningar räknas ur matchningar med ett köp; öppen
   * efterfrågan ur aktiva efterlysningar. Under tröskeln svarar vägen med tomma listor, och remsan
   * ritar då ingenting — hellre en sida utan bevis än en sida med påhittade.
   */
  if (segments[0] === "bevis" && req.method === "GET") {
    const MIN = Number(process.env.EFTERLYSNING_PROOF_MIN ?? 3);
    const [all, matches] = await Promise.all([store.all(), store.allMatches()]);
    const byId = new Map(all.map((e) => [e.id, e]));

    const uppfyllda = matches
      .filter((m) => m.purchasedAt)
      .map((m) => {
        const e = byId.get(m.efterlysningId);
        if (!e) return null;
        const days = Math.max(1, Math.round(
          (new Date(m.purchasedAt!).getTime() - new Date(e.createdAt).getTime()) / 86_400_000,
        ));
        return { vad: e.summary, dagar: days };
      })
      .filter((x): x is { vad: string; dagar: number } => x !== null)
      .slice(0, 6);

    // Öppen efterfrågan, grupperad så att ingen enskild köpare går att peka ut.
    const counts = new Map<string, number>();
    for (const e of all) {
      if (e.state !== "active" || !e.userId) continue;
      const key = e.filter.brands?.length
        ? `${e.filter.brands[0]}`
        : e.filter.categorySlug ?? "";
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const efterfragan = [...counts.entries()]
      .map(([vad, antal]) => ({ vad, antal }))
      .sort((a, b) => b.antal - a.antal)
      .slice(0, 6);

    const enough = uppfyllda.length + efterfragan.length >= MIN;
    json(res, 200, enough ? { uppfyllda, efterfragan } : { uppfyllda: [], efterfragan: [] });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Kontobundna vägar
// ---------------------------------------------------------------------------

export async function handleEfterlysning(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  user: { userId: string; email: string | null },
): Promise<boolean> {
  /** POST /api/efterlysning — spara. Konverteringsögonblicket: nu finns någon att höra av sig till. */
  if (segments.length === 0 && req.method === "POST") {
    const body = await readBody<{ spec?: ParsedSpec; omrade?: string; parseMethod?: string }>(req);
    if (!body.spec?.filter) return json(res, 400, { error: "Ingen spec att spara." }), true;
    const row = await store.create({
      userId: user.userId,
      email: user.email,
      filter: body.spec.filter,
      styleTags: body.spec.styleTags ?? [],
      deadline: body.spec.deadline ?? null,
      urgency: body.spec.urgency ?? "none",
      note: body.spec.note ?? null,
      summary: body.spec.summary || summarize(body.spec),
      parseMethod: (body.parseMethod as never) ?? "chat",
      // Grovt område, för efterfrågeväggen. Aldrig mer exakt än en stadsdel.
      area: (body.omrade ?? "").trim().slice(0, 40) || null,
    });
    json(res, 201, { efterlysning: row, dagar: EXPIRY_DAYS });
    return true;
  }

  /**
   * GET /api/efterlysning/inkorg — notiserna.
   *
   * PRIMÄR KANAL, inte ett komplement till brevet. Den når mottagaren oavsett om en
   * e-postleverantör är vald, ligger kvar, går att läsa om, och pekar rakt in i den efterlysning
   * som orsakade den.
   */
  if (segments[0] === "inkorg" && req.method === "GET") {
    json(res, 200, { notiser: await inbox(user.userId) });
    return true;
  }

  if (segments[0] === "inkorg" && req.method === "POST") {
    const body = await readBody<{ ids?: string[] }>(req);
    await markRead(user.userId, body.ids ?? []);
    json(res, 200, { ok: true });
    return true;
  }

  /** GET /api/efterlysning — mina. */
  if (segments.length === 0 && req.method === "GET") {
    const mine = await store.forUser(user.userId);
    const withMatches = await Promise.all(
      mine.map(async (e) => ({ efterlysning: e, traffar: (await store.matchesFor(e.id)).length })),
    );
    json(res, 200, { efterlysningar: withMatches });
    return true;
  }

  if (segments.length >= 1) {
    const id = segments[0];
    const row = await store.get(id);
    // 404 och inte 403: ett annat svar hade avslöjat att efterlysningen finns.
    if (!row || row.userId !== user.userId) return json(res, 404, { error: "Efterlysningen finns inte." }), true;

    if (segments.length === 1 && req.method === "GET") {
      json(res, 200, { efterlysning: row, traffar: await store.matchesFor(id) });
      return true;
    }

    /** PATCH — pausa, återuppta, eller ändra specen. */
    if (segments.length === 1 && req.method === "PATCH") {
      const body = await readBody<{ state?: Efterlysning["state"]; spec?: ParsedSpec }>(req);
      const patch: Partial<Efterlysning> = {};
      if (body.state === "active" || body.state === "paused" || body.state === "fulfilled") patch.state = body.state;
      if (body.spec?.filter) {
        patch.filter = body.spec.filter;
        patch.styleTags = body.spec.styleTags ?? [];
        patch.deadline = body.spec.deadline ?? null;
        patch.urgency = body.spec.urgency ?? "none";
        patch.note = body.spec.note ?? null;
        patch.summary = body.spec.summary || summarize(body.spec);
        // En ändrad spec ska få höra av sig om möbler den gamla redan avfärdat.
        patch.notifiedProductIds = [];
      }
      json(res, 200, { efterlysning: await store.update(id, patch) });
      return true;
    }

    if (segments.length === 1 && req.method === "DELETE") {
      json(res, 200, { ok: await store.remove(id, user.userId) });
      return true;
    }

    if (segments[1] === "fornya" && req.method === "POST") {
      json(res, 200, { efterlysning: await store.renew(id) });
      return true;
    }

    /** POST /:id/svep — kör om svepet på begäran. Samma väg som förstagången, mot en sparad spec. */
    if (segments[1] === "svep" && req.method === "POST") {
      const result = await sweep(row);
      json(res, 200, {
        traffar: result.candidates.map((c) => ({
          produkt: c.product, kalla: c.source, typ: c.kind, passform: c.fitNote,
        })),
        lasta: result.scanned,
        prognos: result.forecast,
      });
      return true;
    }
  }

  return false;
}

/** Vad specOf är till för — klienten skickar tillbaka samma form den fick. */
export { specOf };
