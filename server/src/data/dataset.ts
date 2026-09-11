/**
 * Datasetet: en rad per möbel, med allt vi vet om den — och med AI:ns ord skilda från människans.
 *
 * VARFÖR VYN FINNS. Annonspanelen (adminAnnonser.ts) svarar på "vad har vi fått in och vad hände med
 * det". Den här svarar på en annan fråga: "vad sa modellen, vad blev det, och hade den rätt". Det är
 * två olika läsningar av samma lager, och de går inte att slå ihop — den ena sorterar på läge och
 * pris, den andra på rättelser och facit.
 *
 * DEN ENDA REGELN SOM STYR FILEN: ett värde är antingen AI:ns eller människans, aldrig bådas. Varje
 * fält bärs därför som ett par — `aiSa` och `manniskanSa` — och `manniskanSa` är null när ingen rört
 * fältet. Att skriva in det rättade värdet i ett enda fält och kalla det "värdet" hade förstört
 * precis det som gör datan värd något: ett rättat värde är en märkt miss, och en miss utan sitt
 * ursprungliga påstående är ingen etikett alls.
 *
 * SJU KÄLLOR, INGEN EGEN SANNING. Ingenting räknas om här som någon annan redan räknar:
 *
 *   jobStore           besiktningen, fynden, annonsen, prisstegen, publiceringen
 *   data/rattelser     vad AI:n sa innan en människa ändrade det
 *   data/flode         stegen, tiderna, avhoppen, frågorna, chipen, enheten
 *   analys/store       visningar, klick, kassor, köp
 *   butik/store        tillståndet och huvudboken
 *   butik/orders       betalningen, leveransen, historiken
 *   tradera/mailwatch  köparens frågor och buden i den kanalen
 *
 * LUCKORNA STÅR UTSKRIVNA. Tre av de efterfrågade fälten har ingen källa än — frågorna om lukt,
 * husdjur och rök, "Berätta"-knappen, och leveranskontrollens foton och tvister. De redovisas som
 * `luckor` med en rad var om VARFÖR de är tomma, i stället för att visas som nollor. En nolla som i
 * själva verket betyder "det går inte att mäta än" är det värsta en datavy kan innehålla: den ser
 * ut som ett svar.
 */

import { getDebugTrace, listJobs, ownerIdOf } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import { jobToProduct } from "../butik/normalize.js";
import { store as butikStore, type ButikRecord } from "../butik/store.js";
import { allOrders, type Order } from "../butik/orders.js";
import { allStatistik, tomStatistik, type AnnonsStatistik } from "../analys/store.js";
import { allaSessioner, avhoppen, tratt, type Avhopp, type FlodesSession, type TrattSteg } from "./flode.js";
import { allaSamtal } from "./samtal.js";
import { allaRattelser, type Rattelse } from "./rattelser.js";
import type { ConditionJob, Damage, ListingAttribute } from "../types.js";
import type { Product } from "../butik/types.js";

// ---------------------------------------------------------------------------
// Formen
// ---------------------------------------------------------------------------

/**
 * Ett fält, som ett par.
 *
 * `manniskanSa` null = orört. Det är skillnaden mellan "säljaren höll med" och "säljaren tittade
 * aldrig", och den skillnaden får inte gå förlorad — se filens topp.
 */
export interface Falt {
  falt: string;
  aiSa: string | null;
  manniskanSa: string | null;
  /**
   * Modellens säkerhet på fältet, som den faktiskt uttrycker den.
   *
   * IDENTIFIERINGEN svarar med "high" | "medium" | "low" för hela identiteten. EGENSKAPERNA (mått,
   * material, färg) har ingen konfidenssiffra alls — de är antingen belagda mot en källa, uppskattade
   * för möbeltypen, eller obelagda, och det står här som "belagd" / "uppskattad" / "obelagd". Att
   * hitta på ett tal för dem hade varit att uppfinna en säkerhet modellen aldrig uttryckt.
   */
  konfidens: string | null;
  /** Källan värdet vilar på, när det har en. */
  kalla: string | null;
}

export interface DataIdentitet {
  falt: Falt[];
  /** Modellens egen konfidens på identiteten som helhet. */
  konfidens: string | null;
  konfidensNotis: string | null;
  nyprisSek: number | null;
  nyprisKalla: string | null;
  /** Kandidaterna identifieringen visade, och vilken säljaren valde. */
  kandidatRundor: number;
  aiForstaForslag: string | null;
  saljarensVal: string | null;
  /** Sant när säljaren valde något annat än modellens förstahandsförslag, eller skrev in eget. */
  identitetRattad: boolean;
}

export interface DataFynd {
  id: string;
  typ: string;
  /** Delen och den finare positionen på den. */
  del: string;
  position: string;
  allvarlighet: string;
  paverkan: string;
  beskrivning: string;
  /** Bildrutorna fyndet syns i, med utsnittet när ett skapades. */
  bilder: Array<{ imageId: string; viewLabel: string | null; cropPath: string | null }>;
  konfidens: number;
  /** Andrabesiktningens dom: CONFIRMED, REJECTED, UNCERTAIN eller NOT_RUN. */
  granskning: string;
  granskningSkal: string;
  /** Säljarens svar: "stämmer" | "stämmer inte" | "rättade" | null när de aldrig svarade. */
  saljarenSa: "stämmer" | "stämmer inte" | "rättade" | null;
  /** Sant när fyndet är säljarens eget tillägg — då fanns ingen AI-utsaga att jämföra med. */
  saljarenLaTill: boolean;
  /** Rättelserna på just det här fyndet, med före och efter. */
  rattelser: Rattelse[];
}

