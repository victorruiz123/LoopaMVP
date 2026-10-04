/**
 * Provkörning av Blockets prisändring, från terminalen.
 *
 *   npm run blocket:pris -- <jobId>                        torrkörning på jobbets Blocket-annons: öppnar, vaktar rubriken, fyller i, sparar INTE
 *   npm run blocket:pris -- <jobId> --skarpt               sparar
 *   npm run blocket:pris -- --annons <url> --pris <kr>     torrkörning på VILKEN annons som helst på kontot (rubriken läses från Blocket)
 *   npm run blocket:pris -- --annons <url> --pris <kr> --skarpt
 *
 * Finns av samma skäl som prov.ts: det ska gå att se roboten göra exakt det driften gör, steg för
 * steg, med BLOCKET_SYNLIG=1 och en människa som tittar. Jobbläget räknar priset som stegen skulle:
 * möbeln plus hemleveransen. Annonsläget tar priset rakt av — det är för att prova mot en annons
 * som inte har något jobb, t.ex. en egen testannons.
 *
 * Samma kod som servern kör (driveBlocketPriceChange). Skriptet skriver inget kvitto på något jobb:
 * efter en skarp körning i jobbläget ska "Ändrat för hand" tryckas i panelen, eller så låter man
 * stegen bekräfta kanalen själv vid nästa varv.
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { getJob } = await import("../../jobStore.js");
const { annonsensFrakt, prisMedHemleverans } = await import("../../hemleverans.js");
const { kategoriMedRattelse } = await import("../../butik/overrides.js");
const { kanalPrisLagen } = await import("../../priceLadder.js");
const { adTitle } = await import("../../adContent.js");
const { capTitle } = await import("./mapping.js");
const { blocketBaseUrl, blocketHeadful, missingBlocketEnv, sessionFileExists } = await import("./blocket.js");
const { ensureSession, goAndSettle, handleBankID, startBrowser } = await import("./browser.js");
const { adIdFromUrl, blocketPrisRobotPa, driveBlocketPriceChange } = await import("./pris.js");

const args = process.argv.slice(2);
const flagga = (namn: string): string | null => {
  const i = args.indexOf(namn);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const skarpt = args.includes("--skarpt");
const annonsUrl = flagga("--annons");
const prisFlagga = flagga("--pris");
const jobId = args.find((a) => !a.startsWith("--") && a !== annonsUrl && a !== prisFlagga)?.trim();

function anvandning(): never {
  console.error("\n  Användning:");
  console.error("    npm run blocket:pris -- <jobId> [--skarpt]");
  console.error("    npm run blocket:pris -- --annons <url> --pris <kr> [--skarpt]\n");
  process.exit(1);
}

if (!jobId && !(annonsUrl && prisFlagga)) anvandning();

console.log("\nBlocket-prisändring, provkörning\n");

const saknas = missingBlocketEnv();
if (saknas.length) {
  console.error(`  ✗ Blocket är inte konfigurerat. Saknar: ${saknas.join(", ")}\n`);
  process.exit(1);
}
if (!sessionFileExists()) {
  console.error("  ✗ Sessionsfilen finns inte. Logga in för hand (npm run blocket:logga-in) och försök igen.\n");
  process.exit(1);
}

// ---------- Vad som ska ändras, och till vad ----------
let adUrl: string;
let rubrik: string | null = null;
let annonspris: number;
let forklaring: string;

if (annonsUrl) {
  if (!adIdFromUrl(annonsUrl)) {
    console.error(`  ✗ Hittar inget annons-id i ${annonsUrl}. Ange annonsens adress, t.ex. https://www.blocket.se/21946768.\n`);
    process.exit(1);
  }
  annonspris = Math.round(Number(prisFlagga));
  if (!Number.isFinite(annonspris) || annonspris < 1) {
    console.error(`  ✗ --pris ska vara ett belopp i kronor, inte "${prisFlagga}".\n`);
    process.exit(1);
  }
  adUrl = annonsUrl;
  forklaring = "annonsläge — priset tas rakt av, rubriken läses från Blocket";
} else {
  const job = await getJob(jobId!);
  if (!job) {
    console.error(`\n  ✗ Hittade inget jobb med id ${jobId}.\n`);
    process.exit(1);
  }
  if (!job.blocket || job.blocket.status !== "published" || !job.blocket.url) {
    console.error("  ✗ Jobbet har ingen publicerad Blocket-annons med adress — det finns inget att ändra priset på.\n");
    process.exit(1);
  }
  if (!job.priceLadder) {
    console.error("  ✗ Jobbet har ingen prissteg, så det finns inget pris att flytta till.\n");
    process.exit(1);
  }
  const frakt = annonsensFrakt(job, await kategoriMedRattelse(job));
  annonspris = prisMedHemleverans(job.priceLadder.currentPrice, frakt);
  adUrl = job.blocket.url;
  rubrik = capTitle(adTitle(job));
  const lage = kanalPrisLagen(job).find((l) => l.kanal === "blocket");
  console.log(`  Jobb:         ${job.id}`);
  console.log(`  Ligger på:    ${lage ? prisMedHemleverans(lage.bekraftat, frakt) : "?"} kr enligt kvittot (${lage?.via ?? "inget kvitto"})`);
  forklaring = `jobbläge — möbeln ${job.priceLadder.currentPrice} kr + ${frakt} kr hemleverans`;
}

console.log(`  Annons:       ${adUrl}`);
console.log(`  Ska ligga på: ${annonspris} kr (${forklaring})`);
console.log(`  Mot:          ${blocketBaseUrl()}`);
console.log(`  Läge:         ${skarpt ? "SKARPT — sparar" : "torrkörning — sparar inte"}${blocketHeadful() ? ", synlig webbläsare" : ", headless"}`);
console.log(`  Driftens robot: ${blocketPrisRobotPa() ? "PÅ" : "AV (BLOCKET_PRIS_ROBOT=1 slår på den)"}\n`);

const s = await startBrowser();
try {
  const logga = (name: string, status: string, details?: Record<string, unknown>) => {
    const extra = details && Object.keys(details).length ? `  ${JSON.stringify(details)}` : "";
    console.log(`  [${status}] ${name}${extra}`);
  };
  await ensureSession(s.page, logga);
  await handleBankID(s.page, s.context, logga);

  // Annonsläget: rubriken läses från ägarsidan, så att rubrikvakten i roboten har något att vakta mot.
  if (!rubrik) {
    await goAndSettle(s.page, `${blocketBaseUrl()}/my-items/details/${adIdFromUrl(adUrl)}`);
    rubrik = (await s.page.locator("main h2").first().textContent({ timeout: 5000 }).catch(() => null))?.trim() ?? null;
    if (!rubrik) {
      console.error("\n  ✗ Kunde inte läsa annonsens rubrik från Mina annonser — ligger annonsen på det här kontot?\n");
      process.exitCode = 1;
      throw new Error("ingen rubrik");
    }
    logga(`Rubrik från Mina annonser: "${rubrik}"`, "ok", {});
  } else {
    console.log(`  Rubrik:       ${rubrik}`);
  }

  const r = await driveBlocketPriceChange(s.page, s.context, { adUrl, title: rubrik, price: annonspris, dryRun: !skarpt }, logga);
  console.log(
    `\n  ✓ ${r.status === "andrad" ? "Priset ändrat" : "Torrkörning klar"}` +
      `${r.verifierad === null ? "" : r.verifierad ? ` — ${annonspris} kr står på ägarsidan` : " — syntes INTE på ägarsidan än"}` +
      `${r.lage ? ` (annonsen är ${r.lage.toLowerCase()})` : ""}\n`,
  );
  if (r.status === "andrad") {
    console.log("  Den publika annonssidan svarar 404 i några minuter efter varje ändring — ägarsidan under");
    console.log("  Mina annonser visar det nya priset direkt. Kvittot på ett jobb skrivs inte av provet: tryck");
    console.log("  \"Ändrat för hand\" i panelen, eller låt stegen bekräfta kanalen vid nästa varv.\n");
  }
} catch (err) {
  if (!(err instanceof Error && err.message === "ingen rubrik")) {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} finally {
  await s.browser.close().catch(() => undefined);
}
