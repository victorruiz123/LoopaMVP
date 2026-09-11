/**
 * Fyller kandidatbildsregistret i förväg, ur butikernas egna sortimentslistor.
 *
 *   npx tsx scripts/forvarm-kandidatbilder.ts                   # alla fem butikerna
 *   npx tsx scripts/forvarm-kandidatbilder.ts --butik ikea,mio  # bara några
 *   npx tsx scripts/forvarm-kandidatbilder.ts --antal 50        # tak, för att se hur det går
 *   npx tsx scripts/forvarm-kandidatbilder.ts --torr            # hämta inget, visa bara vad som fanns
 *   npx tsx scripts/forvarm-kandidatbilder.ts --takt 2          # färre samtidiga hämtningar
 *   npx tsx scripts/forvarm-kandidatbilder.ts --igen            # pröva om de som inte gav någon bild
 *
 * VARFÖR. Modellväljarens miniatyr kommer antingen ur registret — en filkontroll, några
 * millisekunder — eller ur en jakt: sidor att hämta, sökmotorer att fråga, träffar att rangordna,
 * fem till fyrtio sekunder. Registret fylls annars bara av trafik, alltså av den förste säljaren som
 * råkar ha just den möbeln, och han får betala hela väntan för alla som kommer efter. Värst syns det
 * efter "hitta nya": omgång två består per definition av de modeller säljaren INTE redan blivit
 * erbjuden, alltså de ovanliga, alltså de som aldrig ligger i registret.
 *
 * Det går inte att göra letandet snabbt. Det går att slippa det, och det är vad det här skriptet gör.
 *
 * SAMMA VÄG SOM DRIFTEN, hela vägen. Bilderna hämtas med `lokalKandidatbild` och skrivs med
 * `registreraKandidatbilder` — samma nedskalning till 400 px, samma kontroll att det verkligen ÄR en
 * bild, samma nyckel. En förvärmd bild är alltså inte en annan sorts bild än en jagad, bara en som
 * redan ligger där. Och skulle sidan visa sig ge fel bild finns rättelsen på ett ställe för båda.
 *
 * VI VET VILKEN SIDA DET ÄR, och det är hela skillnaden mot jakten. Jakten letar upp en sida och
 * måste sedan bevisa att den handlar om modellen; här kommer adressen ur butikens egen sitemap och
 * modellnamnet ur den sidans egen titel. Det finns ingenting att gissa, så ingen gissning kan slinka
 * igenom.
 *
 * ÅTERUPPTAGBART. Registret är också minnet: en modell som redan har en bild hoppas över, och en
 * körning som avbryts kan startas om utan att göra om det som gjordes. Modeller som inte gav någon
 * bild skrivs ned separat — inte i registret, som bara bär träffar — så att nästa körning inte
 * lägger tid på dem igen. `--igen` prövar dem ändå.
 *
 * MÅTTFULLT MOT BUTIKERNA. Fyra samtidiga hämtningar per butik, en modell per produktfamilj i stället
 * för en per färg och storlek, och ingenting hämtas två gånger. Det är ungefär vad en person som
 * bläddrar i sortimentet kostar dem, utspritt över en förmiddag.
 *
 * FILERNA HAMNAR I `server/data/kandidatbilder`, alltså på den maskin skriptet kördes på. Körs det
 * på en dator måste katalogen föras över till driften (app.loopa.nu) för att någon säljare ska se
 * skillnaden — både jpg-filerna och `register.json`, som pekar på dem.
 */
import { lokalKandidatbild, kandidatbilderDir, registreradKandidatbild, registreraKandidatbilder } from "../server/src/kandidatbild.js";
import { extractImages } from "../server/src/candidateImages.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Sidhämtningens tak. Sitemaps är stora och långsamma; produktsidor är snabba. */
const SIDA_TIMEOUT_MS = 30_000;
/** Hur mycket av en produktsida vi läser. og-taggarna sitter i huvudet, som i candidateImages. */
const MAX_SIDA_BYTES = 1024 * 1024;

/** En modell att förvärma: vad den heter (om upptäckten vet det) och var dess sida ligger. */
type Modell = {
  /** Namnet upptäckten gissar ur adressen. Sidans egen titel går före när den säger något annat. */
  model: string;
  url: string;
};

type Butik = {
  id: string;
  /** Märket som skrivs i registret. Måste stavas som generatorn stavar det — se nyckel() i kandidatbild.ts. */
  brand: string;
  /** Sortimentet, en adress per modell. */
  upptack(): Promise<Modell[]>;
  /** Modellnamnet läst ur sidan. Null = behåll det upptäckten gissade. */
  namn?(html: string, url: string): string | null;
  /** Bildadresser att pröva, bäst först. Standard är sidans egna og/JSON-LD-bilder. */
  bilder?(html: string, url: string): Promise<string[]> | string[];
};

// ---------------------------------------------------------------------------
// Hämtning
// ---------------------------------------------------------------------------

