/**
 * Tradera-posten: läser Gmail var halvtimme och gör det mejlen säger.
 *
 * VARFÖR MEJLEN OCH INTE API:T. Traderas REST v4 säger vad en annons kostar och om den ligger uppe,
 * men det är mejlen som bär händelserna — "din vara är såld", "du har fått en fråga" — och de kommer
 * i samma sekund som de sker. Att läsa dem är att läsa Traderas egen händelselogg, utan att pollas
 * per annons.
 *
 * TRE SAKER HÄNDER PER MEJL, i den här ordningen:
 *
 *   1. Mejlet tolkas (mail.ts) och läggs i posten (data/tradera-post.json). Posten är sanningen om
 *      vad vi sett; panelen läser den, och samma Message-ID hamnar aldrig där två gånger.
 *   2. Är det en försäljning och annonsen är vår, blir möbeln såld i butiken genom SAMMA
 *      tillståndsmaskin som kassan använder (`claimForSale`). Den vinner över en pågående
 *      reservation hos oss — möbeln är faktiskt borta. Ett null tillbaka betyder att den redan var
 *      såld, och det är inte ett fel.
 *   3. Ett brev går till adminadressen (TRADERA_MAIL_NOTIFY_TO, förval: Gmail-kontot självt) via
 *      utskicket. Med EMAIL_PROVIDER=gmail är det ett riktigt mejl; annars hamnar det i /outbox.
 *
 * MEJLEN RÖRS INTE. Ingen olästmarkering, ingen etikett, ingen flytt: inkorgen är ägarens. Markören
 * är IMAP-UID:t för det senast lästa mejlet, sparad tillsammans med brevlådans UIDVALIDITY — byter
 * Gmail den, börjar vi om från TRADERA_MAIL_SINCE_DAYS dagar tillbaka.
 *
 * KONTOT: en Gmail-adress och ett APP-LÖSENORD (Google-kontot -> Säkerhet -> Tvåstegsverifiering ->
 * Applösenord). Vanliga lösenordet fungerar inte mot IMAP, och OAuth hade krävt ett Google
 * Cloud-projekt för en enda inkorg. Saknas någon av variablerna är bevakaren av, och säger det.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { DATA_DIR, listJobs } from "../../jobStore.js";
import { loopaIdFor } from "../../loopaId.js";
import { claimForSale, store as butikStore } from "../../butik/store.js";
import { invalidate } from "../../butik/inventory.js";
import { sender } from "../../notify/outbox.js";
import { isFromTradera, parseTraderaMail, type TraderaMail, type TraderaMailKind } from "./mail.js";
import type { ConditionJob } from "../../types.js";

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const VARS = ["GMAIL_USER", "GMAIL_APP_PASSWORD"] as const;

export function missingGmailEnv(): string[] {
  return VARS.filter((name) => !process.env[name]?.trim());
}

export function traderaMailConfigured(): boolean {
  return missingGmailEnv().length === 0 && process.env.TRADERA_MAIL_WATCH !== "0";
}

function pollMinutes(): number {
  const n = Number(process.env.TRADERA_MAIL_POLL_MINUTES ?? 30);
  return Number.isFinite(n) && n >= 1 ? n : 30;
}

function sinceDays(): number {
  const n = Number(process.env.TRADERA_MAIL_SINCE_DAYS ?? 7);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

function notifyTo(): string | null {
  return process.env.TRADERA_MAIL_NOTIFY_TO?.trim() || process.env.GMAIL_USER?.trim() || null;
}

// ---------------------------------------------------------------------------
// Posten och markören — en JSON-fil var, som resten av datakatalogen
// ---------------------------------------------------------------------------

export interface TraderaPost extends TraderaMail {
  id: string;
  /** Loopa-id:t på möbeln mejlet gällde, när vi kunde koppla det. */
  loopaId: string | null;
  /** Vad vi gjorde. Läses i panelen; "redan-sald" och "okand-annons" är lika viktiga som "sald". */
  outcome: "sald" | "redan-sald" | "okand-annons" | "noterad";
  outcomeNote: string | null;
  /** När en människa kryssade av posten i panelen. */
  handledAt: string | null;
  seenAt: string;
}

