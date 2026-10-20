/**
 * Provkörning av Blockets borttagning — det första halvsteget i veckans omläggning — från terminalen.
 *
 *   npm run blocket:ta-bort -- <jobId>                          torrkörning: hittar kortet och "Ta bort", klickar INTE
 *   npm run blocket:ta-bort -- <jobId> --skarpt                 tar bort annonsen (den läggs INTE upp igen av provet)
 *   npm run blocket:ta-bort -- --annons <url> [--rubrik <r>] [--skarpt]
 *
 * Samma kod som servern kör (driveBlocketBorttagning). Torrkörningen är det som ska göras på riktiga
 * Blocket innan BLOCKET_TA_BORT_ROBOT=1 sätts: den säger om valet hittas, och var. Den skarpa körningen
 * skriver ingenting på jobbet — lägg upp annonsen igen från panelen efteråt, eller låt bli att köra den
 * på en riktig Loopa-annons.
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { getJob } = await import("../../jobStore.js");
const { adTitle } = await import("../../adContent.js");
const { capTitle } = await import("./mapping.js");
const { blocketBaseUrl, blocketHeadful, missingBlocketEnv, sessionFileExists } = await import("./blocket.js");
const { ensureSession, goAndSettle, handleBankID, startBrowser } = await import("./browser.js");
const { adIdFromUrl } = await import("./pris.js");
const { blocketOmlaggningKlar, driveBlocketBorttagning } = await import("./borttagning.js");

const args = process.argv.slice(2);
const flagga = (namn: string): string | null => {
  const i = args.indexOf(namn);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const skarpt = args.includes("--skarpt");
const annonsUrl = flagga("--annons");
const rubrikFlagga = flagga("--rubrik");
const jobId = args.find((a) => !a.startsWith("--") && a !== annonsUrl && a !== rubrikFlagga)?.trim();

if (!jobId && !annonsUrl) {
  console.error("\n  Användning:");
  console.error("    npm run blocket:ta-bort -- <jobId> [--skarpt]");
  console.error("    npm run blocket:ta-bort -- --annons <url> [--rubrik <rubrik>] [--skarpt]\n");
  process.exit(1);
}

console.log("\nBlocket-borttagning, provkörning\n");
const saknas = missingBlocketEnv();
if (saknas.length) {
  console.error(`  ✗ Blocket är inte konfigurerat. Saknar: ${saknas.join(", ")}\n`);
  process.exit(1);
}
if (!sessionFileExists()) {
  console.error("  ✗ Sessionsfilen finns inte. Logga in för hand (npm run blocket:logga-in) och försök igen.\n");
  process.exit(1);
}

let adUrl: string;
let rubrik: string | null = rubrikFlagga;
if (annonsUrl) {
  if (!adIdFromUrl(annonsUrl)) {
    console.error(`  ✗ Hittar inget annons-id i ${annonsUrl}.\n`);
    process.exit(1);
  }
  adUrl = annonsUrl;
} else {
  const job = await getJob(jobId!);
  if (!job?.blocket || job.blocket.status !== "published" || !job.blocket.url) {
    console.error("  ✗ Jobbet har ingen publicerad Blocket-annons med adress.\n");
    process.exit(1);
  }
  adUrl = job.blocket.url;
  rubrik = capTitle(adTitle(job));
  console.log(`  Jobb:         ${job.id}`);
}

console.log(`  Annons:       ${adUrl}`);
console.log(`  Mot:          ${blocketBaseUrl()}`);
console.log(`  Läge:         ${skarpt ? "SKARPT — TAR BORT ANNONSEN" : "torrkörning — klickar inte"}${blocketHeadful() ? ", synlig webbläsare" : ", headless"}`);
console.log(`  Driftens omläggning: ${blocketOmlaggningKlar() ? "PÅ" : "AV (BLOCKET_TA_BORT_ROBOT=1 + BLOCKET_PUBLICERA=1 slår på den)"}\n`);

const s = await startBrowser();
try {
  const logga = (name: string, status: string, details?: Record<string, unknown>) => {
    const extra = details && Object.keys(details).length ? `  ${JSON.stringify(details)}` : "";
    console.log(`  [${status}] ${name}${extra}`);
  };
  await ensureSession(s.page, logga);
  await handleBankID(s.page, s.context, logga);

  if (!rubrik) {
    await goAndSettle(s.page, `${blocketBaseUrl()}/my-items/details/${adIdFromUrl(adUrl)}`);
    rubrik = (await s.page.locator("main h2").first().textContent({ timeout: 5000 }).catch(() => null))?.trim() ?? null;
    if (rubrik) logga(`Rubrik från ägarsidan: "${rubrik}"`, "ok", {});
    else if (skarpt) throw new Error("Kunde inte läsa rubriken — ange den med --rubrik för en skarp körning.");
  } else {
    console.log(`  Rubrik:       ${rubrik}`);
  }

  if (skarpt) {
    console.log("\n  Tar bort annonsen om fem sekunder. Ctrl-C avbryter.\n");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const r = await driveBlocketBorttagning(s.page, { adUrl, title: rubrik, dryRun: !skarpt }, logga);
  const besked = {
    torrkorning: `Torrkörning klar — valet hittades (${r.vag}). Ingenting klickat.`,
    borttagen: `Annonsen togs bort (${r.vag}) och står inte längre bland de aktiva.`,
    "redan-borta": "Annonsen stod inte bland de aktiva — inget att ta bort.",
  }[r.status];
  console.log(`\n  ✓ ${besked}\n`);
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await s.browser.close().catch(() => undefined);
}
