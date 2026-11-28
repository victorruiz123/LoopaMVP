/**
 * Orderspecifikationen: Traderas "Betalt objekt"-mejl och PDF:en som ligger i det.
 *
 * DET ÄR HÄR KÖPAREN FÅR ETT NAMN. "Sålt objekt"-mejlet bär bara ett alias, och själva "Betalt
 * objekt"-mejlet bär ordernummer, objektnummer och vår egen referens — men inte vem köparen är.
 * Namn, adress, e-post och telefon står BARA i bilagan Orderspecifikation.pdf. Utan den kan vi inte
 * höra av oss om leveransen, och möbeln står kvar i hallen tills någon loggar in på Tradera.
 *
 * TOLKNINGEN GÅR PÅ POSITION, INTE PÅ ORDNING. PDF:en har två kolumner: säljaren (Loopas Tradera-
 * konto) till vänster och köparen till höger, på samma höjd. I den platta texten kommer säljarens
 * telefonnummer FÖRE köparens, och en tolkning som tog "första numret efter Köpare" hade fått rätt
 * på det här brevet och fel så fort Tradera flyttade en rad. Här delas varje rad i vänster och höger
 * halva, och köparen är det som står till höger om mitten. Skickas ett SMS till fel nummer går det
 * till säljaren själv — ett fel som inte syns förrän köparen undrar varför ingen hört av sig.
 *
 * TECKNEN SOM FÖRSVINNER. Traderas PDF ritar "+" och "-" med glyfer textlagret inte känner igen:
 * "+46701234567" läses som "46701234567" och "2026-09-26" som "20260926". `normalizePhone` lägger
 * tillbaka landsprefixet; datumet tas ur mejlet i stället.
 *
 * REN KOD utom `pdfTextItems`, som är den enda raden som rör ett bibliotek. Resten testas på
 * sparade textrader (tests/tradera-orderspec.test.ts).
 */

import { stripHtml } from "./mail.js";

/** En textbit ur PDF:en med sin position. y växer UPPÅT (PDF-koordinater). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
}

/** En part i ordern som den står i specifikationen. */
export interface OrderKontakt {
  alias: string | null;
  namn: string | null;
  /** Gatuadressen. Två rader (c/o, lägenhet) fogas ihop med kommatecken. */
  adress: string | null;
  postnummer: string | null;
  ort: string | null;
  email: string | null;
  /** E.164: +46701234567. Null när inget nummer står, eller när det inte går att läsa som ett. */
  telefon: string | null;
}

export interface Orderspecifikation {
  ordernummer: string | null;
  saljare: OrderKontakt;
  kopare: OrderKontakt;
  /** Objektnumren i orderns produktrader. En order kan i princip bära flera objekt. */
  objektnr: number[];
  /** "Totalt" — det köparen betalade, frakt inräknad. */
  totaltSek: number | null;
  /** Fraktraden. 0 när frakten är inbakad i priset eller "Annat fraktsätt". */
  fraktSek: number | null;
  betalmetod: string | null;
}

/** Det som står i själva mejlet, utan bilagan. */
export interface BetaltMejl {
  ordernummer: string | null;
  itemId: number | null;
  /** "Egen referens" — vårt jobb-id, satt när annonsen publicerades. Står fullt ut bara i mejlet. */
  egenReferens: string | null;
  alias: string | null;
  /** Traderas id för köpet, ur "Boka frakt"-länken. Behövs för att hitta ordern hos Tradera. */
  purchaseOrderId: string | null;
  titel: string | null;
}

// ---------------------------------------------------------------------------
// Mejlet
// ---------------------------------------------------------------------------

