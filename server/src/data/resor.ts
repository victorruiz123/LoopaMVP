/**
 * Resorna: hur säljarna rör sig genom uppladdningen, mikrosteg för mikrosteg.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Tratten i data/flode.ts säger hur många som nådde varje SKÄRM. Den
 * säger inte vart de gick sedan — framåt, bakåt, eller ut — och inte vad som hände precis innan de
 * försvann. Det är de två frågorna man ställer när ett steg tappar folk: är steget för svårt (de
 * tvekar länge och trycker runt), går det sönder (ett fel och sedan tystnad), eller skickar det dem
 * fel väg (tillbaka till kameran, om och om igen)?
 *
 * TRE LÄSNINGAR AV SAMMA TIDSLINJE:
 *
 *   kartan     per mikrosteg: hur många kom hit, vart gick de härnäst, hur länge stod de
 *   fastnar    per mikrosteg: hur många lämnade HÄR, och vilket fel eller klick som kom sist
 *   resorna    en rad per besök, och för ett besök hela tidslinjen
 *
 * INGEN EGEN LAGRING. Allt räknas ur flödessessionerna, som redan bär mikrostegen, klicken och felen.
 * Funktionerna är rena, så att testerna kan mata dem utan disk.
 */

import { MIKRO_INDEX, type FlodesSession, type Punkt } from "./flode.js";

/** Ett besök som tystnat kortare tid än så kan fortfarande vara på väg. Det är inget avhopp än. */
const PAGAR_MS = 30 * 60 * 1000;

/** Mikrostegen som betyder att uppladdningen gick i mål. Den som slutar här har inte lämnat. */
const MAL = new Set(["fardig_annons", "publicerad"]);

export interface KartSteg {
  namn: string;
  /** Besök som nådde steget. */
  nadde: number;
  /** Besök som slutade här, utan att gå i mål och utan att fortfarande vara på väg. */
  lamnade: number;
  /** Vart de gick härnäst, räknat per gång steget lämnades. */
  vidare: Array<{ namn: string; antal: number; riktning: "fram" | "bak" }>;
  /** Median i millisekunder från steget till nästa mikrosteg. */
  medianMs: number | null;
  /** Felen som inträffade medan de stod här. */
  fel: Array<{ namn: string; antal: number }>;
  /** Knapparna de tryckte på medan de stod här. */
  klick: Array<{ namn: string; antal: number }>;
  /** Av dem som lämnade här: det sista felet de fick innan de gick. Tomt = inget fel, de bara gick. */
  felForeAvhopp: Array<{ namn: string; antal: number }>;
  mobil: { nadde: number; lamnade: number };
  dator: { nadde: number; lamnade: number };
}

export interface ResaRad {
  sess: string;
  uid: string | null;
  jobId: string | null;
  start: string;
  slut: string;
  varaktighetMs: number;
  enhet: string | null;
  sistaMikro: string | null;
  iMal: boolean;
  pagar: boolean;
  antalFel: number;
  antalKlick: number;
  /** Det sista felet, om det fanns ett. */
  sistaFel: string | null;
}

export interface ResorSvar {
  dagar: number;
  fran: string;
  /** Första besöket med mikrosteg. Allt före det mättes bara på skärmnivå. */
  matningSedan: string | null;
  summering: {
    besok: number;
    iMal: number;
    lamnade: number;
    pagar: number;
    medFel: number;
    medianMsTillMal: number | null;
  };
  karta: KartSteg[];
  fel: Array<{ namn: string; antal: number; besok: number; ledTillAvhopp: number }>;
  resor: ResaRad[];
}

