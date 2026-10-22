/**
 * Har en köpare skrivit till annonsen? Läses innan veckans omläggning tar ner den (borttagning.ts).
 *
 * VARFÖR: när en Blocket-annons tas bort står konversationen kvar i inkorgen, men med "(Annons)" i
 * stället för annonsens rubrik och utan länk till den — köparen pratar om en möbel som inte längre
 * finns. Skarpt 2026-10-20: barstolen 21946768 togs ner med ett obesvarat bud ("finns stolen kvar? Kan
 * tänka mig att ge 250kr …") från lördagen innan. En annons med meddelanden tas därför inte ner: den
 * ligger kvar, och omläggningen lägger upp den nya bredvid (integrations/omlaggning.ts).
 *
 * TVÅ KÄLLOR, UPPMÄTTA 2026-10-21:
 *
 *   Ägarsidan  /my-items/details/<id> har en statistikruta: "Klick på annonsen 0 · Sparad som favorit 0
 *              · Skickade meddelanden 0" (etiketten först, talet efter). Räknaren gäller just den
 *              annonsen och är huvudkällan.
 *   Inkorgen   /messages skickar vidare till den senaste konversationen (/messages/id/<nyckel>). Listan
 *              till vänster har en länk per konversation med annonsens rubrik och sista meddelandet;
 *              den öppna konversationen länkar till annonsen som https://www.blocket.se/<id>, så länge
 *              annonsen finns. Konversationer vars rubrik liknar vår öppnas, och räknas bara om de
 *              länkar till JUST vårt id — en tidigare annons för samma möbel som ligger kvar (för att den
 *              hade meddelanden) har samma rubrik, och får inte hålla kvar den nya i all evighet.
 *
 * GÅR RÄKNAREN INTE ATT LÄSA räknas annonsen som att den har meddelanden: att låta den ligga kvar bredvid
 * den nya kostar en dubblett, att ta ner den kan kosta en köpare.
 */

import type { Page } from "playwright";
import { blocketBaseUrl } from "./blocket.js";
import { goAndSettle, isLoggedOut } from "./browser.js";
import { dismissCookieBanner, dismissModal } from "./form.js";
import type { Logga } from "./diag.js";
import { adIdFromUrl, rubrikStammer } from "./pris.js";

export interface BlocketMeddelanden {
  /** "Skickade meddelanden" på ägarsidan. Null = gick inte att läsa. */
  raknare: number | null;
  /** Konversationer i inkorgen som länkar till annonsen. Null = inkorgen gick inte att läsa. */
  konversationer: number | null;
  /** Ska annonsen ligga kvar? Sant vid meddelanden, och när räknaren inte gick att läsa. */
  harMeddelanden: boolean;
  /** I klartext, för loggen. */
  skal: string;
}

/** Talet efter "Skickade meddelanden" i ägarsidans text. Null när etiketten inte står där. */
export function raknareUrText(text: string): number | null {
  const m = text.replace(/\s+/g, " ").match(/Skickade meddelanden:? (\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Utfallet av de två källorna, som regel. Ren funktion, så att regeln går att testa. */
export function bedomMeddelanden(raknare: number | null, konversationer: number | null): BlocketMeddelanden {
  const delar = [
    `räknaren ${raknare ?? "oläslig"}`,
    `konversationer i inkorgen ${konversationer ?? "oläslig"}`,
  ].join(", ");
  if ((raknare ?? 0) > 0 || (konversationer ?? 0) > 0) {
    return { raknare, konversationer, harMeddelanden: true, skal: `Annonsen har meddelanden från köpare (${delar}).` };
  }
  if (raknare === null) {
    return { raknare, konversationer, harMeddelanden: true, skal: `Meddelandena gick inte att läsa på ägarsidan (${delar}) — räknas som att de finns.` };
  }
  return { raknare, konversationer, harMeddelanden: false, skal: `Inga meddelanden (${delar}).` };
}

const MAX_OPPNADE = 10;

/** Läser båda källorna. Kastar aldrig för en oläslig sida — det blir null i utfallet. */
export async function lasBlocketMeddelanden(
  page: Page,
  annons: { id: string; title: string | null },
  logga: Logga,
): Promise<BlocketMeddelanden> {
  const bas = blocketBaseUrl();
  let raknare: number | null = null;
  try {
    await goAndSettle(page, `${bas}/my-items/details/${annons.id}`);
    await dismissCookieBanner(page);
    await dismissModal(page);
    if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
    // Statistikrutan ritas efter resten av sidan.
    await page.getByText(/Skickade meddelanden/i).first().waitFor({ timeout: 15_000 }).catch(() => null);
    raknare = raknareUrText(await page.locator("body").innerText({ timeout: 4000 }).catch(() => ""));
  } catch (err) {
    if (/gått ut/i.test(String(err))) throw err;
  }
  logga(raknare === null ? "Räknaren för meddelanden gick inte att läsa" : `Skickade meddelanden: ${raknare}`, raknare === null ? "warning" : "ok", { id: annons.id });

  let konversationer: number | null = null;
  if (annons.title) {
    try {
      konversationer = await konversationerOmAnnonsen(page, annons.id, annons.title);
      logga(`Konversationer om annonsen i inkorgen: ${konversationer}`, "ok", { id: annons.id });
    } catch (err) {
      logga("Inkorgen gick inte att läsa", "warning", { id: annons.id, fel: String(err).slice(0, 200) });
    }
  }
  return bedomMeddelanden(raknare, konversationer);
}

async function konversationerOmAnnonsen(page: Page, id: string, title: string): Promise<number> {
  const bas = blocketBaseUrl();
  await goAndSettle(page, `${bas}/messages`);
  if (isLoggedOut(page.url())) throw new Error("Blocket-sessionen har gått ut.");
  const lista = 'a[href*="/messages/id/"]';
  // En tom inkorg har inga länkar alls; då finns inget att räkna.
  const finns = await page.locator(lista).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (!finns) return 0;

  const lankar = await page.$$eval(lista, (as) =>
    as.map((a) => ({ href: a.getAttribute("href") ?? "", text: (a as HTMLElement).innerText ?? "" })),
  );
  const kandidater = [...new Set(lankar.filter((l) => rubrikIText(l.text, title)).map((l) => l.href))].slice(0, MAX_OPPNADE);

  let antal = 0;
  for (const href of kandidater) {
    await goAndSettle(page, new URL(href, bas).href);
    // Den öppna konversationens annonslänk ritas efter listan.
    await page.waitForTimeout(2500);
    const ids = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    if (ids.some((h) => !h.includes("/messages/") && adIdFromUrl(h) === id)) antal++;
  }
  return antal;
}

/** Står rubriken i konversationens rad? Raden är rubriken följd av sista meddelandet. */
export function rubrikIText(text: string, title: string): boolean {
  const rader = text.split("\n").map((r) => r.trim()).filter(Boolean);
  return rader.some((r) => rubrikStammer(r, title));
}