interface Cursor {
  uidValidity: string | null;
  lastUid: number;
  lastPollAt: string | null;
  lastError: string | null;
}

const FILE = () => path.join(process.env.TRADERA_MAIL_DIR?.trim() || DATA_DIR, "tradera-post.json");
const CURSOR = () => path.join(process.env.TRADERA_MAIL_DIR?.trim() || DATA_DIR, "tradera-post-cursor.json");

let posts: TraderaPost[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function loadPosts(): Promise<TraderaPost[]> {
  if (posts) return posts;
  try {
    posts = JSON.parse(await readFile(FILE(), "utf-8")) as TraderaPost[];
  } catch {
    posts = [];
  }
  return posts;
}

async function flushPosts(): Promise<void> {
  await mkdir(path.dirname(FILE()), { recursive: true });
  await writeFile(FILE(), JSON.stringify(await loadPosts(), null, 2), "utf-8");
}

async function loadCursor(): Promise<Cursor> {
  try {
    return JSON.parse(await readFile(CURSOR(), "utf-8")) as Cursor;
  } catch {
    return { uidValidity: null, lastUid: 0, lastPollAt: null, lastError: null };
  }
}

async function saveCursor(c: Cursor): Promise<void> {
  await mkdir(path.dirname(CURSOR()), { recursive: true });
  await writeFile(CURSOR(), JSON.stringify(c, null, 2), "utf-8");
}

/** För tester: glöm det som lästs in, så nästa läsning går till disk. */
export function resetTraderaPost(): void {
  posts = null;
}

export async function listTraderaPost(limit = 200): Promise<{ poster: TraderaPost[]; status: TraderaMailStatus }> {
  const all = await loadPosts();
  const poster = [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  return { poster, status: await traderaMailStatus() };
}

export async function markTraderaPostHandled(id: string, handled: boolean): Promise<TraderaPost | null> {
  return serialize(async () => {
    const row = (await loadPosts()).find((p) => p.id === id);
    if (!row) return null;
    row.handledAt = handled ? new Date().toISOString() : null;
    await flushPosts();
    return row;
  });
}

export interface TraderaMailStatus {
  configured: boolean;
  missing: string[];
  account: string | null;
  pollMinutes: number;
  lastPollAt: string | null;
  lastError: string | null;
  /** Poster ingen kryssat av. Det tal fliken visar i sin knapp. */
  ohanterade: number;
}

export async function traderaMailStatus(): Promise<TraderaMailStatus> {
  const cursor = await loadCursor();
  const all = await loadPosts();
  return {
    configured: traderaMailConfigured(),
    missing: missingGmailEnv(),
    account: process.env.GMAIL_USER?.trim() || null,
    pollMinutes: pollMinutes(),
    lastPollAt: cursor.lastPollAt,
    lastError: cursor.lastError,
    ohanterade: all.filter((p) => !p.handledAt && p.kind !== "ovrigt").length,
  };
}

// ---------------------------------------------------------------------------
// Matchningen mot våra annonser
// ---------------------------------------------------------------------------

/**
 * Vilket jobb gäller mejlet? Annons-id:t först; rubriken bara när den pekar på EXAKT ett jobb med
 * en publicerad annons. Två soffor med samma rubrik får hellre bli "okänd annons" än fel möbel såld.
 */
export function matchJob(mail: Pick<TraderaMail, "itemId" | "title">, jobs: ConditionJob[]): ConditionJob | null {
  if (mail.itemId) {
    const hit = jobs.find((j) => j.tradera?.itemId === mail.itemId);
    if (hit) return hit;
  }
  if (mail.title) {
    const want = mail.title.trim().toLowerCase();
    const byTitle = jobs.filter((j) => j.tradera?.status === "published" && titleOf(j)?.trim().toLowerCase() === want);
    if (byTitle.length === 1) return byTitle[0];
  }
  return null;
}

function titleOf(job: ConditionJob): string | null {
  const listing = job.result?.listing ?? job.listing ?? null;
  return listing?.result?.listing.title ?? null;
}

// ---------------------------------------------------------------------------
// Handlingen per mejl
// ---------------------------------------------------------------------------

async function actOn(mail: TraderaMail, jobs: ConditionJob[]): Promise<Omit<TraderaPost, "id" | "seenAt" | "handledAt">> {
  const job = matchJob(mail, jobs);
  const loopaId = job ? loopaIdFor(job.id) : null;

  if (mail.kind !== "sald") {
    return { ...mail, loopaId, outcome: "noterad", outcomeNote: job ? null : "Kunde inte koppla mejlet till en annons hos oss." };
  }
  if (!job || !loopaId) {
    return { ...mail, loopaId: null, outcome: "okand-annons", outcomeNote: "Såld, men annonsen finns inte bland våra publicerade jobb." };
  }

  const itemId = mail.itemId ?? job.tradera?.itemId ?? null;
  const before = await butikStore().get(loopaId);
  if (before?.state === "sold" || before?.state === "delivered" || before?.state === "returned") {
    return { ...mail, loopaId, outcome: "redan-sald", outcomeNote: `Möbeln var redan ${before.state === "sold" ? "såld" : before.state} (${before.soldChannel ?? "okänd kanal"}).` };
  }
  if (!before) {
    return { ...mail, loopaId, outcome: "okand-annons", outcomeNote: "Jobbet finns men möbeln har ingen post i butikslagret." };
  }

  const sold = await claimForSale(loopaId, "tradera", { kind: "tradera", itemId }, { traderaItemId: itemId });
  if (!sold) {
    const now = await butikStore().get(loopaId);
    return { ...mail, loopaId, outcome: "redan-sald", outcomeNote: `Gick inte att sälja från läget "${now?.state ?? "?"}".` };
  }
  invalidate();
  console.info(`[tradera-post] ${loopaId} såld på Tradera (item ${itemId ?? "?"}) — markerad såld i butiken.`);
  return { ...mail, loopaId, outcome: "sald", outcomeNote: null };
}

function adminLink(loopaId: string | null): string | null {
  const base = (process.env.LOOPA_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  return loopaId ? `${base}/?admin=1#${loopaId}` : `${base}/?admin=1`;
}

const KIND_LABEL: Record<TraderaMailKind, string> = {
  sald: "Såld på Tradera",
  fraga: "Fråga på Tradera",
  bud: "Nytt bud på Tradera",
  ovrigt: "Tradera",
};

async function notify(post: TraderaPost): Promise<void> {
  const to = notifyTo();
  if (!to) return;
  const what = post.title ?? (post.itemId ? `annons ${post.itemId}` : post.subject);
  const subject = `${KIND_LABEL[post.kind]}: ${what}`;
  const lines = [
    `${KIND_LABEL[post.kind]} — ${what}`,
    "",
    post.kind === "sald"
      ? post.outcome === "sald"
        ? `Möbeln ${post.loopaId} är nu markerad som såld i Loopa.`
        : `Loopa gjorde INGET: ${post.outcomeNote ?? post.outcome}.`
      : post.kind === "fraga"
        ? `Frågan: ${post.excerpt}`
        : post.excerpt,
    "",
    post.amountSek ? `Belopp: ${post.amountSek} kr` : null,
    post.alias ? `Från: ${post.alias}` : null,
    post.url ? `Annonsen: ${post.url}` : null,
    adminLink(post.loopaId) ? `Panelen: ${adminLink(post.loopaId)}` : null,
    "",
    `Mejlet kom ${post.receivedAt} med ämnet "${post.subject}".`,
  ].filter((l): l is string => l !== null);
  try {
    await sender().send({ to, subject, body: lines.join("\n"), kind: `tradera-${post.kind}` });
  } catch (err) {
    console.warn(`[tradera-post] notisen "${subject}" gick inte iväg:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Hämtningen
// ---------------------------------------------------------------------------

export interface PollResult {
  fetched: number;
  nya: number;
  salda: number;
  fragor: number;
  error: string | null;
}

let polling: Promise<PollResult> | null = null;

/** En körning. Två anrop samtidigt delar på samma — knappen i panelen och timern får inte krocka. */
export function pollTraderaMail(): Promise<PollResult> {
  if (polling) return polling;
  polling = runPoll().finally(() => {
    polling = null;
  });
  return polling;
}

async function runPoll(): Promise<PollResult> {
  const result: PollResult = { fetched: 0, nya: 0, salda: 0, fragor: 0, error: null };
  if (!traderaMailConfigured()) {
    result.error = `Gmail är inte konfigurerat. Saknar ${missingGmailEnv().join(", ") || "TRADERA_MAIL_WATCH"}.`;
    return result;
  }
  const cursor = await loadCursor();
  const client = new ImapFlow({
    host: process.env.GMAIL_IMAP_HOST?.trim() || "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER!.trim(), pass: process.env.GMAIL_APP_PASSWORD!.trim() },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const validity = client.mailbox ? String(client.mailbox.uidValidity) : "";
      const fresh = cursor.uidValidity !== validity || cursor.lastUid === 0;
      const since = new Date(Date.now() - sinceDays() * 86_400_000);
      const query = fresh ? { since, from: "tradera" } : { uid: `${cursor.lastUid + 1}:*`, from: "tradera" };
      const uids = (await client.search(query, { uid: true })) || [];
      const wanted = (Array.isArray(uids) ? uids : []).filter((u) => u > cursor.lastUid || fresh);

      const raws: { uid: number; source: Buffer }[] = [];
      if (wanted.length) {
        for await (const msg of client.fetch(wanted, { uid: true, source: true }, { uid: true })) {
          if (msg.source) raws.push({ uid: msg.uid, source: msg.source });
        }
      }
      result.fetched = raws.length;

      const known = new Set((await loadPosts()).map((p) => p.messageId));
      const jobs = raws.length ? await listJobs() : [];
      let maxUid = fresh ? 0 : cursor.lastUid;

      for (const raw of raws.sort((a, b) => a.uid - b.uid)) {
        maxUid = Math.max(maxUid, raw.uid);
        const parsed = await simpleParser(raw.source);
        const from = parsed.from?.text ?? "";
        if (!isFromTradera(from)) continue;
        const messageId = parsed.messageId ?? `uid:${validity}:${raw.uid}`;
        if (known.has(messageId)) continue;

        const mail = parseTraderaMail({
          messageId,
          subject: parsed.subject ?? "",
          from,
          text: parsed.text ?? null,
          html: typeof parsed.html === "string" ? parsed.html : null,
          date: (parsed.date ?? new Date()).toISOString(),
        });
        const acted = await actOn(mail, jobs);
        const post: TraderaPost = { ...acted, id: randomUUID(), seenAt: new Date().toISOString(), handledAt: null };
        await serialize(async () => {
          (await loadPosts()).push(post);
          await flushPosts();
        });
        known.add(messageId);
        result.nya++;
        if (post.kind === "sald") result.salda++;
        if (post.kind === "fraga") result.fragor++;
        if (post.kind !== "ovrigt") await notify(post);
      }

      await saveCursor({ uidValidity: validity, lastUid: maxUid, lastPollAt: new Date().toISOString(), lastError: null });
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.warn(`[tradera-post] hämtningen misslyckades: ${result.error}`);
    await saveCursor({ ...cursor, lastPollAt: new Date().toISOString(), lastError: result.error });
    try {
      client.close();
    } catch {
      // redan stängd
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Timern
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Startar bevakningen. Första körningen sker en halv minut efter uppstart — servern ska hinna svara
 * på sina första anrop innan den öppnar en IMAP-anslutning — och sedan var TRADERA_MAIL_POLL_MINUTES.
 */
export function startTraderaMailWatch(): () => void {
  if (!traderaMailConfigured()) {
    const saknas = missingGmailEnv();
    console.info(
      saknas.length
        ? `[tradera-post] av — saknar ${saknas.join(", ")} i server/.env.`
        : "[tradera-post] av — TRADERA_MAIL_WATCH=0.",
    );
    return () => undefined;
  }
  const every = pollMinutes() * 60_000;
  console.info(`[tradera-post] läser ${process.env.GMAIL_USER} var ${pollMinutes()}:e minut.`);
  const tick = () =>
    void pollTraderaMail().then((r) => {
      if (r.nya) console.info(`[tradera-post] ${r.nya} nya mejl: ${r.salda} sålda, ${r.fragor} frågor.`);
    });
  const first = setTimeout(tick, 30_000);
  timer = setInterval(tick, every);
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
    timer = null;
  };
}
