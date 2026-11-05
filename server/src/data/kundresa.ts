/**
 * Kundresan: från första besöket till en såld möbel, och hur folk rör sig på vägen.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Varje del av resan mättes redan, men på var sitt ställe: trafiken
 * slutade vid "lade upp en annons", flödet vid det intygade kortet, och annonslistan började först
 * när möbeln låg ute. Ingen av dem kunde svara på frågan som avgör var nästa krona ska läggas —
 * vilken kanal ger SÅLDA möbler, och var på vägen dit försvinner flest? Här sätts delarna ihop till
 * en tratt, utan att någon av mätningarna behöver veta om de andra.
 *
 * TVÅ ENHETER, OCH DET SÄGS RAKT UT. Första halvan räknas i besök — ett besök börjar sälja eller
 * inte — och andra halvan i annonser — en annons blir såld eller inte. Att låtsas att de är samma
 * sak hade gjort tratten snyggare och fel: en säljare som lägger upp tre möbler är ett besök och tre
 * annonser. Bron mellan dem är den färdiga annonsen, som finns i båda.
 *
 * KOHORTER, INTE HÄNDELSER. Perioden väljer VILKA besök och annonser som följs — de som började i
 * perioden — och sedan följs de hela vägen, också efter periodens slut. Det är så en konvertering
 * räknas rätt: "av annonserna från oktober såldes 40 %" och inte "i oktober såldes 12 möbler och 30
 * annonser lades upp", två tal om olika saker.
 *
 * INGEN EGEN SANNING. Allt härleds ur besöken, flödena, jobben, butiken och ordrarna; filen lagrar
 * ingenting och är ren, så att testerna kan mata den. Adminernas egna besök och annonser räknas inte.
 */

import { SEKTIONER, type Besok } from "./besok.js";
import { STEG, type FlodesSession, type Punkt } from "./flode.js";

const DYGN = 24 * 60 * 60 * 1000;
const STEG_INDEX = new Map<string, number>(STEG.map((s, i) => [s, i]));
const CAPTURE = STEG_INDEX.get("capture")!;
const STARTING = STEG_INDEX.get("starting")!;

/** En annons, så som resan behöver den. Servervägen sätter ihop den ur jobbet, butiken och ordern. */
export interface AnnonsIn {
  jobId: string;
  ownerId: string | null;
  /** När jobbet skapades — uppladdningen. Samma tid översikten räknar "nya annonser" på. */
  skapad: string;
  /** Sant när jobbet blev en färdig annons. Samma regel som kontolistans cardCount. */
  fardig: boolean;
  /** "Sälj med Loopa" trycktes. */
  overlamnad: string | null;
  /** En admin godkände, och möbeln fick gå ut. */
  godkand: string | null;
  sald: string | null;
}

export interface ResanIn {
  besok: Besok[];
  floden: FlodesSession[];
  annonser: AnnonsIn[];
  admins: ReadonlySet<string>;
  dagar: number;
  /** Bara besök och annonser från den här kanalen. Null = alla. */
  kanal: string | null;
  /** Kampanjlänkarnas koder. Resultaten räknas bara för dem. */
  kampanjkoder: string[];
  /** "mobil" eller "dator". Null = båda. */
  enhet: string | null;
  nu?: Date;
}

export interface ResSteg {
  nyckel: string;
  antal: number;
  /** Samma steg perioden innan. Null där jämförelsen inte är rättvis — se `helaResan`. */
  forra: number | null;
  /**
   * Medianen i millisekunder. Första halvan: från besökets början. Andra halvan: från steget innan.
   * Null när inget underlag finns.
   */
  medianMs: number | null;
}

/**
 * Hur långt ett besök kom, i ett ord. Varje besök har precis ett — det längst komna — så att
 * andelarna för en ingång alltid summerar till hundra.
 *
 * ORDNINGEN ÄR DJUPET: att lämna direkt är minst, en färdig annons mest. Köparens och säljarens väg
 * är olika vägar, men en färdig annons är mer än att ha tittat på möbler, och den som började sälja
 * efter att ha tittat i butiken räknas som säljare — det är vad besöket blev.
 */
export const UTFALL = ["lamnade", "tittade", "mobler", "salja", "annons"] as const;
export type Utfall = (typeof UTFALL)[number];

/**
 * En ingång: sidan besöken BÖRJADE på, vad de blev, och vart de gick härnäst.
 *
 * Det är den enklaste frågan om hur folk rör sig som går att agera på: ingången väljer vi själva med
 * länken vi delar, och "nästa sida" visar om sidan leder dit vi tror.
 */
export interface Ingang {
  sida: string;
  besok: number;
  utfall: Record<Utfall, number>;
  /** Sidan efter ingången, de vanligaste först. Null = lämnade utan att gå vidare. */
  nasta: Array<{ sida: string | null; antal: number }>;
}

