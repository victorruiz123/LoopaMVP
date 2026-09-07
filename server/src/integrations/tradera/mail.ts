/**
 * Tolkningen av ett mejl från Tradera: vad hände, och med vilken annons?
 *
 * REN FUNKTION, INGET NÄT. IMAP-hämtningen ligger i mailwatch.ts; det här är bara läsningen av ett
 * mejl som redan ligger på bordet, så att den går att testa på sparade brev och skärpa i takt med
 * att vi ser hur Traderas mejl faktiskt ser ut.
 *
 * FYRA SORTER, och ordningen är viktig eftersom ett mejl kan innehålla flera ord:
 *
 *   sald    varan är såld — Köp Nu gick igenom, eller auktionen slutade med ett vinnande bud.
 *           Det här är det enda utfallet som ÄNDRAR något hos oss (möbeln blir såld i butiken).
 *   fraga   någon ställde en fråga om annonsen, eller skickade ett meddelande om den.
 *   bud     nytt bud eller nytt högsta bud. Trevligt att veta, inget att göra.
 *   ovrigt  allt annat från Tradera — kvitton, kampanjer, "din annons har gått ut utan bud".
 *
 * ANNONS-ID:T ÄR NYCKELN. Traderas mejl länkar alltid till annonsen som
 * https://www.tradera.com/item/<kategori>/<annonsId>/<slug>, och det är annonsId vi matchar mot
 * `job.tradera.itemId`. Titeln är reserven när länken saknas; den är inte unik, så den används bara
 * när exakt en publicerad annons bär den.
 *
 * ORDVALEN ÄR ANTAGANDEN tills de bekräftats mot skarpa brev. Ett mejl som inte känns igen hamnar som
 * `ovrigt` i panelen i stället för att försvinna — det är så vi upptäcker en formulering vi missat.
 */

export type TraderaMailKind = "sald" | "fraga" | "bud" | "ovrigt";

export interface RawMail {
  messageId: string;
  subject: string;
  from: string;
  /** Ren text. Saknas den byggs den ur html. */
  text: string | null;
  html: string | null;
  date: string;
}

export interface TraderaMail {
  messageId: string;
  kind: TraderaMailKind;
  subject: string;
  receivedAt: string;
  /** Annons-id ur länken eller ur texten. Null när mejlet inte pekar på en enskild annons. */
  itemId: number | null;
  /** Annonsens rubrik som den står i mejlet, när den går att hitta. */
  title: string | null;
  /** Belopp i kronor när mejlet nämner ett — slutpris, bud. */
  amountSek: number | null;
  /** Köparens eller frågeställarens alias, när det står. */
  alias: string | null;
  /** Själva frågan för `fraga`, annars ett kort utdrag ur brevet. */
  excerpt: string;
  /** Länken till annonsen på Tradera. */
  url: string | null;
}

/** Är avsändaren Tradera? Vi läser bara sådana mejl, oavsett vad IMAP-sökningen råkade ge. */
export function isFromTradera(from: string): boolean {
  return /@(?:[a-z0-9-]+\.)*tradera\.(?:com|se|net)\b/i.test(from) || /\btradera\b/i.test(from);
}