export interface DataSkick {
  fynd: DataFynd[];
  antalFynd: number;
  bekraftade: number;
  avvisade: number;
  saljarensEgna: number;
  obesvarade: number;
  /** Betyget som står nu, och det modellen först föreslog. Skilda åt — se `betygRattat`. */
  betyg: string | null;
  betygEtikett: string | null;
  modellensBetyg: string | null;
  betygRattat: boolean;
  /** Svaren på frågorna om lukt, husdjur och rök. Se `LUCKOR` — frågorna ställs inte än. */
  fragor: Falt[];
  antalBilder: number;
  /** Vinklarna säljaren faktiskt tog, när fotoguiden användes. Videovarv märker inte sina rutor. */
  taeckta: string[];
  saknade: string[];
  /** Besiktningens egen täckningsdom och dess notis om vad den aldrig fick se. */
  taeckning: string | null;
  taeckningNotis: string | null;
  /** Delarna modellen svepte, och de den inte kunde se. Ur felsökningsspåret. */
  ejSynligaDelar: string[];
}

export interface DataFlode {
  sess: string | null;
  /** Millisekunder från flödets start till ett intygat kort. Null när det aldrig kom dit. */
  tidTillIntygatMs: number | null;
  perStegMs: Record<string, number>;
  besokta: string[];
  sistaSteg: string | null;
  intygat: boolean;
  fragor: FlodesSession["fragor"];
  chip: FlodesSession["chip"];
  berattaPa: boolean;
  enhet: string | null;
  plattform: string | null;
  vy: string | null;
}

export interface DataPris {
  /** Prismotorns förslag, spann och konfidens. */
  forslagSek: number | null;
  lagSek: number | null;
  hogSek: number | null;
  konfidens: string | null;
  motorNotis: string | null;
  /** Vad säljaren valde: startpriset i stegen. Skilt från förslaget — det är hela frågan. */
  saljarensStartSek: number | null;
  golvSek: number | null;
  veckoSankningPct: number | null;
  /** Varje genomförd sänkning: när, från, till. */
  sankningar: Array<{ at: string; fran: number; till: number }>;
  /** Priset som ligger nu. */
  nuSek: number | null;
  slutSek: number | null;
  /** Slutpriset som andel av nypriset och av modellens förslag. Null när nämnaren saknas. */
  andelAvNypris: number | null;
  andelAvForslag: number | null;
  /** Sant när säljaren la sig på något annat än förslaget. */
  prisRattat: boolean;
}

export interface DataKanal {
  kanal: string;
  publiceradAt: string | null;
  /** Visningar när kanalen ger oss dem. Tradera gör det inte — se `notis`. */
  visningar: number | null;
  forfragningar: number;
  klick: number;
  notis: string | null;
}

export interface DataDistribution {
  kanaler: DataKanal[];
  /** Produktsidans egen mätning. */
  sidvisningar: number;
  unikaVisningar: number;
  listvisningar: number;
  kassor: number;
  kop: number;
  utgaendeTradera: number;
  /** Rå räkning per händelsenamn — källor, koder och allt annat mätningen bär. */
  perHandelse: Record<string, number>;
  bevakningar: number;
}

export interface DataTransaktion {
  dagarTillForstaForfragan: number | null;
  dagarTillSald: number | null;
  kanal: string | null;
  betalsatt: string | null;
  /** Meddelanden med köparen, grovt kategoriserade. Se `kategoriseraFraga`. */
  meddelanden: Array<{ at: string; kanal: string; kategori: string; utdrag: string }>;
  antalMeddelanden: number;
  perKategori: Record<string, number>;
  /** Sant när ett påbörjat köp inte gick i mål, med orsaken ur orderhistoriken. */
  follIgenom: boolean;
  orsak: string | null;
}

export interface DataLeverans {
  hamtningsdatum: string | null;
  leveransdatum: string | null;
  zon: string | null;
  leveranskostnadSek: number | null;
  /** Leveranskontrollen och tvisterna. Se `LUCKOR` — ingen av dem har någon källa än. */
  kontroll: Falt[];
  kopetGodkantAt: string | null;
  tvist: boolean | null;
}

export interface DataObjekt {
  id: string;
  jobId: string;
  loopaId: string;
  createdAt: string;
  ownerId: string | null;
  ownerEmail: string | null;
  titel: string;
  lage: string;
  bildUrl: string | null;
  identitet: DataIdentitet;
  skick: DataSkick;
  flode: DataFlode;
  pris: DataPris;
  distribution: DataDistribution;
  transaktion: DataTransaktion;
  leverans: DataLeverans;
  /** Alla rättelser på möbeln, i tidsordning. Samma rader som ligger inne i sektionerna. */
  rattelser: Rattelse[];
  /** Vad som inte gick att samla in, och varför. */
  luckor: string[];
}

/**
 * Fälten som inte har någon källa än, med skälet.
 *
 * STÅR SOM DATA OCH INTE SOM EN KOMMENTAR, för att panelen ska kunna skriva ut dem bredvid det som
 * faktiskt mäts. Den som läser vyn ska aldrig behöva gissa om ett tomt fält betyder "ingen gjorde
 * det" eller "vi mäter det inte". Varje rad försvinner härifrån den dag funktionen byggs — mätningen
 * på andra sidan finns redan och väntar (se flode.ts och `fragor` ovan).
 */
export const LUCKOR: Array<{ falt: string; skal: string }> = [
  {
    falt: "Svar på frågorna om lukt, husdjur och rök",
    skal:
      "Frågorna ställs inte i säljflödet. De finns bara i Trygg affärs frågelista till säljaren (affar/assess.ts), som är en annan väg med en annan möbel. Fälten står tomma tills flödet frågar.",
  },
  {
    falt: '"Berätta" slogs på',
    skal: 'Det finns ingen "Berätta"-knapp i flödet än. Händelsen är vitlistad i flödesmätningen, så den mäts från dagen knappen byggs.',
  },
  {
    falt: "Foto vid hämtning och vid överlämning",
    skal:
      "Budfirman lämnar inga foton och appen ber inte om några. Ordern bär bokad tid och levererat-datum, inget bildmaterial.",
  },
  {
    falt: "Leveranskontrollen: stämde skicket, avvikelser, fynd som saknades på kortet",
    skal:
      "Ingen kontroll utförs vid överlämningen. Det här är det enda fältet som skulle ge facit på besiktningen, och det saknas helt — se README-raden i panelen.",
  },
  {
    falt: "Tvist: orsak, utfall, kostnad",
    skal:
      "Det finns inget tvistregister. En retur syns som orderläget `return_requested`/`returned` med sin anteckning, och det är allt som går att säga i dag.",
  },
  {
    falt: "Visningar per kanal för Tradera",
    skal: "Tradera rapporterar inga visningssiffror till oss. Klick VIDARE till Tradera mäts på vår sida och står som `utgaende`.",
  },
];