async function hamtaText(url: string, max = MAX_SIDA_BYTES): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SIDA_TIMEOUT_MS),
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok || !res.body) return null;
    // Läses i bitar med ett tak: IKEA:s sitemapfiler är 50 MB, och en produktsida som skickar en
    // megabyte har redan sagt allt vi ville veta i sitt huvud.
    const reader = res.body.getReader();
    const bitar: Uint8Array[] = [];
    let langd = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bitar.push(value);
      langd += value.length;
      if (langd >= max) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return Buffer.concat(bitar).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Adresserna i en sitemap, en i taget.
 *
 * STRÖMMANDE, och det är inte en stilfråga. Mios sitemap bär 1,3 miljoner adresser och IKEA:s väger
 * en kvarts gigabyte; att samla dem i en lista innan de grupperas hade kostat hundratals megabyte på
 * en burk som delar minne med prismotorn — för att sedan kasta nästan allt, eftersom det vi vill ha
 * är några tusen produktfamiljer. Adresserna räknas därför av medan de kommer.
 */
async function sitemapAdresser(url: string, pa: (adress: string) => void): Promise<void> {
  const xml = await hamtaText(url, 256 * 1024 * 1024);
  if (!xml) return;
  // Utan reguljärt uttryck över hela dokumentet: IKEA:s filer ligger på EN rad och är 50 MB, och en
  // global matchning över den raden är mätbart långsammare än att dela på taggen.
  for (const bit of xml.split("<loc>")) {
    const slut = bit.indexOf("</loc>");
    if (slut > 0) pa(bit.slice(0, slut).trim().replace(/&amp;/g, "&"));
  }
}

/** Samma, men genom ett sitemap-index: varje under-sitemap som `valj` släpper igenom gås igenom. */
async function sitemapIndex(index: string, valj: (url: string) => boolean, pa: (adress: string) => void): Promise<void> {
  const delar: string[] = [];
  await sitemapAdresser(index, (u) => {
    if (valj(u)) delar.push(u);
  });
  for (const del of delar) await sitemapAdresser(del, pa);
}

// ---------------------------------------------------------------------------
// Namn ur sidan
// ---------------------------------------------------------------------------

const TITEL = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const OG_TITEL = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i;

function avkoda(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // Numeriska entiteter: DUX skriver "Comfort b&#xe4;ddmadrasser", och utan den här raden hamnade
    // den strängen i registret precis så — en nyckel ingen kan slå upp.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function sidtitel(html: string): string | null {
  const og = html.match(OG_TITEL)?.[1];
  const t = og ?? html.match(TITEL)?.[1];
  return t ? avkoda(t) : null;
}

/**
 * Modellnamnet som VERSALER i en produkttitel.
 *
 * IKEA och Jysk skriver båda modellen i versaler och resten i gemener — "YXSTABY sidobord på hjul",
 * "Matstol TOREBY svart konstläder" — så versalerna ÄR märkningen, oavsett var i raden de står.
 * Flera versalord i rad hör ihop ("KARL JOHAN"), och ett ensamt tecken eller en förkortning som "LED"
 * är ingen modell.
 */
function versalnamn(titel: string): string | null {
  const ord = titel.split(/[\s,]+/);
  const bitar: string[] = [];
  const ut: string[][] = [];
  for (const o of ord) {
    const rent = o.replace(/[^A-ZÅÄÖa-zåäö0-9-]/g, "");
    if (rent.length >= 2 && rent === rent.toUpperCase() && /[A-ZÅÄÖ]/.test(rent)) bitar.push(rent);
    else if (bitar.length) {
      ut.push([...bitar]);
      bitar.length = 0;
    }
  }
  if (bitar.length) ut.push(bitar);
  // Den längsta versalsekvensen, och vid lika den första: "YXSTABY sidobord" ger YXSTABY, och en
  // avslutande brusrad som "IKEA" väger aldrig tyngre än modellen själv.
  const bast = ut.filter((s) => !(s.length === 1 && FORKORTNINGAR.has(s[0]))).sort((a, b) => b.join(" ").length - a.join(" ").length)[0];
  return bast ? bast.join(" ") : null;
}

/** Versaler som aldrig är en modell, hur ensamma de än står i titeln. */
const FORKORTNINGAR = new Set(["IKEA", "JYSK", "MIO", "SITS", "SWEEF", "DUX", "HAY", "LED", "TV", "USB", "PE", "EU", "SE", "OK"]);

/**
 * Titeln utan sajtens egen svans.
 *
 * "DUX 10 | DUX" och "Soft Edge 91 | HAY" bär butiksnamnet efter en lodrät linje, och utan den här
 * skrevs hela raden in som modellnamn — `dux 10 | dux` är en nyckel ingen frågar efter.
 */
function utanSvans(titel: string | null): string | null {
  if (!titel) return null;
  const forst = titel.split(/\s*[|–—]\s*/)[0].trim();
  return forst.length >= 1 && forst.length <= 40 ? forst : null;
}

