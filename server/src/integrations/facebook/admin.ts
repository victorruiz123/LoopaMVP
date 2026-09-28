/**
 * Panelens läsmodeller och åtgärder för Facebook. Ingenting räknas här som lagret redan räknar —
 * det sammanställs.
 */

import {
  facebookAutoDiscover,
  facebookAutoJoin,
  facebookDryRun,
  facebookEnabled,
  facebookGroupPublishingEnabled,
  facebookLimits,
  facebookMarketplaceEnabled,
  facebookMode,
  facebookProfileDir,
  type FacebookLimits,
} from "./config.js";
import { runDiscovery, syncOwnMemberships, validateGroups } from "./discovery.js";
import { recheckMemberships, runAutoJoin } from "./joining.js";
import { applyMembership, refreshEligibility } from "./membership.js";
import { facebookListingFor } from "./mapping.js";
import { compareGroups } from "./ranking.js";
import { profileOf, processQueue, selectForListing, sweepLiveListings } from "./queue.js";
import { browserBusy, lastKnownSession } from "./session.js";
import {
  allGroupPublications,
  allGroups,
  allMarketplace,
  getGroup,
  groupPublicationsFor,
  listManualActions,
  readDiscoveryState,
  readSettings,
  recentEvents,
  resolveManualAction,
  updateGroup,
  updateGroupPublication,
  updateMarketplace,
  writeSettings,
  type FacebookEvent,
} from "./store.js";
import type {
  AdsStatus,
  FacebookGroup,
  FacebookSessionRecord,
  FacebookSettings,
  GroupPublication,
  ManualAction,
  MarketplacePublication,
  MembershipStatus,
  OperatorProfile,
  PublicationStatus,
} from "./types.js";

export type WorkerState = "running" | "paused" | "off";

export interface FacebookOverview {
  enabled: boolean;
  mode: "live" | "mock";
  dryRun: boolean;
  profileDir: string;
  session: FacebookSessionRecord | null;
  browserBusyWith: string | null;
  flags: { autoDiscover: boolean; autoJoin: boolean; marketplaceEnabled: boolean; groupPublishingEnabled: boolean };
  workers: { discovery: WorkerState; autoJoin: WorkerState; marketplace: WorkerState; groupPublishing: WorkerState };
  settings: FacebookSettings;
  limits: FacebookLimits;
  groups: { discovered: number; validated: number; joinRequested: number; pending: number; member: number; postEligible: number; enabled: number; prohibited: number };
  marketplace: Record<PublicationStatus, number>;
  groupPosts: Record<PublicationStatus, number>;
  manualActionsOpen: number;
  lastDiscoveryAt: string | null;
  events: FacebookEvent[];
}

const STATUSES: PublicationStatus[] = ["QUEUED", "PREPARING", "WOULD_PUBLISH", "PUBLISHED", "FAILED", "NEEDS_MANUAL_ACTION"];

function countBy(items: Array<{ status: PublicationStatus }>): Record<PublicationStatus, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PublicationStatus, number>;
  for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1;
  return out;
}

function workerState(envOn: boolean, paused: boolean): WorkerState {
  if (!facebookEnabled() || !envOn) return "off";
  return paused ? "paused" : "running";
}

