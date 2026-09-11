/**
 * Flödesmätningen: vad säljaren gjorde mellan startsidan och det intygade kortet.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Allt annat i datafliken går att läsa ur något som redan sparas —
 * jobbet, butiken, ordern, mätningen. Flödet gör det inte. Tiden från start till intygat, var folk
 * hoppar av, vilket steg en fråga ställdes i: ingenting av det står någonstans i dag, och det går
 * inte att räkna fram i efterhand ur ett jobb som blev klart. Antingen mäts det medan det händer
 * eller så finns det inte.
 *
 * SKILD FRÅN analys/store.ts, och det är avsiktligt. Den mäter ANNONSEN — visningar, klick, köp —
 * med annonsens Loopa-id som nyckel, och en besökare som aldrig blev en annons har den inget att
 * säga om. Den här mäter SÄLJFLÖDET, med en flödessession som nyckel, och den intressantaste raden
 * här är just den som aldrig nådde fram till ett jobb. Att slå ihop de två hade betytt att den ena
 * frågans nyckel blev den andras saknade fält.
 *
 * SESSIONEN OCH JOBBET KNYTS IHOP I EFTERHAND. Märkesvalet och filmningen sker innan jobbet finns —
 * det skapas först vid uppladdningen — så klienten bär ett eget slumpat `sess` genom hela flödet och
 * skickar med `jobId` så fort det finns. Hopkopplingen sker vid läsningen: alla rader med samma
 * `sess` hör till det jobb någon av dem nämner. Utan det hade halva flödet — de två steg som är
 * längst och där flest försvinner — legat lösryckt från möbeln de handlade om.
 *
 * SÄLJAREN STÅR PÅ RADEN NÄR DEN FINNS. Här stod tidigare "ingen identitet", och tratten gick
 * därför bara att läsa som ett medelvärde över okända besökare. Intaget behöver det andra svaret
 * också: vem av våra säljare påbörjade en annons och var släppte hen den. `uid` är kontots id —
 * samma sträng som ett jobbs `ownerId` — och ingenting utöver det: ingen e-post, ingen adress,
 * ingen IP. Namnet bakom id:t hämtas i panelen ur Supabase, av en admin som redan får se det.
 *
 * `uid` ÄR PÅSTÅDD AV WEBBLÄSAREN och behandlas som det. Vägen in är öppen och måste vara det —
 * halva flödet sker före inloggningen, och en `sendBeacon` vid fliksstängning kan inte bära något
 * Authorization-huvud. Den som vill kan alltså skriva en flödesrad i någon annans namn. Det duger
 * för en trattmätning och inte för något annat, och därför är det STYRKTA ägarskapet — jobbets
 * `ownerId` — det som gäller så fort flödet blev ett jobb. Se `saljarnycklar` nedan.
 *
 * Egenskaperna är fortfarande vitlistade och frågornas text når fortfarande inte hit; samtalen
 * sparas där de passerar servern ändå, se data/samtal.ts.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const DATA_KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const FLODE_FIL = () => path.join(DATA_KATALOG(), "flode.jsonl");

/**
 * Stegen i säljflödet, i den ordning de kommer.
 *
 * SPEGLAR `Screen` i web/src/App.tsx och måste göra det: klienten skickar namnet därifrån rakt av.
 * Listan är samtidigt vitlistan — ett steg som inte står här räknas inte — och ordningen, som
 * tratten läses ur. Ett nytt steg i appen måste läggas till här för att synas i panelen.
 */
export const STEG = [
  "home",
  "capture",
  "signup",
  "starting",
  "identify",
  "specs",
  "price",
  "analysis",
  "result",
  "listing",
] as const;

export type Steg = (typeof STEG)[number];

const STEG_INDEX = new Map<string, number>(STEG.map((s, i) => [s, i]));