// ---------------------------------------------------------------------------
// Hjälpare
// ---------------------------------------------------------------------------

function dygnMellan(fran: string | null, till: string | null): number | null {
  if (!fran || !till) return null;
  const start = Date.parse(fran);
  const slut = Date.parse(till);
  if (!Number.isFinite(start) || !Number.isFinite(slut)) return null;
  return Math.max(0, Math.round((slut - start) / 86_400_000));
}

/** Annonsen kan sitta på tre ställen — samma regel som resten av kodbasen följer. */
function listingOf(job: ConditionJob) {
  return job.result?.listing ?? job.listing ?? job.pendingListing ?? null;
}

/**
 * Vilken sorts stöd ett egenskapsvärde har.
 *
 * Se `Falt.konfidens`: egenskaperna har ingen konfidenssiffra, och det här är vad de har i stället.
 */
function stodFor(attr: ListingAttribute): string {
  if (attr.sellerEdited) return "säljarens uppgift";
  if (attr.estimated) return "uppskattad";
  return attr.sourceUrl ? "belagd" : "obelagd";
}

/** Etiketterna som räknas som identitetens kärnfält. Resten av egenskaperna följer med som de är. */
const IDENTITETSFALT = /mått|bredd|höjd|djup|längd|sitthöjd|material|klädsel|tyg|träslag|färg|kulör|år|årsmodell|ålder|tillverkad/i;

/**
 * Grov kategori på en köparfråga.
 *
 * NYCKELORD OCH INTE EN MODELL. Frågan "grov kategori" ska gå att svara på för tusen meddelanden utan
 * att kosta ett modellanrop per meddelande, och en felklassad fråga i en fördelning är ett mindre
 * fel än en fördelning som aldrig räknas för att den är för dyr. Ordningen betyder något: en fråga om
 * "vad kostar frakten" är en leveransfråga, inte en prisfråga, och därför prövas leverans först.
 */
export function kategoriseraFraga(text: string): string {
  const t = text.toLowerCase();
  if (/frakt|leverans|hämta|hämtning|transport|bära|hiss|utkörning|skicka/.test(t)) return "leverans";
  if (/mått|bredd|höjd|längd|cm\b|sitthöjd|passar den|storlek/.test(t)) return "mått";
  if (/skick|repa|fläck|slitage|skada|nött|trasig|fungerar|lukt/.test(t)) return "skick";
  if (/pris|kostar|rabatt|budet?\b|byta|prut|billigare|betala/.test(t)) return "pris";
  /**
   * Adjektiven sist, och EFTER skicket: "hur bred är den" är ett mått, men "är repan djup" är en
   * fråga om skicket trots att den bär samma ord. Substantivet avgör före adjektivet, och det som
   * bara har ett adjektiv att gå på prövas när allt annat sagt nej.
   */
  if (/\b(bred|hög|djup|lång)[at]?\b/.test(t)) return "mått";
  return "övrigt";
}

// ---------------------------------------------------------------------------
// Sektionerna
// ---------------------------------------------------------------------------

function identitetenAv(job: ConditionJob, produkt: Product | null, rattelser: Rattelse[]): DataIdentitet {
  const listing = listingOf(job)?.result ?? null;
  const identitetsRattelser = rattelser.filter((r) => r.omrade === "identitet");
  const rattadeFalt = new Map(identitetsRattelser.map((r) => [r.falt.toLowerCase(), r]));

  const falt: Falt[] = [];
  const kärna: Array<[string, string | null, string | null]> = [
    ["märke", listing?.identity.brand ?? job.identity?.brand ?? null, produkt?.brand ?? null],
    ["modell", listing?.identity.exactProduct ?? job.identity?.model ?? null, produkt?.model ?? null],
    ["variant", listing?.identity.variant ?? null, null],
    ["kategori", listing?.identity.category ?? null, produkt?.categorySlug ?? null],
  ];
  for (const [namn, aiSa] of kärna) {
    const rattad = rattadeFalt.get(namn);
    falt.push({
      falt: namn,
      aiSa: rattad?.aiSa ?? aiSa,
      manniskanSa: rattad?.manniskanSa ?? null,
      konfidens: listing?.identity.confidence ?? null,
      kalla: null,
    });
  }

  /**
   * Egenskaperna — mått, material, färg, ålder — kommer ur annonsgeneratorn och bär sin egen
   * märkning. `sellerEdited` ÄR rättelsen: när den är satt är värdet människans, och AI:ns ord står
   * i rättelseloggen. Utan loggen går det bara att säga ATT det rättats, inte från vad.
   */
  for (const attr of listing?.attributes ?? []) {
    if (!IDENTITETSFALT.test(attr.label) && !IDENTITETSFALT.test(attr.key)) continue;
    const rattad = rattadeFalt.get(attr.label.toLowerCase());
    falt.push({
      falt: attr.label,
      aiSa: rattad?.aiSa ?? (attr.sellerEdited ? null : attr.value),
      manniskanSa: attr.sellerEdited ? attr.value : (rattad?.manniskanSa ?? null),
      konfidens: stodFor(attr),
      kalla: attr.sourceUrl ?? null,
    });
  }

  const forsta = job.candidates?.[0];
  const vald = job.selected;
  const aiForsta = forsta ? [forsta.brand, forsta.model, forsta.variant].filter(Boolean).join(" ") : null;
  const saljarensVal = vald ? [vald.brand, vald.model, vald.variant].filter(Boolean).join(" ") : null;

  return {
    falt,
    konfidens: listing?.identity.confidence ?? null,
    konfidensNotis: listing?.identity.uncertaintyNote ?? null,
    nyprisSek: listing?.pricing.retailPriceSek ?? null,
    /** Nyprisets källa är generatorns källista — den första belagda sidan är den vi kan peka på. */
    nyprisKalla: listing?.pricing.retailPriceSek != null ? (listing.sources[0]?.url ?? "generatorns underlag") : null,
    kandidatRundor: (job.candidateRound ?? 0) + 1,
    aiForstaForslag: aiForsta,
    saljarensVal,
    identitetRattad:
      identitetsRattelser.length > 0 || (!!aiForsta && !!saljarensVal && aiForsta !== saljarensVal),
  };
}

