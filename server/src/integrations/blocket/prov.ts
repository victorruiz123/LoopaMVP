/**
 * Provkörning av Blocket-publiceringen, från terminalen.
 *
 *   npm run blocket:prov -- <jobId>
 *
 * Finns för att den skarpa vägen inte går att prova genom gränssnittet utan att först vara inloggad
 * som jobbets ägare — och för att en publicering som tar minuter behöver en plats där man ser varje
 * steg medan det händer, inte bara resultatet efteråt.
 *
 * Kör som TORRKÖRNING om inte BLOCKET_PUBLICERA=1 är satt: formuläret fylls i, frakt- och paketsidan
 * gås igenom, och sista knappen trycks aldrig. OBS att även en torrkörning lämnar ett UTKAST hos
 * Blocket — det är priset för att de två sidorna efter formuläret ska bli provade.
 *
 * Samma kod som servern kör. Skriptet gör ingenting eget: det laddar miljön, säger vad som kommer att
 * hända, och anropar `runBlocketPublish`.
 */

import { existsSync } from "node:fs";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { getJob } = await import("../../jobStore.js");
const { planBlocketPublish, runBlocketPublish } = await import("./publish.js");
const { blocketBaseUrl, blocketConfigured, blocketHeadful, blocketLivePublishing, blocketPostalCode, missingBlocketEnv, sessionFile } =
  await import("./blocket.js");

const jobId = process.argv[2]?.trim();
if (!jobId) {
  console.error("\n  Användning: npm run blocket:prov -- <jobId>\n");
  process.exit(1);
}

const job = await getJob(jobId);
if (!job) {
  console.error(`\n  ✗ Hittade inget jobb med id ${jobId}.\n`);
  process.exit(1);
}

console.log("\nBlocket-provkörning\n");

const saknas = missingBlocketEnv();
if (saknas.length) {
  console.error(`  ✗ Blocket är inte konfigurerat. Saknar: ${saknas.join(", ")}`);
  console.error("    Sätt dem i server/.env — se server/.env.example.\n");
  process.exit(1);
}

const session = sessionFile()!;
if (!existsSync(session)) {
  console.error(`  ✗ Sessionsfilen finns inte: ${session}`);
  console.error("    Blocket har passwordless inloggning — logga in för hand och exportera om filen.\n");
  process.exit(1);
}

/**
 * `--session` provar BARA att sessionen fortfarande gäller.
 *
 * Läser en enda sida — /mina-annonser — och rör inget formulär. Skild från den vanliga körningen för
 * att sessionen är det som går sönder oftast och som är billigast att kontrollera: den åldras av sig
 * själv, och BankID roterar den varje gång någon legitimerar sig.
 */
if (process.argv.includes("--session")) {
  const { startBrowser, ensureSession } = await import("./browser.js");
  const s = await startBrowser();
  try {
    await ensureSession(s.page, (namn, status) => console.log(`  [${status}] ${namn}`));
    console.log("\n  ✓ Sessionen gäller. Du kan köra en torrkörning.\n");
  } catch (err) {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await s.browser.close().catch(() => null);
  }
  process.exit(process.exitCode ?? 0);
}

const readiness = await planBlocketPublish(job);
if (!readiness.ok) {
  console.error(`  ✗ Annonsen går inte att publicera: ${readiness.reason}\n`);
  process.exit(1);
}
const { plan } = readiness;

const skarpt = blocketLivePublishing();
console.log(`  Läge         ${skarpt ? "SKARPT — annonsen blir publik" : "TORRKÖRNING — sista knappen trycks inte"}`);
console.log(`  Mot          ${blocketBaseUrl()}`);
console.log(`  Webbläsare   ${blocketHeadful() ? "synlig" : "osynlig (BankID går inte att svara på)"}`);
console.log(`  Session      ${session}`);
console.log("");
console.log(`  Rubrik       ${plan.title}`);
console.log(`  Pris         ${plan.price} kr  (${plan.itemPrice} kr möbel + ${plan.shippingSek} kr hemleverans)`);
console.log(`  Kategori     ${[plan.category.main, plan.category.sub, plan.category.product].filter(Boolean).join(" > ")}`);
console.log(`  Skick        ${plan.condition ?? "(inget betyg)"}`);
console.log(`  Mått         ${[plan.measurements.height, plan.measurements.width, plan.measurements.depth].map((v) => v ?? "–").join(" / ")} cm (H/B/D)`);
console.log(`  Bilder       ${plan.imageCount}`);
console.log(`  Postnummer   ${blocketPostalCode()}`);
console.log("");

// `--plan` stannar här: ingen webbläsare, ingen sida besökt, ingenting skrivet. Vägen att kontrollera
// att konfigurationen och annonsen ser rätt ut innan något alls händer hos Blocket.
if (process.argv.includes("--plan")) {
  console.log("  --plan angivet: stannar här. Ingen webbläsare startades och inget skrevs.\n");
  process.exit(0);
}

if (skarpt) {
  // Fem sekunder att hinna ångra sig. En publicerad Blocket-annons går inte att ta ner automatiskt,
  // och det finns ingen väg tillbaka som inte är en människa som loggar in och raderar den.
  console.log("  ⚠ SKARPT LÄGE. Annonsen läggs upp publikt på kontot i sessionsfilen.");
  console.log("    Avbryt med Ctrl+C inom fem sekunder om det inte var meningen.\n");
  await new Promise((klar) => setTimeout(klar, 5000));
}

console.log("  Kör … (varje steg loggas nedan)\n");
await runBlocketPublish(jobId);

const efter = await getJob(jobId);
const resultat = efter?.blocket;
console.log("\n  ── Resultat ─────────────────────────────────────────────");
console.log(`  Status       ${resultat?.status ?? "(inget skrevs)"}`);
if (resultat?.url) console.log(`  Annons       ${resultat.url}`);
if (resultat?.receiptUrl) console.log(`  Slutade på   ${resultat.receiptUrl}`);
if (resultat?.error) console.log(`  Fel          ${resultat.error}`);
console.log(`  Steg         ${resultat?.steps.length ?? 0} (sparade på jobbet)`);
const varningar = (resultat?.steps ?? []).filter((s) => s.status === "warning" || s.status === "error");
if (varningar.length) {
  console.log("\n  Värt att titta på:");
  for (const steg of varningar) console.log(`   • [${steg.status}] ${steg.name}`);
}
console.log("");
