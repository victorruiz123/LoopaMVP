/**
 * Tar emot en ny Blocket-session på stdin och tar den i bruk. KÖRS PÅ SERVERN.
 *
 * Du kallar den inte själv — `npm run blocket:byt-session` på din dator gör det över SSH:
 *
 *   ssh loopa-oracle 'cd /opt/loopa/server && node_modules/.bin/tsx src/integrations/blocket/installera-session.ts' < session.json
 *
 * Tre steg:
 *   1. VÄNTA på att ingen Blocket-webbläsare kör. En publicering som pågår skriver tillbaka SIN
 *      session när den slutar (saveSessionIfReal) — och skulle då skriva över den nya med den gamla.
 *      Räknaren i vakt.ts lever i serverprocessen och syns inte härifrån, så frågan ställs till
 *      operativsystemet: kör någon Chromium ur Playwrights katalog? `--tvinga` hoppar över väntan.
 *   2. SKRIV sessionen (sessionsbyte.ts).
 *   3. PRÖVA den: samma kontroll som vakten gör, plus vilket konto den tillhör. Beskedet skrivs till halsa.json så att panelen
 *      säger "gäller" direkt. `--utan-kontroll` hoppar över steget.
 *
 * Utgångskoder: 0 bytt och gäller · 1 inte bytt · 2 bytt men kontrollen föll.
 */

import { execFileSync } from "node:child_process";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { skrivHalsa } = await import("./blocket.js");
const { installeraSession } = await import("./sessionsbyte.js");
const { ensureSession, startBrowser } = await import("./browser.js");
const { kontoText, lasKonto } = await import("./inloggning.js");

/** Samma kontroll som vakten (vakt.ts) — och dessutom vilket konto sessionen tillhör. */
async function provaOchLasKonto() {
  const s = await startBrowser();
  try {
    await ensureSession(s.page, () => undefined);
    const konto = await lasKonto(s.page);
    return { ok: true, url: s.page.url(), fel: null, konto };
  } catch (err) {
    return { ok: false, url: s.page.url(), fel: err instanceof Error ? err.message : String(err), konto: null };
  } finally {
    await s.browser.close().catch(() => undefined);
  }
}

const tvinga = process.argv.includes("--tvinga");
const utanKontroll = process.argv.includes("--utan-kontroll");

/** Hur länge vi väntar på en pågående körning innan vi ger upp. */
const MAX_VANTAN_MS = Number(process.env.BLOCKET_BYTE_VANTA_MS ?? 10 * 60 * 1000);

function webblasareKor(): boolean {
  try {
    // Mönstret matchar Chromium-binären (…/ms-playwright/chromium-1234/…, chromium_headless_shell-…),
    // inte skalet som startade oss — det har bara "…/ms-playwright" utan snedstreck efter.
    execFileSync("pgrep", ["-f", "ms-playwright/chrom"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // pgrep svarar 1 när inget matchar (och saknas den kan vi inte veta mer).
  }
}

async function lasStdin(): Promise<string> {
  const delar: Buffer[] = [];
  for await (const del of process.stdin) delar.push(del as Buffer);
  return Buffer.concat(delar).toString("utf8");
}

const text = (await lasStdin()).trim();
if (!text) {
  console.error("  ✗ Ingen session kom in på stdin.");
  process.exit(1);
}

if (!tvinga && webblasareKor()) {
  console.log("  … en Blocket-körning pågår på servern, väntar på att den blir klar");
  const slut = Date.now() + MAX_VANTAN_MS;
  while (webblasareKor()) {
    if (Date.now() > slut) {
      console.error(`  ✗ Körningen var inte klar efter ${Math.round(MAX_VANTAN_MS / 60000)} minuter. Sessionen byttes INTE.`);
      console.error("    Försök igen om en stund, eller kör med --tvinga.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

let fil: string;
try {
  fil = installeraSession(text);
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : String(err)} Sessionen byttes INTE.`);
  process.exit(1);
}
console.log(`  ✓ Ny session sparad på servern (${fil})`);

if (utanKontroll) process.exit(0);

console.log("  … prövar den mot Blocket");
const utfall = await provaOchLasKonto();
skrivHalsa({ kontrolleradAt: new Date().toISOString(), ok: utfall.ok, url: utfall.url, fel: utfall.fel });
if (utfall.ok) {
  console.log(`  ✓ Sessionen gäller. Servern är inloggad som: ${kontoText(utfall.konto)}`);
  console.log("    Roboten använder den från nästa körning — ingen omstart behövs.");
  process.exit(0);
}
console.error(`  ✗ Sessionen sparades, men gäller inte: ${utfall.fel ?? "okänt fel"} (${utfall.url ?? "ingen adress"})`);
process.exit(2);
