/**
 * Kommandoraden för Facebook-distributionen — för utveckling och kontrollerade prov.
 *
 *   npm run facebook -- status
 *   npm run facebook -- session
 *   npm run facebook -- discover [--query "möbler Stockholm" ...]
 *   npm run facebook -- validate [--max 6] [--group <id> ...]
 *   npm run facebook -- join --group <id> [--group <id>] [--max 1]
 *   npm run facebook -- recheck
 *   npm run facebook -- marketplace-dry-run <loopaId>
 *   npm run facebook -- group-dry-run <loopaId> <groupId>
 *   npm run facebook -- queue [--max 2]
 *   npm run facebook -- manual-actions [open]
 *   npm run facebook -- resolve <id> [anteckning]
 *   npm run facebook -- pause
 *   npm run facebook -- resume
 *   npm run facebook -- sync-memberships
 *
 * TORRKÖRNINGSKOMMANDONA TVINGAR FACEBOOK_DRY_RUN=true oavsett miljön. Härifrån publiceras aldrig
 * något. `join` är den enda riktiga skrivningen, och den kräver att grupperna pekas ut uttryckligen.
 *
 * SÄKER LOKAL UPPSTART (LÄRDOM 2026-09-27): `sweepLiveListings` känner inte av om en människa tryckt
 * "Godkänn och lägg ut" — bara att möbeln är live och saknar en Facebook-post — och kön kör i samma
 * varv som svepningen. En lokalt speglad/iscensatt annons (facebook-spegla-annons.mts) som råkar stå
 * live när servern startar med FACEBOOK_ENABLED=1 FACEBOOK_DRY_RUN=false kan alltså bli en RIKTIG
 * skrivning inom några minuter, utan att någon tryckt något — det hände 2026-09-27 (LP-74PJ-NBK8).
 *
 * KÖR DÄRFÖR `npm run facebook -- pause` INNAN servern startas, varje gång lokal inspektion eller ett
 * iscensatt testfall är på gång. Det skriver bara panelens egna pausknappar (marketplacePaused,
 * groupPublishingPaused, discoveryPaused, autoJoinPaused i settings.json) till disk — ingen server
 * behöver köra för det, så det finns inget kapplöpningsfönster mot svepningens 3-minutersfördröjning.
 * `queue.ts` läser samma inställningar för BÅDE att köa (enqueueForListing) och att köra (processQueue),
 * så en post som redan låg i kö innan pausen rörs inte heller — pausen tar bort ingenting, den bara
 * stoppar nästa skrivning. Kör `npm run facebook -- resume` när du uttryckligen vill tillåta kön igen.
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const [, , kommando, ...rest] = process.argv;

function flagg(namn: string): string[] {
  const ut: string[] = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === `--${namn}` && rest[i + 1]) ut.push(rest[++i]);
  return ut;
}
const positional = rest.filter((a, i) => !a.startsWith("--") && (i === 0 || !rest[i - 1].startsWith("--")));

function skriv(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

switch (kommando) {
  case "status": {
    const { facebookOverview } = await import("./admin.js");
    const o = await facebookOverview();
    skriv({ ...o, events: o.events.slice(0, 15) });
    break;
  }
  case "session": {
    const { withFacebookBrowser, checkSession } = await import("./session.js");
    skriv(await withFacebookBrowser("cli-session", ({ page }) => checkSession(page)));
    break;
  }
  case "discover": {
    const { runDiscovery } = await import("./discovery.js");
    const queries = flagg("query");
    skriv(await runDiscovery({ queries: queries.length ? queries : undefined, force: true }));
    break;
  }
  case "validate": {
    const { validateGroups } = await import("./discovery.js");
    const groupIds = flagg("group");
    skriv(await validateGroups({ max: Number(flagg("max")[0] ?? 6), groupIds: groupIds.length ? groupIds : undefined }));
    break;
  }
  case "join": {
    const groupIds = flagg("group");
    if (!groupIds.length) {
      console.error("join kräver --group <id> — ansökningar från kommandoraden är alltid uttryckliga.");
      process.exit(1);
    }
    const { runAutoJoin } = await import("./joining.js");
    skriv(await runAutoJoin({ groupIds, max: Number(flagg("max")[0] ?? groupIds.length) }));
    break;
  }
  case "recheck": {
    const { recheckMemberships } = await import("./joining.js");
    skriv(await recheckMemberships({ force: true }));
    break;
  }
  case "marketplace-dry-run": {
    process.env.FACEBOOK_DRY_RUN = "true";
    const loopaId = positional[0];
    if (!loopaId) {
      console.error("marketplace-dry-run kräver ett Loopa-ID.");
      process.exit(1);
    }
    const { jobByLoopaId } = await import("../../publicCard.js");
    const job = await jobByLoopaId(loopaId);
    if (!job) {
      console.error(`Hittar inget jobb för ${loopaId}.`);
      process.exit(1);
    }
    const { facebookListingFor } = await import("./mapping.js");
    const readiness = await facebookListingFor(job);
    if (!readiness.ok) {
      console.error(`Annonsen kan inte läggas ut: ${readiness.reason}`);
      process.exit(1);
    }
    const { driveMarketplaceForm } = await import("./marketplace.js");
    const { withFacebookBrowser } = await import("./session.js");
    const { stegLogg } = await import("./steps.js");
    const { logga, steps } = stegLogg(`cli marketplace ${loopaId}`);
    const result = await withFacebookBrowser("cli-marketplace", ({ page }) => driveMarketplaceForm(page, { listing: readiness.listing, dryRun: true, onPhase: async () => undefined }, logga), { headful: flagg("headful").length > 0 || process.env.FACEBOOK_HEADFUL === "1" });
    skriv({ listing: { ...readiness.listing, imagePaths: readiness.listing.imagePaths.length }, result, steps });
    break;
  }
  case "group-dry-run": {
    process.env.FACEBOOK_DRY_RUN = "true";
    const [loopaId, groupId] = positional;
    if (!loopaId || !groupId) {
      console.error("group-dry-run kräver <loopaId> <groupId>.");
      process.exit(1);
    }
    const { jobByLoopaId } = await import("../../publicCard.js");
    const { getGroup } = await import("./store.js");
    const [job, group] = await Promise.all([jobByLoopaId(loopaId), getGroup(groupId)]);
    if (!job || !group) {
      console.error(!job ? `Hittar inget jobb för ${loopaId}.` : `Hittar ingen grupp ${groupId}.`);
      process.exit(1);
    }
    const { facebookListingFor } = await import("./mapping.js");
    const readiness = await facebookListingFor(job);
    if (!readiness.ok) {
      console.error(`Annonsen kan inte läggas ut: ${readiness.reason}`);
      process.exit(1);
    }
    const { driveGroupPost } = await import("./publisher.js");
    const { withFacebookBrowser } = await import("./session.js");
    const { stegLogg } = await import("./steps.js");
    const { logga, steps } = stegLogg(`cli grupp ${groupId}`);
    const result = await withFacebookBrowser("cli-group", ({ page }) => driveGroupPost(page, { group, listing: readiness.listing, dryRun: true, onPhase: async () => undefined }, logga));
    skriv({ result, steps });
    break;
  }
  case "open": {
    /**
     * Öppnar en adress i ett SYNLIGT Chromium på LoopaMVP:s profil och väntar tills operatören stänger
     * fönstret. För det Facebook kräver att en människa gör: samtyckesval, kontrollpunkter, medlemsfrågor
     * som inte kunde besvaras. Roboten klickar ingenting här.
     */
    const url = positional[0] ?? "https://www.facebook.com/";
    const { openFacebookBrowser } = await import("./session.js");
    const browser = await openFacebookBrowser({ headful: true });
    await browser.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
    console.log(`Fönstret är öppet på ${url}. Gör det som behövs och stäng fönstret när du är klar (väntar högst 30 min).`);
    const slut = Date.now() + Number(process.env.FACEBOOK_OPEN_TIMEOUT_MS ?? 30 * 60 * 1000);
    while (Date.now() < slut && !browser.page.isClosed() && browser.context.pages().length > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(browser.page.isClosed() ? "Fönstret stängdes." : "Tiden gick ut — stänger.");
    await browser.close();
    break;
  }
  case "queue": {
    const { processQueue, sweepLiveListings } = await import("./queue.js");
    skriv({ sweep: await sweepLiveListings(), run: await processQueue({ max: Number(flagg("max")[0] ?? 2), force: true }) });
    break;
  }
  case "manual-actions": {
    const { listManualActions } = await import("./store.js");
    const all = await listManualActions();
    skriv(positional[0] === "open" ? all.filter((a) => !a.resolvedAt) : all);
    break;
  }
  case "resolve": {
    /** Samma väg som panelens knapp (admin.ts `resolveAction`) — ingen egen skrivning till lagret här. */
    const [id, anteckning] = positional;
    if (!id) {
      console.error("resolve kräver <id> [anteckning] — id:t från manual-actions.");
      process.exit(1);
    }
    const { resolveAction } = await import("./admin.js");
    skriv(await resolveAction(id, `operator${anteckning ? `: ${anteckning}` : ""}`));
    break;
  }
  /**
   * SÄKER UPPSTART. Skriver bara settings.json — kräver ingen körande server, så det finns inget
   * kapplöpningsfönster mot svepningens fördröjning vid uppstart (se kommentaren överst i filen).
   * Samma fyra brytare som panelen har var för sig; `pause`/`resume` sätter alla fyra i ett svep,
   * det som en människa vill ha före/efter en kontrollerad lokal körning.
   */
  case "pause": {
    const { writeSettings } = await import("./store.js");
    const s = await writeSettings({ marketplacePaused: true, groupPublishingPaused: true, discoveryPaused: true, autoJoinPaused: true }, "cli:pause");
    console.log("Pausat: marketplace, grupper, upptäckt och auto-ansökan. Inget köas eller körs förrän `npm run facebook -- resume`.");
    skriv({ marketplacePaused: s.marketplacePaused, groupPublishingPaused: s.groupPublishingPaused, discoveryPaused: s.discoveryPaused, autoJoinPaused: s.autoJoinPaused });
    break;
  }
  case "sync-memberships": {
    /** Läsning, ingen skrivning: Facebooks egen lista över grupper kontot redan gått med i. */
    const { syncOwnMemberships } = await import("./discovery.js");
    skriv(await syncOwnMemberships());
    break;
  }
  case "resume": {
    const { writeSettings } = await import("./store.js");
    const s = await writeSettings({ marketplacePaused: false, groupPublishingPaused: false, discoveryPaused: false, autoJoinPaused: false }, "cli:resume");
    console.log("Återupptaget: nästa varv köar och kör som vanligt.");
    skriv({ marketplacePaused: s.marketplacePaused, groupPublishingPaused: s.groupPublishingPaused, discoveryPaused: s.discoveryPaused, autoJoinPaused: s.autoJoinPaused });
    break;
  }
  default:
    console.error("Okänt kommando. Se kommentaren överst i cli.ts.");
    process.exit(1);
}
