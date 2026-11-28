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
import { simpleParser, type ParsedMail } from "mailparser";
import { DATA_DIR, listJobs } from "../../jobStore.js";
import { loopaIdFor } from "../../loopaId.js";
import { claimForSale, store as butikStore } from "../../butik/store.js";
import { invalidate } from "../../butik/inventory.js";
import { sender } from "../../notify/outbox.js";
import { isFromTradera, parseTraderaMail, type TraderaMail, type TraderaMailKind } from "./mail.js";
import { parseBetaltMejl, parseOrderspecifikation, pdfTextItems } from "./orderspec.js";
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
  outcome: "sald" | "redan-sald" | "okand-annons" | "noterad" | "betald" | "betald-fel";
  outcomeNote: string | null;
  /**
   * Ordern ett "Betalt objekt"-mejl blev, och hur köparen nåddes. Bara på `betald`.
   * Köparens kontaktuppgifter står här för att adminbrevet och panelen ska kunna visa dem; hela
   * uppgifterna (adress, säljare) ligger på ordern.
   */
  order?: {
    id: string;
    reference: string;
    kopare: { namn: string | null; telefon: string | null; email: string | null; adress: string | null };
    sms: string;
    mejl: string;
    fraktLank: string;
  } | null;
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
 *
 * Id:t matchar också jobbets kvarlämnade annonser — äldre annonser som fick ligga kvar vid en
 * omläggning för att en köpare skrivit (types.ts `KvarlamnadAnnons`). En försäljning där säljer möbeln.
 */
