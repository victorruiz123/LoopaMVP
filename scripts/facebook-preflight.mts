/**
 * Förkontroll inför en kontrollerad publicering. LÄSER BARA: vem som är inloggad, vilka grupper kontot
 * är medlem i enligt Facebooks egen sida "Dina grupper", och de utpekade målgruppernas aktuella
 * huvud, skrivrutor och regler. Skriver ingenting till Facebook och ingenting till grupplagret.
 *
 *   npx tsx scripts/facebook-preflight.mts "Köp & Sälj Huddinge och Botkyrka" "Köp/sälj Retro möbler och inredning Stockholm"
 */
import { writeFileSync } from "node:fs";
import { facebookBaseUrl } from "../server/src/integrations/facebook/config.ts";
import { inspectGroup } from "../server/src/integrations/facebook/discovery.ts";
import { canonicalGroupUrl, groupKeyFromUrl } from "../server/src/integrations/facebook/groups.ts";
import { classifyGroup } from "../server/src/integrations/facebook/ranking.ts";
import { assessRules } from "../server/src/integrations/facebook/rules.ts";
import { goto, screenshot, withFacebookBrowser } from "../server/src/integrations/facebook/session.ts";

const targets = process.argv.slice(2);
const norm = (s: string) => s.toLowerCase().replace(/[^a-zåäö0-9]+/g, " ").trim();

await withFacebookBrowser("preflight", async ({ page, context }) => {
  // 1. Identitet: c_user-kakan är kontots id; /me/ bekräftar.
  const cUser = (await context.cookies("https://www.facebook.com")).find((c) => c.name === "c_user")?.value ?? null;
  await goto(page, `${facebookBaseUrl()}/me/`, "profil");
  await page.waitForTimeout(3000);
  const profileName = (await page.locator('[role="main"] h1').first().innerText().catch(() => "")).trim();
  console.log(JSON.stringify({ cUser, profileUrl: page.url(), profileName }));
  await screenshot(page, "preflight_identitet");

  // 2. Dina grupper.
  await goto(page, `${facebookBaseUrl()}/groups/joins/?nav_source=tab`, "dina grupper");
  await page.waitForTimeout(5000);
  const found = new Map<string, { key: string; url: string; name: string }>();
  for (let i = 0; i < 12; i++) {
    const rows = await page.evaluate(() => {
      const out: Array<{ href: string; name: string }> = [];
      const main = document.querySelector('[role="main"]') ?? document.body;
      for (const a of Array.from(main.querySelectorAll('a[href*="/groups/"]')) as HTMLAnchorElement[]) {
        const name = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        if (name && name.length >= 3) out.push({ href: a.href, name });
      }
      return out;
    });
    for (const r of rows) {
      const key = groupKeyFromUrl(r.href);
      if (!key || /^(feed|joins|discover|create|search)$/.test(key) || found.has(key)) continue;
      found.set(key, { key, url: canonicalGroupUrl(r.href)!, name: r.name });
    }
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1200);
  }
  await screenshot(page, "preflight_dina_grupper");
  const mine = [...found.values()];
  console.log(`\nDINA GRUPPER (${mine.length}):`);
  for (const g of mine) console.log(`- ${g.name} | ${g.url}`);
  writeFileSync("C:/LoopaMVP/server/data/facebook/mina-grupper.json", JSON.stringify({ at: new Date().toISOString(), userId: cUser, groups: mine }, null, 2), "utf-8");

  // 3. Målgrupperna: hitta dem i listan, läs gruppsida + Om-sida (inspectGroup klickar ingenting).
  for (const t of targets) {
    const hit = mine.find((g) => norm(g.name) === norm(t)) ?? mine.find((g) => norm(g.name).includes(norm(t)) || norm(t).includes(norm(g.name)));
    console.log(`\n=== MÅL: ${t}`);
    if (!hit) {
      console.log("  finns INTE bland Dina grupper");
      continue;
    }
    console.log(`  träff: ${hit.name} | ${hit.url} | nyckel ${hit.key}`);
    const snap = await inspectGroup(page, hit.url);
    const { category } = classifyGroup(snap.name, snap.aboutText);
    const rules = assessRules(snap.rulesText, category, snap.name);
    await goto(page, hit.url, "gruppsida");
    await page.waitForTimeout(2500);
    const buttons = await page.locator('[role="main"] [role="button"]').evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()).filter((x) => /Har gått med|Gå med|Skriv något|Sälj något|Skapa|Anonymt|Bjud in/.test(x)));
    await screenshot(page, `preflight_grupp_${hit.key}`);
    console.log(JSON.stringify({ name: snap.name, finalUrl: snap.finalUrl, memberCount: snap.memberCount, visibility: snap.visibility, membership: snap.membership, composerKind: snap.composerKind, recentPostCount: snap.recentPostCount, hasRulesSection: snap.hasRulesSection, category, adsStatus: rules.adsStatus, evidence: rules.evidence, buttons }, null, 1));
    console.log("--- REGLER (rulesText) ---\n" + (snap.rulesText ?? "(inga regler hittade)").slice(0, 3000));
    console.log("--- OM (första 1200) ---\n" + (snap.aboutText ?? "").slice(0, 1200));
  }
});
