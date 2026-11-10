/**
 * Från SerpApis JSON till samma sorts TEXT som det lokala systemet läser ur Googles sida (SerpApi-flödet).
 *
 * Appskalet läser `document.body.innerText` och skär ut svaret (main.js, answerTo). Servern (externalIdentify.ts) och namnläsningen (prompts.ts, proposalNames) är byggda för den texten. SerpApi
 * ger i stället ett strukturerat svar (`text_blocks`, `references`, `reconstructed_markdown`), så här görs den om till ren text: rubriker och stycken som rader, listor kvar med sina nummer eller
 * streck, TABELLER som rader med tabbtecken mellan cellerna (samma form som sidans egen innerText gav, "1⇥NORDVIKEN Barstol⇥Aktuell⇥100 %"), länkar som sin text. Adresserna tas ut separat.
 *
 * SKILLNADER mot det lokala som inte går att undvika (mäts, se docs/serpapi.md): sidans text är exakt det Google ritar, den här är SerpApis tolkning av det; formatet på listor och tabeller
 * kan skilja.
 */

/** Googles eget besked när AI-läget inte kan svara (samma mönster som main.js, NO_ANSWER). */
export const NO_ANSWER = /Det verkar inte finnas något svar för den här sökningen/;

/** Värdnamn som aldrig är en källa (samma lista som scripts/loopa-app-prototype/extract-links.js). */
const BAD_HOST = /(^|\.)google\.[a-z.]+$|gstatic\.com$|googleusercontent\.com$|googleadservices\.com$|doubleclick\.net$|ggpht\.com$|youtube\.com$|facebook\.com$|schema\.org$|w3\.org$/i;

type Json = Record<string, any>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** En rad i ett textblock: titel och/eller text, vilket SerpApi än kallar fältet. */
const itemText = (it: unknown): string => {
  if (typeof it === "string") return it;
  const o = (it ?? {}) as Json;
  const title = str(o.title);
  const body = str(o.snippet) || str(o.text) || str(o.content);
  return title && body && !body.startsWith(title) ? `${title}: ${body}` : body || title;
};

/** Rader ur en lista, nästlade listor indragna. Numrerad lista får 1., 2., …; annars streck. */
function listLines(items: unknown, ordered: boolean, depth = 0): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  items.forEach((it, i) => {
    const t = itemText(it).trim();
    if (t) out.push(`${"  ".repeat(depth)}${ordered ? `${i + 1}.` : "-"} ${t}`);
    const sub = (it as Json)?.list ?? (it as Json)?.items;
    if (sub) out.push(...listLines(sub, ordered, depth + 1));
  });
  return out;
}

/** En tabell (rader av celler) som rader med tabbtecken mellan cellerna. */
function tableLines(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (Array.isArray(r) ? r : Array.isArray((r as Json)?.cells) ? (r as Json).cells : null))
    .filter((r): r is unknown[] => !!r)
    .map((r) => r.map((c) => itemText(c).replace(/\s+/g, " ").trim()).join("\t"))
    .filter((l) => l.replace(/\t/g, "").trim());
}

/** `text_blocks` som text, ett block per stycke. Okända blocktyper tas med så långt de har text: hellre en rad för mycket än ett tyst bortfall. */
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const out: string[] = [];
  for (const b of blocks as Json[]) {
    const type = str(b?.type);
    const ordered = /order|number|decimal/i.test(`${str(b?.list_type)} ${str(b?.style)} ${b?.ordered === true ? "ordered" : ""}`);
    if (type === "list" || Array.isArray(b?.list)) out.push(listLines(b.list ?? b.items, ordered).join("\n"));
    else if (type === "table" || Array.isArray(b?.table)) out.push(tableLines(b.table ?? b.rows).join("\n"));
    else if (type === "code_blocks" || type === "code") out.push(str(b.code) || str(b.snippet));
    else {
      const t = itemText(b).trim();
      if (t) out.push(t);
    }
    // Blocktyper med egna barn (expanderbara avsnitt) tas med rakt av.
    if (Array.isArray(b?.text_blocks)) out.push(blocksToText(b.text_blocks));
  }
  return out.filter((s) => s.trim()).join("\n\n");
}

/**
 * Markdown (`reconstructed_markdown`) som den text sidan hade gett: tabellrader blir tabbtecken (skiljerader försvinner), [länktext](adress) blir länktext, fetstil, kursiv, rubrikmarkeringar och
 * kodtecken tas bort. Numrerade rader och streck får vara kvar: namnläsningen känner igen dem. Ren funktion.
 */
