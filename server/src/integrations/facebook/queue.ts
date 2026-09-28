/**
 * Kön: från "möbeln är live på Loopa" till Marketplace och grupperna — hållbart, en i taget.
 *
 * UTLÖSAREN är butikens övergång till `live` (butik/store.ts, `onPublished`), som är det enda ställe
 * där "annonsen är godkänd och till salu" faktiskt avgörs — oavsett om det skedde genom panelens
 * "Godkänn och lägg ut", en manuell publicering eller en förtur som gick ut. Ovanpå det en SVEPNING
 * som ställer varje live-möbel utan Facebook-post i kö: tappas en händelse (krasch mitt i) står
 * möbeln ändå i kön inom tio minuter.
 *
 * FACEBOOK FÅR ALDRIG FÄLLA LOOPA. Allt här är fire-and-forget bakom en try/catch, och ingenting
 * anropas i det HTTP-svar som gör möbeln live. Fel skrivs i Facebook-lagret och panelen.
 *
 * KRASCHSÄKERHETEN bor i `phase`. Före sista knappen är ett omförsök säkert och görs (upp till tre
 * gånger). Efter att knappen tryckts men innan utfallet lästs är ett omförsök en möjlig dubblett —
 * då blir posten NEEDS_MANUAL_ACTION och en människa kontrollerar Facebook. `recoverInterrupted` gör
 * den sorteringen vid varje uppstart.
 */

import { productById } from "../../butik/inventory.js";
import { store as butikStore } from "../../butik/store.js";
import { getJob } from "../../jobStore.js";
import type { ConditionJob } from "../../types.js";
import type { ChannelPlan } from "../autoPublish.js";
import {
  facebookAutoDiscover,
  facebookDryRun,
  facebookEnabled,
  facebookGroupPublishingEnabled,
  facebookLimits,
  facebookMarketplaceEnabled,
} from "./config.js";
import { FacebookInterrupt } from "./checkpoint.js";
import { applySnapshot, inspectGroup, runDiscovery, syncOwnMemberships, validateGroups } from "./discovery.js";
import { recheckMemberships, runAutoJoin } from "./joining.js";
import { facebookListingFor, groupListingSnapshot, groupSnapshot, marketplaceSnapshot } from "./mapping.js";
import { driveMarketplaceForm } from "./marketplace.js";
import { computePostEligibility, selectGroupsForListing, type ListingProfile, type SelectionResult } from "./membership.js";
import { driveGroupPost } from "./publisher.js";
import { rulesStale } from "./rules.js";
import { lastKnownSession, recordInterrupt, withFacebookBrowser } from "./session.js";
import { stegLogg } from "./steps.js";
import {
  allGroupPublications,
  allGroups,
  allMarketplace,
  enqueueGroupPublication,
  enqueueMarketplace,
  getGroup,
  lastWriteAt,
  listManualActions,
  logEvent,
  putGroup,
  readSettings,
  recordManualAction,
  recordWrite,
  updateGroup,
  updateGroupPublication,
  updateMarketplace,
  writeSettings,
  writesSince,
} from "./store.js";
import type { FacebookSettings, GroupPublication, MarketplacePublication, PublicationPhase } from "./types.js";

const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Utlösaren
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  marketplace: "created" | "exists" | "skipped";
  marketplaceReason: string | null;
  groupsCreated: number;
  groupsExisting: number;
  /** Grupperna urvalet pekade ut för just den här möbeln, bäst först. */
  groupsSelected: string[];
  /** Medlemsgrupper som INTE valdes, med skälet — det panelen svarar med på "varför inte den". */
  groupsSkipped: Array<{ id: string; name: string; reason: string }>;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Urvalet av grupper per annons
// ---------------------------------------------------------------------------

/** Taket för grupper per annons: panelens inställning vinner över miljöns förval. */
export function effectiveMaxGroups(settings: FacebookSettings): number {
  return settings.maxGroupsPerListing ?? facebookLimits().maxGroupsPerListing;
}

/** Taket för grupp-inlägg per dag, totalt: panelens inställning vinner över miljöns förval. */
export function effectiveMaxGroupPostsPerDay(settings: FacebookSettings): number {
  return settings.maxGroupPostsPerDay ?? facebookLimits().maxGroupPostsPerDay;
}

/** Grupper med en olöst manuell åtgärd. Läget där är okänt tills en människa tittat — ingenting köas dit. */
async function blockedGroupIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const a of await listManualActions()) if (!a.resolvedAt && a.context.groupId) ids.add(a.context.groupId);
  return ids;
}