function median(tal: number[]): number | null {
  if (!tal.length) return null;
  const s = [...tal].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function topp(m: Map<string, number>, n: number): Array<{ namn: string; antal: number }> {
  return [...m].map(([namn, antal]) => ({ namn, antal })).sort((a, b) => b.antal - a.antal).slice(0, n);
}

const oka = (m: Map<string, number>, k: string, d = 1) => m.set(k, (m.get(k) ?? 0) + d);

/**
 * Mikrostegen i ordning, upprepningar i rad borttagna, med tiden de nåddes och sin plats i
 * tidslinjen.
 *
 * PLATSEN OCH INTE KLOCKSLAGET avgör vilket steg ett klick eller fel hör till. Två rader kan bära
 * samma millisekund — ett klick som startar inspelningen och mikrosteget det ger — och en gräns
 * dragen på tiden hade lagt klicket i fel steg. Ordningen i tidslinjen är den ordning de skrevs.
 */
function forekomster(s: FlodesSession): Array<{ namn: string; at: string; index: number; pos: number }> {
  const ut: Array<{ namn: string; at: string; index: number; pos: number }> = [];
  s.punkter.forEach((p, pos) => {
    if (p.typ !== "mikro") return;
    if (ut.length && ut[ut.length - 1].namn === p.namn) return;
    ut.push({ namn: p.namn, at: p.at, index: MIKRO_INDEX.get(p.namn) ?? -1, pos });
  });
  return ut;
}

function status(s: FlodesSession, nu: number): { iMal: boolean; pagar: boolean } {
  const iMal = s.intygat || s.mikro.some((m) => MAL.has(m));
  const pagar = !iMal && nu - Date.parse(s.slut) < PAGAR_MS;
  return { iMal, pagar };
}

/**
 * Resorna för en period.
 *
 * Bara besök med minst ett mikrosteg räknas: äldre besök mättes på skärmnivå och har ingen tidslinje
 * att läsa, och att blanda in dem hade gjort kartan till ett snitt av två olika mätningar.
 */
export function resor(sessioner: FlodesSession[], dagar: number, admins: ReadonlySet<string>, nuDatum = new Date()): ResorSvar {
  const nu = nuDatum.getTime();
  const fran = new Date(nu - dagar * 24 * 60 * 60 * 1000).toISOString();
  const medMikro = sessioner.filter((s) => s.mikro.length > 0 && !(s.uid && admins.has(s.uid)));
  const urval = medMikro.filter((s) => s.start >= fran);

  type Ack = {
    nadde: number;
    lamnade: number;
    vidare: Map<string, number>;
    tider: number[];
    fel: Map<string, number>;
    klick: Map<string, number>;
    felForeAvhopp: Map<string, number>;
    mobil: { nadde: number; lamnade: number };
    dator: { nadde: number; lamnade: number };
  };
  const ack = new Map<string, Ack>();
  const hamta = (namn: string): Ack => {
    let a = ack.get(namn);
    if (!a) {
      a = {
        nadde: 0, lamnade: 0, vidare: new Map(), tider: [], fel: new Map(), klick: new Map(),
        felForeAvhopp: new Map(), mobil: { nadde: 0, lamnade: 0 }, dator: { nadde: 0, lamnade: 0 },
      };
      ack.set(namn, a);
    }
    return a;
  };

  const felAck = new Map<string, { antal: number; besok: Set<string>; ledTillAvhopp: number }>();
  const resorUt: ResaRad[] = [];
  const tiderTillMal: number[] = [];

  for (const s of urval) {
    const { iMal, pagar } = status(s, nu);
    const forek = forekomster(s);
    const enhet = s.enhet === "dator" ? "dator" : s.enhet === "mobil" ? "mobil" : null;
    const sedda = new Set<string>();

    forek.forEach((f, i) => {
      const a = hamta(f.namn);
      if (!sedda.has(f.namn)) {
        sedda.add(f.namn);
        a.nadde += 1;
        if (enhet) a[enhet].nadde += 1;
      }
      const nasta = forek[i + 1];
      if (nasta) {
        oka(a.vidare, `${nasta.namn}\u0000${nasta.index >= f.index ? "fram" : "bak"}`);
        const ms = Date.parse(nasta.at) - Date.parse(f.at);
        if (ms >= 0 && ms <= PAGAR_MS) a.tider.push(ms);
      }
      // Klick och fel hör till mikrosteget de inträffade i: från att steget nåddes till nästa.
      for (const p of s.punkter.slice(f.pos, nasta?.pos ?? s.punkter.length)) {
        if (p.typ === "klick") oka(a.klick, p.namn);
        if (p.typ === "fel") oka(a.fel, p.namn);
      }
    });

    const sista = forek[forek.length - 1];
    const lamnade = !iMal && !pagar;
    const felISession = s.punkter.filter((p) => p.typ === "fel");
    if (lamnade && sista) {
      const a = hamta(sista.namn);
      a.lamnade += 1;
      if (enhet) a[enhet].lamnade += 1;
      const sistaFel = [...s.punkter.slice(sista.pos)].reverse().find((p) => p.typ === "fel");
      oka(a.felForeAvhopp, sistaFel?.namn ?? "inget_fel");
    }
    for (const p of felISession) {
      const r = felAck.get(p.namn) ?? { antal: 0, besok: new Set(), ledTillAvhopp: 0 };
      r.antal += 1;
      r.besok.add(s.sess);
      felAck.set(p.namn, r);
    }
    if (lamnade && felISession.length) {
      const sistaFel = felISession[felISession.length - 1].namn;
      felAck.get(sistaFel)!.ledTillAvhopp += 1;
    }
    if (iMal) {
      const mal = s.punkter.find((p) => (p.typ === "mikro" && MAL.has(p.namn)) || p.typ === "intygat");
      if (mal) tiderTillMal.push(Date.parse(mal.at) - Date.parse(s.start));
    }

    resorUt.push({
      sess: s.sess,
      uid: s.uid,
      jobId: s.jobId,
      start: s.start,
      slut: s.slut,
      varaktighetMs: s.totaltMs,
      enhet: s.enhet,
      sistaMikro: sista?.namn ?? null,
      iMal,
      pagar,
      antalFel: felISession.length,
      antalKlick: s.punkter.filter((p) => p.typ === "klick").length,
      sistaFel: felISession[felISession.length - 1]?.namn ?? null,
    });
  }

  const karta: KartSteg[] = [...ack]
    .sort((a, b) => (MIKRO_INDEX.get(a[0]) ?? 99) - (MIKRO_INDEX.get(b[0]) ?? 99))
    .map(([namn, a]) => ({
      namn,
      nadde: a.nadde,
      lamnade: a.lamnade,
      vidare: [...a.vidare]
        .map(([k, antal]) => {
          const [till, riktning] = k.split("\u0000");
          return { namn: till, antal, riktning: riktning as "fram" | "bak" };
        })
        .sort((x, y) => y.antal - x.antal)
        .slice(0, 4),
      medianMs: median(a.tider),
      fel: topp(a.fel, 3),
      klick: topp(a.klick, 4),
      felForeAvhopp: topp(a.felForeAvhopp, 3),
      mobil: a.mobil,
      dator: a.dator,
    }));

  const sammanResor = resorUt.sort((a, b) => (a.slut < b.slut ? 1 : -1));
  return {
    dagar,
    fran,
    matningSedan: medMikro.length ? medMikro.map((s) => s.start).sort()[0] : null,
    summering: {
      besok: urval.length,
      iMal: sammanResor.filter((r) => r.iMal).length,
      lamnade: sammanResor.filter((r) => !r.iMal && !r.pagar).length,
      pagar: sammanResor.filter((r) => r.pagar).length,
      medFel: sammanResor.filter((r) => r.antalFel > 0).length,
      medianMsTillMal: median(tiderTillMal),
    },
    karta,
    fel: [...felAck]
      .map(([namn, r]) => ({ namn, antal: r.antal, besok: r.besok.size, ledTillAvhopp: r.ledTillAvhopp }))
      .sort((a, b) => b.antal - a.antal),
    resor: sammanResor.slice(0, 300),
  };
}

/** En resa i sin helhet: tidslinjen, i ordning. */
export interface Resa {
  sess: string;
  uid: string | null;
  jobId: string | null;
  start: string;
  slut: string;
  enhet: string | null;
  plattform: string | null;
  iMal: boolean;
  pagar: boolean;
  punkter: Punkt[];
}

export function resaFor(s: FlodesSession, nuDatum = new Date()): Resa {
  const { iMal, pagar } = status(s, nuDatum.getTime());
  return {
    sess: s.sess,
    uid: s.uid,
    jobId: s.jobId,
    start: s.start,
    slut: s.slut,
    enhet: s.enhet,
    plattform: s.plattform,
    iMal,
    pagar,
    punkter: s.punkter,
  };
}