export function markdownToText(md: string): string {
  // Googles dolda hjälptext vid produktkort ("Sits PalmaÖppna dialogrutan för produktvisaren för varan.") följer med i SerpApis text och klistrar sig vid modellnamnet ("PalmaÖppna").
  const lines = md.replace(/Öppna dialogrutan för produktvisaren för varan\.?/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let l = raw;
    if (/^\s*\|.*\|\s*$/.test(l)) {
      // Skiljeraden mellan tabellens rubrik och rader ("| --- | :---: |") är inget innehåll.
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes("-")) continue;
      l = l.trim().replace(/^\|\s*/, "").replace(/\s*\|$/, "").split(/\s*\|\s*/).join("\t");
    }
    l = l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
      .replace(/^(\s*)#{1,6}\s+/, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      // Källhänvisningar ("[0] [1]") är siffror i SerpApis text men ikoner på sidan: de hör inte till svaret.
      .replace(/(?:[ \t]*\[\d{1,3}\])+/g, "")
      // SerpApis markdown backslash-escapar skiljetecken ("\(", "\-", "\."): sidans text har inga.
      .replace(/\\([\\`*_{}[\]()<>#+\-.!|~"'&:])/g, "$1")
      // Punktmarkörer och indrag försvinner i innerText (listpunkterna är ritade, inte text); numrerade rader behålls, namnläsningen känner igen dem.
      .replace(/^[ \t]*[-*•][ \t]+/, "");
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** SerpApi lägger sin egen källista sist i markdownen ("References" följt av "[0] …"). Den tas bort här: källorna läggs i stället till av referenceSection, ur `references`, så att de inte står två gånger. */
export function stripReferences(md: string): string {
  return md.replace(/\n[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?References(?:\*\*)?[ \t]*\n+[ \t]*\[\d+\][\s\S]*$/i, "");
}

/** Svarets text: SerpApis egen markdownversion när den finns (de bygger den ur alla blocktyper), annars våra egna block. */
export function answerText(resp: Json): string {
  const md = stripReferences(str(resp?.reconstructed_markdown)).trim();
  return (md ? markdownToText(md) : blocksToText(resp?.text_blocks)).trim();
}

/** Källkorten som rader: titel och sida, utan adress (sidans text visar korten så, och adresserna står i listan "Länkar på sidan"). */
export function referenceLines(resp: Json): string[] {
  const refs = Array.isArray(resp?.references) ? (resp.references as Json[]) : [];
  return refs
    .map((r) => {
      const title = str(r?.title).replace(/\s+/g, " ").trim();
      const source = str(r?.source).replace(/\s+/g, " ").trim();
      return title ? `- ${title}${source && !title.includes(source) ? ` (${source})` : ""}` : "";
    })
    .filter(Boolean);
}

/** Avsnittet med källkorten, att lägga under svaret när det skickas till servern. Tomt om SerpApi inte angav några. */
export function referenceSection(resp: Json): string {
  const lines = referenceLines(resp);
  return lines.length ? `Källor som AI-läget anger:\n${lines.join("\n")}` : "";
}

/**
 * Adresserna svaret stöder sig på, med samma regler som skalets extract-links.js: bara http(s), inte Googles egna eller sociala sidor, ingen startsida (en adress utan sökväg säger inget om vilken
 * modell det är), skiljetecken som hör till meningen bort, högst 60 st. Källkortens adresser först (det är dem AI-läget stöder sig på), därefter adresser i texten.
 */
export function collectLinks(resp: Json, ...extraTexts: string[]): string[] {
  const out = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== "string") return;
    try {
      const x = new URL(u.trim().replace(/[.,;:!?)\]}>"'*_]+$/, ""));
      if (/^https?:$/.test(x.protocol) && !BAD_HOST.test(x.hostname)) out.add(x.href);
    } catch {
      /* ogiltig adress: hoppa över */
    }
  };
  for (const r of Array.isArray(resp?.references) ? (resp.references as Json[]) : []) add(r?.link);
  // Utan `location` skickar SerpApi ingen `references`-lista, och länkarna i markdownen är Googles omdirigeringar (google.com/goto, bortfiltrerade nedan). De riktiga adresserna ligger i
  // text_blocks (`snippet_links[].link`, `link`): de tas därifrån, i den ordning de står.
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Json;
    if (typeof o.link === "string") add(o.link);
    for (const k of Object.keys(o)) if (k !== "link") walk(o[k]);
  };
  walk(resp?.text_blocks);
  for (const s of Array.isArray(resp?.shopping_results) ? (resp.shopping_results as Json[]) : []) add(s?.product_link ?? s?.link);
  const texts = [str(resp?.reconstructed_markdown), ...extraTexts];
  for (const t of texts) {
    for (const m of t.matchAll(/\]\((https?:\/\/(?:[^()\s]|\([^)\s]*\))+)\)/g)) add(m[1]);
    for (const m of t.matchAll(/https?:\/\/[^\s)>"'\]]+/g)) add(m[0]);
  }
  return [...out].filter((u) => new URL(u).pathname.length > 1).slice(0, 60);
}

/** Rådata ur Googles bildsök i samma form som skalets IMAGE_ROWS_JS: miniatyrens adress, sidans titel, storlek. Servern väljer och kontrollerar (externalImages.ts). */
export function imageRows(resp: Json): Array<{ src: string; alt: string; w: number; h: number; source?: string; page?: string }> {
  const rows = Array.isArray(resp?.images_results) ? (resp.images_results as Json[]) : [];
  return rows
    .map((r) => ({
      src: str(r?.thumbnail) || str(r?.original),
      alt: str(r?.title).replace(/\s+/g, " ").trim(),
      w: Number(r?.original_width) || Number(r?.thumbnail_width) || 0,
      h: Number(r?.original_height) || Number(r?.thumbnail_height) || 0,
      // Sajtens namn ("IKEA", "PriceRunner", "Vision of Home") och sidan bilden sitter på. Skalets rader har dem inte; servern (externalImages.ts) använder dem när de finns för att veta VEM som visar bilden:
      // PriceRunner NORDVIKEN 2026-11-07 hade rätt titel men fel möbel på bilden, och 29 av 40 träffar kom från IKEA självt.
      source: str(r?.source).trim() || undefined,
      page: str(r?.link).trim() || undefined,
    }))
    // Skalet tar miniatyrer som är minst 90 px åt båda håll och har en http(s)-adress; bilder utan storlek behålls (servern prövar sedan).
    .filter((r) => /^https?:\/\//i.test(r.src) && (r.w === 0 || r.w >= 90) && (r.h === 0 || r.h >= 90))
    .slice(0, 40);
}