const ALLVAR: Record<string, string> = { S1: "S1 mindre", S2: "S2 måttlig", S3: "S3 stor", S4: "S4 kritisk" };

/** De fyra sidorna ett varv ska täcka. Omslag och närbild är tillägg, inte vinklar. */
const VINKLAR = ["Framifrån", "Höger sida", "Bakifrån", "Vänster sida"];

function saljarensSvar(d: Damage): DataFynd["saljarenSa"] {
  if (d.sellerAction === "confirmed") return "stämmer";
  if (d.sellerAction === "rejected") return "stämmer inte";
  if (d.sellerAction === "corrected") return "rättade";
  return null;
}

async function skicketAv(job: ConditionJob, rattelser: Rattelse[]): Promise<DataSkick> {
  const result = job.result;
  const damages = result?.damages ?? [];
  const bilder = result?.images ?? job.images ?? [];
  const bildById = new Map(bilder.map((b) => [b.id, b]));

  const fynd: DataFynd[] = damages.map((d) => ({
    id: d.id,
    typ: d.type,
    del: d.part,
    position: d.semanticLocation,
    allvarlighet: ALLVAR[d.severity] ?? d.severity,
    paverkan: d.impact,
    beskrivning: d.description,
    bilder: d.evidence.map((e) => ({
      imageId: e.imageId,
      viewLabel: bildById.get(e.imageId)?.viewLabel ?? null,
      cropPath: e.cropPath ?? null,
    })),
    konfidens: d.confidence,
    granskning: d.verification,
    granskningSkal: d.verificationReason,
    saljarenSa: saljarensSvar(d),
    saljarenLaTill: d.sellerAdded,
    rattelser: rattelser.filter((r) => r.fyndId === d.id),
  }));

  const betygsRattelser = rattelser.filter((r) => r.omrade === "betyg");
  /**
   * Modellens eget betyg är det FÖRSTA som någonsin stod på jobbet, inte det som står nu.
   *
   * Betyget räknas om vid varje rättelse (se regradeAndReprice i server.ts), så det som ligger i
   * jobbet efter en avvisad skada är ett betyg som redan bär säljarens korrigering. Det ursprungliga
   * finns bara i loggen, och `aiSa` på den äldsta raden är det.
   */
  const modellensBetyg = betygsRattelser[0]?.aiSa ?? result?.grade?.grade ?? null;

  const taeckta = [...new Set(bilder.map((b) => b.viewLabel).filter((v): v is string => !!v))];
  const trace = await getDebugTrace(job.id).catch(() => undefined);

  return {
    fynd,
    antalFynd: fynd.length,
    bekraftade: fynd.filter((f) => f.saljarenSa === "stämmer").length,
    avvisade: fynd.filter((f) => f.saljarenSa === "stämmer inte").length,
    saljarensEgna: fynd.filter((f) => f.saljarenLaTill).length,
    obesvarade: fynd.filter((f) => f.saljarenSa === null && !f.saljarenLaTill).length,
    betyg: result?.grade?.grade ?? null,
    betygEtikett: result?.grade?.label ?? null,
    modellensBetyg,
    betygRattat: betygsRattelser.length > 0,
    /**
     * Frågorna om lukt, husdjur och rök står som fält utan svar, inte som frånvaro.
     *
     * Se LUCKOR: de ställs inte i flödet än. Raderna finns här för att den som läser vyn ska se att
     * fältet är TOMT och inte att det saknas — och för att svaren har någonstans att landa den dag
     * frågorna byggs.
     */
    fragor: [
      { falt: "lukt", aiSa: null, manniskanSa: null, konfidens: null, kalla: "frågan ställs inte än" },
      { falt: "husdjur", aiSa: null, manniskanSa: null, konfidens: null, kalla: "frågan ställs inte än" },
      { falt: "rök", aiSa: null, manniskanSa: null, konfidens: null, kalla: "frågan ställs inte än" },
    ],
    antalBilder: bilder.length,
    taeckta,
    /**
     * Saknade vinklar går bara att räkna när fotoguiden användes: ett filmat varv märker inte sina
     * bildrutor med väderstreck, med flit (se web/src/lib/videoFrames.ts — vinkeln mäts inte, så
     * ingenting sant kan sägas om den). För ett varv är `taeckning` och `ejSynligaDelar` svaret i
     * stället, och de kommer ur besiktningen som faktiskt tittade på bilderna.
     */
    saknade: taeckta.length ? VINKLAR.filter((v) => !taeckta.includes(v)) : [],
    taeckning: result?.coverage ?? null,
    taeckningNotis: result?.coverageNote ?? null,
    ejSynligaDelar: (trace?.partsInspected ?? []).filter((p) => !p.visible).map((p) => p.part),
  };
}

function flodetAv(session: FlodesSession | null): DataFlode {
  return {
    sess: session?.sess ?? null,
    tidTillIntygatMs: session?.tidTillIntygat ?? null,
    perStegMs: session?.perSteg ?? {},
    besokta: session?.besokta ?? [],
    sistaSteg: session?.sistaSteg ?? null,
    intygat: session?.intygat ?? false,
    fragor: session?.fragor ?? [],
    chip: session?.chip ?? [],
    berattaPa: session?.berattaPa ?? false,
    enhet: session?.enhet ?? null,
    plattform: session?.plattform ?? null,
    vy: session?.vy ?? null,
  };
}

