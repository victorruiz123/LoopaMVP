/**
 * Översikten: hur det går för Loopa, med användarna först.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Datafliken byggdes för att svara på om MODELLEN blir bättre, och den
 * gjorde det bra — men den som öppnar panelen vill oftast veta något annat först: får vi in folk,
 * varifrån, blir de säljare, och kommer de tillbaka? Allt det fanns utspritt (kontolistan, flödet,
 * besöken, inbjudningarna, ordrarna) men ingenstans räknat ihop. Här räknas det ihop.
 *
 * INGEN EGEN SANNING. Varje tal härleds ur något som redan sparas; filen lagrar ingenting. Den är en
 * ren funktion av sina indata, så att testerna kan mata den och servervägen bara hämtar och lämnar.
 *
 * VARJE TAL HAR SIN FÖRRA PERIOD när den går att räkna. "34 nya konton" säger ingenting; "34, mot
 * 21 perioden innan" säger om det går åt rätt håll. Där förra perioden inte går att räkna — besöken
 * mättes inte då — står den som null och panelen visar ingen jämförelse, i stället för en falsk.
 *
 * ADMINERNA RÄKNAS INTE. Varken som nya konton, aktiva eller säljare: det är vi, inte användare.
 */

import type { AdminAccount } from "../admin.js";
import type { Order } from "../butik/orders.js";
import type { ReferralHandelse } from "../referral/store.js";
import type { Besok } from "./besok.js";
import type { FlodesSession } from "./flode.js";

const DYGN = 24 * 60 * 60 * 1000;

/** Ett jobb, så som översikten behöver det. Servervägen gör om ConditionJob till den här formen. */
export interface JobbIn {
  ownerId: string | null;
  createdAt: string;
  /** Sant när jobbet blev en färdig annons. Samma regel som kontolistans `cardCount`. */
  fardig: boolean;
}

export interface OversiktIn {
  konton: AdminAccount[];
  jobb: JobbIn[];
  /** Butikslagrets tillstånd per möbel: räcker för "ute nu". */
  butiksLagen: string[];
  ordrar: Order[];
  besok: Besok[];
  floden: FlodesSession[];
  inbjudningar: ReferralHandelse[];
  dagar: number;
  nu?: Date;
}

export interface Jamforelse {
  nu: number;
  /** Samma tal perioden innan. Null när det inte går att räkna — se filens topp. */
  forra: number | null;
}

export interface NyttKontoRad {
  id: string;
  namn: string;
  registrerad: string;
  kanal: string | null;
  /** Hur långt kontot kommit: "annons" = har en färdig annons, "borjat" = har filmat, "inget" = ingenting. */
  status: "annons" | "borjat" | "inget";
  telefon: string | null;
}

export interface Oversikt {
  dagar: number;
  fran: string;
  konton: {
    totalt: number;
    nya: Jamforelse;
    aktiva: Jamforelse;
    /** Av de nya kontona: hur många som filmat något, och hur många som har en färdig annons. */
    nyaBorjade: number;
    nyaMedAnnons: number;
    /** Median i dygn från registrering till första jobbet, över konton med känt registreringsdatum. */
    medianDygnTillForstaAnnons: number | null;
    /** Konton med minst en färdig annons, och av dem hur många med fler än en. */
    saljare: number;
    saljareFlera: number;
  };
  /**
   * Veckorna, de senaste tolv, äldst först. Nordstjärnan läser härifrån: nya annonser, nya säljare
   * (konton vars FÖRSTA färdiga annons kom den veckan) och sålda (genomförda köp i butiken).
   */
  perVecka: Array<{ vecka: string; nyaKonton: number; nyaAnnonser: number; nyaSaljare: number; salda: number }>;
  /** Registreringsveckorna och hur många av dem som blev säljare, och när. Se `kohorterAv`. */
  kohorter: Kohort[];
  /** Konton som inte kan ingå i en kohort: registreringsdatumet är gissat ur första jobbet. */
  kohorterUtanDatum: number;
  /** Säljarnas läge: fem grupper med namnen i, för att kunna höra av sig. Se `GRUPPER`. */
  grupper: Grupp[];
  /** Nya konton i perioden per kanal. "Okänd" är de som registrerade sig utan ett mätt besök. */
  kanaler: Array<{ kanal: string; nyaKonton: number; medAnnons: number }>;
  inbjudningar: {
    lankarDelade: Jamforelse;
    registrerade: Jamforelse;
    /** Inbjudna som lade upp en annons, så att inbjudaren fick sin kredit (eller nekades den). */
    gavAnnons: number;
  };
  affar: {
    nyaAnnonser: Jamforelse;
    uteNu: number;
    kop: Jamforelse;
    /** Summan av köpen i kronor, frakt oräknad. */
    varde: Jamforelse;
  };
  /** De nyaste kontona i perioden, med hur långt de kommit. Listan att ringa från. */
  nyaKontonLista: NyttKontoRad[];
}

