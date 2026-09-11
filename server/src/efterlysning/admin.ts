/**
 * Efterlysningarna som en människa läser dem, och brevet den människan skickar.
 *
 * MATCHNINGEN SKER FÖR HAND, och det är ett beslut och inte en lucka. Sveparen (sweep.ts) matchar
 * automatiskt mot ett `ProductFilter`, och det fungerar för det som ÄR ett filter: kategori, pris,
 * mått. Men det köparen skrev — "gärna HAY eller Muuto", "något som tål en katt", ett märke vi inte
 * har i lager — överlever aldrig tolkningen, och det är ofta just det som avgör om möbeln som kom in
 * i dag är rätt. En människa som läser originaltexten bredvid möbeln avgör det på två sekunder.
 *
 * PANELEN VISAR DÄRFÖR TVÅ SAKER BREDVID VARANDRA: vad personen skrev, och vad vi har som ligger i
 * närheten. Kandidaterna kommer ur butikens vanliga `browse` med efterlysningens filter — samma
 * lista rutnätet hade visat — och är ett FÖRSLAG, inte ett facit. Knappen sitter hos människan.
 *
 * BREVET BÄR MÖBELN, INTE ETT BESKED OM ATT DET FINNS ETT BESKED. Bild, pris, skick och en länk rakt
 * till produktsidan: mottagaren ska kunna avgöra om det är rätt utan att först logga in någonstans.
 */

import { browse } from "../butik/browse.js";
import { productById } from "../butik/inventory.js";
import type { Product } from "../butik/types.js";
import * as store from "./store.js";
import { sendLetter } from "./notify.js";
import type { Efterlysning, MatchSource } from "./types.js";
import { emit } from "./analytics.js";

const BASE = () =>
  process.env.LOOPA_PUBLIC_URL?.trim() || process.env.PUBLIC_URL?.trim() || "https://app.loopa.nu";

export function produktLank(productId: string): string {
  return `${BASE()}/butik/objekt/${encodeURIComponent(productId)}`;
}

const SEK = (n: number | null) => (n === null ? "okänt pris" : `${n.toLocaleString("sv-SE")} kr`);

/** En rad i panelen. Allt en människa behöver för att döma, och ingenting mer. */
export interface AdminEfterlysning {
  id: string;
  state: Efterlysning["state"];
  /** Vad personen faktiskt skrev. Står FÖRST i panelen — se filens topp. */
  originalText: string | null;
  summary: string;
  epost: string | null;
  /** Sant för en efterlysning som hör till ett konto. Då finns även inkorgen som kanal. */
  konto: boolean;
  varifran: string | null;
  fragor: { field: string; question: string; answer: string | null }[];
  filter: Efterlysning["filter"];
  styleTags: string[];
  note: string | null;
  skapad: string;
  /** Möbler vi redan hört av oss om, så samma tips inte går två gånger. */
  tipsade: string[];
}

function rad(e: Efterlysning): AdminEfterlysning {
  return {
    id: e.id,
    state: e.state,
    originalText: e.originalText ?? null,
    summary: e.summary,
    epost: e.email,
    konto: !!e.userId,
    varifran: e.origin ?? null,
    fragor: e.asked ?? [],
    filter: e.filter,
    styleTags: e.styleTags,
    note: e.note,
    skapad: e.createdAt,
    tipsade: e.notifiedProductIds,
  };
}

/**
 * Alla efterlysningar, nyast först.
 *
 * INGEN SIDINDELNING. Registret är litet — matchningen sker för hand, vilket i sig sätter taket för
 * hur många det kan bli innan det här slutar vara en lista och blir en kö. Den dagen kommer, och då
 * är sidindelning rätt svar; att bygga den nu hade varit maskineri utan ett problem att lösa.
 */