function prisetAv(job: ConditionJob, produkt: Product | null, record: ButikRecord | undefined, ordrar: Order[]): DataPris {
  const pris = job.result?.price ?? null;
  const ladder = job.priceLadder ?? null;
  const forslag = pris?.status === "ok" && pris.default !== null ? Math.round(pris.default) : null;
  /**
   * Slutpriset är vad KÖPAREN betalade, inte vad annonsen stod på.
   *
   * Ordern bär det priset — reservationen låser det, och prisstegen får inte flytta det efteråt. Ett
   * "slutpris" läst ur stegen hade varit priset som råkade ligga uppe den dagen, vilket är något
   * annat än det som betalades.
   */
  const betald = ordrar.find((o) => o.status !== "cancelled" && o.status !== "pending");
  const slut = betald?.priceSek ?? (record?.state === "sold" || record?.state === "delivered" ? record.reservedPriceSek : null);
  const nypris = produkt?.retailPriceSek ?? null;

  return {
    forslagSek: forslag,
    lagSek: pris?.low != null ? Math.round(pris.low) : null,
    hogSek: pris?.high != null ? Math.round(pris.high) : null,
    konfidens: pris?.confidence ?? null,
    motorNotis: pris?.note ?? pris?.unavailableReason ?? null,
    saljarensStartSek: ladder ? Math.round(ladder.startPrice) : null,
    golvSek: ladder ? Math.round(ladder.floorPrice) : null,
    veckoSankningPct: ladder ? Math.round(ladder.weeklyDropPct * 100) : null,
    sankningar: (ladder?.drops ?? []).map((d) => ({ at: d.at, fran: Math.round(d.from), till: Math.round(d.to) })),
    nuSek: produkt?.priceSek ?? (ladder ? Math.round(ladder.currentPrice) : null),
    slutSek: slut ?? null,
    andelAvNypris: slut && nypris ? Math.round((slut / nypris) * 100) : null,
    andelAvForslag: slut && forslag ? Math.round((slut / forslag) * 100) : null,
    prisRattat: !!ladder && forslag !== null && Math.round(ladder.startPrice) !== forslag,
  };
}

function distributionenAv(job: ConditionJob, record: ButikRecord | undefined, statistik: AnnonsStatistik, bevakningar: number): DataDistribution {
  const kanaler: DataKanal[] = [];
  if (record) {
    kanaler.push({
      kanal: "Butiken",
      publiceradAt: record.listedAt,
      visningar: statistik.visningar,
      forfragningar: statistik.kassor,
      klick: statistik.klick,
      notis: null,
    });
  }
  if (job.tradera) {
    kanaler.push({
      kanal: "Tradera",
      publiceradAt: job.tradera.publishedAt,
      visningar: null,
      forfragningar: 0,
      klick: statistik.utgaende,
      notis: "Tradera rapporterar inga visningar till oss. Talet är klick VIDARE dit, mätta på vår sida.",
    });
  }
  return {
    kanaler,
    sidvisningar: statistik.visningar,
    unikaVisningar: statistik.unikaVisningar,
    listvisningar: statistik.listvisningar,
    kassor: statistik.kassor,
    kop: statistik.kop,
    utgaendeTradera: statistik.utgaende,
    perHandelse: statistik.perHandelse,
    bevakningar,
  };
}

/**
 * Betalsättet, så långt ordern kan säga det.
 *
 * En order med en Stripe-session betalades med kort i vår kassa. En möbel som såldes på Tradera
 * betalades utanför oss och vi vet inte hur — det står som "Tradera (okänt)" och inte som ett
 * påstående om ett betalsätt vi aldrig sett.
 */
function betalsattAv(record: ButikRecord | undefined, order: Order | undefined): string | null {
  if (order?.stripeSessionId) return "kort (Stripe)";
  if (record?.soldChannel === "tradera") return "Tradera (okänt för oss)";
  if (order) return "okänt";
  return null;
}

function transaktionenAv(
  record: ButikRecord | undefined,
  ordrar: Order[],
  meddelanden: DataTransaktion["meddelanden"],
): DataTransaktion {
  const forsta = ordrar.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  const genomford = ordrar.find((o) => o.status !== "cancelled" && o.status !== "pending");
  const avbruten = ordrar.find((o) => o.status === "cancelled");
  const forstaKontakt = [forsta?.createdAt, meddelanden[0]?.at].filter(Boolean).sort()[0] ?? null;

  const perKategori: Record<string, number> = {};
  for (const m of meddelanden) perKategori[m.kategori] = (perKategori[m.kategori] ?? 0) + 1;

  return {
    dagarTillForstaForfragan: dygnMellan(record?.listedAt ?? null, forstaKontakt),
    dagarTillSald: dygnMellan(record?.listedAt ?? null, record?.soldAt ?? null),
    kanal: record?.soldChannel ?? null,
    betalsatt: betalsattAv(record, genomford ?? forsta),
    meddelanden,
    antalMeddelanden: meddelanden.length,
    perKategori,
    follIgenom: !!avbruten && !genomford,
    /** Orsaken skrivs av den som avbröt ordern — sista raden i historiken är den som säger varför. */
    orsak: avbruten ? (avbruten.events.slice().reverse().find((e) => e.status === "cancelled")?.note ?? null) : null,
  };
}