export interface Kohort {
  /** Måndagen veckan kontona registrerades. */
  vecka: string;
  konton: number;
  /** Konton som lade upp sin första färdiga annons inom ett, sju respektive trettio dygn. */
  inom1: number;
  inom7: number;
  inom30: number;
  /** Konton som lagt upp fler än en annons, när som helst. */
  flera: number;
  /**
   * Sant när veckan är gammal nog för att talet ska vara färdigt. En kohort från i förrgår har inte
   * haft trettio dagar på sig, och dess "inom 30" är inte lågt — det är inte klart än.
   */
  klar7: boolean;
  klar30: boolean;
}

export type GruppNyckel = "nya" | "fastnade" | "aktiva" | "sovande" | "aldrig";

export interface GruppMedlem {
  id: string;
  namn: string;
  epost: string | null;
  telefon: string | null;
  registrerad: string | null;
  /** Senaste gången kontot gjorde något: filmade, eller var inloggat i ett mätt besök. */
  senast: string | null;
  annonser: number;
  /** För dem som fastnade: skärmen de stod på sist i flödet. */
  stannadeVid: string | null;
}

export interface Grupp {
  nyckel: GruppNyckel;
  antal: number;
  /** Högst 200, de senast aktiva först. */
  medlemmar: GruppMedlem[];
}

/** Ett konto utan aktivitet så länge är sovande. */
const SOVANDE_DYGN = 30;
/** Så länge räknas ett konto som nytt, och "har inte börjat än" som ett läge och inte ett beslut. */
const NY_DYGN = 14;

/** Köp som räknas: betalda och framåt. Ett avbrutet eller returnerat köp är inget köp. */
const GENOMFORDA = new Set(["paid", "booking", "scheduled", "delivered"]);

function median(tal: number[]): number | null {
  if (!tal.length) return null;
  const s = [...tal].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Måndagen i veckan ett datum ligger i, som YYYY-MM-DD. */
function veckaFor(iso: string): string {
  const d = new Date(iso);
  const dag = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - dag);
  return d.toISOString().slice(0, 10);
}