/**
 * Modellen ur en produkttitel som börjar med namnet och fortsätter med vad det är.
 *
 * "Pillo fotpall" → Pillo. "Plus Kontorsstolar - Kontorsmöbler | Kinnarps" → Plus. Först kapas
 * säljsvansen vid den första skiljelinjen, sedan orden fram till möbeltypen — samma gräns som
 * `familjFöreTypord` drar i en slug, men på en titel som har å, ä och ö i behåll.
 */
function namnFöreTypord(titel: string): string | null {
  const ord: string[] = [];
  for (const o of titel.split(/\s[–—|]\s|\s-\s/)[0].trim().split(/\s+/)) {
    if (TYPORD.test(o.toLowerCase().replace(/[^a-zåäö]/g, "")) || /^\d/.test(o)) break;
    ord.push(o);
  }
  const namn = ord.join(" ").trim();
  return namn.length >= 2 && namn.length <= 40 ? namn : null;
}

/** "cherrie" → "Cherrie". Sluggen är gemener; modellnamn skrivs inte så. */
function frånSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Butikerna
// ---------------------------------------------------------------------------

/**
 * EN SIDA PER MODELL, inte per variant.
 *
 * SÖDERHAMN har dussintals produktsidor — en per klädsel, storlek och kulör — och de bär alla samma
 * modellnamn och nästan samma bild. Att hämta dem alla vore att be IKEA om fyrtiotusen sidor för att
 * få tretusen namn. Nyckeln är därför produktfamiljen, och den första adressen i varje familj får
 * stå för den.
 */
class Familjer {
  private ut = new Map<string, Modell>();
  /** Första adressen i varje familj vinner; resten är samma modell i en annan färg. */
  lagg(url: string, nyckel: string | null | undefined): void {
    if (!nyckel || this.ut.has(nyckel)) return;
    this.ut.set(nyckel, { model: frånSlug(nyckel), url });
  }
  lista(): Modell[] {
    return [...this.ut.values()];
  }
}

/**
 * Familjenamnet i en slug som börjar med modellen: allt fram till möbeltypen.
 *
 * Mio skriver `madison-lux-3-sits-soffa` och `delux-sense-kontinentalsang-...`, alltså modellen
 * först och vad det är sedan. Var modellen slutar syns bara på att nästa ord är en möbeltyp eller en
 * siffra — "Madison Lux" är två ord, "Eden" ett — så det är typordet som får dra gränsen. Läser den
 * fel blir familjen bara finare uppdelad än nödvändigt: två sidor hämtas där en hade räckt. Den
 * felar alltså mot fler hämtningar, aldrig mot fel bild, för namnet kommer ur sidan.
 */
const TYPORD =
  /^(soffa|soffor|sits|schaslong|schäslong|hornsoffa|hörnsoffa|fatolj|fåtölj|karmstol|stol|stolar|bord|bank|bänk|sang|säng|kontinentalsang|kontinentalsäng|ramsang|ramsäng|byra|byrå|skap|skåp|skänk|skank|hylla|bokhylla|garderob|matgrupp|pall|puff|sideboard|vitrinskap|vitrinskåp|sangbord|sängbord|spegel|matta|lampa|taklampa|golvlampa|bordslampa|madrass|baddsoffa|bäddsoffa|fotpall|skrivbord|soffbord|matbord|barstol|dynbox|kladstang|klädstång|ställbar|stallbar|lux|modulsoffa|modulsoffan|serie|serien)$/;

function familjFöreTypord(slug: string): string | null {
  const delar = decodeURIComponent(slug).toLowerCase().split("-");
  const ut: string[] = [];
  for (const d of delar) {
    if (!d) continue;
    if (TYPORD.test(d) || /^\d/.test(d)) break;
    ut.push(d);
  }
  return ut.length ? ut.join("-") : null;
}

