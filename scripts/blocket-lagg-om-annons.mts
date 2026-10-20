/**
 * Lägger om en Blocket-annons UTAN Loopa-jobb: tar ner den och lägger upp den igen med ett sänkt pris.
 * Samma två robotar som veckans omläggning kör (borttagning.ts, publish.ts driveBlocketForm), med
 * innehållet läst av med scripts/blocket-las-annons.mts i stället för ur ett jobb.
 *
 *   tsx scripts/blocket-lagg-om-annons.mts <annons-id> --pris <kr> --torr     torrkör borttagningen, rör inget
 *   tsx scripts/blocket-lagg-om-annons.mts <annons-id> --pris <kr> --skarpt   tar ner och lägger upp igen
 *   tsx scripts/blocket-lagg-om-annons.mts <annons-id> --pris <kr> --bara-upp lägger bara upp (den gamla är redan borta)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SERVER = new URL("../server", import.meta.url).pathname;
try {
  process.loadEnvFile(`${SERVER}/.env`);
} catch {}
const args = process.argv.slice(2);
const id = args[0];
const prisIdx = args.indexOf("--pris");
const pris = Math.round(Number(args[prisIdx + 1]));
const baraUpp = args.includes("--bara-upp");
const skarpt = args.includes("--skarpt") || baraUpp;
if (!id || prisIdx < 0 || !Number.isFinite(pris) || pris < 1 || (skarpt === args.includes("--torr") && !baraUpp)) {
  console.error("\n  Användning: tsx scripts/blocket-lagg-om-annons.mts <annons-id> --pris <kr> (--torr | --skarpt)\n");
  process.exit(1);
}
const KATALOG = path.join(SERVER, "data", "blocket-annonser", id);
const annons = JSON.parse(readFileSync(path.join(KATALOG, "annons.json"), "utf-8"));
const falt = (etikett: string): string => {
  const f = annons.falt.find((x: { etikett: string }) => x.etikett === etikett);
  return (f?.valt ?? f?.varde ?? "").trim();
};
const tal = (etikett: string): number | undefined => (Number(falt(etikett)) > 0 ? Number(falt(etikett)) : undefined);
const bilder = readdirSync(KATALOG)
  .filter((f) => /^bild-\d+\.(jpg|png)$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  .map((f) => path.join(KATALOG, f));

const skickBlocket = falt("Skick");
const plan = {
  title: annons.rubrik as string,
  loopaId: "",
  category: { main: falt("Huvudkategori"), sub: falt("Underkategori") || null, product: falt("Produktkategori") || null },
  price: pris,
  priceSource: "seller" as const,
  // Formulärrobotens lista översätter "Bra skick" till Blockets "Bra skick - varsamt använd".
  condition: skickBlocket.split(" - ")[0] || null,
  measurements: { height: tal("Höjd"), width: tal("Bredd"), depth: tal("Djup") },
  brand: falt("Varumärke") || null,
  postalCode: falt("Postnummer"),
  imageCount: bilder.length,
  dryRun: false,
};
const beskrivning = falt("Beskrivning");

const { blocketBaseUrl, missingBlocketEnv, sessionFileExists } = await import(`${SERVER}/src/integrations/blocket/blocket.ts`);
const { ensureSession, handleBankID, saveSessionIfReal, startBrowser } = await import(`${SERVER}/src/integrations/blocket/browser.ts`);
const { driveBlocketBorttagning } = await import(`${SERVER}/src/integrations/blocket/borttagning.ts`);
const { driveBlocketForm, publiceraForberedd } = await import(`${SERVER}/src/integrations/blocket/publish.ts`);
if (missingBlocketEnv().length || !sessionFileExists()) {
  console.error("  ✗ Ingen Blocket-session (BLOCKET_SESSION).");
  process.exit(1);
}

console.log(`\nOmläggning av Blocket-annons ${id} — ${skarpt ? "SKARPT" : "torrkörning av borttagningen"}\n`);
console.log(`  Rubrik:      ${plan.title}`);
console.log(`  Ligger på:   ${falt("Pris")} kr  →  läggs upp för ${pris} kr`);
console.log(`  Kategori:    ${[plan.category.main, plan.category.sub, plan.category.product].filter(Boolean).join(" › ")}`);
console.log(`  Skick:       ${skickBlocket}   Mått: ${JSON.stringify(plan.measurements)}   Märke: ${plan.brand}   Postnr: ${plan.postalCode}`);
console.log(`  Bilder:      ${bilder.length}   Beskrivning: ${beskrivning.length} tecken\n`);
if (!plan.title || !plan.category.main || !plan.postalCode || !beskrivning || bilder.length === 0) {
  console.error("  ✗ Avläsningen saknar något som behövs för att lägga upp annonsen igen — ingenting rört.\n");
  process.exit(1);
}

const logga = (n: string, s: string, d?: Record<string, unknown>) => console.log(`  [${s}] ${n}${d && Object.keys(d).length ? "  " + JSON.stringify(d) : ""}`);
const s = await startBrowser();
const logg: Record<string, unknown> = { id, pris, start: new Date().toISOString() };
try {
  await ensureSession(s.page, logga);
  await handleBankID(s.page, s.context, logga);
  const adUrl = `${blocketBaseUrl()}/${id}`;

  // Alltid först: torrkörningen. Hittar den inte valet rörs ingenting. Med --bara-upp ska den gamla
  // annonsen redan vara borta, och det kontrolleras i stället.
  const torr = await driveBlocketBorttagning(s.page, { adUrl, title: plan.title, dryRun: true }, logga);
  if (baraUpp) {
    if (torr.status !== "redan-borta") throw new Error("Den gamla annonsen står fortfarande bland de aktiva — --bara-upp hade gett två annonser. Avbryter.");
    const r = await driveBlocketForm(s.page, s.context, { plan, description: beskrivning, files: bilder }, logga);
    logg.upplagd = { ...r, at: new Date().toISOString() };
    if (await saveSessionIfReal(s.context).catch(() => false)) logga("Sessionen sparades om", "ok");
    console.log(`\n  ✓ Upplagd igen: ${r.status} — ${r.url ?? r.receiptUrl}\n`);
  } else if (torr.status !== "torrkorning") {
    throw new Error(`Torrkörningen gav "${torr.status}" — avbryter.`);
  } else if (!skarpt) {
    console.log(`\n  ✓ Torrkörning klar — "Ta bort" hittades (${torr.vag}). Ingenting klickat.\n`);
  } else {
    // FÖRBERED FÖRST, som veckans omläggning: den nya annonsen fylls i hela vägen till sista knappen
    // (BankID, frakt, paket, alla bilder räknade) medan den gamla ligger kvar. Går det inte rörs ingenting.
    console.log(`\n  Förbereder den nya annonsen för ${pris} kr — den gamla ligger kvar …\n`);
    const forberedd = await driveBlocketForm(s.page, s.context, { plan: { ...plan, dryRun: true }, description: beskrivning, files: bilder }, logga);
    logg.forberedd = { paketUrl: forberedd.receiptUrl, at: new Date().toISOString() };

    console.log("\n  Förberedd. Tar bort den gamla annonsen om fem sekunder. Ctrl-C avbryter.\n");
    await new Promise((r) => setTimeout(r, 5000));
    const bort = await driveBlocketBorttagning(s.page, { adUrl, title: plan.title, dryRun: false }, logga);
    logg.borttagen = { status: bort.status, vag: bort.vag, at: new Date().toISOString() };
    console.log(`\n  ✓ Gamla annonsen: ${bort.status} (${bort.vag ?? "—"}). Publicerar den förberedda …\n`);

    const r = await publiceraForberedd(s.page, s.context, forberedd.receiptUrl, logga);
    logg.upplagd = { ...r, at: new Date().toISOString() };
    if (await saveSessionIfReal(s.context).catch(() => false)) logga("Sessionen sparades om", "ok");
    console.log(`\n  ✓ Upplagd igen: ${r.status} — ${r.url ?? r.receiptUrl}\n`);
  }
} catch (err) {
  logg.fel = err instanceof Error ? err.message : String(err);
  console.error(`\n  ✗ ${logg.fel}\n`);
  await s.page.screenshot({ path: path.join(KATALOG, "omlaggning-fel.png"), fullPage: true }).catch(() => null);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(KATALOG, `omlaggning-${Date.now()}.json`), JSON.stringify(logg, null, 2));
  await s.browser.close();
}