export function matchJob(mail: Pick<TraderaMail, "itemId" | "title">, jobs: ConditionJob[]): ConditionJob | null {
  if (mail.itemId) {
    const hit =
      jobs.find((j) => j.tradera?.itemId === mail.itemId) ??
      jobs.find((j) => (j.kvarlamnadeAnnonser ?? []).some((k) => k.kanal === "tradera" && k.itemId === mail.itemId));
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

/**
 * "Betalt objekt": läs orderspecifikationen, se till att möbeln är såld, skapa ordern och skicka
 * fraktlänken till köparen. Se betald.ts för kedjan och orderspec.ts för tolkningen.
 *
 * JOBBET HITTAS PÅ "EGEN REFERENS" FÖRST — det är vårt jobb-id, satt av oss när annonsen
 * publicerades, och det enda id:t i mejlet som inte kan peka på fel möbel. Objektnumret är reserven.
 *
 * OBJEKTNUMREN MÅSTE STÄMMA. Säger PDF:en ett annat objekt än mejlet skickas ingenting: hellre en
 * köpare som får vänta på ett samtal än ett SMS om fel soffa.
 */
async function actOnBetald(
  mail: TraderaMail,
  parsed: Pick<ParsedMail, "subject" | "text" | "html" | "attachments">,
  jobs: ConditionJob[],
): Promise<Omit<TraderaPost, "id" | "seenAt" | "handledAt">> {
  const meta = parseBetaltMejl(parsed.subject ?? "", parsed.text ?? null, typeof parsed.html === "string" ? parsed.html : null);
  const itemId = meta.itemId ?? mail.itemId;
  const base = { ...mail, itemId, alias: meta.alias ?? mail.alias, title: meta.titel ?? mail.title };
  const job =
    (meta.egenReferens ? jobs.find((j) => j.id.toLowerCase() === meta.egenReferens) : undefined) ??
    matchJob({ itemId, title: base.title }, jobs);
  if (!job) {
    return { ...base, loopaId: null, outcome: "okand-annons", outcomeNote: "Betald, men annonsen finns inte bland våra jobb. Ingen order skapad." };
  }
  const loopaId = loopaIdFor(job.id);

  // Såld först. Har "Sålt objekt" redan gjort det blir det här "redan-sald", och det är väntat.
  const salj = await actOn({ ...base, kind: "sald" }, [job]);
  if (salj.outcome === "okand-annons") {
    return { ...base, loopaId, outcome: "betald-fel", outcomeNote: `${salj.outcomeNote ?? "Möbeln finns inte i butikslagret."} Ingen order skapad.` };
  }

  const pdf = (parsed.attachments ?? []).find(
    (a) => /\.pdf$/i.test(a.filename ?? "") || a.contentType === "application/pdf" || /orderspec/i.test(a.filename ?? ""),
  );
  if (!pdf) {
    return { ...base, loopaId, outcome: "betald-fel", outcomeNote: "Orderspecifikationen (PDF) saknades i mejlet — köparens uppgifter finns på Tradera under Mina sålda." };
  }
  let spec;
  try {
    spec = parseOrderspecifikation(await pdfTextItems(new Uint8Array(pdf.content)));
  } catch (err) {
    return { ...base, loopaId, outcome: "betald-fel", outcomeNote: `Orderspecifikationen gick inte att läsa: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (itemId && spec.objektnr.length && !spec.objektnr.includes(itemId)) {
    return {
      ...base,
      loopaId,
      outcome: "betald-fel",
      outcomeNote: `Orderspecifikationen gäller objekt ${spec.objektnr.join(", ")}, mejlet ${itemId}. Ingenting skickat — kontrollera för hand.`,
    };
  }

  const { hanteraBetaltKop, fraktLank } = await import("./betald.js");
  // Kategorin sätter fraktavgiften i zonen (soffor kostar mer). Faller uppslaget blir det grundpriset.
  const produkt = await import("../../butik/inventory.js").then((m) => m.productById(loopaId)).catch(() => null);
  const utfall = await hanteraBetaltKop({
    meta,
    spec,
    messageId: mail.messageId,
    receivedAt: mail.receivedAt,
    job,
    loopaId,
    titel: titleOf(job) ?? base.title,
    categorySlug: produkt?.categorySlug ?? null,
  });
  const k = utfall.order.kopare;
  const smsBesked = !utfall.created
    ? "redan skickat tidigare"
    : utfall.sms
      ? utfall.sms.sent
        ? `skickat till ${k?.telefon}`
        : `INTE skickat (${utfall.sms.error ?? "okänt fel"})`
      : "inget nummer i orderspecifikationen";
  const mejlBesked = !utfall.created
    ? "redan skickat tidigare"
    : utfall.mejl === "skickat"
      ? `skickat till ${k?.email}`
      : utfall.mejl === "ingen-adress"
        ? "ingen adress"
        : "misslyckades";
  return {
    ...base,
    loopaId,
    outcome: "betald",
    outcomeNote: utfall.created ? null : `Ordern fanns redan (${utfall.order.reference}). Ingenting skickat igen.`,
    order: {
      id: utfall.order.id,
      reference: utfall.order.reference,
      kopare: {
        namn: k?.namn ?? null,
        telefon: k?.telefon ?? null,
        email: k?.email ?? null,
        adress: k ? [k.adress, [k.postnummer, k.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null : null,
      },
      sms: smsBesked,
      mejl: mejlBesked,
      fraktLank: fraktLank(utfall.order),
    },
  };
}

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
  await taNerOvrigaTradera(job, loopaId, itemId);
  return { ...mail, loopaId, outcome: "sald", outcomeNote: null };
}

/**
 * Möbeln såldes på en av sina Tradera-annonser. Ligger den ute på fler — den aktuella och äldre som
 * lämnats kvar vid en omläggning — tas de andra ner, så att ingen kan köpa den en gång till. Köpet
 * gäller oavsett: ett fel här loggas högt i stället för att kastas.
 */
async function taNerOvrigaTradera(job: ConditionJob, loopaId: string, saldItemId: number | null): Promise<void> {
  try {
    const { taNerKvarlamnadeTradera, taNerTraderaAnnons } = await import("./nedtagning.js");
    if (saldItemId !== null && job.tradera?.itemId && job.tradera.itemId !== saldItemId) {
      await taNerTraderaAnnons(job, loopaId, `möbeln såld på Tradera-annonsen ${saldItemId}`);
    }
    await taNerKvarlamnadeTradera(job, loopaId, "möbeln såld på Tradera", saldItemId);
  } catch (err) {
    console.error(
      `[tradera-post] ${loopaId}: övriga Tradera-annonser kunde INTE tas ner efter försäljningen — ta ner dem för hand:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function adminLink(loopaId: string | null): string | null {
  const base = (process.env.LOOPA_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  return loopaId ? `${base}/?admin=1#${loopaId}` : `${base}/?admin=1`;
}

const KIND_LABEL: Record<TraderaMailKind, string> = {
  sald: "Såld på Tradera",
  betald: "Betald på Tradera",
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
    post.kind === "betald"
      ? post.order
        ? [
            `Order ${post.order.reference} skapad för ${post.loopaId}.`,
            "",
            `Köpare: ${post.order.kopare.namn ?? post.alias ?? "okänd"}`,
            post.order.kopare.adress ? `Adress: ${post.order.kopare.adress}` : "Adress: saknas",
            `Telefon: ${post.order.kopare.telefon ?? "saknas"}`,
            `E-post: ${post.order.kopare.email ?? "saknas"}`,
            "",
            `SMS med fraktlänken: ${post.order.sms}`,
            `Mejl med fraktlänken: ${post.order.mejl}`,
            `Fraktlänken: ${post.order.fraktLank}`,
            post.outcomeNote ?? "",
          ].join("\n")
        : `Loopa gjorde INGET: ${post.outcomeNote ?? post.outcome}.`
      : post.kind === "sald"
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
  /** "Betalt objekt" — köp som blev ordrar med fraktlänk. */
  betalda: number;
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
  const result: PollResult = { fetched: 0, nya: 0, salda: 0, betalda: 0, fragor: 0, error: null };
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
        const acted = mail.kind === "betald" ? await actOnBetald(mail, parsed, jobs) : await actOn(mail, jobs);
        const post: TraderaPost = { ...acted, id: randomUUID(), seenAt: new Date().toISOString(), handledAt: null };
        await serialize(async () => {
          (await loadPosts()).push(post);
          await flushPosts();
        });
        known.add(messageId);
        result.nya++;
        if (post.kind === "sald") result.salda++;
        if (post.kind === "betald") result.betalda++;
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
      if (r.nya) console.info(`[tradera-post] ${r.nya} nya mejl: ${r.salda} sålda, ${r.betalda} betalda, ${r.fragor} frågor.`);
    });
  const first = setTimeout(tick, 30_000);
  timer = setInterval(tick, every);
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
    timer = null;
  };
}