/**
 * Händelser som får skrivas.
 *
 * Vitlistan är säkerheten, precis som i analysmätningen: vägen in är öppen — en säljare som ännu inte
 * loggat in är själva mätobjektet — och en öppen väg som tar emot vilket namn som helst är en gratis
 * skrivbar disk för vem som helst på internet.
 */
export const FLODESHANDELSER = new Set([
  /** Ett steg lämnades. Bär hur länge det varade — det är den enda källan till "tid per steg". */
  "steg",
  /** Fliken stängdes utan att flödet var färdigt. Bär steget det stod på. */
  "avhopp",
  /** Flödet nådde ett intygat kort. */
  "intygat",
  /** En fråga ställdes till en av chattarna. Bär steget och en grov kategori, aldrig frågans text. */
  "guide_fraga",
  /** Ett förslagschip trycktes. */
  "chip",
  /** "Berätta" slogs på. Se `berattaFinns` nedan. */
  "beratta",
  /** Enheten, en gång per flödessession. */
  "enhet",
  /** Kontot loggade in. Bär inget eget innehåll — poängen är `uid` på raden. */
  "saljare",
]);

/**
 * Egenskaper som får följa med. Allt annat kastas.
 *
 * `text` står med och är den enda som bär något en människa skrivit — men bara för chipen, vars text
 * VI har skrivit, och den klipps hårt. Frågornas egen text når aldrig hit: `guide_fraga` bär en
 * kategori, för panelen ska kunna svara på VAD folk undrar över utan att bli ett läsbart arkiv över
 * vad enskilda personer frågat.
 */
const TILLATNA_PROPS = new Set(["steg", "ms", "chatt", "kategori", "text", "enhet", "plattform", "bredd", "vy", "varv"]);

export interface FlodesRad {
  at: string;
  /** Flödessessionen. Slumpad i webbläsaren, betyder ingenting utanför besöket. */
  sess: string;
  /** Jobbet, när det hunnit skapas. Null för allt som hände före uppladdningen. */
  jobId: string | null;
  /** Kontot, när säljaren hunnit logga in. Påstådd av klienten — se filens topp. */
  uid: string | null;
  event: string;
  props: Record<string, string | number | boolean>;
}

/**
 * Ett helt flöde, hopsatt ur sina rader.
 *
 * `jobId` kan vara null: det är fallet som gör mätningen värd att ha. En session som tog slut på
 * `capture` blev aldrig ett jobb, och den raden är svaret på "var tappar vi folk".
 */
export interface FlodesSession {
  sess: string;
  jobId: string | null;
  /** Kontot flödet hörde till. Null för den som aldrig loggade in — vilket är de flesta avhoppen. */
  uid: string | null;
  start: string;
  slut: string;
  /** Millisekunder från första till sista raden. Inte "tid till intygat" — se `tidTillIntygat`. */
  totaltMs: number;
  /** Tid per steg, summerad över besöken i steget. */
  perSteg: Record<string, number>;
  /** Stegen i den ordning de faktiskt besöktes, dubbletter borttagna. */
  besokta: string[];
  /** Längst komna steget. Tratten räknas på den. */
  sistaSteg: string | null;
  /** Sant när flödet nådde ett intygat kort. Då är `sistaSteg` inget avhopp. */
  intygat: boolean;
  /** Millisekunder från flödets första rad till intyget. Null när det aldrig kom dit. */
  tidTillIntygat: number | null;
  /** Frågor till guiderna: vilket steg, vilken chatt, vilken kategori. */
  fragor: Array<{ at: string; steg: string | null; chatt: string | null; kategori: string | null }>;
  /** Förslagschip som trycktes. */
  chip: Array<{ at: string; steg: string | null; text: string | null }>;
  berattaPa: boolean;
  enhet: string | null;
  plattform: string | null;
  vy: string | null;
}

// ---------------------------------------------------------------------------
// Minnet
// ---------------------------------------------------------------------------

const sessioner = new Map<string, FlodesRad[]>();
let laddad: Promise<void> | null = null;
let kedja: Promise<unknown> = Promise.resolve();

