/**
 * Läser kontots FAKTISKA gruppmedlemskap ur Facebooks egna sidor "Dina grupper" (/groups/joins/)
 * och gruppflödets vänsterspalt (/groups/feed/). Skriver ingenting (utom mina-grupper.json).
 *
 *   npx tsx scripts/facebook-mina-grupper.mts
 */
import { writeFileSync } from "node:fs";
import { facebookBaseUrl } from "../server/src/integrations/facebook/config.ts";
import { groupKeyFromUrl, canonicalGroupUrl } from "../server/src/integrations/facebook/groups.ts";
import { withFacebookBrowser, goto, screenshot } from "../server/src/integrations/facebook/session.ts";

const OUT = "C:/LoopaMVP/server/data/facebook/mina-grupper.json";
type Rad = { key: string; url: string; name: string; snippet: string; source: string };

const samla = async (page: import("playwright").Page, scope: string, source: string, found: Map<string, Rad>) => {
  for (let i = 0; i < 8; i++) {
    const rows = await page.evaluate((sel) => {
      const out: Array<{ href: string; name: string; snippet: string }> = [];
      const root = document.querySelector(sel) ?? document.body;
      for (const a of Array.from(root.querySelectorAll('a[href*="/groups/"]')) as HTMLAnchorElement[]) {
        const name = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!name || name.length < 3) continue;
        const box = a.closest('[role="listitem"]') ?? a.parentElement?.parentElement?.parentElement;
        out.push({ href: a.href, name, snippet: (box?.textContent ?? "").replace(/\s+/g, " ").slice(0, 200) });
      }
      return out;
    }, scope);
    for (const r of rows) {
      const key = groupKeyFromUrl(r.href);
      if (!key || /^(feed|joins|discover|create|search)$/.test(key) || found.has(key)) continue;
      found.set(key, { key, url: canonicalGroupUrl(r.href)!, name: r.name, snippet: r.snippet, source });
    }
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1500);
  }
};

await withFacebookBrowser("mina-grupper", async ({ page }) => {
  const found = new Map<string, Rad>();
  await goto(page, `${facebookBaseUrl()}/groups/joins/?nav_source=tab`, "dina grupper");
  await page.waitForTimeout(6000);
  console.log("URL:", page.url());
  await samla(page, '[role="main"]', "joins", found);
  await screenshot(page, "dina_grupper");
  console.log("--- sidtext /groups/joins/ ---\n" + (await page.locator('[role="main"]').first().innerText().catch(() => "")).replace(/\n{2,}/g, "\n").slice(0, 800));

  await goto(page, `${facebookBaseUrl()}/groups/feed/`, "gruppflöde");
  await page.waitForTimeout(6000);
  await samla(page, '[role="navigation"]', "feed-sidebar", found);
  await screenshot(page, "gruppflode");
  console.log("--- vänsterspalt /groups/feed/ ---\n" + (await page.locator('[role="navigation"]').last().innerText().catch(() => "")).replace(/\n{2,}/g, "\n").slice(0, 800));

  const list = [...found.values()];
  console.log(`\n${list.length} grupper hittade:`);
  for (const g of list) console.log(`- [${g.source}] ${g.name} | ${g.url} | ${g.snippet.slice(0, 100)}`);
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), groups: list }, null, 2), "utf-8");
});