export function profileOf(l: { categorySlug: string; brand: string | null; location?: string | null; region?: string | null }): ListingProfile {
  return { categorySlug: l.categorySlug, brand: l.brand, location: l.location || l.region || "Stockholm" };
}

/** Urvalet för en möbel, med lagrets grupper, panelens tak och de öppna åtgärderna. Rena regler i membership.ts. */
export async function selectForListing(profile: ListingProfile, settings?: FacebookSettings): Promise<SelectionResult> {
  const s = settings ?? (await readSettings());
  return selectGroupsForListing(await allGroups(), profile, {
    max: effectiveMaxGroups(s),
    defaultCooldownHours: facebookLimits().groupCooldownHours,
    blockedGroupIds: await blockedGroupIds(),
  });
}

/**
 * Facebook som kanal i "Godkänn och lägg ut" — det planen i integrations/autoPublish.ts visar.
 *
 * Kanalen KÖR inte här: publiceringen går genom kön (onListingLive -> enqueueForListing -> arbetarna),
 * asynkront och isolerat. Planen svarar bara på om det finns något att köa: Marketplace saknas, eller
 * någon vald grupp saknar post. Finns allt redan är kanalen "ligger redan uppe" — idempotensen i
 * lagret gör ändå att ett tryck till aldrig blir en dubblett.
 */
export async function facebookChannelPlan(job: ConditionJob): Promise<ChannelPlan> {
  const configured = facebookEnabled();
  const base: ChannelPlan = { channel: "facebook", configured, missingEnv: configured ? [] : ["FACEBOOK_ENABLED"], ready: false, reason: null, alreadyRunning: false, dryRun: facebookDryRun() };
  if (!configured) return { ...base, reason: "FACEBOOK_ENABLED är inte satt på servern." };
  const readiness = await facebookListingFor(job);
  if (!readiness.ok) return { ...base, reason: readiness.reason };
  const session = await lastKnownSession();
  if (session && (session.status === "CHECKPOINT" || session.status === "RESTRICTED")) {
    return { ...base, reason: `Facebook-sessionen står i ${session.status} — lös åtgärden i panelen först.` };
  }
  const settings = await readSettings();
  const mpWanted = facebookMarketplaceEnabled() && !settings.marketplacePaused;
  const groupsWanted = facebookGroupPublishingEnabled() && !settings.groupPublishingPaused;
  if (!mpWanted && !groupsWanted) return { ...base, reason: "Marketplace och gruppinlägg är pausade i panelen." };
  const loopaId = readiness.listing.loopaId;
  const existingMp = (await allMarketplace()).some((p) => p.listingId === loopaId);
  const existingGroups = new Set((await allGroupPublications()).filter((p) => p.listingId === loopaId).map((p) => p.groupId));
  const selection = groupsWanted ? await selectForListing(profileOf(readiness.listing), settings) : { selected: [], skipped: [] };
  const groupsMissing = selection.selected.filter((x) => !existingGroups.has(x.group.id));
  const mpMissing = mpWanted && !existingMp;
  if (!mpMissing && groupsMissing.length === 0) return { ...base, ready: true, alreadyRunning: true };
  return { ...base, ready: true };
}

/**
 * Ställer en live-möbel i kö för Marketplace och för varje grupp som är MEMBER + postbar + påslagen.
 * Idempotent på båda nivåerna — lagret vägrar dubbletter (store.ts).
 */
