/**
 * Byter Blocket-sessionen på servern. Körs på DIN dator:
 *
 *   npm run blocket:byt-session
 *
 * 1. Öppnar Blocket i Chrome med en TOM profil — det nuvarande kontot följer aldrig med.
 * 2. Du loggar in: mejladressen väljer konto, och BankID bekräftar när Blocket ber om det.
 * 3. Kontot läses av och visas. Du bekräftar att det är rätt konto.
 * 4. Sessionen skickas till servern över SSH, där installera-session.ts sparar den, prövar den och
 *    säger vilket konto servern nu är inloggad på.
 * Ingen .env att redigera, ingen omstart.
 *
 * Varför SSH och inte en knapp i panelen: sessionen ÄR inloggningen på Blocket-kontot. Över SSH går
 * den med samma nyckel som allt annat underhåll, och servern får ingen ny ingång som tar emot den.
 *
 * Val:
 *   --fran-fil <sökväg>  hoppa över inloggningen och skicka en session som redan finns
 *                        (den som sparades när ett tidigare försök inte nådde servern)
 *   --ja                 fråga inte om kontot är rätt (för körningar utan terminal)
 *   --tvinga             vänta inte på en pågående Blocket-körning på servern
 *   --utan-kontroll      pröva inte sessionen på servern efteråt
 *
 * Miljö (förval inom parentes):
 *   BLOCKET_SSH_VARD        SSH-värden (loopa-oracle, se ~/.ssh/config)
 *   BLOCKET_SERVER_KATALOG  serverns server/-katalog (/opt/loopa/server)
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { blocketBaseUrl, isRealBlocket } = await import("./blocket.js");
const { kontoText, loggaInIWebblasare } = await import("./inloggning.js");
const { felISession } = await import("./sessionsbyte.js");

const VARD = process.env.BLOCKET_SSH_VARD?.trim() || "loopa-oracle";
const KATALOG = process.env.BLOCKET_SERVER_KATALOG?.trim() || "/opt/loopa/server";
/** Hit sparas sessionen om den inte når servern, så att inloggningen inte behöver göras om. gitignorerad. */
const RESERV = path.resolve(import.meta.dirname, "../../../blocket-session.json");

const argv = process.argv.slice(2);
const franFil = argv.includes("--fran-fil") ? argv[argv.indexOf("--fran-fil") + 1] : null;
const utanFraga = argv.includes("--ja");
const vidare = argv.filter((a) => a === "--tvinga" || a === "--utan-kontroll");

async function fraga(text: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("  ✗ Ingen terminal att fråga i. Kör med --ja om kontot redan är bekräftat.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(j|ja|y|yes)$/i.test((await rl.question(text)).trim());
  } finally {
    rl.close();
  }
}

console.log("\nByt Blocket-session på servern\n");
console.log(`  Server   ${VARD}:${KATALOG}`);

let session: string;
if (franFil) {
  session = readFileSync(path.resolve(franFil), "utf8");
  console.log(`  Session  ${franFil}\n`);
} else {
  if (!isRealBlocket()) {
    console.error(`\n  ✗ BLOCKET_BAS_URL pekar på ${blocketBaseUrl()}, inte blocket.se. En session därifrån är värdelös.\n`);
    process.exit(1);
  }
  console.log("");
  const inloggning = await loggaInIWebblasare();
  if (!inloggning) {
    console.error("  Ingenting skickades till servern.\n");
    process.exit(1);
  }
  session = inloggning.session;
  console.log(`\n  ✓ Inloggad som: ${kontoText(inloggning.konto)}\n`);
  if (!utanFraga && !(await fraga("  Är det rätt konto, och ska servern använda det från och med nu? (j/N) "))) {
    console.error("\n  Avbrutet. Ingenting skickades — servern har kvar sin nuvarande session.\n");
    process.exit(1);
  }
}

const fel = felISession(session);
if (fel) {
  console.error(`  ✗ ${fel} Ingenting skickades.\n`);
  process.exit(1);
}

console.log(`\n  … skickar till ${VARD}`);
const kommando = [
  `cd ${KATALOG}`,
  // Samma webbläsarkatalog som tjänsten (deploy/oracle/loopa-server.service) — annars hittar
  // kontrollen ingen Chromium.
  `PLAYWRIGHT_BROWSERS_PATH=/opt/loopa/ms-playwright node_modules/.bin/tsx src/integrations/blocket/installera-session.ts ${vidare.join(" ")}`,
].join(" && ");

const kod = await new Promise<number>((resolve) => {
  const ssh = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", VARD, kommando], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  ssh.on("error", () => resolve(255));
  ssh.on("close", (c) => resolve(c ?? 255));
  ssh.stdin.on("error", () => undefined);
  ssh.stdin.end(session);
});

if (kod === 0) {
  console.log("\n  ✓ Klart. Blocket-sessionen på servern är bytt.\n");
  process.exit(0);
}
if (kod === 2) {
  console.error("\n  ✗ Sessionen kom fram men Blocket godtog den inte. Kör kommandot igen och logga in på nytt.\n");
  process.exit(2);
}

// Nådde inte fram, eller servern vägrade. Spara inloggningen så att den inte behöver göras om.
if (!franFil) {
  writeFileSync(RESERV, session, { encoding: "utf8", mode: 0o600 });
  console.error(`\n  ✗ Sessionen byttes inte på servern (kod ${kod}). Den sparades lokalt i ${RESERV}.`);
  console.error("    Försök igen utan att logga in: npm run blocket:byt-session -- --fran-fil server/blocket-session.json\n");
} else {
  console.error(`\n  ✗ Sessionen byttes inte på servern (kod ${kod}).\n`);
}
process.exit(1);