export async function facebookOverview(): Promise<FacebookOverview> {
  const [groups, marketplace, groupPosts, settings, session, manual, discovery, events] = await Promise.all([
    allGroups(),
    allMarketplace(),
    allGroupPublications(),
    readSettings(),
    lastKnownSession(),
    listManualActions(),
    readDiscoveryState(),
    recentEvents(60),
  ]);
  return {
    enabled: facebookEnabled(),
    mode: facebookMode(),
    dryRun: facebookDryRun(),
    profileDir: facebookProfileDir(),
    session,
    browserBusyWith: browserBusy(),
    flags: {
      autoDiscover: facebookAutoDiscover(),
      autoJoin: facebookAutoJoin(),
      marketplaceEnabled: facebookMarketplaceEnabled(),
      groupPublishingEnabled: facebookGroupPublishingEnabled(),
    },
    workers: {
      discovery: workerState(facebookAutoDiscover(), settings.discoveryPaused),
      autoJoin: workerState(facebookAutoJoin(), settings.autoJoinPaused),
      marketplace: workerState(facebookMarketplaceEnabled(), settings.marketplacePaused),
      groupPublishing: workerState(facebookGroupPublishingEnabled(), settings.groupPublishingPaused),
    },
    settings,
    limits: facebookLimits(),
    groups: {
      discovered: groups.length,
      validated: groups.filter((g) => g.lastValidatedAt).length,
      joinRequested: groups.filter((g) => g.membershipStatus === "JOIN_REQUESTED").length,
      pending: groups.filter((g) => g.membershipStatus === "PENDING_APPROVAL").length,
      member: groups.filter((g) => g.membershipStatus === "MEMBER").length,
      postEligible: groups.filter((g) => g.postEligible).length,
      enabled: groups.filter((g) => g.enabledForDistribution).length,
      prohibited: groups.filter((g) => g.adsStatus === "PROHIBITED").length,
    },
    marketplace: countBy(marketplace),
    groupPosts: countBy(groupPosts),
    manualActionsOpen: manual.filter((m) => !m.resolvedAt).length,
    lastDiscoveryAt: discovery.lastRunAt,
    events,
  };
}

// ---------------------------------------------------------------------------
// Grupperna
// ---------------------------------------------------------------------------

export interface GroupFilter {
  membership?: MembershipStatus | "pending" | "not_member" | null;
  ads?: AdsStatus | null;
  enabled?: boolean | null;
  q?: string | null;
}

export interface GroupRow extends FacebookGroup {
  publishedCount: number;
  queuedCount: number;
}

export async function listGroups(filter: GroupFilter = {}): Promise<GroupRow[]> {
  const [groups, posts] = await Promise.all([allGroups(), allGroupPublications()]);
  const q = filter.q?.trim().toLowerCase();
  return groups
    .filter((g) => {
      if (filter.membership === "pending") return g.membershipStatus === "JOIN_REQUESTED" || g.membershipStatus === "PENDING_APPROVAL";
      if (filter.membership === "not_member") return g.membershipStatus !== "MEMBER" && g.membershipStatus !== "JOIN_REQUESTED" && g.membershipStatus !== "PENDING_APPROVAL";
      if (filter.membership) return g.membershipStatus === filter.membership;
      return true;
    })
    .filter((g) => (filter.ads ? g.adsStatus === filter.ads : true))
    .filter((g) => (filter.enabled === true ? g.enabledForDistribution : filter.enabled === false ? !g.enabledForDistribution : true))
    .filter((g) => (q ? `${g.name} ${g.geography} ${g.canonicalUrl}`.toLowerCase().includes(q) : true))
    .sort(compareGroups)
    .map((g) => ({
      ...g,
      publishedCount: posts.filter((p) => p.groupId === g.id && p.status === "PUBLISHED").length,
      queuedCount: posts.filter((p) => p.groupId === g.id && (p.status === "QUEUED" || p.status === "PREPARING")).length,
    }));
}

export interface GroupDetail {
  group: FacebookGroup;
  publications: GroupPublication[];
  manualActions: ManualAction[];
}

export async function groupDetail(id: string): Promise<GroupDetail | null> {
  const group = await getGroup(id);
  if (!group) return null;
  const [posts, manual] = await Promise.all([allGroupPublications(), listManualActions()]);
  return {
    group,
    publications: posts.filter((p) => p.groupId === id).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
    manualActions: manual.filter((m) => m.context.groupId === id),
  };
}