export async function enqueueForListing(loopaId: string, jobId: string): Promise<EnqueueResult> {
  const out: EnqueueResult = { marketplace: "skipped", marketplaceReason: null, groupsCreated: 0, groupsExisting: 0, groupsSelected: [], groupsSkipped: [], reason: null };
  if (!facebookEnabled()) return { ...out, reason: "FACEBOOK_ENABLED är inte satt." };

  const job = await getJob(jobId);
  if (!job) return { ...out, reason: "Jobbet finns inte." };
  const readiness = await facebookListingFor(job);
  if (!readiness.ok) return { ...out, reason: readiness.reason };

  const settings = await readSettings();
  const dryRun = facebookDryRun();

  if (!facebookMarketplaceEnabled()) out.marketplaceReason = "FACEBOOK_MARKETPLACE_ENABLED är av.";
  else if (settings.marketplacePaused) out.marketplaceReason = "Marketplace är pausat i panelen.";
  else {
    const { created } = await enqueueMarketplace(loopaId, jobId, dryRun);
    out.marketplace = created ? "created" : "exists";
    if (created) await logEvent({ worker: "queue", level: "info", action: "KÖAD MARKETPLACE", target: loopaId, detail: `${readiness.listing.title} står i kö${dryRun ? " (torrkörning)" : ""}.` });
  }

  if (facebookGroupPublishingEnabled() && !settings.groupPublishingPaused) {
    // Urvalet är PER MÖBEL (kategori, märke, region) och kapas av panelens tak. Lagret vägrar
    // dubbletter per möbel × grupp, så ett andra anrop skapar ingenting — det är idempotensen.
    const selection = await selectForListing(profileOf(readiness.listing), settings);
    out.groupsSelected = selection.selected.map((x) => x.group.id);
    out.groupsSkipped = selection.skipped;
    for (const { group } of selection.selected) {
      const { created } = await enqueueGroupPublication(loopaId, group.id, jobId, dryRun);
      if (created) out.groupsCreated += 1;
      else out.groupsExisting += 1;
    }
    if (out.groupsCreated) {
      const varfor = selection.selected.map((x) => `${x.group.name} (${x.reasons.join(", ")})`).join("; ");
      await logEvent({ worker: "queue", level: "info", action: "KÖAD GRUPPER", target: loopaId, detail: `${out.groupsCreated} grupp-inlägg står i kö${dryRun ? " (torrkörning)" : ""}: ${varfor}.` });
    }
  }
  return out;
}

