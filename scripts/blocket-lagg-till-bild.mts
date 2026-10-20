/**
 * Lägger till en bild på en Blocket-annons som redan ligger uppe, och mäter hur uppladdaren visar den.
 *
 *   tsx scripts/blocket-lagg-till-bild.mts <annons-id> <bildfil> --rubrik "<rubrik>" [--skarpt]
 *
 * Öppnar redigeringsformuläret /recommerce/create/<id>, vaktar rubriken, räknar förhandsbilderna, laddar
 * upp filen och loggar varje sekund vad uppladdaren visar. Sparar (bara med --skarpt) först när en bild
 * till syns. Utan --skarpt sparas ingenting.
 */
const SERVER = new URL("../server", import.meta.url).pathname;
try {
  process.loadEnvFile(`${SERVER}/.env`);
} catch {}
const args = process.argv.slice(2);
const [id, fil] = args;
const rubrikIdx = args.indexOf("--rubrik");
const rubrik = rubrikIdx >= 0 ? args[rubrikIdx + 1] : null;
const skarpt = args.includes("--skarpt");
if (!id || !fil || !rubrik) {
  console.error('\n  Användning: tsx scripts/blocket-lagg-till-bild.mts <annons-id> <bildfil> --rubrik "<rubrik>" [--skarpt]\n');
  process.exit(1);
}

const { blocketBaseUrl } = await import(`${SERVER}/src/integrations/blocket/blocket.ts`);
const { ensureSession, goAndSettle, saveSessionIfReal, startBrowser } = await import(`${SERVER}/src/integrations/blocket/browser.ts`);
const { clickFirstVisible, dismissCookieBanner, dismissModal } = await import(`${SERVER}/src/integrations/blocket/form.ts`);
const { lasRubrik, redigeringsformularet, rubrikStammer } = await import(`${SERVER}/src/integrations/blocket/pris.ts`);
const { forhandsbilder } = await import(`${SERVER}/src/integrations/blocket/publish.ts`);

const s = await startBrowser();
const page = s.page;
try {
  await ensureSession(page, () => undefined);
  await goAndSettle(page, `${blocketBaseUrl()}/recommerce/create/${id}`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (!(await redigeringsformularet(page))) throw new Error(`Inget redigeringsformulär på ${page.url()}`);
  await page.waitForTimeout(2500);
  const iFormularet = await lasRubrik(page);
  if (!rubrikStammer(iFormularet, rubrik)) throw new Error(`Formuläret visar "${iFormularet}", inte "${rubrik}" — rör ingenting.`);

  const fore = await forhandsbilder(page);
  console.log(`  Före: ${fore.length} förhandsbilder`);
  for (const b of fore) console.log(`    ${b}`);

  await page.locator('input[type="file"]').first().setInputFiles(fil, { timeout: 20_000 });
  let efter = fore;
  for (let sek = 1; sek <= 30; sek++) {
    await page.waitForTimeout(1000);
    efter = await forhandsbilder(page);
    console.log(`  ${String(sek).padStart(2)} s: ${efter.length} förhandsbilder${efter.length > fore.length ? `  ny: ${efter.filter((b) => !fore.includes(b)).join(", ")}` : ""}`);
    if (efter.length > fore.length && efter.every((b) => !b.startsWith("blob:"))) break;
  }
  if (efter.length <= fore.length) throw new Error("Bilden syntes aldrig i uppladdaren — sparar inte.");

  if (!skarpt) {
    console.log("\n  ✓ Bilden syns i uppladdaren. Torrkörning — sparade inte.\n");
  } else {
    const knapp = await clickFirstVisible(page, ['button:has-text("Spara")', 'button[type="submit"]:not([disabled])'], 12_000);
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(3000);
    console.log(`  Sparade (${knapp}) → ${page.url()}`);
    if (await saveSessionIfReal(s.context).catch(() => false)) console.log("  Sessionen sparades om");
    console.log("\n  ✓ Klart.\n");
  }
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await s.browser.close();
}
