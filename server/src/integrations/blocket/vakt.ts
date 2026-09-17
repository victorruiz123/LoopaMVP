/**
 * Sessionsvakten: upptäcker att Blocket-sessionen gått ut INNAN en säljare gör det.
 *
 * Sessionen är det som går sönder oftast, och det syns inte förrän någon publicerar: Blocket byter
 * den när BankID slutförs, Schibsted låter den åldras, och servern kan aldrig skaffa en ny själv —
 * inloggningen är passwordless med BankID i en synlig webbläsare, och servern är osynlig. Den enda
 * vägen tillbaka är en människa med en telefon (BLOCKET-PLAN.md, fas B). Ju tidigare den människan
 * får veta, desto färre godkännanden faller i tysthet.
 *
 * Vakten gör det billigaste som finns: en färsk webbläsare, Mina annonser, inget formulär. Utfallet
 * skrivs till halsa.json (blocket.ts) där `planBlocketPublish` läser det, så att Kanallistan i
 * panelen säger "sessionen har gått ut" innan någon trycker. Vid ÖVERGÅNG ok → fel mejlas
 * adminadresserna — en gång, inte var tolfte timme.
 *
 * Beroendena är injicerbara för testerna: det som ska prövas är övergångslogiken, inte Chromium.
 */

import { adminEmails } from "../../admin.js";
import { blocketConfigured, lasHalsa, skrivHalsa, type BlocketHalsa } from "./blocket.js";
import { ensureSession, startBrowser } from "./browser.js";

let upptagen = false;

/**
 * Sätts av `runBlocketPublish` runt en körning. Vakten startar ingen webbläsare bredvid en
 * publicering: två Chromium på en liten server är ett minnesproblem, och en kontroll mitt i en
 * BankID-väntan kan rotera sessionen under fötterna på roboten.
 */
export function markeraUpptagen(varde: boolean): void {
  upptagen = varde;
}

export type SessionsUtfall = Pick<BlocketHalsa, "ok" | "url" | "fel">;

/** Kontrollen själv. Samma väg som en publicering tar först, och inget mer. */
export async function kontrolleraSession(): Promise<SessionsUtfall> {
  const s = await startBrowser();
  try {
    let url: string | null = null;
    await ensureSession(s.page, (_namn, _status, details) => {
      if (details && typeof details.url === "string") url = details.url;
    });
    return { ok: true, url, fel: null };
  } catch (err) {
    return { ok: false, url: s.page.url(), fel: err instanceof Error ? err.message : String(err) };
  } finally {
    await s.browser.close().catch(() => undefined);
  }
}

export interface VaktBeroenden {
  kontroll: () => Promise<SessionsUtfall>;
  las: () => BlocketHalsa | null;
  skriv: (halsa: BlocketHalsa) => void;
  larma: (halsa: BlocketHalsa) => Promise<void>;
  nu: () => Date;
}

const standard: VaktBeroenden = {
  kontroll: kontrolleraSession,
  las: lasHalsa,
  skriv: skrivHalsa,
  larma: mejlaAdmin,
  nu: () => new Date(),
};

/**
 * Ett varv: kontrollera, skriv, larma vid övergång.
 *
 * Larmet går när sessionen just gått ut (förra beskedet var ok) och vid första kontrollen som faller
 * (inget besked fanns). Ett fel som redan är känt larmar inte igen — det är samma fel, och ett
 * mejl var tolfte timme om samma sak lär mottagaren att inte läsa dem. Null = vakten hoppade över
 * varvet för att en publicering pågår.
 */
export async function korBlocketVakt(beroenden: Partial<VaktBeroenden> = {}): Promise<BlocketHalsa | null> {
  const d = { ...standard, ...beroenden };
  if (upptagen) return null;

  const fore = d.las();
  const utfall = await d.kontroll();
  const halsa: BlocketHalsa = { kontrolleradAt: d.nu().toISOString(), ...utfall };
  d.skriv(halsa);

  if (!halsa.ok && (fore === null || fore.ok)) {
    await d.larma(halsa).catch(() => undefined);
  }
  return halsa;
}

async function mejlaAdmin(halsa: BlocketHalsa): Promise<void> {
  const { sendLetter } = await import("../../efterlysning/notify.js");
  const body = [
    `Blocket-sessionen gäller inte längre (kontrollerad ${halsa.kontrolleradAt}).`,
    halsa.fel ? `Servern sa: ${halsa.fel}` : "",
    "",
    "Inga annonser läggs ut på Blocket förrän någon loggat in på nytt. Så här (BLOCKET-PLAN.md, fas B):",
    "  1. Lokalt, i LoopaMVP: npm run blocket:logga-in  (synligt Chromium, logga in med Loopas Blocket-konto)",
    "  2. npm run blocket:prov -- <jobId> --session   ska säga \"Sessionen gäller\"",
    "  3. Packa: node -e \"console.log(require('zlib').gzipSync(require('fs').readFileSync('blocket-session.json')).toString('base64'))\"",
    "  4. Klistra in värdet som BLOCKET_STORAGE_STATE_GZIP i serverns .env och starta om tjänsten.",
    "",
    "Vakten tystnar av sig själv när den nya sessionen gäller.",
  ].join("\n");
  for (const to of adminEmails()) {
    await sendLetter({ to, subject: "Blocket-sessionen har gått ut", body, kind: "blocket" });
  }
}

/**
 * Startar vakten i serverprocessen. Av när ingen session är konfigurerad, eller när
 * BLOCKET_VAKT_MINUTER är 0. Första kontrollen två minuter efter start — inte direkt, för då
 * konkurrerar Chromium med allt annat servern gör vid uppstart.
 */
export function startBlocketVakt(): void {
  const minuter = Number(process.env.BLOCKET_VAKT_MINUTER ?? 720);
  if (!Number.isFinite(minuter) || minuter <= 0) {
    console.info("[blocket-vakt] avstängd (BLOCKET_VAKT_MINUTER=0)");
    return;
  }
  if (!blocketConfigured()) {
    console.info("[blocket-vakt] ingen Blocket-session konfigurerad — vakten är av");
    return;
  }

  const varv = async () => {
    try {
      const halsa = await korBlocketVakt();
      if (!halsa) return;
      if (halsa.ok) console.info(`[blocket-vakt] sessionen gäller (${halsa.url ?? "okänd adress"})`);
      else console.warn(`[blocket-vakt] sessionen gäller INTE — ${halsa.fel ?? "okänt fel"}`);
    } catch (err) {
      console.warn(`[blocket-vakt] kontrollen föll: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  setTimeout(() => void varv(), 2 * 60_000).unref();
  setInterval(() => void varv(), minuter * 60_000).unref();
  console.info(`[blocket-vakt] kontrollerar sessionen var ${minuter}:e minut, första gången om två minuter`);
}