/**
 * Taket på hur många sessioner minnet håller.
 *
 * Filen är sanningen och behåller allt; minnet är indexet panelen läser. En växande karta som aldrig
 * städas är samma minnesläcka som en växande loggfil hade varit — och det är den senaste tidens
 * flöden panelen frågar efter, inte fjolårets.
 */
const SESSIONSTAK = 20_000;

function skrivIn(rad: FlodesRad): void {
  let rader = sessioner.get(rad.sess);
  if (!rader) {
    if (sessioner.size >= SESSIONSTAK) {
      // Kartan är insättningsordnad: den första nyckeln är den äldsta sessionen.
      const aldst = sessioner.keys().next().value;
      if (aldst !== undefined) sessioner.delete(aldst);
    }
    rader = [];
    sessioner.set(rad.sess, rader);
  }
  // Taket per session stoppar en klient som fastnat i en slinga från att äta minnet.
  if (rader.length < 400) rader.push(rad);
}

async function ladda(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(FLODE_FIL(), "utf-8");
  } catch {
    return;
  }
  for (const rad of raw.split("\n")) {
    if (!rad.trim()) continue;
    try {
      const r = JSON.parse(rad) as FlodesRad;
      if (!r?.sess || !r.event || !r.at) continue;
      skrivIn(r);
    } catch {
      // En halv rad från en process som dog mitt i en skrivning får inte fälla hela läsningen.
      continue;
    }
  }
}

export function redo(): Promise<void> {
  laddad ??= ladda();
  return laddad;
}

// ---------------------------------------------------------------------------
// Skrivningen
// ---------------------------------------------------------------------------

function stada(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const ut: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!TILLATNA_PROPS.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) ut[k] = Math.round(v);
    else if (typeof v === "boolean") ut[k] = v;
    else if (typeof v === "string" && v.length <= 120) ut[k] = v;
  }
  return ut;
}

/**
 * Skriver en flödesrad. Faller aldrig — en mätning får inte fälla det den mäter.
 *
 * Anropas från en öppen väg, så allt prövas här och inget antas: händelsenamnet mot vitlistan,
 * steget mot STEG, egenskaperna mot sin egen lista.
 */
export async function spara(
  sess: string,
  jobId: string | null,
  event: string,
  props: Record<string, unknown> = {},
  uid: string | null = null,
): Promise<void> {
  try {
    if (!FLODESHANDELSER.has(event)) return;
    const nyckel = sess.trim().slice(0, 40);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(nyckel)) return;
    const rensade = stada(props);
    if (typeof rensade.steg === "string" && !STEG_INDEX.has(rensade.steg)) delete rensade.steg;
    await redo();
    const rad: FlodesRad = {
      at: new Date().toISOString(),
      sess: nyckel,
      jobId: jobId?.trim().slice(0, 64) || null,
      // Samma form som Supabases id, och inget annat: fältet ska inte gå att använda som en fri
      // textrad in i filen av den som hittar den öppna vägen.
      uid: typeof uid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(uid.trim()) ? uid.trim() : null,
      event,
      props: rensade,
    };
    skrivIn(rad);
    const text = JSON.stringify(rad) + "\n";
    kedja = kedja
      .then(async () => {
        await mkdir(DATA_KATALOG(), { recursive: true });
        await appendFile(FLODE_FIL(), text, "utf-8");
      })
      .catch(() => undefined);
    await kedja;
  } catch {
    // Tyst. Se filens topp.
  }
}

// ---------------------------------------------------------------------------
// Läsningen
// ---------------------------------------------------------------------------