function leveransenAv(ordrar: Order[]): DataLeverans {
  const order = ordrar.find((o) => o.deliveryDate) ?? ordrar[0];
  const levererad = order?.events.slice().reverse().find((e) => e.status === "delivered");
  return {
    /**
     * HÄMTNINGSDATUMET saknar eget fält på ordern: budfirman hämtar hos säljaren och kör ut samma
     * dag, så den bokade tiden är båda. Att skriva den i två fält hade sett ut som två mätpunkter.
     */
    hamtningsdatum: order?.deliveryDate ?? null,
    leveransdatum: levererad?.at ?? null,
    zon: order?.deliveryZone ?? null,
    leveranskostnadSek: order?.deliveryFeeSek ?? null,
    /**
     * Leveranskontrollen och avstånd: se LUCKOR. Zonen är det närmaste vi kommer ett avstånd — vi
     * mäter aldrig kilometer, vi prissätter på postnummerzon.
     */
    kontroll: [
      { falt: "foto vid hämtning", aiSa: null, manniskanSa: null, konfidens: null, kalla: "samlas inte in" },
      { falt: "foto vid överlämning", aiSa: null, manniskanSa: null, konfidens: null, kalla: "samlas inte in" },
      { falt: "stämde skicket", aiSa: null, manniskanSa: null, konfidens: null, kalla: "ingen kontroll utförs" },
      { falt: "avvikelser", aiSa: null, manniskanSa: null, konfidens: null, kalla: "ingen kontroll utförs" },
      { falt: "fynd som saknades på kortet", aiSa: null, manniskanSa: null, konfidens: null, kalla: "ingen kontroll utförs" },
    ],
    kopetGodkantAt: levererad?.at ?? null,
    /** Returen är det närmaste en tvist vi har. Null när ingen order finns att uttala sig om. */
    tvist: ordrar.length ? ordrar.some((o) => o.status === "return_requested" || o.status === "returned") : null,
  };
}

// ---------------------------------------------------------------------------
// Hopsättningen
// ---------------------------------------------------------------------------

/**
 * Köparens meddelanden i Tradera-posten, per möbel.
 *
 * Läses en gång för hela listan och inte per rad: posten ligger i en JSON-fil, och 193 läsningar av
 * den för att rita en lista är samma fel som orderfilen redan lärt oss (se adminAnnonser.ts).
 */
async function meddelandenPerLoopaId(): Promise<Map<string, DataTransaktion["meddelanden"]>> {
  const ut = new Map<string, DataTransaktion["meddelanden"]>();
  try {
    const { listTraderaPost } = await import("../integrations/tradera/mailwatch.js");
    const { poster } = await listTraderaPost();
    for (const post of poster) {
      if (!post.loopaId) continue;
      // Bara det som är ett meddelande FRÅN en människa. Sålt-avier och budnotiser är händelser.
      if (post.kind !== "fraga") continue;
      const rad = { at: post.receivedAt, kanal: "Tradera", kategori: kategoriseraFraga(`${post.subject} ${post.excerpt}`), utdrag: post.excerpt.slice(0, 200) };
      const lista = ut.get(post.loopaId) ?? [];
      lista.push(rad);
      ut.set(post.loopaId, lista);
    }
  } catch {
    // Utan Gmail-bevakaren finns ingen post. Tom karta är rätt svar, inte ett fel.
  }
  return ut;
}

/** Bevakningar skapade från en möbels sida — mätningen bär dem som en händelse per annons. */
function bevakningarAv(statistik: AnnonsStatistik): number {
  return statistik.perHandelse["bevakning_created"] ?? 0;
}

export interface DataSvar {
  objekt: DataObjekt[];
  summering: DataSummering;
  /** Tratten över ALLA flöden, även de som aldrig blev ett jobb. */
  tratt: TrattSteg[];
  /** Flöden som aldrig nådde en uppladdning. De syns ingen annanstans i produkten. */
  avhoppUtanJobb: number;
  /**
   * De avbrutna flödena, ett i taget och nyast först.
   *
   * Tratten säger HUR MÅNGA som försvann i ett steg. Den här listan säger vilka, när, hur länge de
   * höll på och på vilken enhet — och är därmed den enda delen av vyn som går att agera på i ett
   * enskilt fall. Se `Avhopp` i data/flode.ts.
   */
  avhopp: Avhopp[];
  /** En rad per säljare: vad de påbörjat, vad de fullföljt och var de brukar släppa taget. */
  saljare: DataSaljare[];
  luckor: typeof LUCKOR;
}

/**
 * En säljare, summerad över alla sina flöden.
 *
 * KONTOT ÄR NYCKELN, inte flödessessionen. Samma person som filmar tre möbler på tre kvällar är tre
 * sessioner och EN säljare, och frågan panelen ställer — "vem fastnar, och fastnar de på samma
 * ställe varje gång" — går bara att besvara på den senare nyckeln.
 *
 * ID:T ÄR STYRKT NÄR DET GÅR. Flödesraden bär ett konto som webbläsaren påstått (se data/flode.ts);
 * jobbet bär det ägarskap servern satte vid uppladdningen. Blev flödet ett jobb gäller jobbets, och
 * bara annars klientens. Skillnaden syns i `styrkta` — noll styrkta flöden är en rad att läsa med
 * en nypa salt.
 */
export interface DataSaljare {
  uid: string;
  /** Alla flöden vi sett från kontot. */
  floden: number;
  /** Flöden som gick förbi startsidan: en påbörjad annons. */
  paborjade: number;
  /** Flöden som nådde ett intygat kort. */
  intygade: number;
  /** Påbörjade flöden som tog slut utan intyg. */
  avbrutna: number;
  /** Var de tog slut, räknat per steg. Den vanligaste väggen för just den här säljaren. */
  perSistaSteg: Record<string, number>;
  /** Flöden där kontot kunde styrkas ur jobbets ägarskap. */
  styrkta: number;
  /** Annonser i lagret som ägs av kontot. Räknas ur jobben, oberoende av mätningen. */
  annonser: number;
  salda: number;
  /** Samtal i "Hur fungerar det?" som fördes inloggad. */
  samtal: number;
  forsta: string | null;
  senaste: string | null;
  enheter: string[];
}

export interface DataSummering {
  antal: number;
  /** Möbler där minst en människa rättat minst en sak. */
  medRattelse: number;
  rattelser: number;
  fynd: number;
  bekraftadeFynd: number;
  avvisadeFynd: number;
  egnaFynd: number;
  /** Andel av alla besvarade fynd som säljaren sa stämde. Null när ingen svarat på något. */
  traffsakerhet: number | null;
  betygRattade: number;
  identitetRattade: number;
  prisRattade: number;
  medianTidTillIntygatMs: number | null;
  salda: number;
  medianDagarTillSald: number | null;
}