export interface GroupPatch {
  /** Adminens brytare för distribution. Fryser gruppen mot automatiken (se membership.ts). */
  enabledForDistribution?: boolean;
  /** Nollställ medlemskapet till NOT_MEMBER — efter att en människa löst en fråga eller ett avbrott. */
  resetMembership?: boolean;
  /** En människa har gått med / svarat för hand: sätt läget uttryckligen. */
  membershipStatus?: MembershipStatus;
  note?: string;
}

export class FacebookAdminError extends Error {}

export async function patchGroup(id: string, patch: GroupPatch, adminId: string | null): Promise<FacebookGroup> {
  const limits = facebookLimits();
  const updated = await updateGroup(id, (g) => {
    let next = g;
    if (patch.resetMembership) next = applyMembership(next, "NOT_MEMBER", `Nollställt av admin${adminId ? ` ${adminId}` : ""}.${patch.note ? ` ${patch.note}` : ""}`);
    if (patch.membershipStatus && patch.membershipStatus !== next.membershipStatus) {
      next = applyMembership(next, patch.membershipStatus, `Satt av admin${adminId ? ` ${adminId}` : ""}.${patch.note ? ` ${patch.note}` : ""}`);
    }
    if (typeof patch.enabledForDistribution === "boolean") {
      next = { ...next, enabledForDistribution: patch.enabledForDistribution, enabledForDistributionSetBy: "admin" };
    }
    return refreshEligibility(next, limits);
  });
  if (!updated) throw new FacebookAdminError("Gruppen finns inte.");
  return updated;
}

// ---------------------------------------------------------------------------
// Publiceringarna
// ---------------------------------------------------------------------------

export interface ListingGroupSelection {
  /** Grupperna urvalet pekar ut just nu, bäst först — oavsett om de redan har en post. */
  selected: Array<{ id: string; name: string; score: number; reasons: string[] }>;
  /** Medlemsgrupper (och kandidater) som INTE valdes, med skälet. Samma lista som köandet räknar ut. */
  skipped: Array<{ id: string; name: string; reason: string }>;
}

export interface ListingChannelStatus {
  marketplace: MarketplacePublication | null;
  groups: GroupPublication[];
  groupsTotal: number;
  groupsPublished: number;
  groupsWouldPublish: number;
  /**
   * Urvalet räknat om LIVE (inte lagrat) — det panelen annars aldrig ser när `groups` är tom. `godkann`
   * köar via `onListingLive`, som kör exakt samma uträkning men kastar resultatet (fire-and-forget); det
   * är samma anledning en möbel kan hamna med noll grupp-poster utan en enda rad som säger varför. Null
   * när annonsen inte går att slå upp (jobbet saknas, eller Facebook-läsbarheten fallerar).
   */
  groupSelection: ListingGroupSelection | null;
}

export async function listingChannelStatus(loopaId: string): Promise<ListingChannelStatus> {
  const [marketplace, groups, groupSelection] = await Promise.all([allMarketplace(), groupPublicationsFor(loopaId), currentGroupSelection(loopaId)]);
  return {
    marketplace: marketplace.find((p) => p.listingId === loopaId) ?? null,
    groups,
    groupsTotal: groups.length,
    groupsPublished: groups.filter((p) => p.status === "PUBLISHED").length,
    groupsWouldPublish: groups.filter((p) => p.status === "WOULD_PUBLISH").length,
    groupSelection,
  };
}

async function currentGroupSelection(loopaId: string): Promise<ListingGroupSelection | null> {
  const { jobByLoopaId } = await import("../../publicCard.js");
  const job = await jobByLoopaId(loopaId).catch(() => undefined);
  if (!job) return null;
  const readiness = await facebookListingFor(job);
  if (!readiness.ok) return null;
  const settings = await readSettings();
  const result = await selectForListing(profileOf(readiness.listing), settings);
  return {
    selected: result.selected.map((x) => ({ id: x.group.id, name: x.group.name, score: x.score, reasons: x.reasons })),
    skipped: result.skipped,
  };
}