function bygg(sess: string, rader: FlodesRad[]): FlodesSession {
  const sorterade = [...rader].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const forsta = sorterade[0];
  const sista = sorterade[sorterade.length - 1];
  const ut: FlodesSession = {
    sess,
    jobId: sorterade.find((r) => r.jobId)?.jobId ?? null,
    uid: sorterade.find((r) => r.uid)?.uid ?? null,
    start: forsta.at,
    slut: sista.at,
    totaltMs: new Date(sista.at).getTime() - new Date(forsta.at).getTime(),
    perSteg: {},
    besokta: [],
    sistaSteg: null,
    intygat: false,
    tidTillIntygat: null,
    fragor: [],
    chip: [],
    berattaPa: false,
    enhet: null,
    plattform: null,
    vy: null,
  };


  const sedda = new Set<string>();
  let langst = -1;
  for (const rad of sorterade) {
    const steg = typeof rad.props.steg === "string" ? rad.props.steg : null;
    if (steg && !sedda.has(steg)) {
      sedda.add(steg);
      ut.besokta.push(steg);
    }
    if (steg) {
      const i = STEG_INDEX.get(steg) ?? -1;
      if (i > langst) {
        langst = i;
        ut.sistaSteg = steg;
      }
    }
    switch (rad.event) {
      case "steg":
        if (steg && typeof rad.props.ms === "number") ut.perSteg[steg] = (ut.perSteg[steg] ?? 0) + rad.props.ms;
        break;
      case "intygat":
        ut.intygat = true;
        ut.tidTillIntygat = new Date(rad.at).getTime() - new Date(forsta.at).getTime();
        break;
      case "guide_fraga":
        ut.fragor.push({
          at: rad.at,
          steg,
          chatt: typeof rad.props.chatt === "string" ? rad.props.chatt : null,
          kategori: typeof rad.props.kategori === "string" ? rad.props.kategori : null,
        });
        break;
      case "chip":
        ut.chip.push({ at: rad.at, steg, text: typeof rad.props.text === "string" ? rad.props.text : null });
        break;
      case "beratta":
        ut.berattaPa = true;
        break;
      case "enhet":
        ut.enhet = typeof rad.props.enhet === "string" ? rad.props.enhet : ut.enhet;
        ut.plattform = typeof rad.props.plattform === "string" ? rad.props.plattform : ut.plattform;
        ut.vy = typeof rad.props.vy === "string" ? rad.props.vy : ut.vy;
        break;
      default:
        break;
    }
  }
  return ut;
}

/** Alla flödessessioner, nyast först. */
export async function allaSessioner(): Promise<FlodesSession[]> {
  await redo();
  const ut: FlodesSession[] = [];
  for (const [sess, rader] of sessioner) if (rader.length) ut.push(bygg(sess, rader));
  return ut.sort((a, b) => (a.start < b.start ? 1 : -1));
}

/**
 * Flödet för ett jobb, hopsatt ur alla sessioner som nämner det.
 *
 * Fler än en session kan höra till samma jobb: en säljare som stänger fliken och öppnar kortet igen
 * senare får ett nytt `sess` men samma möbel. Den FÖRSTA sessionen bär flödet — det är den som
 * innehåller filmningen — och därför är det den som returneras.
 */
export async function flodeForJobb(jobId: string): Promise<FlodesSession | null> {
  const alla = await allaSessioner();
  const matchande = alla.filter((s) => s.jobId === jobId);
  if (!matchande.length) return null;
  return matchande.sort((a, b) => (a.start < b.start ? -1 : 1))[0];
}

/**
 * Tratten: hur många som nådde varje steg, och hur många som stannade där.
 *
 * `stannade` räknas på sessioner som ALDRIG kom längre och inte intygade — alltså avhoppen. Ett steg
 * med hög andel avhopp är antingen för långt eller för svårt, och det är hela frågan mätningen finns
 * för att kunna besvara.
 */
export interface TrattSteg {
  steg: string;
  naddeHit: number;
  stannade: number;
  /** Median i millisekunder över de sessioner som mätte tid i steget. */
  medianMs: number | null;
}