const ITEM_URL = /https?:\/\/(?:www\.)?tradera\.com\/item\/(?:\d+\/)?(\d{6,})(?:\/[^\s"'<>)]*)?/i;
const ITEM_NUMBER = /(?:annons|objekt|vara|item)(?:s)?(?:nummer|nr|-id| id)?[.:\s]+#?\s*(\d{6,})/i;

/** Ta bort taggar, fäll ihop blanktecken. Räcker för Traderas mejl, som är text med lite formatering. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function bodyText(mail: RawMail): string {
  const text = mail.text?.trim();
  if (text) return text.replace(/\r/g, "");
  return mail.html ? stripHtml(mail.html) : "";
}

/** Sorten avgörs på ämnesraden först — den är kortast och minst brusig — och på kroppen som reserv. */
export function classify(subject: string, body: string): TraderaMailKind {
  const s = subject.toLowerCase();
  const b = body.toLowerCase().slice(0, 1500);

  const soldWords = /\b(?:såld|sålt|sålde|köpt|köpte|vunnit|vann|grattis|betalning mottagen|köp nu|köpet)\b/;
  const questionWords = /\b(?:fråga|frågor|meddelande|undrar|har skrivit|skrivit till dig|svara)\b/;
  const bidWords = /\b(?:bud|budet|högsta bud|överbjuden|budgivning)\b/;
  const notSold = /\b(?:utan bud|inga bud|avslutades utan|osåld|inte såld|gick inte|ingen köpare)\b/;

  // "Utan bud" innehåller ordet bud. Det som INTE hände avgörs före det som hände.
  if (notSold.test(s)) return "ovrigt";
  if (soldWords.test(s)) return "sald";
  if (questionWords.test(s)) return "fraga";
  if (bidWords.test(s)) return "bud";
  if (notSold.test(b)) return "ovrigt";
  if (questionWords.test(b) && /\b(?:fråga|meddelande)\b/.test(b)) return "fraga";
  if (soldWords.test(b) && /\b(?:såld|sålt|köpt|vunnit)\b/.test(b)) return "sald";
  if (bidWords.test(b)) return "bud";
  return "ovrigt";
}

function findItemId(subject: string, body: string, html: string | null): { itemId: number | null; url: string | null } {
  for (const haystack of [html ?? "", body, subject]) {
    const m = ITEM_URL.exec(haystack);
    if (m) return { itemId: Number(m[1]), url: m[0].replace(/[),.]+$/, "") };
  }
  const n = ITEM_NUMBER.exec(body) ?? ITEM_NUMBER.exec(subject);
  return { itemId: n ? Number(n[1]) : null, url: null };
}

/** Rubriken står oftast inom citattecken i ämnesraden: Grattis! "Madison 3-sits soffa" är såld. */
function findTitle(subject: string, body: string): string | null {
  const quoted = /[""«]([^""»]{3,120})[""»]/.exec(subject) ?? /[""«]([^""»]{3,120})[""»]/.exec(body.slice(0, 600));
  if (quoted) return quoted[1].trim();
  const after = /(?:annons(?:en)?|varan|objektet)\s+(.{3,120}?)(?:\s+(?:är|har|blev|fick)\b|$)/i.exec(subject);
  return after ? after[1].trim().replace(/[.!?]+$/, "") : null;
}

function findAmount(body: string): number | null {
  const m = /(\d{1,3}(?:[  .]\d{3})*|\d+)(?:[,.]\d{2})?\s*(?:kr|sek|kronor)\b/i.exec(body);
  if (!m) return null;
  const n = Number(m[1].replace(/[  .]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findAlias(body: string): string | null {
  const m =
    /(?:köpare|köparen|från|användaren|medlemmen|budgivaren)\s*[:\-]?\s*([A-Za-z0-9_.\-åäöÅÄÖ]{2,32})\b/i.exec(body) ??
    /\b([A-Za-z0-9_.\-åäöÅÄÖ]{2,32})\s+(?:har (?:köpt|ställt|skrivit|lagt))/i.exec(body);
  if (!m) return null;
  const alias = m[1];
  if (/^(?:din|ditt|har|och|att|på|en|ett|som|den|det|tradera)$/i.test(alias)) return null;
  return alias;
}

/** Frågan i ett frågemejl: raderna efter "Fråga:"/"Meddelande:", annars de första meningsfulla raderna. */
function findExcerpt(kind: TraderaMailKind, body: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^https?:\/\//.test(l));
  if (kind === "fraga") {
    const idx = lines.findIndex((l) => /^(?:fråga|meddelande|frågan|meddelandet)\s*[:\-]?\s*$/i.test(l) || /^(?:fråga|meddelande)\s*[:\-]\s*\S/i.test(l));
    if (idx >= 0) {
      const first = lines[idx].replace(/^(?:fråga|meddelande|frågan|meddelandet)\s*[:\-]?\s*/i, "");
      const rest = lines.slice(idx + 1, idx + 6).filter((l) => !/^(?:svara|logga in|hälsningar|tradera)/i.test(l));
      const text = [first, ...rest].filter(Boolean).join(" ").trim();
      if (text) return text.slice(0, 600);
    }
  }
  return lines.slice(0, 6).join(" ").slice(0, 400);
}

export function parseTraderaMail(mail: RawMail): TraderaMail {
  const body = bodyText(mail);
  const kind = classify(mail.subject, body);
  const { itemId, url } = findItemId(mail.subject, body, mail.html);
  return {
    messageId: mail.messageId,
    kind,
    subject: mail.subject,
    receivedAt: mail.date,
    itemId,
    title: findTitle(mail.subject, body),
    amountSek: kind === "sald" || kind === "bud" ? findAmount(body) : null,
    alias: findAlias(body),
    excerpt: findExcerpt(kind, body),
    url,
  };
}