export async function listaEfterlysningar(): Promise<{ poster: AdminEfterlysning[] }> {
  const alla = await store.all();
  return {
    poster: alla
      // Utkasten från direktsvepet har varken e-post eller konto och är inte någons efterlysning —
      // de finns bara för att bära svepets loggning. Se `svep` i routes.ts.
      .filter((e) => e.email || e.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(rad),
  };
}

/** En kandidat, som panelen visar den. Samma fält som brevet sedan bär. */
export interface Kandidat {
  id: string;
  titel: string;
  marke: string | null;
  pris: number | null;
  bild: string | null;
  skick: string | null;
  kalla: MatchSource;
  lank: string;
  /** Sant om vi redan skickat den här möbeln till den här personen. */
  tipsad: boolean;
}

function kandidatAv(p: Product, e: Efterlysning): Kandidat {
  return {
    id: p.id,
    titel: p.title,
    marke: p.brand,
    pris: p.priceSek,
    bild: p.imageUrl,
    skick: p.condition?.label ?? null,
    kalla: p.source === "tradera" ? "tradera" : "loopa_live",
    lank: produktLank(p.id),
    tipsad: e.notifiedProductIds.includes(p.id),
  };
}

/**
 * Vad vi har som ligger i närheten av den här efterlysningen.
 *
 * FILTRET KÖRS MJUKT. Panelen frågar med kategori och pristak men UTAN mått, färg och material —
 * de fälten fäller kandidater som en människa mycket väl kan tycka duger, och en tom lista säger
 * ingenting om varför den är tom. Den hårda matchningen finns redan i sweep.ts; det här är en hylla
 * att titta på.
 */
export async function kandidater(id: string, gräns = 24): Promise<{ poster: Kandidat[] } | null> {
  const e = await store.get(id);
  if (!e) return null;
  const result = await browse({
    categorySlug: e.filter.categorySlug ?? null,
    brands: e.filter.brands ?? null,
    maxPriceSek: e.filter.maxPriceSek ?? null,
    limit: gräns,
  });
  return { poster: result.items.map((p) => kandidatAv(p, e)) };
}

export class TipsFel extends Error {}

/**
 * Skickar tipset, och skriver ner att vi gjort det.
 *
 * ORDNINGEN ÄR: logga träffen, märk möbeln som skickad, SEDAN brevet. Samma ordning som notify.ts,
 * av samma skäl — en avsändare som faller ska hellre ha missat ett brev än skicka samma brev varje
 * gång någon trycker på knappen igen.
 *
 * DUBBLETTEN STOPPAS HÄR och inte i gränssnittet. Knappen är grå för en möbel vi redan skickat, men
 * en grå knapp är en artighet; regeln måste sitta där skrivningen sker.
 */
export async function skickaTips(
  id: string,
  productId: string,
  /** Admins egen rad ovanför möbeln. Tom = bara möbeln. */
  hälsning?: string,
): Promise<{ skickat: boolean; till: string }> {
  const e = await store.get(id);
  if (!e) throw new TipsFel("Efterlysningen finns inte.");
  if (!e.email) throw new TipsFel("Den här efterlysningen har ingen e-postadress att skriva till.");
  if (e.notifiedProductIds.includes(productId)) {
    throw new TipsFel("Vi har redan hört av oss om den möbeln.");
  }
  const p = await productById(productId);
  if (!p) throw new TipsFel("Möbeln finns inte längre.");

  await store.logMatches([{
    efterlysningId: e.id,
    productId: p.id,
    source: p.source === "tradera" ? "tradera" : "loopa_live",
    // Handplockad av en människa som läst originaltexten. Det är den strängaste bedömning vi har.
    kind: "exact",
    fitNote: "Utvald för hand mot det du skrev.",
  }]);
  await store.markNotified(e.id, [p.id]);

  const rader = [
    hälsning?.trim() || null,
    hälsning?.trim() ? "" : null,
    `Du skrev till oss att du letade efter: ${e.originalText?.trim() || e.summary}`,
    "",
    `${p.title}${p.brand ? ` — ${p.brand}` : ""}`,
    SEK(p.priceSek),
    p.condition?.label ? `Skick: ${p.condition.label}` : null,
    // Bilden som en adress och inte som en bilaga: breven är ren text tills en e-postleverantör är
    // vald, och mallspråket är deras beslut och inte vårt. Se notify/outbox.ts.
    p.imageUrl ? `Bild: ${p.imageUrl}` : null,
    "",
    `Se den här: ${produktLank(p.id)}`,
    "",
    "Är det inte rätt behöver du inte göra något — vi hör av oss igen när nästa kommer in.",
  ].filter((r) => r !== null);

  const skickat = await sendLetter({
    to: e.email,
    subject: `Vi hittade något: ${p.title}`,
    body: rader.join("\n"),
    kind: "efterlysning-tips",
  });
  emit("notification_sent", {
    kind: "match", source: p.source === "tradera" ? "tradera" : "loopa_live", antal: 1,
    efterlysning: e.id, brev: true, handplockad: true,
  });
  return { skickat, till: e.email };
}