export function tratt(sessioner: FlodesSession[]): TrattSteg[] {
  return STEG.map((steg) => {
    const naddeHit = sessioner.filter((s) => s.besokta.includes(steg)).length;
    const stannade = sessioner.filter((s) => !s.intygat && s.sistaSteg === steg).length;
    const tider = sessioner.map((s) => s.perSteg[steg]).filter((n): n is number => typeof n === "number" && n > 0).sort((a, b) => a - b);
    return {
      steg,
      naddeHit,
      stannade,
      medianMs: tider.length ? tider[Math.floor(tider.length / 2)] : null,
    };
  });
}

/**
 * Ett avbrutet flöde, som en rad.
 *
 * DEN HÄR RADEN ÄR HELA MÄTNINGENS POÄNG. Tratten säger att nio av tio försvinner på modellvalet;
 * den säger inte VILKA nio, när, på vilken telefon eller om de hann fråga något först. Ett tal går
 * inte att ringa upp. En rad gör det — och för den som loggat in bär den dessutom kontot, vilket är
 * skillnaden mellan "vi tappar folk i identifieringen" och "vi tappade Anna i identifieringen, tre
 * gånger, alltid på mobil".
 *
 * `paborjad` skiljer en PÅBÖRJAD ANNONS från ett besök. Den som öppnade startsidan och stängde den
 * igen har inte avbrutit någonting — hen tittade. Den som valde märke och började filma har lagt ned
 * arbete och sedan släppt det, och bara de raderna är avhopp i den mening ordet har här.
 */
export interface Avhopp {
  sess: string;
  uid: string | null;
  jobId: string | null;
  start: string;
  slut: string;
  totaltMs: number;
  /** Längst komna steget — det är HÄR de försvann. */
  sistaSteg: string | null;
  besokta: string[];
  /** Tiden i det sista steget. Lång tid + avhopp = steget är svårt, inte ointressant. */
  sistaStegMs: number | null;
  /** Sant när flödet hann bli en påbörjad annons. Se `Avhopp` ovan. */
  paborjad: boolean;
  antalFragor: number;
  enhet: string | null;
  plattform: string | null;
  vy: string | null;
}

/** Första steget efter startsidan. Allt därifrån och framåt är en påbörjad annons. */
const FORSTA_ARBETSSTEG = 1;

/**
 * Alla flöden som tog slut utan ett intyg, nyast först.
 *
 * Ett flöde utan steg alls räknas inte: det är en sidladdning, inte ett avhopp.
 */
export function avhoppen(sessioner: FlodesSession[]): Avhopp[] {
  return sessioner
    .filter((s) => !s.intygat && s.sistaSteg !== null)
    .map((s) => ({
      sess: s.sess,
      uid: s.uid,
      jobId: s.jobId,
      start: s.start,
      slut: s.slut,
      totaltMs: s.totaltMs,
      sistaSteg: s.sistaSteg,
      besokta: s.besokta,
      sistaStegMs: s.sistaSteg ? (s.perSteg[s.sistaSteg] ?? null) : null,
      paborjad: s.besokta.some((steg) => (STEG_INDEX.get(steg) ?? -1) >= FORSTA_ARBETSSTEG),
      antalFragor: s.fragor.length,
      enhet: s.enhet,
      plattform: s.plattform,
      vy: s.vy,
    }))
    .sort((a, b) => (a.slut < b.slut ? 1 : -1));
}

/**
 * Finns "Berätta" i appen?
 *
 * NEJ, INTE ÄN — och det står här i stället för att tigas ihjäl. Händelsen är vitlistad och
 * hopsättningen läser den, så mätningen är på plats den dag knappen byggs; till dess visar panelen
 * fältet som osamlat i stället för som ett falskt "aldrig påslaget". Skillnaden mellan "ingen tryckte"
 * och "det gick inte att trycka" är hela skälet till att raden finns.
 *
 * Samma sak gäller frågorna om lukt, husdjur och rök: se `LUCKOR` i dataset.ts.
 */
export const berattaFinns = false;

/** Bara för tester: glöm allt och läs om vid nästa fråga. */
export function nollstall(): void {
  sessioner.clear();
  laddad = null;
}