export interface SidBeteende {
  sida: string;
  /** Besök som såg sidan. Enheten är besök genom hela sidvyn, så att talen går att jämföra. */
  besok: number;
  /** Besök där scrolldjupet mättes. Andelarna nedan räknas på det. */
  medDjup: number;
  /** Besök som nådde minst 25, 50, 75 respektive 100 % av sidan. */
  djup: { 25: number; 50: number; 75: number; 100: number };
  /** Sektionerna i sidans ordning: hur många besök som såg dem, och hur många som tryckte i dem. */
  sektioner: Array<{ namn: string; sedd: number; klick: number }>;
}

/**
 * En skärm i säljflödet: hur många som kom hit, hur många som slutade här, och vad som gick fel för
 * dem som slutade. Felen räknas en gång per besök — tre försök att spela in är ett problem, inte tre.
 */
export interface FlodesSteg {
  steg: string;
  nadde: number;
  /** Besök vars längst komna skärm var den här, utan att bli en färdig annons. */
  lamnade: number;
  medianMs: number | null;
  /** De vanligaste felen hos dem som lämnade här. */
  fel: Array<{ namn: string; antal: number }>;
}

export interface SessionRad {
  sess: string;
  uid: string | null;
  start: string;
  slut: string;
  kanal: string;
  kalla: string;
  enhet: string | null;
  landning: string | null;
  sista: string | null;
  sidor: number;
  /** Längst komna skärmen i säljflödet. Null för den som aldrig kom in i det. */
  sistaSteg: string | null;
  /** Antal fel säljaren fick under besöket. */
  fel: number;
  borjade: boolean;
  intygat: boolean;
  kassa: boolean;
  kop: boolean;
}

export interface KallaResa {
  kalla: string;
  besok: number;
  borjade: number;
  fardigaBesok: number;
  annonser: number;
  salda: number;
}

/** En kanal genom resan, med källorna inom den — Instagram och Facebook under "Sociala medier". */
export interface KanalResa extends Omit<KallaResa, "kalla"> {
  kanal: string;
  /** Samma kanal perioden innan, för trenden. Null när besöken inte mättes då. */
  forraBesok: number | null;
  forraFardigaBesok: number | null;
  kallor: KallaResa[];
}

/** En kampanjlänk genom resan. Se data/kampanjer.ts. */
export interface KampanjResa {
  kod: string;
  besok: number;
  borjade: number;
  fardigaBesok: number;
  annonser: number;
  salda: number;
  /** Senaste besöket genom länken. Null = ingen har använt den än. */
  senast: string | null;
}

/**
 * Hur bra kanalerna går att mäta. Ett besök utan känd källa är inte en kanal som heter Direkt — det
 * är ett besök vi inte vet något om, och andelen säger hur mycket kanaltabellen går att lita på.
 */
export interface Matkvalitet {
  besok: number;
  /** Besök utan referrer och utan märkning: Direkt. */
  utanKalla: number;
  /** Besök som kom in genom en av panelens kampanjlänkar. */
  viaLank: number;
  annonser: number;
  /** Annonser vars säljare vi aldrig såg komma in. */
  annonserOkand: number;
}

export interface ResanSvar {
  dagar: number;
  fran: string;
  kanal: string | null;
  enhet: string | null;
  /** Kanalerna som finns i perioden, för filtret. */
  kanaler: string[];
  /** besok → borjade → laddade → fardig, i besök. */
  besoksdel: ResSteg[];
  /** fardiga → overlamnade → godkanda → salda, i annonser. */
  annonsdel: ResSteg[];
  /** Annonser i kohorten som ligger ute och inte sålts än — de har inte hunnit, de har inte misslyckats. */
  ligger: number;
  /** Godkännandekön, hela, oavsett period och filter: den är vårt eget steg. */
  ko: { vantar: number; aldstaSedan: string | null; medianMs: number | null };
  perKanal: KanalResa[];
  perKampanj: KampanjResa[];
  matning: Matkvalitet;
  beteende: {
    /** Säljflödet skärm för skärm, för besöken som gick in i det. */
    saljflode: FlodesSteg[];
    /** Alla besök som en ingång, för jämförelsen. */
    alla: Ingang;
    ingangar: Ingang[];
    sidor: SidBeteende[];
    sessioner: SessionRad[];
  };
  /** Första besöket mätningen känner till. Allt före det är okänt, inte noll. */
  matningSedan: string | null;
}

