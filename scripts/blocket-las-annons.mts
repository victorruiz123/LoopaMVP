/**
 * Läser av en Blocket-annons på kontot — BARA LÄSNING — så att den kan läggas upp igen efter en
 * borttagning. För annonser utan Loopa-jobb (t.ex. en egen testannons), där inget annat bär innehållet.
 *
 *   ./server/node_modules/.bin/tsx scripts/blocket-las-annons.mts <annons-id>
 *
 * Öppnar det förifyllda redigeringsformuläret /recommerce/create/<id> och läser rubrik, beskrivning,
 * pris, postnummer, mått, varumärke, skick och kategorivalen, och hämtar bilderna. Trycker aldrig
 * Spara. Skriver allt till server/data/blocket-annonser/<id>/annons.json, bilderna bredvid.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SERVER = new URL("../server", import.meta.url).pathname;
try {
  process.loadEnvFile(`${SERVER}/.env`);
} catch {}
const id = process.argv[2];
if (!id || !/^\d{6,}$/.test(id)) {
  console.error("\n  Användning: tsx scripts/blocket-las-annons.mts <annons-id>\n");
  process.exit(1);
}
const UT = path.join(SERVER, "data", "blocket-annonser", id);
mkdirSync(UT, { recursive: true });

const { blocketBaseUrl, missingBlocketEnv, sessionFileExists } = await import(`${SERVER}/src/integrations/blocket/blocket.ts`);
const { ensureSession, goAndSettle, startBrowser } = await import(`${SERVER}/src/integrations/blocket/browser.ts`);
const { dismissCookieBanner, dismissModal } = await import(`${SERVER}/src/integrations/blocket/form.ts`);
const { annonsenArAktiv, lasRubrik, redigeringsformularet } = await import(`${SERVER}/src/integrations/blocket/pris.ts`);

if (missingBlocketEnv().length || !sessionFileExists()) {
  console.error("  ✗ Ingen Blocket-session (BLOCKET_SESSION).");
  process.exit(1);
}

const logga = (n: string, s: string, d?: unknown) => console.log(`  [${s}] ${n}${d ? "  " + JSON.stringify(d) : ""}`);
const s = await startBrowser();
const page = s.page;
try {
  await ensureSession(page, logga);
  const bas = blocketBaseUrl();
  if (!(await annonsenArAktiv(page, id, logga))) throw new Error("Annonsen står inte bland de aktiva.");

  await goAndSettle(page, `${bas}/recommerce/create/${id}`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  if (!(await redigeringsformularet(page))) throw new Error(`Inget redigeringsformulär på ${page.url()}`);
  await page.waitForTimeout(2500);
  const rubrik = await lasRubrik(page);
  await page.screenshot({ path: path.join(UT, "formular.png"), fullPage: true });

  // Alla fält med etikett och värde, även i skuggor. INGA namngivna funktioner (tsx/__name).
  const falt = await page.evaluate(() => {
    const ut: Array<{ tag: string; namn: string; etikett: string; varde: string; valt?: string }> = [];
    const ko: Array<Document | ShadowRoot> = [document];
    while (ko.length) {
      const r = ko.pop()!;
      r.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) ko.push(el.shadowRoot);
        const tag = el.tagName.toLowerCase();
        if (!/^(w-textfield|w-textarea|w-select|w-combobox|w-radio|w-checkbox|input|textarea|select)$/.test(tag)) return;
        // Inre fält i en komponent räknas via värdelementet.
        const rot = el.getRootNode() as ShadowRoot;
        if (rot.host && /^w-/.test(rot.host.tagName.toLowerCase())) return;
        const inre = el.shadowRoot?.querySelector("input, textarea, select") as HTMLInputElement | HTMLSelectElement | null;
        const f = (inre ?? el) as HTMLInputElement & HTMLSelectElement;
        let etikett = el.getAttribute("aria-label") ?? el.getAttribute("label") ?? "";
        const fid = el.getAttribute("id");
        if (!etikett && fid) etikett = document.querySelector(`label[for="${fid}"]`)?.textContent ?? "";
        if (!etikett) etikett = el.closest("label")?.textContent ?? "";
        let valt: string | undefined;
        if (f instanceof HTMLSelectElement && f.selectedIndex >= 0) valt = f.options[f.selectedIndex]?.text;
        const varde = f instanceof HTMLInputElement && (f.type === "radio" || f.type === "checkbox") ? (f.checked ? "checked" : "") : String(f.value ?? el.getAttribute("value") ?? "");
        ut.push({ tag, namn: el.getAttribute("name") ?? "", etikett: etikett.replace(/\s+/g, " ").trim(), varde: varde.slice(0, 4000), valt: valt ?? (el.hasAttribute("checked") ? "checked" : undefined) });
      });
    }
    return ut;
  });

  // Bilderna i formuläret: ta den största varianten av varje.
  const bildUrl = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll("img")].map((i) => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src).filter((u) => /^https?:/.test(u) && !/logo|icon|avatar|sprite/i.test(u)))],
  );
  const bilder: string[] = [];
  for (const [i, u] of bildUrl.entries()) {
    const stor = u.replace(/\/(default|thumbs?|\d+x\d+)\//, "/default/");
    const svar = await page.context().request.get(stor).catch(() => null);
    const typ = svar?.headers()["content-type"] ?? "";
    if (!svar || !svar.ok() || !/image\//.test(typ)) continue;
    const fil = path.join(UT, `bild-${i + 1}.${typ.includes("png") ? "png" : "jpg"}`);
    writeFileSync(fil, await svar.body());
    bilder.push(fil);
  }

  // Ägarsidans text, för läget och priset.
  await goAndSettle(page, `${bas}/my-items/details/${id}`);
  const agarsida = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 1500);

  const annons = { id, lastAt: new Date().toISOString(), rubrik, falt, bildUrl, bilder, agarsida };
  writeFileSync(path.join(UT, "annons.json"), JSON.stringify(annons, null, 2));
  console.log(`\n  Rubrik: ${rubrik}`);
  for (const f of falt) if (f.varde || f.valt) console.log(`  ${f.tag.padEnd(12)} ${(f.etikett || f.namn).slice(0, 40).padEnd(40)} ${(f.valt ?? f.varde).replace(/\s+/g, " ").slice(0, 90)}`);
  console.log(`  Bilder: ${bilder.length} av ${bildUrl.length} hämtade`);
  console.log(`  Ägarsidan: ${agarsida.slice(0, 200)}`);
  console.log(`\n  ✓ Sparat i ${UT}\n`);
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  await page.screenshot({ path: path.join(UT, "fel.png"), fullPage: true }).catch(() => null);
  process.exitCode = 1;
} finally {
  await s.browser.close();
}