/** Snabb sammanställning för annonslistan — en rad per jobb behöver inte hela posten. */
export async function channelSummaries(): Promise<Map<string, { marketplace: PublicationStatus | null; groupsPublished: number; groupsTotal: number }>> {
  const [marketplace, groups] = await Promise.all([allMarketplace(), allGroupPublications()]);
  const out = new Map<string, { marketplace: PublicationStatus | null; groupsPublished: number; groupsTotal: number }>();
  for (const m of marketplace) out.set(m.listingId, { marketplace: m.status, groupsPublished: 0, groupsTotal: 0 });
  for (const g of groups) {
    const row = out.get(g.listingId) ?? { marketplace: null, groupsPublished: 0, groupsTotal: 0 };
    row.groupsTotal += 1;
    if (g.status === "PUBLISHED") row.groupsPublished += 1;
    out.set(g.listingId, row);
  }
  return out;
}

export async function listPublications(): Promise<{ marketplace: MarketplacePublication[]; groups: GroupPublication[]; manualActions: ManualAction[] }> {
  const [marketplace, groups, manualActions] = await Promise.all([allMarketplace(), allGroupPublications(), listManualActions()]);
  return {
    marketplace: marketplace.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
    groups: groups.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
    manualActions,
  };
}

/**
 * Ställer en publicering i kö igen. Från FAILED och WOULD_PUBLISH alltid; från NEEDS_MANUAL_ACTION bara
 * när en människa uttryckligen säger att den kontrollerat Facebook — det är den enda som kan veta att
 * det inte redan ligger en annons där.
 */
export async function retryPublication(kind: "marketplace" | "group", listingId: string, groupId: string | null, opts: { confirmedNoDuplicate?: boolean } = {}): Promise<void> {
  const allowFrom: PublicationStatus[] = ["FAILED", "WOULD_PUBLISH", ...(opts.confirmedNoDuplicate ? (["NEEDS_MANUAL_ACTION"] as PublicationStatus[]) : [])];
  if (kind === "marketplace") {
    const updated = await updateMarketplace(listingId, (c) => (allowFrom.includes(c.status) ? { ...c, status: "QUEUED", phase: null, failureReason: null } : c));
    if (!updated) throw new FacebookAdminError("Publiceringen finns inte.");
    if (updated.status !== "QUEUED") throw new FacebookAdminError(`Går inte att köa om från ${updated.status}${updated.status === "NEEDS_MANUAL_ACTION" ? " utan att bekräfta att Facebook kontrollerats" : ""}.`);
    return;
  }
  if (!groupId) throw new FacebookAdminError("groupId krävs.");
  const updated = await updateGroupPublication(listingId, groupId, (c) => (allowFrom.includes(c.status) ? { ...c, status: "QUEUED", phase: null, failureReason: null } : c));
  if (!updated) throw new FacebookAdminError("Publiceringen finns inte.");
  if (updated.status !== "QUEUED") throw new FacebookAdminError(`Går inte att köa om från ${updated.status}${updated.status === "NEEDS_MANUAL_ACTION" ? " utan att bekräfta att Facebook kontrollerats" : ""}.`);
}

// ---------------------------------------------------------------------------
// Inställningarna och åtgärderna
// ---------------------------------------------------------------------------

export interface SettingsPatch {
  operatorProfile?: Partial<OperatorProfile>;
  discoveryPaused?: boolean;
  autoJoinPaused?: boolean;
  marketplacePaused?: boolean;
  groupPublishingPaused?: boolean;
  /** Taket för grupper per annons. Null = miljöns förval. 0 = inga grupper. */
  maxGroupsPerListing?: number | null;
  /** Taket för grupp-inlägg per dag, totalt. Null = miljöns förval. 0 = inga grupp-inlägg. */
  maxGroupPostsPerDay?: number | null;
}

const PROFILE_FIELDS: Array<keyof OperatorProfile> = ["displayName", "city", "region", "interests", "businessAffiliation", "defaultJoinReason"];