function median(tal: number[]): number | null {
  if (!tal.length) return null;
  const s = [...tal].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const ms = (fran: string, till: string) => Date.parse(till) - Date.parse(fran);

/** Längst komna skärm i flödet, som index i STEG. -1 för den som aldrig kom in i det. */
function langst(f: FlodesSession | undefined): number {
  if (!f) return -1;
  let i = -1;
  for (const s of f.besokta) i = Math.max(i, STEG_INDEX.get(s) ?? -1);
  return f.intygat ? STEG.length - 1 : i;
}

/** Första gången flödet stod på skärmen `index` eller längre. Null när det aldrig gjorde det. */
function nadde(f: FlodesSession | undefined, index: number): string | null {
  if (!f) return null;
  for (const p of f.punkter) if (p.steg && (STEG_INDEX.get(p.steg) ?? -1) >= index) return p.at;
  return null;
}

// ---------------------------------------------------------------------------
// Tratten
// ---------------------------------------------------------------------------

interface BesoksUtfall {
  b: Besok;
  f: FlodesSession | undefined;
  borjade: boolean;
  laddade: boolean;
  fardig: boolean;
}

function utfall(b: Besok, f: FlodesSession | undefined): BesoksUtfall {
  const i = langst(f);
  const fardig = !!f?.intygat;
  const laddade = fardig || i >= STARTING;
  return { b, f, borjade: laddade || i >= CAPTURE, laddade, fardig };
}

function besoksSteg(lista: BesoksUtfall[]): Array<{ nyckel: string; antal: number; tider: number[] }> {
  const tid = (u: BesoksUtfall, at: string | null) => (at ? ms(u.b.start, at) : -1);
  const giltig = (n: number) => n >= 0 && n < 7 * DYGN;
  return [
    { nyckel: "besok", antal: lista.length, tider: [] },
    {
      nyckel: "borjade",
      antal: lista.filter((u) => u.borjade).length,
      tider: lista.filter((u) => u.borjade).map((u) => tid(u, nadde(u.f, CAPTURE))).filter(giltig),
    },
    {
      nyckel: "laddade",
      antal: lista.filter((u) => u.laddade).length,
      tider: lista.filter((u) => u.laddade).map((u) => tid(u, nadde(u.f, STARTING))).filter(giltig),
    },
    {
      nyckel: "fardig",
      antal: lista.filter((u) => u.fardig).length,
      tider: lista
        .filter((u) => u.fardig)
        .map((u) => tid(u, u.f!.punkter.find((p) => p.typ === "intygat")?.at ?? null))
        .filter(giltig),
    },
  ];
}

/** Tratten slutar vid försäljningen: leveransen och utbetalningen är vårt arbete, inte säljarens steg. */
const ANNONSSTEG = ["fardiga", "overlamnade", "godkanda", "salda"] as const;

function tiderFor(a: AnnonsIn): Array<string | null> {
  return [a.skapad, a.overlamnad, a.godkand, a.sald];
}

/**
 * Hur långt en annons kom, som index i ANNONSSTEG.
 *
 * BAKIFRÅN: en såld möbel har godkänts även om godkännandet saknar tidsstämpel — äldre annonser
 * publicerades innan steget fanns. Tratten får aldrig visa fler sålda än godkända.
 */
function annonsNadde(a: AnnonsIn): number {
  const t = tiderFor(a);
  for (let i = t.length - 1; i >= 1; i -= 1) if (t[i]) return i;
  return 0;
}

function annonsSteg(lista: AnnonsIn[]): Array<{ nyckel: string; antal: number; tider: number[] }> {
  return ANNONSSTEG.map((nyckel, i) => {
    const tider: number[] = [];
    if (i > 0) {
      for (const a of lista) {
        const t = tiderFor(a);
        if (t[i] && t[i - 1]) {
          const d = ms(t[i - 1]!, t[i]!);
          if (d >= 0) tider.push(d);
        }
      }
    }
    return { nyckel, antal: lista.filter((a) => annonsNadde(a) >= i).length, tider };
  });
}

export function helaResan(inn: ResanIn): ResanSvar {
  const nu = inn.nu ?? new Date();
  const nuIso = nu.toISOString();
  const fran = new Date(nu.getTime() - inn.dagar * DYGN).toISOString();
  const forraFran = new Date(nu.getTime() - 2 * inn.dagar * DYGN).toISOString();

  const besokAlla = inn.besok.filter((b) => !(b.uid && inn.admins.has(b.uid)));
  const floden = inn.floden.filter((f) => !(f.uid && inn.admins.has(f.uid)));
  const flodePerSess = new Map(floden.map((f) => [f.sess, f]));
  const besokPerSess = new Map(besokAlla.map((b) => [b.sess, b]));

  // Kontots FÖRSTA besök: där en annons hamnar när flödet som skapade den inte bar någon källa.
  const forstaBesok = new Map<string, Besok>();
  for (const b of [...besokAlla].sort((a, c) => (a.start < c.start ? -1 : 1))) if (b.uid && !forstaBesok.has(b.uid)) forstaBesok.set(b.uid, b);

  /**
   * Annonsens kanal och enhet: besöket där den filmades, annars säljarens första kända besök.
   * Annonser från före besöksmätningen har ingen av delarna och står som "Okänd".
   */
  const annonsBesok = new Map<string, Besok>();
  for (const f of [...floden].sort((a, c) => (a.start < c.start ? -1 : 1))) {
    if (!f.jobId || annonsBesok.has(f.jobId)) continue;
    const b = besokPerSess.get(f.sess);
    if (b) annonsBesok.set(f.jobId, b);
  }
  const annonsensBesok = (a: AnnonsIn) => annonsBesok.get(a.jobId) ?? (a.ownerId ? forstaBesok.get(a.ownerId) : undefined);
  const annonser = inn.annonser
    .filter((a) => a.fardig && !(a.ownerId && inn.admins.has(a.ownerId)))
    .map((a) => {
      const b = annonsensBesok(a);
      return { a, kanal: b?.kanal ?? "Okänd", kalla: b?.kalla ?? "okänd", kampanjkod: b?.kampanjkod ?? null, enhet: b?.enhet ?? null };
    });

  const passarEnhet = (e: string | null) => !inn.enhet || e === inn.enhet;
  const passar = (kanal: string, e: string | null) => (!inn.kanal || kanal === inn.kanal) && passarEnhet(e);
  const besokEnhet = (b: Besok) => b.enhet ?? flodePerSess.get(b.sess)?.enhet ?? null;

  const iFonster = (start: string, slut: string) => (b: Besok) => b.start >= start && b.start < slut;
  const urval = (start: string, slut: string) =>
    besokAlla.filter(iFonster(start, slut)).filter((b) => passar(b.kanal, besokEnhet(b))).map((b) => utfall(b, flodePerSess.get(b.sess)));
  const nuBesok = urval(fran, nuIso);
  const forraBesok = urval(forraFran, fran);

  const annonsUrval = (start: string, slut: string) =>
    annonser.filter(({ a, kanal, enhet }) => a.skapad >= start && a.skapad < slut && passar(kanal, enhet)).map((x) => x.a);
  const nuAnnonser = annonsUrval(fran, nuIso);
  const forraAnnonser = annonsUrval(forraFran, fran);

  // Förra periodens besökstratt jämförs rakt av. Annonserna bara i första steget: en annons från
  // förra perioden har haft en period längre på sig att säljas, och en jämförelse av "sålda" vore
  // en jämförelse av ålder, inte av hur det går.
  const forraBesokSteg = besoksSteg(forraBesok);
  const forraMatt = besokAlla.some((b) => b.start < fran);
  const besoksdel: ResSteg[] = besoksSteg(nuBesok).map((s, i) => ({
    nyckel: s.nyckel,
    antal: s.antal,
    forra: forraMatt ? forraBesokSteg[i].antal : null,
    medianMs: median(s.tider),
  }));
  const annonsdel: ResSteg[] = annonsSteg(nuAnnonser).map((s, i) => ({
    nyckel: s.nyckel,
    antal: s.antal,
    forra: i === 0 ? forraAnnonser.length : null,
    medianMs: median(s.tider),
  }));

  // Godkännandekön: vårt eget steg, och det enda i tratten vi själva kan korta i dag.
  const iKo = annonser.filter(({ a }) => a.overlamnad && !a.godkand && annonsNadde(a) === 1).map((x) => x.a);
  const ko = {
    vantar: iKo.length,
    aldstaSedan: iKo.map((a) => a.overlamnad!).sort()[0] ?? null,
    medianMs: median(
      annonser
        .filter(({ a }) => a.overlamnad && a.godkand && a.godkand >= fran)
        .map(({ a }) => ms(a.overlamnad!, a.godkand!))
        .filter((d) => d >= 0),
    ),
  };

  // Kanalerna, med enhetsfiltret men utan kanalfiltret — tabellen ÄR jämförelsen mellan kanalerna.
  // Källorna inom varje kanal räknas likadant: "Sociala medier" är ett beslut om Instagram ELLER
  // Facebook, och det beslutet kräver att de två står var för sig.
  const tom = () => ({ besok: 0, borjade: 0, fardigaBesok: 0, annonser: 0, salda: 0 });
  const kanalMap = new Map<string, KanalResa & { kallMap: Map<string, KallaResa> }>();
  const rader = (kanal: string, kalla: string) => {
    let r = kanalMap.get(kanal);
    if (!r) {
      r = { kanal, ...tom(), forraBesok: forraMatt ? 0 : null, forraFardigaBesok: forraMatt ? 0 : null, kallor: [], kallMap: new Map() };
      kanalMap.set(kanal, r);
    }
    let k = r.kallMap.get(kalla);
    if (!k) {
      k = { kalla, ...tom() };
      r.kallMap.set(kalla, k);
    }
    return [r, k] as const;
  };
  for (const b of besokAlla.filter(iFonster(forraFran, nuIso))) {
    if (!passarEnhet(besokEnhet(b))) continue;
    const u = utfall(b, flodePerSess.get(b.sess));
    const [r, k] = rader(b.kanal, b.kalla);
    if (b.start < fran) {
      if (r.forraBesok !== null) r.forraBesok += 1;
      if (u.fardig && r.forraFardigaBesok !== null) r.forraFardigaBesok += 1;
      continue;
    }
    for (const x of [r, k]) {
      x.besok += 1;
      if (u.borjade) x.borjade += 1;
      if (u.fardig) x.fardigaBesok += 1;
    }
  }
  for (const { a, kanal, kalla, enhet } of annonser) {
    if (a.skapad < fran || !passarEnhet(enhet)) continue;
    for (const x of rader(kanal, kalla)) {
      x.annonser += 1;
      if (annonsNadde(a) >= 3) x.salda += 1;
    }
  }
  // Okänd sist oavsett storlek: den säger att vi inte vet, inte att den är en kanal. En kanal som
  // bara fanns förra perioden står inte med — den har ingenting att säga om den här.
  const perKanal: KanalResa[] = [...kanalMap.values()]
    .filter((r) => r.besok > 0 || r.annonser > 0)
    .sort((a, b) => (a.kanal === "Okänd" ? 1 : b.kanal === "Okänd" ? -1 : b.besok - a.besok || b.annonser - a.annonser))
    .map(({ kallMap, ...r }) => ({
      ...r,
      kallor: [...kallMap.values()]
        .filter((k) => k.besok > 0 || k.annonser > 0)
        .sort((a, b) => b.besok - a.besok || b.annonser - a.annonser)
        .slice(0, 8),
    }));

  // Kampanjlänkarna, med samma regler som kanalerna. En länk ingen använt står med på noll: att
  // affischen inte gav något är också ett svar.
  const kampanjMap = new Map<string, KampanjResa>(
    inn.kampanjkoder.map((kod) => [kod, { kod, besok: 0, borjade: 0, fardigaBesok: 0, annonser: 0, salda: 0, senast: null }]),
  );
  const periodensBesok = besokAlla.filter(iFonster(fran, nuIso)).filter((b) => passarEnhet(besokEnhet(b)));
  for (const b of periodensBesok) {
    const r = b.kampanjkod ? kampanjMap.get(b.kampanjkod) : undefined;
    if (!r) continue;
    const u = utfall(b, flodePerSess.get(b.sess));
    r.besok += 1;
    if (u.borjade) r.borjade += 1;
    if (u.fardig) r.fardigaBesok += 1;
    if (!r.senast || b.start > r.senast) r.senast = b.start;
  }
  const periodensAnnonser = annonser.filter(({ a, enhet }) => a.skapad >= fran && passarEnhet(enhet));
  for (const { a, kampanjkod } of periodensAnnonser) {
    const r = kampanjkod ? kampanjMap.get(kampanjkod) : undefined;
    if (!r) continue;
    r.annonser += 1;
    if (annonsNadde(a) >= 3) r.salda += 1;
  }
  const matning: Matkvalitet = {
    besok: periodensBesok.length,
    utanKalla: periodensBesok.filter((b) => b.kanal === "Direkt").length,
    viaLank: periodensBesok.filter((b) => b.kampanjkod && kampanjMap.has(b.kampanjkod)).length,
    annonser: periodensAnnonser.length,
    annonserOkand: periodensAnnonser.filter((x) => x.kanal === "Okänd").length,
  };

  return {
    dagar: inn.dagar,
    fran,
    kanal: inn.kanal,
    enhet: inn.enhet,
    kanaler: perKanal.map((k) => k.kanal),
    besoksdel,
    annonsdel,
    ligger: nuAnnonser.filter((a) => annonsNadde(a) === 2).length,
    ko,
    perKanal,
    perKampanj: [...kampanjMap.values()],
    matning,
    beteende: beteende(nuBesok, {
      tryckte: new Set(
        floden.filter((f) => f.jobId && f.punkter.some((p) => p.typ === "klick" && p.namn === "publicera")).map((f) => f.jobId!),
      ),
      lamnade: new Set(annonser.filter(({ a }) => a.overlamnad).map(({ a }) => a.jobId)),
    }),
    matningSedan: besokAlla.length ? besokAlla.reduce((m, b) => (b.start < m ? b.start : m), besokAlla[0].start) : null,
  };
}

// ---------------------------------------------------------------------------
// Beteendet
// ---------------------------------------------------------------------------

/** Ingångar med färre besök än så slås ihop till "Övriga" — en sida med två besök är ingen ingång. */
const MINSTA_INGANG = 5;
const ANTAL_INGANGAR = 6;

/**
 * Köparnas sidor: butiken, köpsidan, efterlysningarna, Trygg affär och det publika annonskortet.
 * Den som landar där kom för att köpa, och att få av dem börjar sälja säger ingenting om sidan —
 * därför står de inte med bland ingångarna, och räknas inte in i snittet de jämförs mot.
 */
const KOPARSIDA = /^\/(butik|kop|efterlyses|affar|a|c)(\/|$)/;

/** Butikens produktsida: att ha öppnat en möbel är köparens första riktiga steg. */
const PRODUKTSIDA = /^\/butik\/objekt\//;

function utfallFor(u: BesoksUtfall): Utfall {
  if (u.fardig) return "annons";
  if (u.borjade) return "salja";
  const b = u.b;
  if (b.sidor.some((s) => PRODUKTSIDA.test(s.sida)) || b.handlingar.some((h) => h.namn === "begin_checkout" || h.namn === "purchase")) return "mobler";
  return b.sidor.length >= 2 ? "tittade" : "lamnade";
}

function tomIngang(sida: string): Ingang {
  return { sida, besok: 0, utfall: { lamnade: 0, tittade: 0, mobler: 0, salja: 0, annons: 0 }, nasta: [] };
}

/**
 * Säljflödet som det ser ut i appen i dag, i dess ordning.
 *
 * INTE STEG I flode.ts RAKT AV. Den listan är vitlistan och har kvar `signup` som tredje skärm, men
 * kontot frågas inte efter där längre: säljaren filmar och laddar upp som gäst, och kontot skapas
 * först i "Sälj med Loopa" (web/src/components/SellWithLoopa.tsx, `kontoSteg`). `signup` mitt i
 * flödet visas bara när en session gått ut, och räknad som ett steg hade den sett ut att passeras av
 * alla.
 *
 * TVÅ STEG EFTER KORTET. Det färdiga kortet är inte målet — det är att säljaren lämnar möbeln till
 * oss. `salj` är trycket på "Sälj med Loopa", `lamnad` är att annonsen faktiskt kom fram: jobbets
 * Tradera-post finns (se `overlamnad` i AnnonsIn). Det sista läses ur jobbet och inte ur flödet,
 * eftersom en säljare kan komma tillbaka och trycka i ett senare besök.
 */
export const SALJSTEG = ["home", "capture", "starting", "identify", "specs", "price", "analysis", "result", "listing", "salj", "lamnad"] as const;
const SALJ_INDEX = new Map<string, number>(SALJSTEG.map((s, i) => [s, i]));
const SALJ = SALJ_INDEX.get("salj")!;
const LAMNAD = SALJ_INDEX.get("lamnad")!;
const LISTING = SALJ_INDEX.get("listing")!;

interface Publicering {
  /** Jobb där någon tryckte "Sälj med Loopa", i vilket besök som helst. */
  tryckte: ReadonlySet<string>;
  /** Jobb som kom fram till oss. */
  lamnade: ReadonlySet<string>;
}

/** Längst komna steget i säljflödet, som index i SALJSTEG. -1 utanför flödet. */
function hogsta(f: FlodesSession | undefined, pub: Publicering): number {
  if (!f) return -1;
  let h = -1;
  for (const s of f.besokta) h = Math.max(h, SALJ_INDEX.get(s) ?? -1);
  if (f.intygat) h = Math.max(h, LISTING);
  const tryckte = f.punkter.some((p) => p.typ === "klick" && p.namn === "publicera") || (!!f.jobId && pub.tryckte.has(f.jobId));
  if (tryckte) h = Math.max(h, SALJ);
  if (f.mikro.includes("publicerad") || (!!f.jobId && pub.lamnade.has(f.jobId))) h = LAMNAD;
  return h;
}

/**
 * Varför ett besök stannade på ett steg. Felen säljaren fick — och för "Sälj med Loopa", där inget
 * fel behövs för att stanna, också vad som hände: kontot, en avbruten granskning.
 */
function orsaker(f: FlodesSession, steg: number): string[] {
  const ut = new Set(f.punkter.filter((p) => p.typ === "fel").map((p) => p.namn));
  if (steg === SALJ) {
    const tryck = f.punkter.find((p) => p.typ === "klick" && p.namn === "publicera")?.at ?? "";
    if (f.punkter.some((p) => p.typ === "mikro" && p.namn === "konto" && p.at >= tryck)) ut.add("konto_vid_publicering");
    if (f.punkter.some((p) => p.typ === "klick" && p.namn === "publicera_avbryt")) ut.add("granskning_avbruten");
  }
  return [...ut];
}

function saljflode(lista: BesoksUtfall[], pub: Publicering): FlodesSteg[] {
  // Bara besök som BÖRJADE flödet. Den som öppnar sin annons igen från profilen är samma säljare i
  // ett nytt besök, inte en ny som kom till kortet — det besöket räknas på det första, via jobbet.
  const iFlodet = lista
    .filter((u) => u.f && (u.f.besokta.includes("home") || u.f.besokta.includes("capture")))
    .map((u) => ({ f: u.f!, h: hogsta(u.f, pub) }));
  return SALJSTEG.map((steg, i) => {
    const slutadeHar = iFlodet.filter((x) => x.h === i && i < LAMNAD);
    const orsak = new Map<string, number>();
    for (const x of slutadeHar) for (const namn of orsaker(x.f, i)) orsak.set(namn, (orsak.get(namn) ?? 0) + 1);
    return {
      steg,
      nadde: iFlodet.filter((x) => x.h >= i).length,
      lamnade: slutadeHar.length,
      medianMs: median(iFlodet.map((x) => x.f.perSteg[steg]).filter((n): n is number => typeof n === "number" && n > 0)),
      fel: [...orsak].map(([namn, antal]) => ({ namn, antal })).sort((a, b) => b.antal - a.antal).slice(0, 3),
    };
  });
}

function beteende(lista: BesoksUtfall[], pub: Publicering): ResanSvar["beteende"] {
  const alla = tomIngang("alla");
  const perIngang = new Map<string, { ingang: Ingang; nasta: Map<string, number> }>();
  for (const u of lista) {
    const sida = u.b.landning ?? u.b.sidor[0]?.sida;
    if (!sida || KOPARSIDA.test(sida)) continue;
    const ut = utfallFor(u);
    alla.besok += 1;
    alla.utfall[ut] += 1;
    let r = perIngang.get(sida);
    if (!r) {
      r = { ingang: tomIngang(sida), nasta: new Map() };
      perIngang.set(sida, r);
    }
    r.ingang.besok += 1;
    r.ingang.utfall[ut] += 1;
    // Nästa sida: den första som inte är ingången själv. Ingen = lämnade härifrån.
    const nasta = u.b.sidor.find((s) => s.sida !== sida)?.sida ?? "";
    r.nasta.set(nasta, (r.nasta.get(nasta) ?? 0) + 1);
  }
  const ingangar = [...perIngang.values()]
    .filter((r) => r.ingang.besok >= MINSTA_INGANG)
    .sort((a, b) => b.ingang.besok - a.ingang.besok)
    .slice(0, ANTAL_INGANGAR)
    .map(({ ingang, nasta }) => ({
      ...ingang,
      nasta: [...nasta]
        .map(([sida, antal]) => ({ sida: sida || null, antal }))
        .sort((a, b) => b.antal - a.antal)
        .slice(0, 5),
    }));

  // Sidorna: scrolldjup och sektioner, i besök.
  const sidMap = new Map<string, { besok: Set<string>; djup: Map<string, number>; sedd: Map<string, Set<string>>; klick: Map<string, Set<string>> }>();
  const sidRad = (sida: string) => {
    let r = sidMap.get(sida);
    if (!r) {
      r = { besok: new Set(), djup: new Map(), sedd: new Map(), klick: new Map() };
      sidMap.set(sida, r);
    }
    return r;
  };
  for (const { b } of lista) {
    for (const s of b.sidor) {
      const r = sidRad(s.sida);
      r.besok.add(b.sess);
      if (s.djup !== null) r.djup.set(b.sess, Math.max(r.djup.get(b.sess) ?? 0, s.djup));
    }
    for (const s of b.sektioner) {
      const r = sidRad(s.sida);
      r.sedd.set(s.namn, (r.sedd.get(s.namn) ?? new Set()).add(b.sess));
    }
    for (const k of b.klick) {
      const r = sidRad(k.sida);
      r.klick.set(k.namn, (r.klick.get(k.namn) ?? new Set()).add(b.sess));
      // Ett tryck i en sektion betyder att den syntes, även om observatören inte hann rapportera det.
      r.sedd.set(k.namn, (r.sedd.get(k.namn) ?? new Set()).add(b.sess));
    }
  }
  const ordning = new Map<string, number>(SEKTIONER.map((s, i) => [s, i]));
  const sidor: SidBeteende[] = [...sidMap]
    .filter(([, r]) => r.djup.size > 0 || r.sedd.size > 0)
    .map(([sida, r]) => {
      const djup = [...r.djup.values()];
      return {
        sida,
        besok: r.besok.size,
        medDjup: djup.length,
        djup: {
          25: djup.filter((d) => d >= 25).length,
          50: djup.filter((d) => d >= 50).length,
          75: djup.filter((d) => d >= 75).length,
          100: djup.filter((d) => d >= 100).length,
        },
        sektioner: [...r.sedd]
          .sort(([a], [b]) => (ordning.get(a) ?? 99) - (ordning.get(b) ?? 99))
          .map(([namn, sedd]) => ({ namn, sedd: sedd.size, klick: r.klick.get(namn)?.size ?? 0 })),
      };
    })
    .sort((a, b) => b.besok - a.besok)
    .slice(0, 12);

  const sessioner: SessionRad[] = [...lista]
    .sort((a, c) => (a.b.start < c.b.start ? 1 : -1))
    .slice(0, 300)
    .map(({ b, f, borjade, fardig }) => ({
      sess: b.sess,
      uid: b.uid,
      start: b.start,
      slut: b.slut,
      kanal: b.kanal,
      kalla: b.kalla,
      enhet: b.enhet,
      landning: b.landning,
      sista: b.sidor[b.sidor.length - 1]?.sida ?? null,
      sidor: b.sidor.length,
      sistaSteg: f && hogsta(f, pub) >= 0 ? SALJSTEG[hogsta(f, pub)] : null,
      fel: f?.punkter.filter((p) => p.typ === "fel").length ?? 0,
      borjade,
      intygat: fardig,
      kassa: b.handlingar.some((h) => h.namn === "begin_checkout"),
      kop: b.handlingar.some((h) => h.namn === "purchase"),
    }));

  return { saljflode: saljflode(lista, pub), alla, ingangar, sidor, sessioner };
}

// ---------------------------------------------------------------------------
// Ett besök, punkt för punkt
// ---------------------------------------------------------------------------

export interface TidPunkt {
  at: string;
  typ: "landning" | "sida" | "handling" | "klick" | "flode";
  namn: string;
  sida: string | null;
  /** Sidan: tiden där i ms. */
  ms: number | null;
  /** Sidan: hur långt ned besökaren kom. */
  djup: number | null;
  /** Handlingen: möbeln den gällde. */
  objekt: string | null;
  /** Flödets egen punkt, när punkten kommer därifrån. Panelen ritar den som uppladdningsfliken gör. */
  flode: Punkt | null;
}

export interface Tidslinje {
  sess: string;
  uid: string | null;
  start: string;
  slut: string;
  kanal: string;
  kalla: string;
  kampanj: string | null;
  enhet: string | null;
  punkter: TidPunkt[];
}

/**
 * Hela besöket i en lista: sidorna, butikens händelser, trycken i sektionerna och säljflödets
 * mikrosteg, i den ordning de hände.
 *
 * Flödets "steg"-punkter står inte med: de är "lämnade skärmen" och står redan som en sida.
 */
export function tidslinje(b: Besok, f: FlodesSession | null): Tidslinje {
  const punkter: TidPunkt[] = [];
  const tom = { sida: null, ms: null, djup: null, objekt: null, flode: null };
  punkter.push({ ...tom, at: b.start, typ: "landning", namn: b.kalla, sida: b.landning });
  for (const s of b.sidor) punkter.push({ ...tom, at: s.at, typ: "sida", namn: s.sida, sida: s.sida, ms: s.ms, djup: s.djup });
  for (const h of b.handlingar) punkter.push({ ...tom, at: h.at, typ: "handling", namn: h.namn, sida: h.sida, objekt: h.objekt });
  for (const k of b.klick) punkter.push({ ...tom, at: k.at, typ: "klick", namn: k.namn, sida: k.sida });
  if (f) for (const p of f.punkter) if (p.typ !== "steg") punkter.push({ ...tom, at: p.at, typ: "flode", namn: p.namn, sida: null, flode: p });
  // Landningen först även när en sidrad råkar ha samma tidsstämpel.
  const vikt = (p: TidPunkt) => (p.typ === "landning" ? 0 : p.typ === "sida" ? 1 : 2);
  punkter.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : vikt(x) - vikt(y)));
  return {
    sess: b.sess,
    uid: b.uid ?? f?.uid ?? null,
    start: b.start,
    slut: [b.slut, f?.slut ?? ""].sort().at(-1)!,
    kanal: b.kanal,
    kalla: b.kalla,
    kampanj: b.kampanj,
    enhet: b.enhet ?? f?.enhet ?? null,
    punkter,
  };
}

