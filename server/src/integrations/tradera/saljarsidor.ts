/**
 * Traderas egna säljarsidor: visningar och bevakare per annons — det API:t inte lämnar ut.
 *
 * UPPMÄTT 2026-10-29 (Loopas konto, inkorgens session, bara läsning):
 *
 *   /my/listings ("Aktiva annonser") hämtar sin lista med POST /api/webclient/my/seller/listings och
 *   `{ parameters: { processState, hasBids, itemType, itemCondition, reservePriceReached, paging } }`.
 *   processState "OnGoing" = aktiva, "Ended" = avslutade (sålda och osålda); andra värden ger 400.
 *   Varje annons har `viewsCount` och `wishlistCount` — visningarna och bevakarna som REST-API:t
 *   (tradera.ts `getTraderaLage`) saknar — plus `bidInformation.bidCount`, `currentPrice`,
 *   `listing.endDate`, `listing.ownReference` (Loopas jobb-id, satt vid publiceringen) och
 *   `activityType` ("Active", "Unsold" …).
 *
 * Anropet görs INIFRÅN sidan, med sidans egna kakor, i en session sparad för hand (logga-in.ts) — samma
 * session som inkorgen läses med (inkorg.ts). Det är Traderas webbklients eget API och odokumenterat:
 * ändras det slutar det här att fungera, och statistiken visar då senast sparade siffror — de nollas
 * aldrig.
 */

import { traderaSessionFile, traderaInkorgKonfigurerad } from "./inkorg.js";

export interface TraderaWebAnnons {
  itemId: number;
  ownReference: string | null;
  aktiv: boolean;
  /** Traderas eget ord: "Active", "Unsold", "Sold" … Översätts i vyn, gissas aldrig. */
  status: string;
  visningar: number;
  bevakare: number;
  bud: number;
  prisSek: number | null;
  slutar: string | null;
  typ: string | null;
  url: string | null;
}

/** En post ur Traderas lista i vår form. Null när id:t saknas. Ren. */
export function tolkaWebAnnons(raw: unknown): TraderaWebAnnons | null {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.itemId !== "number") return null;
  const listing = (r.listing ?? {}) as Record<string, any>;
  const tal = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    itemId: r.itemId,
    ownReference: typeof listing.ownReference === "string" ? listing.ownReference : null,
    aktiv: r.isActive === true,
    status: typeof r.activityType === "string" ? r.activityType : "Unknown",
    visningar: tal(r.viewsCount),
    bevakare: tal(r.wishlistCount),
    bud: tal(r.bidInformation?.bidCount),
    prisSek: typeof r.currentPrice === "number" ? r.currentPrice : null,
    slutar: typeof listing.endDate === "string" ? listing.endDate : null,
    typ: typeof listing.itemType === "string" ? listing.itemType : null,
    url: typeof r.itemUrl === "string" ? `https://www.tradera.com${r.itemUrl}` : null,
  };
}

const PER_SIDA = 100;
/** Avslutade annonser samlas på hög; 20 sidor är långt mer än Loopas konto har. */
const MAX_SIDOR = 20;

/**
 * Alla annonser på kontot, aktiva och avslutade, med visningar och bevakare. Kastar när sessionen gått
 * ut eller listan inte går att läsa — anroparen behåller då sina förra siffror.
 */
export async function lasTraderaSaljarAnnonser(): Promise<TraderaWebAnnons[]> {
  if (!traderaInkorgKonfigurerad()) throw new Error("Ingen Tradera-session (npm run tradera:logga-in).");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "sv-SE",
      storageState: traderaSessionFile(),
    });
    const page = await context.newPage();
    await page.goto("https://www.tradera.com/my/listings", { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (/login|logga-in/i.test(new URL(page.url()).pathname)) throw new Error("Tradera-sessionen har gått ut.");

    const alla: TraderaWebAnnons[] = [];
    for (const processState of ["OnGoing", "Ended"]) {
      for (let sida = 0; sida < MAX_SIDOR; sida++) {
        const svar = await page.evaluate(
          async ({ processState, skip, take }) => {
            const r = await fetch("/api/webclient/my/seller/listings", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", "x-requested-with": "XMLHttpRequest" },
              body: JSON.stringify({
                parameters: { processState, hasBids: "All", itemType: "All", itemCondition: "All", reservePriceReached: "All", paging: { skip, take } },
              }),
            });
            return { status: r.status, text: await r.text() };
          },
          { processState, skip: sida * PER_SIDA, take: PER_SIDA },
        );
        if (svar.status === 401 || svar.status === 403) throw new Error("Tradera-sessionen har gått ut.");
        if (svar.status !== 200) throw new Error(`Traderas säljarlista svarade ${svar.status}.`);
        const items = (JSON.parse(svar.text) as { items?: unknown[] }).items ?? [];
        for (const raw of items) {
          const a = tolkaWebAnnons(raw);
          if (a) alla.push(a);
        }
        if (items.length < PER_SIDA) break;
      }
    }
    return alla;
  } finally {
    await browser.close().catch(() => null);
  }
}
