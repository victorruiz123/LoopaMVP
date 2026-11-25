/**
 * GOOGLES BILDRADER: modellkortens bilder ur samma sökning som identifierar modellen.
 *
 * När frågan till AI-läget har ett foto OCH ber om exempelbilder ritar Google en rad bilder per modell. SerpApis tolkade JSON saknar dem, men de ligger i den råa sidan
 * (search_metadata.raw_html_file; ingår i samma sökning):
 *   <img id="…" alt="källsidans titel">   +   sn._setImageSrc('<id>','data:image/…')   +   länken (/goto?url=…) direkt efter bilden.
 *
 * ODOKUMENTERAD STRUKTUR: Google kan ändra sidan utan förvarning. Hittas inget ska flödet gå vidare utan bilder, aldrig falla.
 */

import { createHash } from "node:crypto";
import { motsagerTyp, typfamilj } from "../candidateType.js";
import { lokalOriginalbild, sparaInbaddadKandidatbild } from "../kandidatbild.js";

const log = (...a: unknown[]) => console.log("[google-bilder]", ...a);

/** Läggs efter identifieringsfrågan (PROMPT). Utan den, och utan foto, ritar AI-läget inga bildrader. */
export const BILDBEGARAN =
  "Visa dessutom en exempelbild från internet för varje förslag, direkt under modellens namn. Bilden ska visa hela möbeln av just den modellen, " +
  "helst en produktbild mot vit bakgrund från tillverkarens eller en återförsäljares produktsida, i den variant som mest liknar möbeln på bilden " +
  "jag skickade (klädsel, färg och underrede). Visa inte bilden jag skickade, och använd en bild ur en begagnatannons bara om ingen annan finns. " +
  "Skriv adressen till sidan som exempelbilden kommer från. Hittar du ingen bild som säkert visar rätt modell, skriv det hellre än att visa en annan möbel.";

export interface GoogleBild {
  titel: string;
  dataUri: string;
  /** Bildtaggens plats i sidan: raderna ligger efter sin modells rubrik. */
  at: number;
  /** Källsidan: ur bildens data, annars länken direkt efter bilden (Googles omdirigering). */
  kalla: string | null;
  /** Originalbildens adress ur bildens data. Rutan i raden (dataUri) är ofta en beskuren och liten kopia av den. */
  original: string | null;
}

/** Datan efter bildtaggen: Googles egen kopia (adress, mått), originalets adress, mått, källsidan. */
const BILDDATA = /"https:\/\/encrypted-tbn\d\.gstatic\.com\/images\?q\\u003dtbn:[^"]+",\d+,\d+,"(https?:[^"]+)",\d+,\d+,"(https?:[^"]+)"/;
/** Adresserna står som JSON-strängar (= för =). */
const avkodaJson = (s: string): string | null => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return null;
  }
};

