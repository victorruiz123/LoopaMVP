/**
 * Oberoende verifiering efter en skarp publicering. LÄSER BARA: Dina säljinlägg på Marketplace,
 * annonssidan, och målgruppernas flöden. Klickar aldrig Publicera, ändrar ingenting på Facebook.
 *
 *   npx tsx scripts/facebook-verifiera-publicering.mts "SoffaDirekt Bergholm" <gruppurl> <gruppurl>
 */
import { facebookBaseUrl } from "../server/src/integrations/facebook/config.ts";
import { goto, screenshot, withFacebookBrowser } from "../server/src/integrations/facebook/session.ts";

const [title, ...groupUrls] = process.argv.slice(2);
type P = import("playwright").Page;
const clean = (s: string) => s.replace(/\n{2,}/g, "\n").trim();

async function dumpItem(page: P, label: string) {
  const main = page.locator('[role="main"]').first();
  const text = clean(await main.innerText().catch(() => ""));
  console.log(`\n##### ${label}\nurl: ${page.url()}\n--- text (1800) ---\n${text.slice(0, 1800)}`);
  const imgs = await main.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src).filter((s) => /scontent|fbcdn/.test(s) && !/\/s\d+x\d+\/|emoji|static/.test(s)).length);
  const loopaLinks = await main.locator('a[href*="loopa"]').evaluateAll((els) => els.map((e) => `${(e as HTMLAnchorElement).href} :: ${(e.textContent ?? "").trim().slice(0, 80)}`));
  const loopaText = (text.match(/https?:\/\/[a-z.]*loopa\.nu\S*/gi) ?? []).slice(0, 5);
  console.log("bilder (cdn):", imgs, "| loopa-ankare:", loopaLinks, "| loopa-text:", loopaText);
  console.log("pris i texten:", text.match(/\d[\d\s ]*\s?kr/g)?.slice(0, 4), "| innehåller titel:", text.includes(title));
}

await withFacebookBrowser("verifiera", async ({ page }) => {
  // 1. Marketplace: Dina säljinlägg.
  await goto(page, `${facebookBaseUrl()}/marketplace/you/selling`, "dina säljinlägg");
  await page.waitForTimeout(4000);
  await screenshot(page, "verifiera_dina_saljinlagg");
  const items = await page.locator('[role="main"] a[href*="/marketplace/item/"]').evaluateAll((els) => els.map((e) => `${(e as HTMLAnchorElement).href.split("?")[0]} :: ${(e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100)}`));
  console.log("Dina säljinlägg – annonslänkar:", items);
  console.log("--- sidtext (800) ---\n" + clean(await page.locator('[role="main"]').first().innerText().catch(() => "")).slice(0, 800));
  const mine = items.filter((i) => i.includes(title));
  const urls = [...new Set(mine.map((i) => i.split(" :: ")[0]))];
  console.log(`\nMarketplace-annonser med titeln "${title}": ${urls.length}`, urls);
  for (const u of urls.slice(0, 3)) {
    await goto(page, u, "annonssida");
    await page.waitForTimeout(3500);
    await dumpItem(page, `MARKETPLACE-ANNONS ${u}`);
    await screenshot(page, "verifiera_mp_annons");
  }

  // 2. Grupperna.
  for (const g of groupUrls) {
    await goto(page, g, "gruppsida");
    await page.waitForTimeout(4000);
    const article = page.locator('[role="feed"] > div').filter({ hasText: title }).first();
    const found = await article.count();
    console.log(`\n===== GRUPP ${g}: inlägg med titeln i flödet: ${found}`);
    if (found) {
      const links = await article.locator("a[href]").evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLAnchorElement).href.split("?")[0]))].filter((h) => /\/groups\/|\/marketplace\/|loopa/.test(h)).slice(0, 12));
      console.log("länkar i inlägget:", links);
      console.log("--- inläggstext (900) ---\n" + clean(await article.innerText().catch(() => "")).slice(0, 900));
      await article.scrollIntoViewIfNeeded().catch(() => undefined);
      await screenshot(page, `verifiera_grupp_${g.replace(/\W+/g, "_").slice(-30)}`);
      const perma = links.find((h) => /\/posts\/|\/permalink\//.test(h)) ?? links.find((h) => /\/marketplace\/item\//.test(h));
      if (perma) {
        await goto(page, perma, "permalänk");
        await page.waitForTimeout(3500);
        await dumpItem(page, `GRUPPINLÄGG ${perma}`);
        await screenshot(page, `verifiera_perma_${g.replace(/\W+/g, "_").slice(-30)}`);
      }
    } else {
      console.log("--- flödets början (1000) ---\n" + clean(await page.locator('[role="main"]').first().innerText().catch(() => "")).slice(0, 1000));
      await screenshot(page, `verifiera_grupp_saknas_${g.replace(/\W+/g, "_").slice(-30)}`);
    }
  }
});