/** Anropas från butikens `live`-övergång. Fångar allt — Facebook får aldrig fälla publiceringen. */
export function onListingLive(loopaId: string, jobId: string | null): void {
  if (!facebookEnabled() || !jobId) return;
  void enqueueForListing(loopaId, jobId).catch((err) => console.warn(`[facebook:queue] köandet för ${loopaId} föll: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Svepningen: varje live-möbel med ett jobb ställs i kö. Dubbletter avvisas av lagret.
 *
 * Körs varje minut, så den läser lagret EN gång och hoppar över möbler som redan har allt de kan få —
 * en Marketplace-post och en post per distributionsmål. Bara det som saknar något får jobbet läst
 * från disk (`enqueueForListing` bygger annonsen för att veta att den går att lägga ut).
 */
export async function sweepLiveListings(): Promise<{ examined: number; enqueued: number }> {
  if (!facebookEnabled()) return { examined: 0, enqueued: 0 };
  const [marketplace, groupPosts, settings] = await Promise.all([allMarketplace(), allGroupPublications(), readSettings()]);
  const hasMarketplace = new Set(marketplace.map((p) => p.listingId));
  const covered = new Map<string, Set<string>>();
  for (const p of groupPosts) {
    const set = covered.get(p.listingId) ?? new Set<string>();
    set.add(p.groupId);
    covered.set(p.listingId, set);
  }

  let examined = 0;
  let enqueued = 0;
  for (const record of await butikStore().all()) {
    if (record.source !== "loopa" || record.state !== "live" || !record.jobId) continue;
    examined += 1;
    const done = covered.get(record.id) ?? new Set<string>();
    // Urvalet per möbel ur butikens egen projektion (i minnet) — jobbet läses från disk först när något saknas.
    const product = await productById(record.id).catch(() => null);
    const wanted = product ? (await selectForListing(profileOf(product), settings)).selected.map((x) => x.group.id) : [];
    const complete = hasMarketplace.has(record.id) && wanted.every((id) => done.has(id));
    if (complete) continue;
    const result = await enqueueForListing(record.id, record.jobId).catch(() => null);
    if (result && (result.marketplace === "created" || result.groupsCreated > 0)) enqueued += 1;
  }
  return { examined, enqueued };
}

// ---------------------------------------------------------------------------
// Återhämtningen vid uppstart
// ---------------------------------------------------------------------------

export async function recoverInterrupted(): Promise<{ requeued: number; manual: number; failed: number }> {
  let requeued = 0;
  let manual = 0;
  let failed = 0;
  for (const p of await allMarketplace()) {
    if (p.status !== "PREPARING") continue;
    if (p.phase === "publish_clicked") {
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: "Processen dog efter att Publicera tryckts men innan utfallet lästs. Kontrollera Marketplace för hand — ett omförsök kan ge två annonser." }));
      await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: `Marketplace ${p.listingId}: Publicera kan ha tryckts utan verifiering (omstart).`, url: null, screenshot: p.screenshot, lastCompletedStep: p.steps.at(-1)?.name ?? null, context: { worker: "marketplace", listingId: p.listingId } });
      manual += 1;
    } else if (p.attempts >= MAX_ATTEMPTS) {
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "FAILED", phase: null, failureReason: "Avbröts av en omstart för tredje gången." }));
      failed += 1;
    } else {
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "QUEUED", phase: null }));
      requeued += 1;
    }
  }
  for (const p of await allGroupPublications()) {
    if (p.status !== "PREPARING") continue;
    if (p.phase === "publish_clicked") {
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: "Processen dog efter att Publicera tryckts men innan utfallet lästs. Kontrollera gruppen för hand — ett omförsök kan ge två inlägg." }));
      await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: `Grupp-inlägg ${p.listingId} i ${p.groupId}: Publicera kan ha tryckts utan verifiering (omstart).`, url: null, screenshot: p.screenshot, lastCompletedStep: p.steps.at(-1)?.name ?? null, context: { worker: "group-post", listingId: p.listingId, groupId: p.groupId } });
      manual += 1;
    } else if (p.attempts >= MAX_ATTEMPTS) {
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "FAILED", phase: null, failureReason: "Avbröts av en omstart för tredje gången." }));
      failed += 1;
    } else {
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "QUEUED", phase: null }));
      requeued += 1;
    }
  }
  if (requeued || manual || failed) {
    await logEvent({ worker: "queue", level: "warning", action: "ÅTERHÄMTNING", target: null, detail: `${requeued} köposter återställda till kö, ${manual} kräver en människa, ${failed} gav upp.` });
  }
  return { requeued, manual, failed };
}

// ---------------------------------------------------------------------------
// Körningen
// ---------------------------------------------------------------------------

export interface ProcessResult {
  marketplace: Array<{ listingId: string; status: MarketplacePublication["status"]; detail: string | null }>;
  groups: Array<{ listingId: string; groupId: string; status: GroupPublication["status"]; detail: string | null }>;
  stoppedBy: string | null;
}

async function sessionBlocks(): Promise<string | null> {
  const s = await lastKnownSession();
  if (s && (s.status === "CHECKPOINT" || s.status === "RESTRICTED")) {
    return `Sessionen står i ${s.status} (${s.detail}). Lös det i webbläsaren och markera åtgärden som klar.`;
  }
  return null;
}

async function waitForWriteGap(): Promise<void> {
  const limits = facebookLimits();
  const last = await lastWriteAt();
  if (!last) return;
  const gap = Date.now() - Date.parse(last);
  const need = limits.minSecondsBetweenWrites * 1000;
  if (gap < need) await new Promise((r) => setTimeout(r, need - gap));
}

/** Är möbeln fortfarande till salu på Loopa? En såld möbel ska inte gå ut på Facebook. */
async function stillForSale(loopaId: string): Promise<string | null> {
  const record = await butikStore().get(loopaId);
  if (!record) return "Möbeln finns inte i butikslagret.";
  if (record.state !== "live" && record.state !== "reserved") return `Möbeln är inte till salu längre (${record.state}).`;
  return null;
}

/**
 * Kör det som står i kö: Marketplace först (en per annons), sedan grupp-inläggen. `max` skrivningar
 * per varv. Stannar vid första avbrott — resten ligger kvar i kö.
 */
export async function processQueue(opts: { max?: number; force?: boolean } = {}): Promise<ProcessResult> {
  const result: ProcessResult = { marketplace: [], groups: [], stoppedBy: null };
  if (!facebookEnabled() && !opts.force) return { ...result, stoppedBy: "FACEBOOK_ENABLED är inte satt." };
  const blocked = await sessionBlocks();
  if (blocked) return { ...result, stoppedBy: blocked };

  const settings = await readSettings();
  const limits = facebookLimits();
  const dryRun = facebookDryRun();
  let budget = opts.max ?? 3;

  const sinceMidnight = new Date();
  sinceMidnight.setHours(0, 0, 0, 0);

  // ── Marketplace ────────────────────────────────────────────────────────
  if (facebookMarketplaceEnabled() && !settings.marketplacePaused) {
    const queued = (await allMarketplace()).filter((p) => p.status === "QUEUED").sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const p of queued) {
      if (budget <= 0) break;
      if (!dryRun && (await writesSince("marketplace", sinceMidnight)) >= limits.maxMarketplacePerDay) {
        result.stoppedBy = `Dagsgränsen ${limits.maxMarketplacePerDay} Marketplace-annonser är nådd.`;
        break;
      }
      const outcome = await runMarketplace(p, dryRun);
      result.marketplace.push(outcome);
      budget -= 1;
      if (outcome.status === "NEEDS_MANUAL_ACTION" && /avbrott|checkpoint|captcha|inloggning|begräns/i.test(outcome.detail ?? "")) {
        result.stoppedBy = outcome.detail;
        return result;
      }
    }
  }

  // ── Grupperna ──────────────────────────────────────────────────────────
  if (facebookGroupPublishingEnabled() && !settings.groupPublishingPaused) {
    const maxGroupPostsPerDay = effectiveMaxGroupPostsPerDay(settings);
    const queued = (await allGroupPublications()).filter((p) => p.status === "QUEUED").sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const p of queued) {
      if (budget <= 0) break;
      if (!dryRun && (await writesSince("group_post", sinceMidnight)) >= maxGroupPostsPerDay) {
        result.stoppedBy = `Dagsgränsen ${maxGroupPostsPerDay} grupp-inlägg är nådd.`;
        break;
      }
      const outcome = await runGroupPost(p, dryRun);
      result.groups.push(outcome);
      budget -= 1;
      if (outcome.status === "NEEDS_MANUAL_ACTION" && /avbrott|checkpoint|captcha|inloggning|begräns/i.test(outcome.detail ?? "")) {
        result.stoppedBy = outcome.detail;
        return result;
      }
    }
  }
  return result;
}

async function runMarketplace(p: MarketplacePublication, dryRun: boolean): Promise<ProcessResult["marketplace"][number]> {
  const notForSale = await stillForSale(p.listingId);
  if (notForSale) {
    await updateMarketplace(p.listingId, (c) => ({ ...c, status: "FAILED", failureReason: notForSale }));
    return { listingId: p.listingId, status: "FAILED", detail: notForSale };
  }
  const job = await getJob(p.jobId);
  const readiness = job ? await facebookListingFor(job) : ({ ok: false, reason: "Jobbet finns inte." } as const);
  if (!readiness.ok) {
    await updateMarketplace(p.listingId, (c) => ({ ...c, status: "FAILED", failureReason: readiness.reason }));
    return { listingId: p.listingId, status: "FAILED", detail: readiness.reason };
  }
  const listing = readiness.listing;

  const { logga, steps, flush } = stegLogg(`marketplace ${p.listingId}`, (s) => updateMarketplace(p.listingId, (c) => ({ ...c, steps: s })).then(() => undefined));
  await updateMarketplace(p.listingId, (c) => ({ ...c, status: "PREPARING", phase: "before_publish", attempts: c.attempts + 1, attemptedAt: new Date().toISOString(), dryRun, failureReason: null, contentSnapshot: marketplaceSnapshot(listing, "") }));
  logga(dryRun ? "Startar TORRKÖRNING — Publicera trycks inte" : "Startar SKARP publicering", "running", { rubrik: listing.title, pris: listing.price, bilder: listing.imagePaths.length });

  const onPhase = async (phase: PublicationPhase) => {
    await updateMarketplace(p.listingId, (c) => ({ ...c, phase }));
  };

  try {
    if (!dryRun) await waitForWriteGap();
    const run = await withFacebookBrowser("marketplace", ({ page }) => driveMarketplaceForm(page, { listing, dryRun, onPhase }, logga));
    await flush();
    if (run.status === "WOULD_PUBLISH") {
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "WOULD_PUBLISH", phase: "before_publish", screenshot: run.screenshot, failureReason: null, contentSnapshot: marketplaceSnapshot(listing, run.categoryPicked ?? ""), steps: [...steps, ...run.observations.map((o) => ({ name: `Observation: ${o}`, status: "ok" as const, at: new Date().toISOString() }))] }));
      await logEvent({ worker: "marketplace", level: "ok", action: "WOULD_PUBLISH", target: p.listingId, detail: `${listing.title}: formuläret ifyllt fram till Publicera. ${run.observations.join(" ")}` });
      return { listingId: p.listingId, status: "WOULD_PUBLISH", detail: run.observations.join(" ") };
    }
    if (run.status === "RESTRICTED") {
      // Facebook säger nej till Marketplace för kontot. Posten väntar på en människa, och Marketplace
      // pausas så att inte varje köad möbel öppnar formuläret bara för att läsa samma besked.
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", phase: null, screenshot: run.screenshot, failureReason: run.failureReason, steps: [...steps, ...run.observations.map((o) => ({ name: `Observation: ${o}`, status: "warning" as const, at: new Date().toISOString() }))] }));
      await recordManualAction({ kind: "RESTRICTED", reason: run.failureReason ?? "Marketplace begränsat.", url: null, screenshot: run.screenshot, lastCompletedStep: steps.at(-1)?.name ?? null, context: { worker: "marketplace", listingId: p.listingId } });
      await writeSettings({ marketplacePaused: true }, "system:marketplace-restricted");
      await logEvent({ worker: "marketplace", level: "error", action: "BEGRÄNSAD", target: p.listingId, detail: `${run.failureReason} Marketplace pausades i panelen.` });
      return { listingId: p.listingId, status: "NEEDS_MANUAL_ACTION", detail: run.failureReason };
    }
    if (run.status === "PUBLISHED") {
      await recordWrite("marketplace", p.listingId);
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: run.url ? "PUBLISHED" : "NEEDS_MANUAL_ACTION", phase: run.url ? "verified" : "publish_clicked", publishedAt: new Date().toISOString(), facebookUrl: run.url, facebookListingId: run.listingId, moderation: run.moderation, screenshot: run.screenshot, failureReason: run.failureReason, contentSnapshot: marketplaceSnapshot(listing, run.categoryPicked ?? "") }));
      if (!run.url) await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: run.failureReason ?? "Publicera tryckt utan verifierad adress.", url: null, screenshot: run.screenshot, lastCompletedStep: steps.at(-1)?.name ?? null, context: { worker: "marketplace", listingId: p.listingId } });
      await logEvent({ worker: "marketplace", level: run.url ? "ok" : "warning", action: "PUBLICERAD", target: p.listingId, detail: run.url ?? run.failureReason ?? "" });
      return { listingId: p.listingId, status: run.url ? "PUBLISHED" : "NEEDS_MANUAL_ACTION", detail: run.url ?? run.failureReason };
    }
    await updateMarketplace(p.listingId, (c) => ({ ...c, status: "FAILED", phase: null, screenshot: run.screenshot, failureReason: run.failureReason, steps: [...steps, ...run.observations.map((o) => ({ name: `Observation: ${o}`, status: "warning" as const, at: new Date().toISOString() }))] }));
    await logEvent({ worker: "marketplace", level: "error", action: "MISSLYCKAD", target: p.listingId, detail: run.failureReason ?? "okänt fel" });
    return { listingId: p.listingId, status: "FAILED", detail: run.failureReason };
  } catch (err) {
    await flush();
    const current = (await allMarketplace()).find((c) => c.listingId === p.listingId);
    const clicked = current?.phase === "publish_clicked";
    if (err instanceof FacebookInterrupt) {
      await recordInterrupt(err, { worker: "marketplace", listingId: p.listingId }, steps.at(-1)?.name ?? null);
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: `Avbrott: ${err.message}`, screenshot: err.screenshot ?? c.screenshot }));
      return { listingId: p.listingId, status: "NEEDS_MANUAL_ACTION", detail: `Avbrott: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (clicked) {
      await updateMarketplace(p.listingId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: `Fel efter att Publicera tryckts: ${message}. Kontrollera Marketplace för hand.` }));
      await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: `Marketplace ${p.listingId}: fel efter Publicera — ${message}`, url: null, screenshot: current?.screenshot ?? null, lastCompletedStep: steps.at(-1)?.name ?? null, context: { worker: "marketplace", listingId: p.listingId } });
      return { listingId: p.listingId, status: "NEEDS_MANUAL_ACTION", detail: message };
    }
    const attempts = current?.attempts ?? 1;
    const status = attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED";
    await updateMarketplace(p.listingId, (c) => ({ ...c, status, phase: null, failureReason: message }));
    await logEvent({ worker: "marketplace", level: "error", action: status === "QUEUED" ? "FÖLL — KÖAS OM" : "MISSLYCKAD", target: p.listingId, detail: message });
    return { listingId: p.listingId, status, detail: message };
  }
}