export async function patchSettings(patch: SettingsPatch, adminId: string | null): Promise<FacebookSettings> {
  const profile: Partial<OperatorProfile> = {};
  for (const f of PROFILE_FIELDS) {
    const v = patch.operatorProfile?.[f];
    if (typeof v === "string") profile[f] = v.trim().slice(0, 300);
  }
  return writeSettings(
    {
      ...(typeof patch.discoveryPaused === "boolean" ? { discoveryPaused: patch.discoveryPaused } : {}),
      ...(typeof patch.autoJoinPaused === "boolean" ? { autoJoinPaused: patch.autoJoinPaused } : {}),
      ...(typeof patch.marketplacePaused === "boolean" ? { marketplacePaused: patch.marketplacePaused } : {}),
      ...(typeof patch.groupPublishingPaused === "boolean" ? { groupPublishingPaused: patch.groupPublishingPaused } : {}),
      ...(patch.maxGroupsPerListing === null
        ? { maxGroupsPerListing: null }
        : typeof patch.maxGroupsPerListing === "number" && Number.isInteger(patch.maxGroupsPerListing) && patch.maxGroupsPerListing >= 0 && patch.maxGroupsPerListing <= 50
          ? { maxGroupsPerListing: patch.maxGroupsPerListing }
          : {}),
      ...(patch.maxGroupPostsPerDay === null
        ? { maxGroupPostsPerDay: null }
        : typeof patch.maxGroupPostsPerDay === "number" && Number.isInteger(patch.maxGroupPostsPerDay) && patch.maxGroupPostsPerDay >= 0 && patch.maxGroupPostsPerDay <= 500
          ? { maxGroupPostsPerDay: patch.maxGroupPostsPerDay }
          : {}),
      operatorProfile: profile,
    },
    adminId,
  );
}

export async function resolveAction(id: string, adminId: string | null): Promise<ManualAction> {
  const action = await resolveManualAction(id, adminId);
  if (!action) throw new FacebookAdminError("Åtgärden finns inte.");
  return action;
}

export type RunKind = "session" | "discover" | "sync-memberships" | "validate" | "join" | "recheck" | "queue" | "sweep";

/**
 * Startar en körning i bakgrunden på begäran från panelen. Svarar direkt — körningen tar minuter och
 * skriver sitt utfall i lagret och händelseloggen. En webbläsare i taget: är den upptagen sägs det.
 */
export async function startRun(kind: RunKind, opts: { groupIds?: string[]; max?: number } = {}): Promise<{ started: boolean; reason: string | null }> {
  if (!facebookEnabled()) return { started: false, reason: "FACEBOOK_ENABLED är inte satt på servern." };
  const busy = browserBusy();
  if (busy && kind !== "sweep") return { started: false, reason: `Webbläsaren är upptagen med ${busy}. Försök om en stund.` };
  const run = async () => {
    switch (kind) {
      case "session": {
        const { withFacebookBrowser, checkSession } = await import("./session.js");
        await withFacebookBrowser("session-check", ({ page }) => checkSession(page));
        return;
      }
      case "discover":
        await runDiscovery({ force: true });
        return;
      case "sync-memberships":
        await syncOwnMemberships();
        return;
      case "validate":
        await validateGroups({ max: opts.max ?? 6, groupIds: opts.groupIds });
        return;
      case "join":
        await runAutoJoin({ groupIds: opts.groupIds, max: opts.max });
        return;
      case "recheck":
        await recheckMemberships({ force: true, groupIds: opts.groupIds });
        return;
      case "queue":
        await sweepLiveListings();
        await processQueue({ max: opts.max ?? 2 });
        return;
      case "sweep":
        await sweepLiveListings();
        return;
    }
  };
  void run().catch((err) => console.warn(`[facebook] körningen ${kind} föll: ${err instanceof Error ? err.message : String(err)}`));
  return { started: true, reason: null };
}