const entiteter = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const avkodaSkript = (s: string): string => s.replace(/\\x([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\\\//g, "/");
const attribut = (tagg: string, namn: string): string => new RegExp(`\\s${namn}="([^"]*)"`, "i").exec(tagg)?.[1] ?? "";

/** Bilderna med titel och bilddata, i sidans ordning. Ren funktion. */
export function lasGoogleBilder(html: string): GoogleBild[] {
  const data = new Map<string, string>();
  for (const m of html.matchAll(/_setImageSrc\('([^']+)','(data:image[^']+)'\)/g)) data.set(m[1], avkodaSkript(m[2]));
  const taggar = [...html.matchAll(/<img\b[^>]*>/gi)];
  const ut: GoogleBild[] = [];
  taggar.forEach((m, i) => {
    const dataUri = data.get(attribut(m[0], "id"));
    const titel = entiteter(attribut(m[0], "alt")).trim();
    // Säljarens egen uppladdade bild ligger också på sidan ("Bild för visuell sökning").
    if (!dataUri || !titel || /visuell sökning|visual search/i.test(titel)) return;
    const nasta = taggar[i + 1]?.index ?? html.length;
    const lank = /href="(\/goto\?url=[^"]+|https?:\/\/(?![^"]*google\.)[^"]+)"/.exec(html.slice(m.index, Math.min(nasta, m.index + 3500)))?.[1];
    const googlelank = lank ? (lank.startsWith("/") ? `https://www.google.com${entiteter(lank)}` : entiteter(lank)) : null;
    // Datan står ibland med citattecknen som &quot;, därför avkodas utsnittet först.
    const post = BILDDATA.exec(entiteter(html.slice(m.index, Math.min(nasta, m.index + 6000))));
    ut.push({ titel, dataUri, at: m.index, kalla: (post && avkodaJson(post[2])) || googlelank, original: post ? avkodaJson(post[1]) : null });
  });
  return ut;
}

const norm = (s: string): string => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const nammer = (titel: string, namn: string): boolean => norm(namn).trim() !== "" && norm(titel).includes(norm(namn));
/** Andrahand och auktioner: "Möbler - Fåtöljer …" är auktionsnätverkets titelform, som inte alltid säger "auktion". */
const ANDRAHAND = /blocket|tradera|auktion|auction|bukowskis|facebook|marketplace|sellpy|vinted|begagna|möbler - (fåtöljer|soffor)/i;

/** Andra namn AI-läget gav modellen i rubriken: "Genova (säljs även under namnet Clapton)" → ["Clapton"]. Ren funktion. */
export function aliasUrSvaret(answer: string, model: string): string[] {
  const ut = new Set<string>();
  for (const rad of answer.split("\n")) {
    if (!/^[\s#*]*\d[.)]/.test(rad) || !nammer(rad, model)) continue;
    for (const m of rad.matchAll(/(?:även (?:under namnet|som|kallad)|även känd som)\s+(\p{Lu}[\p{L}\p{N}-]+)/gu)) {
      if (norm(m[1]) !== norm(model)) ut.add(m[1]);
    }
  }
  return [...ut];
}

/**
 * Bilderna som får bli modellens kortbild, bästa först. Titeln måste nämna modellen (eller dess andra namn), får inte vara andrahand och inte säga en annan möbeltyp. Ordning:
 * modellens namn i den egna raden, namnet annanstans, andra namnet i den egna raden, andra namnet annanstans; inom varje grupp Googles egen ordning. Ren funktion.
 */
export function bildKandidater(
  bilder: GoogleBild[],
  html: string,
  c: { brand: string; model: string; productType: string | null },
  alias: string[],
  allaModeller: string[],
): GoogleBild[] {
  const rubriker = allaModeller
    .map((m) => ({ m, at: html.indexOf(`${c.brand} ${m}`.trim()) }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at);
  const jag = rubriker.findIndex((r) => r.m === c.model);
  const fran = jag >= 0 ? rubriker[jag].at : -1;
  const till = jag >= 0 ? (rubriker[jag + 1]?.at ?? html.length) : -1;
  const egen = (b: GoogleBild) => fran >= 0 && b.at > fran && b.at < till;
  const fam = typfamilj(c.productType);
  const grupp = (b: GoogleBild): number => {
    if (nammer(b.titel, c.model)) return egen(b) ? 0 : 1;
    if (alias.some((a) => nammer(b.titel, a))) return egen(b) ? 2 : 3;
    return -1;
  };
  const sedda = new Set<string>();
  return bilder
    .map((b) => ({ b, g: grupp(b) }))
    .filter(({ b, g }) => g >= 0 && !ANDRAHAND.test(`${b.titel} ${b.kalla ?? ""} ${b.original ?? ""}`) && !(fam && motsagerTyp(b.titel, fam)))
    .sort((x, y) => x.g - y.g || x.b.at - y.b.at)
    .map(({ b }) => b)
    .filter((b) => !sedda.has(b.dataUri) && !!sedda.add(b.dataUri));
}

// --- Sidan hämtas när svaret kommer, och bilderna väljs när modellnamnen är klara ----------------------------------------------------------------------------------------------------

interface Sida {
  html: string;
  bilder: GoogleBild[];
  skapad: number;
}
/** Nyckel: exakt den svarstext webben får och skickar tillbaka till jobbet. Så behöver varken webben eller jobbet bära bilderna. */
const sidor = new Map<string, Sida>();
const nyckel = (answer: string): string => createHash("sha1").update(answer).digest("hex");
const TTL_MS = 30 * 60 * 1000;

/** Hämtar den råa sidan och sparar bilderna för det här svaret. Ger antalet bilder; 0 när sidan inte går att hämta eller inte har några. Kastar aldrig. */
export async function forberedGoogleBilder(answer: string, raHtmlUrl: string | null, hamta: typeof fetch = fetch): Promise<number> {
  if (!raHtmlUrl) return 0;
  try {
    const t0 = Date.now();
    const res = await hamta(raHtmlUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, 8_000_000);
    const bilder = lasGoogleBilder(html);
    for (const [k, v] of sidor) if (Date.now() - v.skapad > TTL_MS) sidor.delete(k);
    sidor.set(nyckel(answer), { html, bilder, skapad: Date.now() });
    log(`rå sida ${Math.round(html.length / 1024)} kB på ${Date.now() - t0} ms: ${bilder.length} bilder med titel`);
    return bilder.length;
  } catch (err) {
    log(`den råa sidan gick inte att läsa: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    return 0;
  }
}

export interface ValdBild {
  url: string;
  source: string | null;
}

/** Kortbilden per modell: den första av Googles bilder som klarar titelkontrollen (bildKandidater), eller ingen. Inget AI-anrop. Kastar aldrig för en enskild modell. */
export async function valjGoogleBilder(
  jobId: string,
  answer: string,
  candidates: Array<{ brand: string; model: string; productType?: string | null }>,
): Promise<Map<string, ValdBild>> {
  const ut = new Map<string, ValdBild>();
  const sida = sidor.get(nyckel(answer));
  if (!sida) {
    log(`${jobId.slice(0, 8)} ingen rå sida sparad för svaret`);
    return ut;
  }
  const namnen = candidates.map((c) => c.model);
  await Promise.all(
    candidates.map(async (c) => {
      try {
        const kand = bildKandidater(sida.bilder, sida.html, { brand: c.brand, model: c.model, productType: c.productType ?? null }, aliasUrSvaret(answer, c.model), namnen);
        const ta = (b: GoogleBild, url: string, vilken: string) => {
          ut.set(c.model, { url, source: b.kalla });
          log(`${jobId.slice(0, 8)} ${c.model}: "${b.titel.slice(0, 80)}" (${vilken})`);
        };
        // Först originalet: hela möbeln i full upplösning. Högst två försök, så att en butik som inte svarar inte drar ut på tiden.
        for (const b of kand.filter((k) => k.original).slice(0, 2)) {
          const url = await lokalOriginalbild(b.original!);
          if (url) return ta(b, url, "originalet");
        }
        // Annars rutan ur Googles bildrad (kan vara beskuren och liten, men finns alltid). Går en inte att spara tas nästa i ordningen.
        for (const b of kand) {
          const url = await sparaInbaddadKandidatbild(b.dataUri);
          if (url) return ta(b, url, "Googles ruta");
        }
        log(`${jobId.slice(0, 8)} ${c.model}: ingen bild (${kand.length} passande titlar)`);
      } catch (err) {
        log(`${jobId.slice(0, 8)} ${c.model}: urvalet föll — ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      }
    }),
  );
  return ut;
}