const BUTIKER: Butik[] = [
  {
    id: "ikea",
    brand: "IKEA",
    /**
     * Sortimentet står i sju sitemapfiler på sammanlagt en kvarts gigabyte. Bara de svenska:
     * `prod-en-SE` är samma produkter med engelska sluggar, och de skulle bara ge samma familjer
     * en gång till.
     */
    async upptack() {
      const fam = new Familjer();
      // Adressform: /se/sv/p/<familj>-<beskrivning>-<artikelnummer>/
      await sitemapIndex(
        "https://www.ikea.com/sitemaps/sitemap.xml",
        (u) => /prod-sv-SE/.test(u),
        (u) => fam.lagg(u, u.match(/\/se\/sv\/p\/([a-z0-9]+)-/)?.[1]),
      );
      return fam.lista();
    },
    /**
     * Titeln, inte sluggen.
     *
     * IKEA translittererar å, ä och ö i adressen — SÖDERHAMN blir `soederhamn`, YXSTABY förblir
     * `yxstaby` — och den vägen går inte att vända säkert: `ae` är ibland ä och ibland ae. Titeln
     * bär namnet som det stavas, i versaler.
     */
    namn: (html) => {
      const t = sidtitel(html);
      return t ? versalnamn(t) : null;
    },
  },
  {
    id: "mio",
    brand: "Mio",
    /**
     * TVÅ KÄLLOR, för Mio har två sorters sidor och båda bär modeller.
     *
     * Serierna under `varumarken-och-serier` är Mios egna familjenamn — Cherrie, Dakota, Bridge — och
     * en färdig lista över precis det vi vill ha. Men de är bara ett fyrtiotal, och sortimentet är
     * större än så: resten ligger under `/p/`, en adress per färg och storlek, 1,3 miljoner stycken.
     * De grupperas på namnet före möbeltypen och blir knappt tretusen familjer.
     */
    async upptack() {
      const serier = new Familjer();
      const produkter = new Familjer();
      await sitemapIndex(
        "https://www.mio.se/sitemap/sitemap_index.xml",
        () => true,
        (u) => {
          if (/\/varumarken-och-serier\/serier-[^/]+\/[^/]+$/.test(u)) {
            // Även serienamnet kan bära möbeltypen — `plaine-matgrupp` är serien Plaine.
            const serie = u.split("/").pop();
            return serier.lagg(u, serie ? familjFöreTypord(serie) ?? serie : null);
          }
          const slug = u.match(/\/p\/([^/?]+)/)?.[1];
          if (slug) produkter.lagg(u, familjFöreTypord(slug));
        },
      );
      // Serierna först: de är Mios egna namn på familjen, och den som redan fått sin bild därifrån
      // hoppas över när produktsidorna kommer.
      return [...serier.lista(), ...produkter.lista()];
    },
    /**
     * Seriesidorna har namnet i ADRESSEN, produktsidorna i titeln.
     *
     * Och det är inte en förenkling — titeln ljuger på seriesidorna. "Modulsoffan Free" gav modellen
     * `Modulsoffan Free`, som generatorn aldrig kommer att fråga efter: den säger "Mio Free", och en
     * post under fel namn är en post ingen hittar. En sida vars titel var "Soffor | Mio" skrev till
     * och med in kategorin som en modell. Adressen `/serier-soffor/free` säger `free`, kort och rätt.
     *
     * På produktsidorna är titeln däremot det enda stället där modellen står med å, ä och ö i behåll:
     * "Madison Lux 3-sits soffa" — orden före möbeltypen, precis som familjen lästes ur sluggen.
     */
    namn: (html, url) => {
      if (/varumarken-och-serier/.test(url)) return null;
      const t = sidtitel(html);
      if (!t) return null;
      const ord: string[] = [];
      for (const o of t.split(/\s[–—|]\s/)[0].trim().split(/\s+/)) {
        if (TYPORD.test(o.toLowerCase()) || /^\d/.test(o)) break;
        ord.push(o);
      }
      const namn = ord.join(" ").trim();
      return namn.length >= 2 && namn.length <= 40 ? namn : null;
    },
  },
  {
    id: "sits",
    brand: "Sits",
    async upptack() {
      const fam = new Familjer();
      // Bara den språklösa vägen: /de/, /pl/ och de andra är samma kollektioner på andra språk.
      await sitemapAdresser("https://sits.eu/sitemap-0.xml", (u) => {
        if (/^https:\/\/sits\.eu\/collection\/[^/]+\/?$/.test(u)) fam.lagg(u, u.replace(/\/$/, "").split("/").pop());
      });
      return fam.lista();
    },
    /** Sluggen duger: "anna" → Anna. Titeln är en säljmening, inte ett namn. */
    namn: () => null,
    /**
     * SITS BILDER LIGGER INTE I HTML:EN, och den uppenbara vägen dit är en fälla.
     *
     * Sidan byggs av Gatsby i webbläsaren, så den råa HTML:en bär bara logotypen, och `og:image` är
     * en och samma generiska bild för hela sajten. Gatsby lägger sidans data i en JSON bredvid — men
     * den JSON:en bär också sajtens DELADE bilder, och de står först. Att ta den första bilden gav
     * varenda Sits-modell samma foto på en LILL-soffa: Anna och Laila fick samma fil, och hade hela
     * kollektionen körts igenom hade alla 117 pekat på den. Fyra identiska rutor i väljaren är värre
     * än fyra tomma — säljaren tror att något gått sönder, och det har det.
     *
     * Därför plockas bilden ur det fält som är sidans EGET: `collectionPagePreviewImage`. Och för att
     * ett omdöpt fält inte ska kunna återinföra felet tyst kontrolleras filnamnet mot modellen —
     * Sits döper sina filer `ANNA_interior_armchair_...`, så en bild som inte bär modellens namn är
     * någon annans och avvisas.
     */
    async bilder(_html, url) {
      const slug = url.replace(/\/$/, "").split("/").pop();
      const rå = await hamtaText(`https://sits.eu/page-data/collection/${slug}/page-data.json`);
      if (!rå) return [];
      let src: unknown;
      let titel: unknown;
      try {
        const d = JSON.parse(rå);
        const samling = d?.result?.data?.wpCollection;
        titel = samling?.title;
        src = samling?.collections?.generalCollectionInformation?.collectionPagePreviewImage?.localFile?.childImageSharp
          ?.gatsbyImageData?.images?.fallback?.src;
      } catch {
        return [];
      }
      // Filen ska bära modellens namn. Bilden hör till sidan bara om den säger det själv.
      const namn = (typeof titel === "string" ? titel : slug ?? "").replace(/[^A-Za-zÅÄÖåäö0-9]/g, "").toLowerCase();
      if (!namn) return [];
      const hörTill = (adress: string) => (adress.split("/").pop()?.toLowerCase() ?? "").startsWith(namn);

      const ut: string[] = [];
      if (typeof src === "string" && src.startsWith("/static/") && hörTill(src)) ut.push(src);
      /**
       * Reservvägen, och den är gratis tack vare namnkontrollen.
       *
       * Ett trettiotal kollektioner saknar `collectionPagePreviewImage` helt — Laila och Stella
       * leather bland dem — och de hade blivit utan bild trots att deras egna foton ligger i samma
       * JSON. Att leta bland dem är ofarligt så länge filnamnet måste börja med modellen: det är
       * precis det villkor som stänger ute sajtens delade bilder, vilken av dem som än råkar stå
       * först.
       */
      for (const m of rå.matchAll(/"(?:src|publicURL)":"(\/static\/[^"]+\.(?:jpg|jpeg|png|webp))"/g)) {
        if (hörTill(m[1]) && !ut.includes(m[1])) ut.push(m[1]);
      }
      return ut.slice(0, 4).map((a) => `https://sits.eu${a}`);
    },
  },
  {
    id: "jysk",
    brand: "JYSK",
    /**
     * INGEN GRUPPERING HÄR, och det är inte en glömska.
     *
     * Jysk lägger modellen mitt i adressen — `matstol-toreby-svart-konstlader-svart` — mellan
     * möbeltypen och färgen, och vilket ord det är går inte att veta utan att känna sortimentet.
     * Familjen kan alltså inte läsas ur adressen, så varje sida hämtas och modellen läses ur titeln.
     * Dubbletterna faller bort i motorn: andra gången TOREBY dyker upp står den redan i registret.
     */
    async upptack() {
      const ut: Modell[] = [];
      const mobelrum = /^https:\/\/jysk\.se\/(sovrum|vardagsrum|matrum|forvaring|kontor|barn|uteplats-balkong)\/[^/]+\/[^/]+$/;
      for (let sida = 1; sida <= 3; sida++) {
        await sitemapAdresser(`https://jysk.se/sitemap.xml?page=${sida}`, (u) => {
          if (mobelrum.test(u)) ut.push({ model: frånSlug(u.split("/").pop() ?? ""), url: u });
        });
      }
      return ut;
    },
    /** "Matstol TOREBY svart konstläder" — modellen är versalordet. */
    namn: (html) => {
      const t = sidtitel(html);
      return t ? versalnamn(t) : null;
    },
  },
  {
    id: "dux",
    brand: "DUX",
    /** Ett litet, fast sortiment: `/produkter/<kategori>/<modell>/`, knappt tvåhundra adresser. */
    async upptack() {
      const fam = new Familjer();
      await sitemapAdresser("https://www.dux.se/sitemap.xml", (u) => {
        const m = u.match(/^https:\/\/www\.dux\.se\/produkter\/[^/]+\/([^/]+)\/$/);
        if (m) fam.lagg(u, m[1]);
      });
      return fam.lista();
    },
    /** "DUX 10 | DUX" → DUX 10. Märket står kvar i namnet, och motorn skriver in båda formerna. */
    namn: (html) => utanSvans(sidtitel(html)),
  },
  {
    id: "hay",
    brand: "HAY",
    /** En egen produktsitemap, 1 400 adresser, ingen gruppering behövs. */
    async upptack() {
      const ut: Modell[] = [];
      await sitemapAdresser("https://www.hay.com/sitemaps/sitemap-products.xml", (u) => {
        const slug = u.split("/").filter(Boolean).pop();
        if (slug) ut.push({ model: frånSlug(slug), url: u });
      });
      return ut;
    },
    /** "Soft Edge 91" — hela namnet ÄR modellen hos HAY, så titeln tas som den står, utan svans. */
    namn: (html) => utanSvans(sidtitel(html)),
  },
  {
    id: "swedese",
    brand: "Swedese",
    /**
     * Produkter och kategorier ligger PÅ SAMMA DJUP, och sluggen är det enda som skiljer dem.
     *
     * `/produkter/fatoljer/lamino-fatolj` är en produkt, `/produkter/fatoljer/fotpallar` en kategori
     * — båda tre segment in. Skillnaden är att produkten bär möbeltypen EFTER namnet, medan
     * kategorin bara är typen i plural. Kravet är därför att namnet ska bli kortare när typordet
     * kapas: `lamino-fatolj` → `lamino`, medan `fotpallar` inte går att korta och alltså inte är en
     * modell. Utan den regeln stod Lamino — Swedeses mest sålda möbel av alla — utanför, medan
     * kategorin "Fotpallar" skrevs in som ett modellnamn.
     */
    async upptack() {
      const fam = new Familjer();
      await sitemapAdresser("https://www.swedese.se/sitemap.xml", (u) => {
        const djupt = u.match(/^https:\/\/www\.swedese\.se\/produkter\/[^/]+\/[^/]+\/([^/]+)$/);
        if (djupt) return fam.lagg(u, familjFöreTypord(djupt[1]) ?? djupt[1]);
        const grunt = u.match(/^https:\/\/www\.swedese\.se\/produkter\/[^/]+\/([^/]+)$/);
        if (!grunt) return;
        const familj = familjFöreTypord(grunt[1]);
        if (familj && familj !== grunt[1].replace(/-$/, "")) fam.lagg(u, familj);
      });
      return fam.lista();
    },
    /** "Pillo fotpall" → Pillo. */
    namn: (html) => {
      const t = sidtitel(html);
      return t ? namnFöreTypord(t) : null;
    },
    /**
     * SWEDESES EGEN og:image ÄR TRASIG, och bilden ligger en domän bort.
     *
     * Taggen pekar på `www.swedese.se/storage/…`, och den adressen svarar 404 med en HTML-sida —
     * varenda Swedese-modell blev därför utan bild, inklusive Lamino. Sidans egna bildtaggar hjälper
     * inte heller: de tre som står i HTML:en är ikoner i svg, resten laddas av JavaScript.
     *
     * Men filen finns, på `webapi.swedese.se` under exakt samma sökväg — det är den domän sidans
     * egna taggar använder. Adressen skrivs alltså om, och originalet får stå kvar sist ifall
     * Swedese lagar sin tagg.
     */
    bilder: (html, url) => {
      const egna = extractImages(html, url);
      const omskrivna = egna
        .filter((a) => a.startsWith("https://www.swedese.se/storage/"))
        .map((a) => a.replace("https://www.swedese.se/", "https://webapi.swedese.se/"));
      return [...omskrivna, ...egna];
    },
  },
  {
    id: "kinnarps",
    brand: "Kinnarps",
    async upptack() {
      const fam = new Familjer();
      await sitemapAdresser("https://www.kinnarps.se/sitemap.xml", (u) => {
        const m = u.match(/^https:\/\/www\.kinnarps\.se\/produkter\/[^/]+\/[^/]+\/([^/]+)\/$/);
        if (m) fam.lagg(u, m[1]);
      });
      return fam.lista();
    },
    /**
     * FÖRSTA ORDET, och inte den vanliga gränsen vid möbeltypen.
     *
     * Kinnarps säljer kontorsmöbler, och deras typord är inte de andras: "Plus Kontorsstolar",
     * "Trixagon Förvaring", "Prim Golvskärm", "Vibe Tak- och Väggabsorbenter". `namnFöreTypord`
     * känner inte igen något av dem och lämnade hela raden — registret fick nycklar som
     * `kinnarps|trixagon förvaring förvaring`, som ingen frågar efter.
     *
     * Att räkna upp kontorssortimentets alla typord vore att jaga en lista som aldrig blir färdig.
     * Kinnarps namnger i stället sina familjer med ETT ord — Plus, Oberon, Trixagon, Scandinavia,
     * Prim, Vibe — och det ordet står först. Gränsen är tvåordsnamn, om de finns: de kapas till sitt
     * första ord, vilket är en sämre nyckel men aldrig en felaktig bild.
     */
    namn: (html) => {
      // Ur den RÅA titeln: "Trixagon bord - Kontorsmöbler och kontorsinredning | Kinnarps" är längre
      // än `utanSvans` släpper igenom, och ett null därifrån hade fallit tillbaka på sluggens gissning
      // — alltså just den `trixagon bord` vi försöker bli av med.
      const forst = sidtitel(html)?.trim().split(/\s+/)[0]?.replace(/[^A-Za-zÅÄÖåäö0-9-]/g, "");
      return forst && forst.length >= 2 ? forst : null;
    },
  },
  {
    id: "sweef",
    brand: "Sweef",
    /**
     * INGEN SITEMAP ATT FÅ TAG PÅ — sortimentet skördas ur kategorisidorna i stället.
     *
     * `sitemap.xml` svarar med Next.js egen 404-sida och robots.txt pekar inte ut någon. Men
     * sortimentet är litet och kategorisidorna listar hela det: ett trettiotal soffor och bäddsoffor,
     * varje länk `/p/<kategori>/<modell>`. Underkategorierna tas med för att en modell som bara står
     * under "modulsoffor" inte ska falla bort.
     */
    async upptack() {
      const rot = "https://sweef.se";
      const kategorier = new Set(["/c/mobler/soffor", "/c/mobler/baddsoffor"]);
      const ut = new Map<string, Modell>();
      // Två varv: först rotkategorierna, sedan de underkategorier de pekar ut.
      for (let varv = 0; varv < 2; varv++) {
        for (const kat of [...kategorier]) {
          const html = await hamtaText(`${rot}${kat}`);
          if (!html) continue;
          if (varv === 0) for (const m of html.matchAll(/href="(\/c\/mobler\/[a-z0-9/-]+)"/g)) kategorier.add(m[1]);
          for (const m of html.matchAll(/href="(\/p\/[a-z0-9/-]+)"/g)) {
            const slug = m[1].split("/").pop();
            if (slug && !ut.has(slug)) ut.set(slug, { model: frånSlug(slug), url: `${rot}${m[1]}` });
          }
        }
      }
      return [...ut.values()];
    },
    /** "Djup, soffa/divansoffa/schäslongsoffa | ELEFANTEN | SWEEF" — modellen är versalordet. */
    namn: (html) => {
      const t = sidtitel(html);
      return t ? versalnamn(t) : null;
    },
  },
  {
    id: "soffadirekt",
    brand: "SoffaDirekt",
    async upptack() {
      const fam = new Familjer();
      await sitemapAdresser("https://www.soffadirekt.se/sitemap.xml", (u) => {
        // Produktsidor, inte kategorisidor: de senare heter alltid index.html.
        if (/\/sv\/artiklar\/[^/]+\.html$/.test(u) && !u.endsWith("/index.html")) {
          fam.lagg(u, u.split("/").pop()?.replace(/\.html$/, "").split("-")[0]);
        }
      });
      return fam.lista();
    },
    /** "BLACKA Stol" — modellen i versaler, möbeltypen efter. */
    namn: (html) => {
      const t = sidtitel(html);
      return t ? versalnamn(t) : null;
    },
  },
];

