/**
 * Facebook-lagret: grupper, köer, session, inställningar och manuella åtgärder — på disk.
 *
 * SAMMA FORM SOM BUTIKENS FILRYGG (butik/store.ts): JSON-filer under server/data/facebook, en
 * låskedja runt varje skrivning så att läs-ändra-skriv aldrig delas av två anrop, och en katalog som
 * går att peka om (FACEBOOK_DATA_DIR) så att testerna aldrig skriver bland skarpa data.
 *
 * VARFÖR INTE I MINNET. Idempotensen för externa skrivningar bor här: en Marketplace-post är unik per
 * Loopa-ID och en grupp-post unik per Loopa-ID + grupp, och `phase` säger om sista knappen redan
 * tryckts. Dör processen mitt i en körning måste nästa start kunna läsa det — annars blir ett omförsök
 * två annonser.
 *
 * VARFÖR INTE SUPABASE ÄN. Butiken har en Postgres-rygg bakom ett uttryckligt val (datalagring.ts);
 * Facebook-lagret är nytt och körs på en maskin, en process. Gränssnittet nedan är det som ska stå
 * kvar den dag en Postgres-rygg läggs till — anroparna vet ingenting om filer.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { facebookDataDir } from "./config.js";
import {
  DEFAULT_FACEBOOK_SETTINGS,
  type FacebookGroup,
  type FacebookSessionRecord,
  type FacebookSettings,
  type GroupPublication,
  type ManualAction,
  type MarketplacePublication,
  type OperatorProfile,
  type PublicationStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Filerna
// ---------------------------------------------------------------------------

const FILES = {
  groups: "groups.json",
  marketplace: "marketplace.json",
  groupPublications: "group-publications.json",
  session: "session.json",
  settings: "settings.json",
  manualActions: "manual-actions.json",
  discovery: "discovery.json",
  writes: "writes.jsonl",
  events: "events.jsonl",
} as const;

function fil(namn: string): string {
  return path.join(facebookDataDir(), namn);
}

/** En låskedja, inte ett lås. Se butik/store.ts för resonemanget. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** Cachen är per fil OCH per katalog, så ett testbyte av FACEBOOK_DATA_DIR inte läser fel lager. */
const cache = new Map<string, unknown>();

async function las<T>(namn: string, fallback: T): Promise<T> {
  const key = fil(namn);
  if (cache.has(key)) return cache.get(key) as T;
  try {
    const raw = await readFile(key, "utf-8");
    const parsed = JSON.parse(raw) as T;
    cache.set(key, parsed);
    return parsed;
  } catch {
    cache.set(key, fallback);
    return fallback;
  }
}

async function skriv<T>(namn: string, value: T): Promise<void> {
  const key = fil(namn);
  await mkdir(path.dirname(key), { recursive: true });
  await writeFile(key, JSON.stringify(value, null, 2), "utf-8");
  cache.set(key, value);
}

async function laggTill(namn: string, rad: unknown): Promise<void> {
  const key = fil(namn);
  await mkdir(path.dirname(key), { recursive: true });
  await appendFile(key, JSON.stringify(rad) + "\n", "utf-8");
}