function summera(objekt: DataObjekt[]): DataSummering {
  const fynd = objekt.flatMap((o) => o.skick.fynd);
  const besvarade = fynd.filter((f) => !f.saljarenLaTill && f.saljarenSa !== null);
  const stammer = besvarade.filter((f) => f.saljarenSa === "stämmer").length;
  const tider = objekt.map((o) => o.flode.tidTillIntygatMs).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const dagar = objekt.map((o) => o.transaktion.dagarTillSald).filter((n): n is number => n !== null).sort((a, b) => a - b);

  return {
    antal: objekt.length,
    medRattelse: objekt.filter((o) => o.rattelser.length > 0).length,
    rattelser: objekt.reduce((s, o) => s + o.rattelser.length, 0),
    fynd: fynd.length,
    bekraftadeFynd: stammer,
    avvisadeFynd: besvarade.filter((f) => f.saljarenSa === "stämmer inte").length,
    egnaFynd: fynd.filter((f) => f.saljarenLaTill).length,
    traffsakerhet: besvarade.length ? Math.round((stammer / besvarade.length) * 100) : null,
    betygRattade: objekt.filter((o) => o.skick.betygRattat).length,
    identitetRattade: objekt.filter((o) => o.identitet.identitetRattad).length,
    prisRattade: objekt.filter((o) => o.pris.prisRattat).length,
    medianTidTillIntygatMs: tider.length ? tider[Math.floor(tider.length / 2)] : null,
    salda: objekt.filter((o) => o.transaktion.dagarTillSald !== null).length,
    medianDagarTillSald: dagar.length ? dagar[Math.floor(dagar.length / 2)] : null,
  };
}

/** Läget i klartext, återanvänt ur annonspanelen så att de två vyerna aldrig kan säga olika saker. */
async function lageAv(job: ConditionJob, record: ButikRecord | undefined): Promise<string> {
  const { lageAv: lage } = await import("../adminAnnonser.js");
  return lage(job, record);
}