export function oversikt(inn: OversiktIn): Oversikt {
  const nu = inn.nu ?? new Date();
  const fran = new Date(nu.getTime() - inn.dagar * DYGN).toISOString();
  const forraFran = new Date(nu.getTime() - 2 * inn.dagar * DYGN).toISOString();
  const iPerioden = (at: string | null | undefined) => !!at && at >= fran;
  const iForra = (at: string | null | undefined) => !!at && at >= forraFran && at < fran;

  const admins = new Set(inn.konton.filter((k) => k.isAdmin).map((k) => k.id));
  const konton = inn.konton.filter((k) => !k.isAdmin);
  const jobb = inn.jobb.filter((j) => !(j.ownerId && admins.has(j.ownerId)));
  const besok = inn.besok.filter((b) => !(b.uid && admins.has(b.uid)));
  const floden = inn.floden.filter((f) => !(f.uid && admins.has(f.uid)));

  // ── Kontona ──────────────────────────────────────────────────────────────
  const nya = konton.filter((k) => iPerioden(k.signedUpAt));
  const nyaForra = konton.filter((k) => iForra(k.signedUpAt));

  const forstaJobb = new Map<string, string>();
  for (const j of jobb) {
    if (!j.ownerId) continue;
    const f = forstaJobb.get(j.ownerId);
    if (!f || j.createdAt < f) forstaJobb.set(j.ownerId, j.createdAt);
  }

  /**
   * Aktiva: konton som GJORT något — filmat, eller varit inloggade i ett mätt besök eller flöde.
   * Förra perioden räknas bara på jobben om besöksmätningen inte fanns då, och blir därför null i
   * stället för ett tal som ser ut att ha ökat bara för att vi började mäta.
   */
  function aktivaMellan(a: (at: string) => boolean): Set<string> {
    const ut = new Set<string>();
    for (const j of jobb) if (j.ownerId && a(j.createdAt)) ut.add(j.ownerId);
    for (const b of besok) if (b.uid && a(b.start)) ut.add(b.uid);
    for (const f of floden) if (f.uid && a(f.start)) ut.add(f.uid);
    return ut;
  }
  const forstaMatning = [...besok.map((b) => b.start), ...floden.map((f) => f.start)].sort()[0] ?? null;
  const aktivaForraGarAttRakna = forstaMatning !== null && forstaMatning <= forraFran;

  const tillForsta = konton
    .filter((k) => k.signedUpAt && !k.signupApproximate && forstaJobb.has(k.id))
    .map((k) => (Date.parse(forstaJobb.get(k.id)!) - Date.parse(k.signedUpAt!)) / DYGN)
    .filter((d) => d >= 0);
  const md = median(tillForsta);

  // ── Per vecka ────────────────────────────────────────────────────────────
  const veckor = new Map<string, { vecka: string; nyaKonton: number; nyaAnnonser: number; nyaSaljare: number; salda: number }>();
  for (let i = 11; i >= 0; i -= 1) {
    const v = veckaFor(new Date(nu.getTime() - i * 7 * DYGN).toISOString());
    veckor.set(v, { vecka: v, nyaKonton: 0, nyaAnnonser: 0, nyaSaljare: 0, salda: 0 });
  }
  for (const k of konton) if (k.signedUpAt) {
    const r = veckor.get(veckaFor(k.signedUpAt));
    if (r) r.nyaKonton += 1;
  }
  for (const j of jobb) if (j.fardig) {
    const r = veckor.get(veckaFor(j.createdAt));
    if (r) r.nyaAnnonser += 1;
  }
  // Färdiga annonser per konto, i tidsordning: den första är när kontot BLEV säljare.
  const fardigaPerKonto = new Map<string, string[]>();
  for (const j of jobb) if (j.fardig && j.ownerId) fardigaPerKonto.set(j.ownerId, [...(fardigaPerKonto.get(j.ownerId) ?? []), j.createdAt]);
  for (const lista of fardigaPerKonto.values()) lista.sort();
  for (const lista of fardigaPerKonto.values()) {
    const r = veckor.get(veckaFor(lista[0]));
    if (r) r.nyaSaljare += 1;
  }
  for (const o of inn.ordrar) if (GENOMFORDA.has(o.status)) {
    const r = veckor.get(veckaFor(o.createdAt));
    if (r) r.salda += 1;
  }

  // ── Kohorterna ───────────────────────────────────────────────────────────
  // Bara konton med KÄNT registreringsdatum. Ett gissat datum är första jobbet, och ett konto vars
  // registrering sätts till dagen det filmade blir säljare "inom en dag" per definition.
  const medDatum = konton.filter((k) => k.signedUpAt && !k.signupApproximate);
  const kohortMap = new Map<string, Kohort>();
  for (let i = 7; i >= 0; i -= 1) {
    const v = veckaFor(new Date(nu.getTime() - i * 7 * DYGN).toISOString());
    const veckansSlut = Date.parse(v) + 7 * DYGN;
    kohortMap.set(v, {
      vecka: v, konton: 0, inom1: 0, inom7: 0, inom30: 0, flera: 0,
      klar7: nu.getTime() - veckansSlut >= 7 * DYGN,
      klar30: nu.getTime() - veckansSlut >= 30 * DYGN,
    });
  }
  for (const k of medDatum) {
    const r = kohortMap.get(veckaFor(k.signedUpAt!));
    if (!r) continue;
    r.konton += 1;
    const fardiga = fardigaPerKonto.get(k.id) ?? [];
    if (fardiga.length > 1) r.flera += 1;
    if (!fardiga.length) continue;
    const dygn = (Date.parse(fardiga[0]) - Date.parse(k.signedUpAt!)) / DYGN;
    if (dygn <= 1) r.inom1 += 1;
    if (dygn <= 7) r.inom7 += 1;
    if (dygn <= 30) r.inom30 += 1;
  }

  // ── Grupperna ────────────────────────────────────────────────────────────
  const senastAktiv = new Map<string, string>();
  const satt = (uid: string | null, at: string) => {
    if (uid && (!senastAktiv.has(uid) || at > senastAktiv.get(uid)!)) senastAktiv.set(uid, at);
  };
  for (const j of jobb) satt(j.ownerId, j.createdAt);
  for (const b of besok) satt(b.uid, b.slut);
  for (const f of floden) satt(f.uid, f.slut);
  // Var de som fastnade stod sist: skärmen i deras senaste flöde.
  const sistaSteg = new Map<string, { at: string; steg: string | null }>();
  for (const f of floden) {
    if (!f.uid) continue;
    const forra = sistaSteg.get(f.uid);
    if (!forra || f.slut > forra.at) sistaSteg.set(f.uid, { at: f.slut, steg: f.sistaSteg });
  }
  const grupperMap = new Map<GruppNyckel, GruppMedlem[]>(
    (["nya", "fastnade", "aktiva", "sovande", "aldrig"] as GruppNyckel[]).map((g) => [g, []]),
  );
  const nuMs = nu.getTime();
  for (const k of konton) {
    const senast = senastAktiv.get(k.id) ?? k.lastActivity ?? null;
    const alderDygn = k.signedUpAt ? (nuMs - Date.parse(k.signedUpAt)) / DYGN : Infinity;
    const grupp: GruppNyckel =
      k.cardCount > 0
        ? senast && nuMs - Date.parse(senast) <= SOVANDE_DYGN * DYGN
          ? "aktiva"
          : "sovande"
        : k.jobCount > 0
          ? "fastnade"
          : alderDygn < NY_DYGN
            ? "nya"
            : "aldrig";
    grupperMap.get(grupp)!.push({
      id: k.id,
      namn: k.name || k.email || `${k.id.slice(0, 8)}…`,
      epost: k.email,
      telefon: k.telefon,
      registrerad: k.signedUpAt,
      senast,
      annonser: k.cardCount,
      stannadeVid: grupp === "fastnade" ? (sistaSteg.get(k.id)?.steg ?? null) : null,
    });
  }
  const grupper: Grupp[] = [...grupperMap].map(([nyckel, medlemmar]) => ({
    nyckel,
    antal: medlemmar.length,
    medlemmar: medlemmar
      .sort((a, b) => ((a.senast ?? a.registrerad ?? "") < (b.senast ?? b.registrerad ?? "") ? 1 : -1))
      .slice(0, 200),
  }));

  // ── Kanalerna ────────────────────────────────────────────────────────────
  const forstaBesok = new Map<string, Besok>();
  for (const b of [...besok].sort((a, c) => (a.start < c.start ? -1 : 1))) if (b.uid && !forstaBesok.has(b.uid)) forstaBesok.set(b.uid, b);
  const kanalMap = new Map<string, { kanal: string; nyaKonton: number; medAnnons: number }>();
  for (const k of nya) {
    const kanal = forstaBesok.get(k.id)?.kanal ?? "Okänd";
    const r = kanalMap.get(kanal) ?? { kanal, nyaKonton: 0, medAnnons: 0 };
    r.nyaKonton += 1;
    if (k.cardCount > 0) r.medAnnons += 1;
    kanalMap.set(kanal, r);
  }
  // Okänd sist oavsett storlek: den säger att vi inte vet, inte att den är en kanal.
  const kanaler = [...kanalMap.values()].sort((a, b) =>
    a.kanal === "Okänd" ? 1 : b.kanal === "Okänd" ? -1 : b.nyaKonton - a.nyaKonton,
  );

  // ── Inbjudningarna ───────────────────────────────────────────────────────
  const inb = (namn: string, a: (at: string) => boolean) =>
    inn.inbjudningar.filter((h) => h.event === namn && a(h.at) && !admins.has(h.userId)).length;

  // ── Affären ──────────────────────────────────────────────────────────────
  const kop = inn.ordrar.filter((o) => GENOMFORDA.has(o.status));
  const summa = (lista: Order[]) => lista.reduce((s, o) => s + (o.priceSek || 0), 0);
  const kopNu = kop.filter((o) => iPerioden(o.createdAt));
  const kopForra = kop.filter((o) => iForra(o.createdAt));

  // ── De nya kontona, ett och ett ─────────────────────────────────────────
  const nyaKontonLista: NyttKontoRad[] = [...nya]
    .sort((a, b) => (a.signedUpAt! < b.signedUpAt! ? 1 : -1))
    .slice(0, 12)
    .map((k) => ({
      id: k.id,
      namn: k.name || k.email || `${k.id.slice(0, 8)}…`,
      registrerad: k.signedUpAt!,
      kanal: forstaBesok.get(k.id)?.kanal ?? null,
      status: k.cardCount > 0 ? "annons" : k.jobCount > 0 ? "borjat" : "inget",
      telefon: k.telefon,
    }));

  return {
    dagar: inn.dagar,
    fran,
    konton: {
      totalt: konton.length,
      nya: { nu: nya.length, forra: nyaForra.length },
      aktiva: {
        nu: aktivaMellan((at) => at >= fran).size,
        forra: aktivaForraGarAttRakna ? aktivaMellan((at) => at >= forraFran && at < fran).size : null,
      },
      nyaBorjade: nya.filter((k) => k.jobCount > 0).length,
      nyaMedAnnons: nya.filter((k) => k.cardCount > 0).length,
      medianDygnTillForstaAnnons: md === null ? null : Math.round(md * 10) / 10,
      saljare: konton.filter((k) => k.cardCount > 0).length,
      saljareFlera: konton.filter((k) => k.cardCount > 1).length,
    },
    perVecka: [...veckor.values()],
    kohorter: [...kohortMap.values()],
    kohorterUtanDatum: konton.filter((k) => k.signedUpAt && k.signupApproximate).length,
    grupper,
    kanaler,
    inbjudningar: {
      lankarDelade: { nu: inb("invite_link_copied", iPerioden), forra: inb("invite_link_copied", iForra) },
      registrerade: { nu: inb("referred_signup", iPerioden), forra: inb("referred_signup", iForra) },
      gavAnnons: inb("referral_credit_created", iPerioden) + inb("referral_credit_denied", iPerioden),
    },
    affar: {
      nyaAnnonser: { nu: jobb.filter((j) => j.fardig && iPerioden(j.createdAt)).length, forra: jobb.filter((j) => j.fardig && iForra(j.createdAt)).length },
      uteNu: inn.butiksLagen.filter((s) => s === "live" || s === "reserved").length,
      kop: { nu: kopNu.length, forra: kopForra.length },
      varde: { nu: summa(kopNu), forra: summa(kopForra) },
    },
    nyaKontonLista,
  };
}