async function lasRader<T>(namn: string): Promise<T[]> {
  try {
    const raw = await readFile(fil(namn), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/** Bara för tester: glöm cachen efter att miljön bytts. */
export function resetFacebookStore(): void {
  cache.clear();
}

const nu = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Grupperna
// ---------------------------------------------------------------------------

export async function allGroups(): Promise<FacebookGroup[]> {
  return [...(await las<FacebookGroup[]>(FILES.groups, []))];
}

export async function getGroup(id: string): Promise<FacebookGroup | null> {
  return (await las<FacebookGroup[]>(FILES.groups, [])).find((g) => g.id === id) ?? null;
}

/** Upsert på gruppnyckeln. Aldrig två poster för samma grupp. */
export async function putGroup(group: FacebookGroup): Promise<FacebookGroup> {
  return serialize(async () => {
    const groups = await las<FacebookGroup[]>(FILES.groups, []);
    const saved = { ...group, updatedAt: nu() };
    const i = groups.findIndex((g) => g.id === group.id);
    if (i >= 0) groups[i] = saved;
    else groups.push(saved);
    await skriv(FILES.groups, groups);
    return saved;
  });
}

/** Läs-ändra-skriv inne i låskedjan. Null när gruppen inte finns. */
export async function updateGroup(id: string, patch: (g: FacebookGroup) => FacebookGroup): Promise<FacebookGroup | null> {
  return serialize(async () => {
    const groups = await las<FacebookGroup[]>(FILES.groups, []);
    const i = groups.findIndex((g) => g.id === id);
    if (i < 0) return null;
    const next = { ...patch(groups[i]), updatedAt: nu() };
    groups[i] = next;
    await skriv(FILES.groups, groups);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Marketplace-publiceringarna — EN per Loopa-ID
// ---------------------------------------------------------------------------

export async function allMarketplace(): Promise<MarketplacePublication[]> {
  return [...(await las<MarketplacePublication[]>(FILES.marketplace, []))];
}

export async function getMarketplace(listingId: string): Promise<MarketplacePublication | null> {
  return (await las<MarketplacePublication[]>(FILES.marketplace, [])).find((p) => p.listingId === listingId) ?? null;
}

/**
 * Ställer annonsen i kö. IDEMPOTENT: finns en post redan — i vilket läge den än står — skapas ingen ny
 * och `created` är falskt. Det är den här raden som gör att ett andra godkännande, en omstart eller en
 * städsvepning aldrig kan ge två Marketplace-annonser.
 */
export async function enqueueMarketplace(
  listingId: string,
  jobId: string,
  dryRun: boolean,
): Promise<{ created: boolean; publication: MarketplacePublication }> {
  return serialize(async () => {
    const list = await las<MarketplacePublication[]>(FILES.marketplace, []);
    const existing = list.find((p) => p.listingId === listingId);
    if (existing) return { created: false, publication: existing };
    const publication: MarketplacePublication = {
      listingId,
      jobId,
      status: "QUEUED",
      phase: null,
      attempts: 0,
      queuedAt: nu(),
      attemptedAt: null,
      publishedAt: null,
      facebookUrl: null,
      facebookListingId: null,
      failureReason: null,
      screenshot: null,
      contentSnapshot: null,
      dryRun,
      steps: [],
      updatedAt: nu(),
    };
    list.push(publication);
    await skriv(FILES.marketplace, list);
    return { created: true, publication };
  });
}

export async function updateMarketplace(
  listingId: string,
  patch: (p: MarketplacePublication) => MarketplacePublication,
): Promise<MarketplacePublication | null> {
  return serialize(async () => {
    const list = await las<MarketplacePublication[]>(FILES.marketplace, []);
    const i = list.findIndex((p) => p.listingId === listingId);
    if (i < 0) return null;
    list[i] = { ...patch(list[i]), updatedAt: nu() };
    await skriv(FILES.marketplace, list);
    return list[i];
  });
}

// ---------------------------------------------------------------------------
// Grupp-publiceringarna — EN per Loopa-ID + grupp
// ---------------------------------------------------------------------------

export async function allGroupPublications(): Promise<GroupPublication[]> {
  return [...(await las<GroupPublication[]>(FILES.groupPublications, []))];
}

export async function groupPublicationsFor(listingId: string): Promise<GroupPublication[]> {
  return (await las<GroupPublication[]>(FILES.groupPublications, [])).filter((p) => p.listingId === listingId);
}

export async function getGroupPublication(listingId: string, groupId: string): Promise<GroupPublication | null> {
  return (
    (await las<GroupPublication[]>(FILES.groupPublications, [])).find((p) => p.listingId === listingId && p.groupId === groupId) ??
    null
  );
}

/** Samma idempotens som Marketplace-kön, med nyckeln listingId + groupId. */
export async function enqueueGroupPublication(
  listingId: string,
  groupId: string,
  jobId: string,
  dryRun: boolean,
): Promise<{ created: boolean; publication: GroupPublication }> {
  return serialize(async () => {
    const list = await las<GroupPublication[]>(FILES.groupPublications, []);
    const existing = list.find((p) => p.listingId === listingId && p.groupId === groupId);
    if (existing) return { created: false, publication: existing };
    const publication: GroupPublication = {
      listingId,
      groupId,
      jobId,
      status: "QUEUED",
      phase: null,
      attempts: 0,
      queuedAt: nu(),
      attemptedAt: null,
      publishedAt: null,
      facebookPostUrl: null,
      failureReason: null,
      screenshot: null,
      contentSnapshot: null,
      dryRun,
      steps: [],
      updatedAt: nu(),
    };
    list.push(publication);
    await skriv(FILES.groupPublications, list);
    return { created: true, publication };
  });
}

export async function updateGroupPublication(
  listingId: string,
  groupId: string,
  patch: (p: GroupPublication) => GroupPublication,
): Promise<GroupPublication | null> {
  return serialize(async () => {
    const list = await las<GroupPublication[]>(FILES.groupPublications, []);
    const i = list.findIndex((p) => p.listingId === listingId && p.groupId === groupId);
    if (i < 0) return null;
    list[i] = { ...patch(list[i]), updatedAt: nu() };
    await skriv(FILES.groupPublications, list);
    return list[i];
  });
}

/** Lägen som räknas som "väntar på en körning". */
export const RUNNABLE_STATUSES: readonly PublicationStatus[] = ["QUEUED"];

// ---------------------------------------------------------------------------
// Sessionen
// ---------------------------------------------------------------------------

export async function readSession(): Promise<FacebookSessionRecord | null> {
  return las<FacebookSessionRecord | null>(FILES.session, null);
}

export async function writeSession(record: FacebookSessionRecord): Promise<void> {
  await serialize(() => skriv(FILES.session, record));
}

// ---------------------------------------------------------------------------
// Inställningarna och operatörsprofilen
// ---------------------------------------------------------------------------

export async function readSettings(): Promise<FacebookSettings> {
  const saved = await las<Partial<FacebookSettings>>(FILES.settings, {});
  return {
    ...DEFAULT_FACEBOOK_SETTINGS,
    ...saved,
    operatorProfile: { ...DEFAULT_FACEBOOK_SETTINGS.operatorProfile, ...(saved.operatorProfile ?? {}) },
  };
}

export async function writeSettings(
  patch: Partial<Omit<FacebookSettings, "operatorProfile" | "updatedAt" | "updatedBy">> & { operatorProfile?: Partial<OperatorProfile> },
  adminId: string | null,
): Promise<FacebookSettings> {
  return serialize(async () => {
    const current = await readSettings();
    const next: FacebookSettings = {
      ...current,
      ...patch,
      operatorProfile: { ...current.operatorProfile, ...(patch.operatorProfile ?? {}) },
      updatedAt: nu(),
      updatedBy: adminId,
    };
    await skriv(FILES.settings, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Manuella åtgärder
// ---------------------------------------------------------------------------

export async function listManualActions(): Promise<ManualAction[]> {
  return [...(await las<ManualAction[]>(FILES.manualActions, []))].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function recordManualAction(
  input: Omit<ManualAction, "id" | "at" | "resolvedAt" | "resolvedBy">,
): Promise<ManualAction> {
  return serialize(async () => {
    const list = await las<ManualAction[]>(FILES.manualActions, []);
    const action: ManualAction = { id: randomUUID(), at: nu(), resolvedAt: null, resolvedBy: null, ...input };
    list.push(action);
    await skriv(FILES.manualActions, list);
    return action;
  });
}

export async function resolveManualAction(id: string, by: string | null): Promise<ManualAction | null> {
  return serialize(async () => {
    const list = await las<ManualAction[]>(FILES.manualActions, []);
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], resolvedAt: nu(), resolvedBy: by };
    await skriv(FILES.manualActions, list);
    return list[i];
  });
}

// ---------------------------------------------------------------------------
// Skrivningarna — för gränserna
// ---------------------------------------------------------------------------

export type WriteKind = "join" | "group_post" | "marketplace";

export interface WriteRecord {
  at: string;
  kind: WriteKind;
  ref: string;
}

/** Varje RIKTIG extern skrivning bokförs här, så gränserna räknar på vad som faktiskt skickats. */
export async function recordWrite(kind: WriteKind, ref: string): Promise<void> {
  await laggTill(FILES.writes, { at: nu(), kind, ref } satisfies WriteRecord);
}

export async function writesSince(kind: WriteKind, since: Date): Promise<number> {
  const rows = await lasRader<WriteRecord>(FILES.writes);
  return rows.filter((r) => r.kind === kind && Date.parse(r.at) >= since.getTime()).length;
}

export async function lastWriteAt(): Promise<string | null> {
  const rows = await lasRader<WriteRecord>(FILES.writes);
  return rows.at(-1)?.at ?? null;
}

// ---------------------------------------------------------------------------
// Upptäcktens läge
// ---------------------------------------------------------------------------

export interface DiscoveryState {
  lastRunAt: string | null;
  /** Var i frågelistan nästa varv börjar. Listan är lång; ett varv tar några frågor. */
  queryCursor: number;
  runs: Array<{ at: string; queries: string[]; hits: number; newGroups: number }>;
}

export async function readDiscoveryState(): Promise<DiscoveryState> {
  return las<DiscoveryState>(FILES.discovery, { lastRunAt: null, queryCursor: 0, runs: [] });
}

export async function writeDiscoveryState(state: DiscoveryState): Promise<void> {
  await serialize(() => skriv(FILES.discovery, { ...state, runs: state.runs.slice(-50) }));
}

// ---------------------------------------------------------------------------
// Händelseloggen — det panelen visar under "Senaste"
// ---------------------------------------------------------------------------

export interface FacebookEvent {
  at: string;
  worker: string;
  level: "info" | "ok" | "warning" | "error";
  action: string;
  target: string | null;
  detail: string;
}

export async function logEvent(event: Omit<FacebookEvent, "at">): Promise<void> {
  const rad: FacebookEvent = { at: nu(), ...event };
  console.info(`[facebook:${event.worker}] ${event.level.toUpperCase()} ${event.action}${event.target ? ` ${event.target}` : ""} — ${event.detail}`);
  await laggTill(FILES.events, rad).catch(() => undefined);
}

export async function recentEvents(limit = 100): Promise<FacebookEvent[]> {
  const rows = await lasRader<FacebookEvent>(FILES.events);
  return rows.slice(-limit).reverse();
}