async function objektAv(
  job: ConditionJob,
  record: ButikRecord | undefined,
  statistik: AnnonsStatistik,
  ordrar: Order[],
  session: FlodesSession | null,
  rattelser: Rattelse[],
  meddelanden: DataTransaktion["meddelanden"],
): Promise<DataObjekt> {
  const loopaId = loopaIdFor(job.id);
  const produkt = jobToProduct(job, record?.state ?? "draft");
  const listing = listingOf(job)?.result ?? null;

  return {
    id: loopaId,
    jobId: job.id,
    loopaId,
    createdAt: job.createdAt,
    ownerId: ownerIdOf(job),
    ownerEmail: job.ownerEmail ?? null,
    titel:
      produkt?.title ??
      listing?.listing.title ??
      [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ") ??
      loopaId,
    lage: await lageAv(job, record),
    bildUrl: produkt?.imageUrl ?? null,
    identitet: identitetenAv(job, produkt, rattelser),
    skick: await skicketAv(job, rattelser),
    flode: flodetAv(session),
    pris: prisetAv(job, produkt, record, ordrar),
    distribution: distributionenAv(job, record, statistik, bevakningarAv(statistik)),
    transaktion: transaktionenAv(record, ordrar, meddelanden),
    leverans: leveransenAv(ordrar),
    rattelser,
    luckor: LUCKOR.map((l) => l.falt),
  };
}

/**
 * Hela datasetet, nyast först.
 *
 * Läser lagret en gång per anrop, samma val som annonspanelen gör och av samma skäl: vyn öppnas av
 * en handfull människor och ett index som kan bli inaktuellt är en sämre affär än en läsning som tar
 * en halv sekund.
 */
/**
 * En rad per säljare, ur flödena och lagret.
 *
 * TVÅ KÄLLOR SOM INTE VET OM VARANDRA. Flödena vet vad någon GJORDE, jobben vet vad det BLEV, och
 * bara ihopslagna svarar de på frågan panelen ställer: påbörjade den här säljaren fem annonser och
 * fick upp en? Ett konto som finns i den ena men inte den andra ska stå med ändå — en säljare med
 * annonser men utan flöden filmade innan mätningen fanns, och en med flöden men utan annonser är
 * precis den vi letar efter.
 *
 * STYRKT ÄGARSKAP VINNER. Blev flödet ett jobb är jobbets ägare sanningen om vem det var; annars
 * står klientens påstående, räknat separat i `styrkta` så att raden går att läsa med rätt tilltro.
 */
function saljarna(
  sessioner: FlodesSession[],
  objekt: DataObjekt[],
  jobbetsAgare: Map<string, string | null>,
  samtalPerUid: Map<string, number>,
): DataSaljare[] {
  const rader = new Map<string, DataSaljare>();
  const rad = (uid: string): DataSaljare =>
    rader.get(uid) ??
    (rader
      .set(uid, {
        uid,
        floden: 0,
        paborjade: 0,
        intygade: 0,
        avbrutna: 0,
        perSistaSteg: {},
        styrkta: 0,
        annonser: 0,
        salda: 0,
        samtal: samtalPerUid.get(uid) ?? 0,
        forsta: null,
        senaste: null,
        enheter: [],
      })
      .get(uid) as DataSaljare);

  for (const sess of sessioner) {
    const styrkt = sess.jobId ? (jobbetsAgare.get(sess.jobId) ?? null) : null;
    const uid = styrkt ?? sess.uid;
    if (!uid) continue;
    const r = rad(uid);
    r.floden += 1;
    if (styrkt) r.styrkta += 1;
    // Samma gräns som avhoppen räknas på: förbi startsidan är en påbörjad annons.
    const paborjad = sess.besokta.some((steg) => steg !== "home");
    if (paborjad) r.paborjade += 1;
    if (sess.intygat) r.intygade += 1;
    else if (paborjad) {
      r.avbrutna += 1;
      if (sess.sistaSteg) r.perSistaSteg[sess.sistaSteg] = (r.perSistaSteg[sess.sistaSteg] ?? 0) + 1;
    }
    if (!r.forsta || sess.start < r.forsta) r.forsta = sess.start;
    if (!r.senaste || sess.slut > r.senaste) r.senaste = sess.slut;
    if (sess.enhet && !r.enheter.includes(sess.enhet)) r.enheter.push(sess.enhet);
  }

  for (const o of objekt) {
    if (!o.ownerId) continue;
    const r = rad(o.ownerId);
    r.annonser += 1;
    if (o.transaktion.dagarTillSald !== null) r.salda += 1;
    // Jobbets datum räknas in i spannet: en säljare vars flöden aldrig mättes ska ändå ha en tid.
    if (!r.forsta || o.createdAt < r.forsta) r.forsta = o.createdAt;
    if (!r.senaste || o.createdAt > r.senaste) r.senaste = o.createdAt;
  }

  for (const [uid, antal] of samtalPerUid) rad(uid).samtal = antal;

  // Den som håller på NU står först: panelen läses oftast för att se vad som just hände.
  return [...rader.values()].sort((a, b) => ((a.senaste ?? "") < (b.senaste ?? "") ? 1 : -1));
}

export async function bygg(): Promise<DataSvar> {
  const [jobs, records, statistik, ordrarAlla, sessioner, rattelser, meddelanden, samtal] = await Promise.all([
    listJobs(),
    butikStore().all(),
    allStatistik(),
    allOrders(),
    allaSessioner(),
    allaRattelser(),
    meddelandenPerLoopaId(),
    allaSamtal(),
  ]);

  const recordById = new Map(records.map((r) => [r.id, r]));
  const ordrarPerId = new Map<string, Order[]>();
  for (const o of ordrarAlla) ordrarPerId.set(o.productId, [...(ordrarPerId.get(o.productId) ?? []), o]);
  const sessionPerJobb = new Map<string, FlodesSession>();
  // Äldst först in i kartan, så att den FÖRSTA sessionen på ett jobb vinner — det är den som bär
  // filmningen. Se `flodeForJobb` för samma regel.
  for (const s of [...sessioner].reverse()) if (s.jobId) sessionPerJobb.set(s.jobId, s);
  const rattelserPerJobb = new Map<string, Rattelse[]>();
  for (const r of rattelser) rattelserPerJobb.set(r.jobId, [...(rattelserPerJobb.get(r.jobId) ?? []), r]);

  const objekt: DataObjekt[] = [];
  for (const job of jobs) {
    const loopaId = loopaIdFor(job.id);
    objekt.push(
      await objektAv(
        job,
        recordById.get(loopaId),
        statistik.get(loopaId) ?? tomStatistik(),
        ordrarPerId.get(loopaId) ?? [],
        sessionPerJobb.get(job.id) ?? null,
        (rattelserPerJobb.get(job.id) ?? []).sort((a, b) => (a.at < b.at ? -1 : 1)),
        meddelanden.get(loopaId) ?? [],
      ),
    );
  }
  objekt.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const samtalPerUid = new Map<string, number>();
  for (const s of samtal) if (s.uid) samtalPerUid.set(s.uid, (samtalPerUid.get(s.uid) ?? 0) + 1);

  return {
    objekt,
    summering: summera(objekt),
    tratt: tratt(sessioner),
    avhoppUtanJobb: sessioner.filter((s) => !s.jobId && !s.intygat).length,
    avhopp: avhoppen(sessioner),
    saljare: saljarna(sessioner, objekt, new Map(jobs.map((j) => [j.id, ownerIdOf(j)])), samtalPerUid),
    luckor: LUCKOR,
  };
}

export async function objektFor(id: string): Promise<DataObjekt | null> {
  const svar = await bygg();
  return svar.objekt.find((o) => o.id === id || o.jobId === id) ?? null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Datasetet som CSV — en rad per möbel, med rättelserna räknade.
 *
 * INTE EN RAD PER FYND, och det är ett val: filen finns för att kunna öppnas i ett kalkylblad och
 * sorteras, inte för att träna på. Den som ska träna läser JSON:en, där varje fynd bär sitt före och
 * efter. En platt CSV över fynd hade tappat just det som gör raderna värda något.
 */
export function tillCsv(objekt: DataObjekt[]): string {
  const kolumner = [
    "loopa_id", "jobb", "skapad", "titel", "lage", "marke", "modell", "betyg", "modellens_betyg",
    "fynd", "bekraftade", "avvisade", "egna", "rattelser", "identitet_rattad", "pris_rattat",
    "forslag_sek", "start_sek", "golv_sek", "slut_sek", "andel_av_nypris", "andel_av_forslag",
    "visningar", "klick", "kop", "dagar_till_sald", "tid_till_intygat_s", "sista_steg", "enhet",
  ];
  const rader = objekt.map((o) => [
    o.loopaId, o.jobId, o.createdAt, o.titel, o.lage,
    o.identitet.falt.find((f) => f.falt === "märke")?.manniskanSa ?? o.identitet.falt.find((f) => f.falt === "märke")?.aiSa ?? "",
    o.identitet.falt.find((f) => f.falt === "modell")?.manniskanSa ?? o.identitet.falt.find((f) => f.falt === "modell")?.aiSa ?? "",
    o.skick.betyg ?? "", o.skick.modellensBetyg ?? "",
    o.skick.antalFynd, o.skick.bekraftade, o.skick.avvisade, o.skick.saljarensEgna,
    o.rattelser.length, o.identitet.identitetRattad ? "ja" : "nej", o.pris.prisRattat ? "ja" : "nej",
    o.pris.forslagSek ?? "", o.pris.saljarensStartSek ?? "", o.pris.golvSek ?? "", o.pris.slutSek ?? "",
    o.pris.andelAvNypris ?? "", o.pris.andelAvForslag ?? "",
    o.distribution.sidvisningar, o.distribution.perHandelse ? Object.values(o.distribution.perHandelse).reduce((a, b) => a + b, 0) : 0,
    o.distribution.kop, o.transaktion.dagarTillSald ?? "",
    o.flode.tidTillIntygatMs !== null ? Math.round(o.flode.tidTillIntygatMs / 1000) : "",
    o.flode.sistaSteg ?? "", o.flode.enhet ?? "",
  ]);
  const fly = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [kolumner.join(","), ...rader.map((r) => r.map(fly).join(","))].join("\n") + "\n";
}
