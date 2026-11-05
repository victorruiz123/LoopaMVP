/**
 * Blockets statistiksida per annons: allt Blocket själv visar säljaren.
 *
 * UPPMÄTT 2026-10-29 (Loopas konto, bara läsning), /recommerce/statistics/<id>:
 *
 *   SAMMANFATTNINGEN står som text: "Totalt antal klick 80 · Kontakter 1 · Sparad som favorit 8",
 *   "Klick från ökad synlighet 0", "Mejlnotiser 156" (personer som fått ett bevakningsmejl),
 *   "Pushnotiser 143", "Annonsens besökare 60" med "En gång: 49 personer · Två till fem gånger: 11
 *   personer · Fler än fem gånger: 0 personer".
 *
 *   DAGARNA ligger i diagrammets `data-props`, base64-kodad JSON: `{ histogram: [{ date, views,
 *   chat_replies, email_replies, favorited, favorited_change, homepage_clicks, promotion_clicks,
 *   pole_position_clicks, recommendation_clicks }] }`, nyast först, en post per dag sedan annonsen
 *   lades upp. En annan `data-props` bär annonsens läge (`state.label`, "Aktiv").
 *
 *   DAGAR KVAR står bara i listan på /my-items ("Aktiv326 dagar kvar"), inte på statistiksidan.
 *
 * Tolkningen är ren och prövas mot texten och attributen som de stod; läsningen gör det en människa
 * gör: öppnar sidan med Loopas session.
 */

import type { Page } from "playwright";
import { blocketBaseUrl } from "./blocket.js";
import { goAndSettle, isLoggedOut } from "./browser.js";
import { dismissCookieBanner, dismissModal } from "./form.js";

export interface BlocketDag {
  datum: string;
  klick: number;
  chattsvar: number;
  mejlsvar: number;
  /** Antal favoriter vid dagens slut, och hur många som tillkom den dagen. */
  favoriter: number;
  nyaFavoriter: number;
  klickStartsidan: number;
  klickMarknadsforing: number;
  klickTopplacering: number;
  klickRekommendation: number;
}

export interface BlocketAnnonsStatistik {
  status: string | null;
  klick: number;
  kontakter: number;
  favoriter: number;
  klickOkadSynlighet: number | null;
  mejlnotiser: number | null;
  pushnotiser: number | null;
  besokare: number | null;
  besokFordelning: { enGang: number; tvaTillFem: number; flerAnFem: number } | null;
  /** Äldst först. */
  perDag: BlocketDag[];
}

/** Talet efter etiketten. Tusental kan stå med mellanslag eller hårt mellanslag: "1 234". */
export function talEfter(text: string, etikett: RegExp): number | null {
  const m = text.match(new RegExp(`${etikett.source}:?\\s*(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)`, "i"));
  return m ? Number(m[1].replace(/[  ]/g, "")) : null;
}

