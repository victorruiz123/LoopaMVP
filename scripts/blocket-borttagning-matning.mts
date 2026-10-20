/**
 * Mätningen av Blockets borttagningsflöde — BARA LÄSNING. Se server/src/integrations/blocket/borttagning.ts.
 *
 *   ./server/node_modules/.bin/tsx scripts/blocket-borttagning-matning.mts <annons-id>
 *
 * Öppnar kortets meny på Mina annonser och ägarsidan /my-items/details/<id>, och listar alla synliga
 * knappar och länkar. Klickar på INGET annat än menyknappen och sparar inte om sessionen. Körs där
 * BLOCKET_SESSION finns (servern). Skärmbilder hamnar i server/data/blocket-matning (MATNING_UT).
 */
import { mkdirSync } from "node:fs";
const SERVER = new URL("../server", import.meta.url).pathname;
const UT = process.env.MATNING_UT ?? `${SERVER}/data/blocket-matning`;
try {
  process.loadEnvFile(`${SERVER}/.env`);
} catch {}
const id = process.argv[2] ?? "21946768";

const { blocketBaseUrl, missingBlocketEnv, sessionFileExists } = await import(`${SERVER}/src/integrations/blocket/blocket.ts`);
const { ensureSession, goAndSettle, startBrowser } = await import(`${SERVER}/src/integrations/blocket/browser.ts`);
const { dismissCookieBanner, dismissModal } = await import(`${SERVER}/src/integrations/blocket/form.ts`);

mkdirSync(UT, { recursive: true });
if (missingBlocketEnv().length || !sessionFileExists()) {
  console.log("Blocket inte konfigurerat lokalt:", missingBlocketEnv(), "session:", sessionFileExists());
  process.exit(1);
}
const logga = (n: string, s: string) => console.log(`  [${s}] ${n}`);
const s = await startBrowser();
const page = s.page;

const synliga = async () =>
  page.evaluate(() => {
    const ut: string[] = [];
    const besok = (root: Document | ShadowRoot) => {
      root.querySelectorAll("a, button, w-button, [role=menuitem], [role=button], dialog").forEach((el) => {
        const h = el as HTMLElement;
        const r = h.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const txt = (h.innerText || h.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const href = h.getAttribute("href") ?? "";
        ut.push(`${h.tagName.toLowerCase()}${h.getAttribute("type") ? `[type=${h.getAttribute("type")}]` : ""} "${txt}" ${href}`);
      });
      root.querySelectorAll("*").forEach((el) => el.shadowRoot && besok(el.shadowRoot));
    };
    besok(document);
    return [...new Set(ut)];
  });

try {
  await ensureSession(page, logga);
  const bas = blocketBaseUrl();

  // 1. Mina annonser → kortets meny
  await goAndSettle(page, `${bas}/my-items`);
  await dismissCookieBanner(page);
  await dismissModal(page);
  console.log("\n== /my-items, url:", page.url());
  const kortLank = page.locator(`a[href="/my-items/details/${id}"]`).first();
  console.log("kortet finns bland aktiva:", (await kortLank.count()) > 0);
  if ((await kortLank.count()) > 0) {
    let kort = kortLank;
    for (let i = 0; i < 6; i++) {
      kort = kort.locator("xpath=..");
      const meny = kort.locator('w-button:has-text("Meny"), button:has-text("Meny"), button[aria-label*="eny" i]').first();
      if (await meny.isVisible({ timeout: 300 }).catch(() => false)) {
        const fore = new Set(await synliga());
        await meny.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        console.log("Nytt synligt efter menyklick:");
        for (const r of await synliga()) if (!fore.has(r)) console.log("   ", r);
        await page.screenshot({ path: `${UT}/meny.png` });
        await page.keyboard.press("Escape");
        break;
      }
    }
  }

  // 2. Detaljsidan
  await goAndSettle(page, `${bas}/my-items/details/${id}`);
  await dismissModal(page);
  console.log("\n== detaljsidan, url:", page.url());
  for (const r of await synliga()) console.log("   ", r);
  console.log("\nText:", (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 800));
  await page.screenshot({ path: `${UT}/detalj.png`, fullPage: true });
} finally {
  await s.browser.close();
}