// ---------------------------------------------------------------------------
// Just nu
// ---------------------------------------------------------------------------

/** Så länge sedan senaste raden räknas ett besök som pågående. */
const AKTIV_MINUTER = 5;

export interface JustNu {
  nu: string;
  minuter: number;
  besokare: number;
  /** Av dem: hur många som står i säljflödet just nu. */
  iSaljflodet: number;
  /** Var de är, flest först. Sidan som besöksmätningen skriver den — "/ · capture" är filmningen. */
  perPlats: Array<{ plats: string; antal: number }>;
  rader: Array<{ sess: string; kanal: string; kalla: string; enhet: string | null; plats: string; sedan: string; senast: string }>;
}

/**
 * Vilka som är inne just nu, och var.
 *
 * LÄSES UR MINNET, inte ur filen: besöks- och flödesmätningen skriver varje rad till sina kartor
 * samtidigt som till disk, så det här är så färskt som det går att bli utan en egen kanal. Ett besök
 * räknas som pågående om det skrivit något de senaste fem minuterna. Adminer räknas inte.
 */
export function justNu(besok: Besok[], floden: FlodesSession[], admins: ReadonlySet<string>, nu = new Date()): JustNu {
  const grans = new Date(nu.getTime() - AKTIV_MINUTER * 60_000).toISOString();
  const flodePerSess = new Map(floden.map((f) => [f.sess, f]));
  const aktiva = besok
    .filter((b) => !(b.uid && admins.has(b.uid)))
    .map((b) => ({ b, f: flodePerSess.get(b.sess) }))
    .filter(({ b, f }) => b.slut >= grans || (f && f.slut >= grans));
  const rader = aktiva
    .map(({ b, f }) => {
      // I flödet är skärmen det säljaren står på; utanför det sidan besöket senast visade.
      const steg = f && f.slut >= b.slut ? [...f.punkter].reverse().find((p) => p.steg)?.steg ?? null : null;
      const plats = steg ? (steg === "home" ? "/" : `/ · ${steg}`) : (b.sidor[b.sidor.length - 1]?.sida ?? b.landning ?? "/");
      const senast = [b.slut, f?.slut ?? ""].sort().at(-1)!;
      return { sess: b.sess, kanal: b.kanal, kalla: b.kalla, enhet: b.enhet ?? f?.enhet ?? null, plats, sedan: b.start, senast };
    })
    .sort((a, c) => (a.senast < c.senast ? 1 : -1));
  const perPlats = new Map<string, number>();
  for (const r of rader) perPlats.set(r.plats, (perPlats.get(r.plats) ?? 0) + 1);
  return {
    nu: nu.toISOString(),
    minuter: AKTIV_MINUTER,
    besokare: rader.length,
    iSaljflodet: rader.filter((r) => r.plats.startsWith("/ · ")).length,
    perPlats: [...perPlats].map(([plats, antal]) => ({ plats, antal })).sort((a, b) => b.antal - a.antal),
    rader: rader.slice(0, 50),
  };
}