// ---------------------------------------------------------------------------
// Motorn
// ---------------------------------------------------------------------------

/** Modeller som prövats utan att ge en bild. Ligger utanför registret, som bara bär träffar. */
const UTAN_BILD_FIL = () => path.join(kandidatbilderDir(), "forvarm-utan-bild.json");

async function laddaUtanBild(): Promise<Set<string>> {
  try {
    const rå: unknown = JSON.parse(await readFile(UTAN_BILD_FIL(), "utf8"));
    return new Set(Array.isArray(rå) ? rå.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

async function sparaUtanBild(nycklar: Set<string>): Promise<void> {
  try {
    await mkdir(kandidatbilderDir(), { recursive: true });
    await writeFile(UTAN_BILD_FIL(), JSON.stringify([...nycklar], null, 0), "utf8");
  } catch {
    /* En lista som inte kan skrivas är en långsam nästa körning, inte ett fel. */
  }
}

/** Kör `arbete` över `poster` med högst `takt` samtidigt. */
async function ipar<T>(poster: T[], takt: number, arbete: (p: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(takt, poster.length) }, async () => {
      for (;;) {
        const egen = i++;
        if (egen >= poster.length) return;
        await arbete(poster[egen]);
      }
    }),
  );
}

type Utfall = { bild: number; fanns: number; utan: number; fel: number };

async function forvarmButik(butik: Butik, flaggor: Flaggor, utanBild: Set<string>): Promise<Utfall> {
  const utfall: Utfall = { bild: 0, fanns: 0, utan: 0, fel: 0 };
  process.stdout.write(`\n[${butik.id}] läser sortimentet…\n`);
  const modeller = await butik.upptack();
  process.stdout.write(`[${butik.id}] ${modeller.length} modeller i sortimentet\n`);
  if (flaggor.torr) {
    for (const m of modeller.slice(0, 12)) process.stdout.write(`  ${m.model.padEnd(24)} ${m.url}\n`);
    if (modeller.length > 12) process.stdout.write(`  … och ${modeller.length - 12} till\n`);
    return utfall;
  }

  const kvar = flaggor.antal ? modeller.slice(0, flaggor.antal) : modeller;
  /** Skrivs i klump: registret sparas till disk vid varje skrivning, och en gång per modell vore en gång för mycket. */
  const attSkriva: Array<{ brand: string; model: string; url: string }> = [];
  const nyckel = (model: string) => `${butik.brand.toLowerCase()}|${model.toLowerCase()}`;

  /** En modell: hämta, läs namnet, hämta bilden. Räknandet och framstegsraden ligger utanför. */
  const en = async (m: Modell): Promise<void> => {
    try {
      // Det upptäckten gissade räcker för att slå upp — och när gissningen stämmer slipper vi
      // hämta sidan alls. Jysk är undantaget: där säger adressen inget om modellen.
      if (butik.id !== "jysk") {
        if (await registreradKandidatbild(butik.brand, m.model)) return void utfall.fanns++;
        if (!flaggor.igen && utanBild.has(nyckel(m.model))) return void utfall.utan++;
      }

      const html = await hamtaText(m.url);
      if (!html) return void utfall.fel++;

      const model = (butik.namn?.(html, m.url) ?? m.model).trim();
      // En kategori är inte en modell. Sidor som svarar med "Soffor | Mio" i stället för produkten
      // skrev annars in rubriken som ett modellnamn, och den posten hade sedan legat i vägen.
      if (!model || model.length > 40 || TYPORD.test(model.toLowerCase())) return void utfall.fel++;

      // Namnet ur sidan kan vara ett annat än gissningen — slå upp igen innan vi hämtar en bild.
      if (await registreradKandidatbild(butik.brand, model)) return void utfall.fanns++;
      if (!flaggor.igen && utanBild.has(nyckel(model))) return void utfall.utan++;

      const bilder = (await (butik.bilder?.(html, m.url) ?? extractImages(html, m.url))).slice(0, 4);
      for (const bild of bilder) {
        // Sidans adress som referer, precis som i jakten: flera butiker vägrar annars lämna ut bilden.
        const lokal = await lokalKandidatbild(bild, m.url);
        if (!lokal) continue;
        attSkriva.push({ brand: butik.brand, model, url: lokal });
        /**
         * SAMMA BILD UNDER BÅDA NAMNEN när märket står i modellnamnet.
         *
         * DUX döper sina sängar "DUX 10" och "DUX Jetson", och generatorn kan lämna antingen
         * `{ brand: "DUX", model: "DUX 10" }` eller `{ brand: "DUX", model: "10" }` — samma möbel,
         * två nycklar. En post under bara den ena är en post hälften av frågorna missar. Den andra
         * kostar ingenting: det är en rad i registret som pekar på en fil som redan ligger där.
         */
        const utanMarke = model.replace(new RegExp(`^${butik.brand}\\s+`, "i"), "").trim();
        if (utanMarke && utanMarke !== model) attSkriva.push({ brand: butik.brand, model: utanMarke, url: lokal });
        utfall.bild++;
        if (attSkriva.length >= 25) await registreraKandidatbilder(attSkriva.splice(0));
        return;
      }
      utanBild.add(nyckel(model));
      utfall.utan++;
    } catch {
      utfall.fel++;
    }
  };

  /**
   * Framstegsraden räknas HÄR och inte inne i `en`.
   *
   * Den satt sist i arbetet förut, efter de `return` som avslutar varje lyckat fall — alltså kom den
   * bara när något gått fel, och en körning som gick bra såg ut att ha hängt sig. En körning som tar
   * en timme måste säga att den lever.
   */
  let gjort = 0;
  await ipar(kvar, flaggor.takt, async (m) => {
    await en(m);
    if (++gjort % 100 === 0) {
      process.stdout.write(`[${butik.id}] ${gjort}/${kvar.length} — ${utfall.bild} nya bilder, ${utfall.utan} utan\n`);
    }
  });

  if (attSkriva.length) await registreraKandidatbilder(attSkriva);
  return utfall;
}

type Flaggor = { butiker: string[]; antal: number | null; takt: number; torr: boolean; igen: boolean };

function lasFlaggor(argv: string[]): Flaggor {
  const varde = (namn: string) => {
    const i = argv.indexOf(namn);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valda = varde("--butik")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const antal = Number(varde("--antal"));
  const takt = Number(varde("--takt"));
  return {
    butiker: valda?.length ? valda : BUTIKER.map((b) => b.id),
    antal: Number.isFinite(antal) && antal > 0 ? antal : null,
    takt: Number.isFinite(takt) && takt > 0 ? Math.min(takt, 12) : 4,
    torr: argv.includes("--torr"),
    igen: argv.includes("--igen"),
  };
}

async function main() {
  const flaggor = lasFlaggor(process.argv.slice(2));
  const okanda = flaggor.butiker.filter((id) => !BUTIKER.some((b) => b.id === id));
  if (okanda.length) {
    console.error(`Okänd butik: ${okanda.join(", ")}. Välj bland ${BUTIKER.map((b) => b.id).join(", ")}.`);
    process.exit(1);
  }

  process.stdout.write(`Registret ligger i ${kandidatbilderDir()}\n`);
  const utanBild = await laddaUtanBild();
  const start = Date.now();
  const summa: Utfall = { bild: 0, fanns: 0, utan: 0, fel: 0 };

  for (const butik of BUTIKER.filter((b) => flaggor.butiker.includes(b.id))) {
    const u = await forvarmButik(butik, flaggor, utanBild);
    process.stdout.write(
      `[${butik.id}] klar — ${u.bild} nya bilder, ${u.fanns} fanns redan, ${u.utan} utan bild, ${u.fel} fel\n`,
    );
    for (const k of Object.keys(summa) as Array<keyof Utfall>) summa[k] += u[k];
    if (!flaggor.torr) await sparaUtanBild(utanBild);
  }

  const minuter = Math.round((Date.now() - start) / 60000);
  process.stdout.write(
    `\nTotalt: ${summa.bild} nya bilder, ${summa.fanns} fanns redan, ${summa.utan} utan bild, ${summa.fel} fel — ${minuter} min\n`,
  );
}

void main();