async function runGroupPost(p: GroupPublication, dryRun: boolean): Promise<ProcessResult["groups"][number]> {
  const notForSale = await stillForSale(p.listingId);
  if (notForSale) {
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "FAILED", failureReason: notForSale }));
    return { listingId: p.listingId, groupId: p.groupId, status: "FAILED", detail: notForSale };
  }
  const group = await getGroup(p.groupId);
  if (!group) {
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "FAILED", failureReason: "Gruppen finns inte i lagret." }));
    return { listingId: p.listingId, groupId: p.groupId, status: "FAILED", detail: "Gruppen finns inte i lagret." };
  }
  const job = await getJob(p.jobId);
  const readiness = job ? await facebookListingFor(job) : ({ ok: false, reason: "Jobbet finns inte." } as const);
  if (!readiness.ok) {
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "FAILED", failureReason: readiness.reason }));
    return { listingId: p.listingId, groupId: p.groupId, status: "FAILED", detail: readiness.reason };
  }
  const listing = readiness.listing;

  const { logga, steps, flush } = stegLogg(`grupp ${p.groupId} ${p.listingId}`, (s) => updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, steps: s })).then(() => undefined));
  await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "PREPARING", phase: "before_publish", attempts: c.attempts + 1, attemptedAt: new Date().toISOString(), dryRun, failureReason: null, composer: group.composerKind, contentSnapshot: group.composerKind === "listing" ? groupListingSnapshot(listing) : groupSnapshot(listing) }));
  const onPhase = async (phase: PublicationPhase) => {
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, phase }));
  };

  try {
    if (!dryRun) await waitForWriteGap();
    const run = await withFacebookBrowser("group-post", async ({ page }) => {
      // Reglerna läses om när de är gamla — före varje publicering, inte en gång för alltid.
      let current = group;
      if (rulesStale(current.rulesLastCheckedAt, facebookLimits().rulesMaxAgeHours)) {
        logga("Reglerna är gamla — läser om gruppsidan först", "running", {});
        const snap = await inspectGroup(page, current.canonicalUrl);
        if (snap.exists) {
          current = await applySnapshot(current, snap);
          await putGroup(current);
          logga(`Regler ${current.adsStatus}, medlemskap ${current.membershipStatus}`, "ok", {});
        }
      }
      const eligibility = computePostEligibility(current);
      if (!eligibility.eligible) {
        return { status: "FAILED" as const, postUrl: null, screenshot: null, observations: [], failureReason: `Gruppen är inte postbar längre: ${eligibility.reasons.join("; ")}.` };
      }
      return driveGroupPost(page, { group: current, listing, dryRun, onPhase }, logga);
    });
    await flush();
    const obs = run.observations.map((o) => ({ name: `Observation: ${o}`, status: "ok" as const, at: new Date().toISOString() }));
    if (run.status === "WOULD_PUBLISH") {
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "WOULD_PUBLISH", phase: "before_publish", composer: run.composer ?? c.composer ?? null, contentSnapshot: run.composer === "listing" ? groupListingSnapshot(listing) : run.composer === "post" ? groupSnapshot(listing) : c.contentSnapshot, screenshot: run.screenshot, failureReason: null, steps: [...steps, ...obs] }));
      await logEvent({ worker: "group-post", level: "ok", action: "WOULD_PUBLISH", target: `${p.listingId} → ${p.groupId}`, detail: `${listing.title} i ${group.name}: inlägget ifyllt fram till Publicera. ${run.observations.join(" ")}` });
      return { listingId: p.listingId, groupId: p.groupId, status: "WOULD_PUBLISH", detail: run.observations.join(" ") };
    }
    if (run.status === "PUBLISHED" || run.status === "PENDING_ADMIN_APPROVAL") {
      await recordWrite("group_post", `${p.listingId}:${p.groupId}`);
      const verified = run.status === "PENDING_ADMIN_APPROVAL" || !!run.postUrl;
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: verified ? "PUBLISHED" : "NEEDS_MANUAL_ACTION", phase: verified ? "verified" : "publish_clicked", publishedAt: new Date().toISOString(), facebookPostUrl: run.postUrl, composer: run.composer ?? c.composer ?? null, facebookListingId: run.facebookListingId, moderation: run.moderation, contentSnapshot: run.composer === "listing" ? groupListingSnapshot(listing) : run.composer === "post" ? groupSnapshot(listing) : c.contentSnapshot, screenshot: run.screenshot, failureReason: verified ? (run.status === "PENDING_ADMIN_APPROVAL" ? "Inlägget väntar på gruppadministratörens godkännande." : null) : run.failureReason, steps: [...steps, ...obs] }));
      await updateGroup(p.groupId, (g) => ({ ...g, lastPostedAt: new Date().toISOString() }));
      if (!verified) await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: run.failureReason ?? "Publicera tryckt utan verifierat inlägg.", url: group.canonicalUrl, screenshot: run.screenshot, lastCompletedStep: steps.at(-1)?.name ?? null, context: { worker: "group-post", listingId: p.listingId, groupId: p.groupId } });
      await logEvent({ worker: "group-post", level: verified ? "ok" : "warning", action: "PUBLICERAD", target: `${p.listingId} → ${p.groupId}`, detail: run.postUrl ?? run.failureReason ?? run.status });
      return { listingId: p.listingId, groupId: p.groupId, status: verified ? "PUBLISHED" : "NEEDS_MANUAL_ACTION", detail: run.postUrl ?? run.failureReason };
    }
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "FAILED", phase: null, screenshot: run.screenshot, failureReason: run.failureReason, steps: [...steps, ...obs] }));
    await logEvent({ worker: "group-post", level: "error", action: "MISSLYCKAD", target: `${p.listingId} → ${p.groupId}`, detail: run.failureReason ?? "okänt fel" });
    return { listingId: p.listingId, groupId: p.groupId, status: "FAILED", detail: run.failureReason };
  } catch (err) {
    await flush();
    const current = (await allGroupPublications()).find((c) => c.listingId === p.listingId && c.groupId === p.groupId);
    const clicked = current?.phase === "publish_clicked";
    if (err instanceof FacebookInterrupt) {
      await recordInterrupt(err, { worker: "group-post", listingId: p.listingId, groupId: p.groupId }, steps.at(-1)?.name ?? null);
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: `Avbrott: ${err.message}`, screenshot: err.screenshot ?? c.screenshot }));
      return { listingId: p.listingId, groupId: p.groupId, status: "NEEDS_MANUAL_ACTION", detail: `Avbrott: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (clicked) {
      await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status: "NEEDS_MANUAL_ACTION", failureReason: `Fel efter att Publicera tryckts: ${message}. Kontrollera gruppen för hand.` }));
      await recordManualAction({ kind: "UNVERIFIED_WRITE", reason: `Grupp-inlägg ${p.listingId} i ${p.groupId}: fel efter Publicera — ${message}`, url: group.canonicalUrl, screenshot: current?.screenshot ?? null, lastCompletedStep: steps.at(-1)?.name ?? null, context: { worker: "group-post", listingId: p.listingId, groupId: p.groupId } });
      return { listingId: p.listingId, groupId: p.groupId, status: "NEEDS_MANUAL_ACTION", detail: message };
    }
    const attempts = current?.attempts ?? 1;
    const status = attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED";
    await updateGroupPublication(p.listingId, p.groupId, (c) => ({ ...c, status, phase: null, failureReason: message }));
    return { listingId: p.listingId, groupId: p.groupId, status, detail: message };
  }
}

// ---------------------------------------------------------------------------
// Bakgrundsarbetarna
// ---------------------------------------------------------------------------

let started = false;

/**
 * Startar arbetarna i serverprocessen. Av av sig själv utan FACEBOOK_ENABLED=1. Första körningarna
 * ligger några minuter efter start, som Blocket-vakten — Chromium ska inte konkurrera med uppstarten.
 */
export function startFacebookWorkers(): void {
  if (started) return;
  started = true;
  if (!facebookEnabled()) {
    console.info("[facebook] avstängt (FACEBOOK_ENABLED är inte satt) — inga arbetare startar");
    return;
  }
  const limits = facebookLimits();
  console.info(
    `[facebook] på — ${facebookDryRun() ? "TORRKÖRNING (Publicera trycks aldrig)" : "SKARPT LÄGE"}, upptäckt ${facebookAutoDiscover() ? "på" : "av"}, ` +
      `kö var ${limits.publishTickSeconds}:e sekund, medlemsvakt var ${limits.membershipCheckMinutes}:e minut, upptäckt var ${limits.discoveryIntervalMinutes}:e minut`,
  );

  void recoverInterrupted().catch((err) => console.warn("[facebook] återhämtningen föll:", err));

  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[facebook] ${name} föll: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tick = safe("kö", async () => {
    await sweepLiveListings();
    await processQueue({ max: 2 });
  });
  // Medlemslistan läses HÄR, i serverprocessen. Lagret cachar per process, så en synk från cli.ts medan
  // servern kör skrevs över av serverns nästa sparning — 116 medlemsgrupper försvann så 2026-09-28.
  // Vakten går före upptäckten (5 min mot 8), så valideringen ser medlemskapen redan första varvet.
  const watch = safe("medlemsvakt", async () => {
    await syncOwnMemberships();
    await recheckMemberships();
  });
  const discover = safe("upptäckt", async () => {
    if (!facebookAutoDiscover()) return;
    await runDiscovery();
    await validateGroups({ max: 6 });
    await runAutoJoin();
  });

  setTimeout(() => void tick(), 3 * 60_000).unref();
  setInterval(() => void tick(), limits.publishTickSeconds * 1000).unref();
  setTimeout(() => void watch(), 5 * 60_000).unref();
  setInterval(() => void watch(), limits.membershipCheckMinutes * 60_000).unref();
  setTimeout(() => void discover(), 8 * 60_000).unref();
  setInterval(() => void discover(), limits.discoveryIntervalMinutes * 60_000).unref();
}