function tal(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Diagrammets dagar ur `data-props`-attributen (base64-JSON). Tom lista när inget histogram finns. */
export function dagarUrProps(props: string[]): BlocketDag[] {
  for (const p of props) {
    let d: { histogram?: unknown };
    try {
      d = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(d?.histogram)) continue;
    return (d.histogram as Array<Record<string, unknown>>)
      .filter((h) => typeof h.date === "string")
      .map((h) => ({
        datum: h.date as string,
        klick: tal(h.views),
        chattsvar: tal(h.chat_replies),
        mejlsvar: tal(h.email_replies),
        favoriter: tal(h.favorited),
        nyaFavoriter: tal(h.favorited_change),
        klickStartsidan: tal(h.homepage_clicks),
        klickMarknadsforing: tal(h.promotion_clicks),
        klickTopplacering: tal(h.pole_position_clicks),
        klickRekommendation: tal(h.recommendation_clicks),
      }))
      .sort((a, b) => a.datum.localeCompare(b.datum));
  }
  return [];
}

/** Annonsens läge ("Aktiv") ur `data-props`. */
export function statusUrProps(props: string[]): string | null {
  for (const p of props) {
    try {
      const d = JSON.parse(Buffer.from(p, "base64").toString("utf8")) as { state?: { label?: unknown } };
      if (typeof d?.state?.label === "string") return d.state.label;
    } catch {
      // Inte base64-JSON; nästa.
    }
  }
  return null;
}

/**
 * Hela sidan, tolkad. Null när sammanfattningens tre huvudtal inte står där — sidan ritade inte klart
 * eller är ombyggd, och då är förra avläsningen bättre än en påhittad nolla.
 */
export function tolkaStatistiksida(text: string, props: string[]): BlocketAnnonsStatistik | null {
  const t = text.replace(/\s+/g, " ");
  const klick = talEfter(t, /Totalt antal klick/);
  const kontakter = talEfter(t, /Kontakter/);
  // "Sparad som favorit" står också i tipsrutan som löptext ("8 personer har markerat … som favorit"),
  // men aldrig med talet direkt efter — etiketten med tal är kortets.
  const favoriter = talEfter(t, /Sparad som favorit/);
  if (klick === null || kontakter === null || favoriter === null) return null;
  const enGang = talEfter(t, /En gång/);
  const tvaTillFem = talEfter(t, /Två till fem gånger/);
  const flerAnFem = talEfter(t, /Fler än fem gånger/);
  return {
    status: statusUrProps(props),
    klick,
    kontakter,
    favoriter,
    klickOkadSynlighet: talEfter(t, /Klick från ökad synlighet/),
    mejlnotiser: talEfter(t, /Mejlnotiser/),
    pushnotiser: talEfter(t, /Pushnotiser/),
    besokare: talEfter(t, /Annonsens besökare/),
    besokFordelning: enGang !== null && tvaTillFem !== null && flerAnFem !== null ? { enGang, tvaTillFem, flerAnFem } : null,
    perDag: dagarUrProps(props),
  };
}

/** Läser statistiksidan för en annons. Kastar när sessionen gått ut; null när sidan inte gick att tolka. */
export async function lasBlocketStatistik(page: Page, id: string): Promise<BlocketAnnonsStatistik | null> {
  await goAndSettle(page, `${blocketBaseUrl()}/recommerce/statistics/${id}`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
  await page.getByText(/Totalt antal klick/i).first().waitFor({ timeout: 15_000 }).catch(() => null);
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const props = await page.$$eval("[data-props]", (els) => els.map((e) => e.getAttribute("data-props") ?? "")).catch(() => [] as string[]);
  return tolkaStatistiksida(text, props);
}

/**
 * Dagar kvar per annons, ur listan på /my-items. Varje kort är en länk till ägarsidan och en rad
 * "Aktiv326 dagar kvar"; kortet hittas som närmaste förälder som bär både länken och raden.
 */
export async function lasDagarKvar(page: Page): Promise<Map<string, number>> {
  await goAndSettle(page, `${blocketBaseUrl()}/my-items`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
  const rader = await page
    .$$eval('a[href*="/my-items/details/"]', (as) =>
      as.map((a) => {
        const id = (a.getAttribute("href") ?? "").match(/details\/(\d+)/)?.[1] ?? null;
        let el: HTMLElement | null = a as HTMLElement;
        for (let i = 0; i < 8 && el; i++) {
          if (/dagar kvar/i.test(el.innerText ?? "")) break;
          el = el.parentElement;
        }
        return { id, text: el?.innerText ?? "" };
      }),
    )
    .catch(() => [] as Array<{ id: string | null; text: string }>);
  const ut = new Map<string, number>();
  for (const r of rader) {
    const m = r.text.match(/(\d+)\s*dagar kvar/i);
    if (r.id && m && !ut.has(r.id)) ut.set(r.id, Number(m[1]));
  }
  return ut;
}