/** Är det ett "Betalt objekt"-mejl? Ämnesraden är stabil; kroppen är reserven. */
export function isBetaltMejl(subject: string, body: string): boolean {
  if (/^\s*betalt objekt\b/i.test(subject)) return true;
  return /\bordern är betald\b/i.test(body) || /\bköparen \S+ har betalat\b/i.test(body);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Traderas HTML skriver å, ä och ö som numeriska entiteter (&#xF6;). stripHtml känner inte dem. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&zwj;|\u200d/g, "")
    .replace(/&nbsp;/g, " ");
}

export function parseBetaltMejl(subject: string, text: string | null, html: string | null): BetaltMejl {
  const body = decodeEntities(text?.trim() ? text : html ? stripHtml(html) : "").replace(/\r/g, "");
  const raw = html ?? "";
  const ordernummer = /ordernummer[\s:]*(\d{5,})/i.exec(body)?.[1] ?? null;
  const item =
    /tradera\.com\/item\/(?:\d+\/)?(\d{6,})/i.exec(raw) ??
    /objektnr[\s:\u200d]*(\d{6,})/i.exec(body) ??
    /\((\d{6,})\)\s*$/.exec(subject);
  const ref = /egen referens[\s:\u00a0]*(?:&nbsp;)*\s*([0-9a-f-]{36})/i.exec(body) ?? /egen referens[^0-9a-f]{0,40}([0-9a-f-]{36})/i.exec(raw);
  const egenReferens = ref && UUID.test(ref[1]) ? ref[1].toLowerCase() : null;
  const alias = /köparen\s+(\S+)\s+har betalat/i.exec(body)?.[1] ?? null;
  const purchaseOrderId = /purchaseOrderId=([0-9a-f-]{36})/i.exec(raw)?.[1] ?? null;
  const titel = /^\s*betalt objekt\s*[-–]\s*(.+?)\s*\(\d{6,}\)\s*$/i.exec(subject)?.[1] ?? null;
  return { ordernummer, itemId: item ? Number(item[1]) : null, egenReferens, alias, purchaseOrderId, titel };
}

// ---------------------------------------------------------------------------
// PDF:en
// ---------------------------------------------------------------------------

/** Textbitarna på första sidan. Den enda funktionen här som rör ett bibliotek. */
export async function pdfTextItems(pdf: Uint8Array): Promise<PdfTextItem[]> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const out: PdfTextItem[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Sida två läggs under sida ett, så att raderna fortsätter i samma ordning.
    const offset = (p - 1) * -10_000;
    for (const it of content.items as Array<{ str?: string; transform?: number[] }>) {
      if (typeof it.str !== "string" || !it.transform) continue;
      out.push({ str: it.str, x: it.transform[4], y: it.transform[5] + offset });
    }
  }
  return out;
}

interface Rad {
  y: number;
  /** Bitarna i läsordning, med x. */
  delar: { x: number; str: string }[];
}

/** Bitar på (nästan) samma höjd blir en rad. Toleransen täcker baslinjer som skiljer en punkt. */
function rader(items: PdfTextItem[]): Rad[] {
  const sorted = items.filter((i) => i.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const out: Rad[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2) last.delar.push({ x: it.x, str: it.str });
    else out.push({ y: it.y, delar: [{ x: it.x, str: it.str }] });
  }
  for (const r of out) r.delar.sort((a, b) => a.x - b.x);
  return out;
}

/**
 * En rads text. Bitar som ligger tätt fogas utan mellanslag — PDF:en delar "Orderspecifikation" i
 * tre bitar kring ligaturen "fi" — och bitar med ett tydligt glapp får ett mellanslag.
 */
function text(delar: { x: number; str: string }[]): string {
  let out = "";
  let prevEnd = -Infinity;
  for (const d of delar) {
    const gap = d.x - prevEnd;
    out += out && gap > 3 && !out.endsWith(" ") && !d.str.startsWith(" ") ? ` ${d.str}` : d.str;
    // En grov bredd: 5 punkter per tecken räcker för att skilja "tätt" från "glapp".
    prevEnd = d.x + d.str.length * 5;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Svenska kronor ur "1 600,00". */
function kronor(s: string): number | null {
  const m = /(\d{1,3}(?:[ \u00a0]\d{3})*|\d+)(?:,(\d{2}))?\s*$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/[ \u00a0]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Ett telefonnummer i E.164-form, eller null.
 *
 * Plustecknet försvinner ur PDF:ens textlager, så "46701234567" är det vanliga fallet. Ett svenskt
 * nummer som börjar på 0 får landsprefixet. Allt som inte blir 8–15 siffror efteråt är inte ett
 * telefonnummer vi vågar skicka till.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `46${digits.slice(1)}`;
  // Ett svenskt mobilnummer skrivet med inhemskt prefix men utan nolla ("701234567").
  else if (/^7\d{8}$/.test(digits)) digits = `46${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function tomKontakt(): OrderKontakt {
  return { alias: null, namn: null, adress: null, postnummer: null, ort: null, email: null, telefon: null };
}

/**
 * En parts block: raderna under "Säljare | alias" eller "Köpare | alias", tills nästa rubrik.
 *
 * Fälten känns igen på formen, inte på radnumret: e-post har ett @, telefonen är bara siffror,
 * postnumret är fem siffror följda av en ort. Namnet är första raden, och allt mellan namnet och
 * postnumret är gatuadressen — en eller två rader.
 */
function kontaktUr(alias: string | null, block: string[]): OrderKontakt {
  const k = tomKontakt();
  k.alias = alias;
  const kvar: string[] = [];
  for (const line of block) {
    if (!k.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) k.email = line.toLowerCase();
    // Plustecknet är en glyf utan text och kan komma ut som ett osynligt tecken före siffrorna. En
    // rad utan bokstäver med minst åtta siffror är telefonnumret, vad som än står framför.
    else if (!k.telefon && !/[a-zåäöé@]/i.test(line) && !/^\d{3} ?\d{2}\s+\S/.test(line) && line.replace(/\D/g, "").length >= 8)
      k.telefon = normalizePhone(line);
    else if (!k.postnummer && /^(\d{3}) ?(\d{2})\s+(\S.*)$/.test(line)) {
      const m = /^(\d{3}) ?(\d{2})\s+(\S.*)$/.exec(line)!;
      k.postnummer = `${m[1]}${m[2]}`;
      k.ort = m[3].trim();
      kvar.push("\u0000"); // markören: allt före den är namn + gata
    } else kvar.push(line);
  }
  const stop = kvar.indexOf("\u0000");
  const fore = stop >= 0 ? kvar.slice(0, stop) : kvar;
  k.namn = fore[0] ?? null;
  const gata = fore.slice(1).filter(Boolean);
  k.adress = gata.length ? gata.join(", ") : null;
  return k;
}

const RUBRIK_SALJARE = /^säljare\s*\|\s*(\S+)/i;
const RUBRIK_KOPARE = /^köpare\s*\|\s*(\S+)/i;

/**
 * Hela specifikationen ur PDF:ens textbitar.
 *
 * Mitten — gränsen mellan säljarens och köparens kolumn — tas ur rubrikerna själva: halvvägs mellan
 * där "Säljare |" och "Köpare |" börjar. Saknas köparens rubrik finns det ingen köpare att läsa, och
 * då är `kopare` tom hellre än gissad.
 */
export function parseOrderspecifikation(items: PdfTextItem[]): Orderspecifikation {
  const rows = rader(items);
  const spec: Orderspecifikation = {
    ordernummer: null,
    saljare: tomKontakt(),
    kopare: tomKontakt(),
    objektnr: [],
    totaltSek: null,
    fraktSek: null,
    betalmetod: null,
  };

  // Rubrikraden för parterna, och mitten mellan kolumnerna.
  let partRad = -1;
  let mitt = Infinity;
  let saljAlias: string | null = null;
  let kopAlias: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const delar = rows[i].delar;
    const kopIdx = delar.findIndex((d) => /^köpare$/i.test(d.str.trim()) || /^köpare\s*\|/i.test(d.str.trim()));
    const saljIdx = delar.findIndex((d) => /^säljare$/i.test(d.str.trim()) || /^säljare\s*\|/i.test(d.str.trim()));
    if (kopIdx < 0 && saljIdx < 0) continue;
    partRad = i;
    const kopX = kopIdx >= 0 ? delar[kopIdx].x : Infinity;
    const saljX = saljIdx >= 0 ? delar[saljIdx].x : 0;
    mitt = kopIdx >= 0 ? (saljX + kopX) / 2 : Infinity;
    const vanster = text(delar.filter((d) => d.x < mitt));
    const hoger = text(delar.filter((d) => d.x >= mitt));
    saljAlias = RUBRIK_SALJARE.exec(vanster)?.[1] ?? null;
    kopAlias = RUBRIK_KOPARE.exec(hoger)?.[1] ?? null;
    break;
  }

  const forstaRader = partRad >= 0 ? rows.slice(0, partRad) : rows;
  for (const r of forstaRader) {
    const t = text(r.delar);
    const m = /^ordernummer\s*(\d{5,})/i.exec(t);
    if (m) spec.ordernummer = m[1];
  }

  // Parternas block: raderna efter rubriken, fram till produkttabellens huvud.
  if (partRad >= 0) {
    const vanster: string[] = [];
    const hoger: string[] = [];
    let i = partRad + 1;
    for (; i < rows.length; i++) {
      const hel = text(rows[i].delar);
      if (/^produkt\b/i.test(hel)) break;
      const v = text(rows[i].delar.filter((d) => d.x < mitt));
      const h = text(rows[i].delar.filter((d) => d.x >= mitt));
      if (v) vanster.push(v);
      if (h) hoger.push(h);
    }
    spec.saljare = kontaktUr(saljAlias, vanster);
    spec.kopare = kopAlias || hoger.length ? kontaktUr(kopAlias, hoger) : tomKontakt();

    // Produktraderna och summorna.
    for (; i < rows.length; i++) {
      const hel = text(rows[i].delar);
      if (/^produkt\b/i.test(hel)) continue;
      if (/^frakt\b/i.test(hel)) {
        spec.fraktSek = kronor(hel);
        continue;
      }
      if (/^totalt\b/i.test(hel)) {
        spec.totaltSek = kronor(hel);
        continue;
      }
      if (/^betalmetod\b/i.test(hel)) {
        spec.betalmetod = hel.replace(/^betalmetod\s*/i, "").trim() || null;
        continue;
      }
      if (/^varav moms/i.test(hel)) continue;
      // Objektnumret står ensamt i sin bit, nio siffror ungefär.
      for (const d of rows[i].delar) {
        const s = d.str.trim();
        if (/^\d{6,12}$/.test(s)) {
          const n = Number(s);
          if (!spec.objektnr.includes(n)) spec.objektnr.push(n);
        }
      }
    }
  }
  return spec;
}

/** Det som räcker för att höra av sig: ett telefonnummer eller en e-postadress. */
export function gårAttNå(k: OrderKontakt): boolean {
  return !!(k.telefon || k.email);
}
