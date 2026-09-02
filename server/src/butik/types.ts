/**
 * Loopa Butik — den gemensamma produktmodellen.
 *
 * Butiken visar två sorters varor i samma rutnät, och de har nästan ingenting gemensamt bakom
 * kulisserna: våra egna möbler är besiktigade jobb i den här servern, Traderas är främmande annonser
 * hämtade över deras API. `source` är skillnaden, och den är ett fält och inte två modeller med flit —
 * rutnätet, sorteringen och filtren ska kunna behandla dem som en lista utan att veta vilken de har
 * framför sig, ända fram till det ögonblick då det faktiskt spelar roll (köpknappen).
 *
 * Det som ALDRIG normaliseras bort: att en Tradera-vara inte är granskad av oss. `grade` är null för
 * dem, inte "okänd" eller ett gissat betyg — kortet är ett attest, och ett attest vi inte utfärdat
 * får inte se ut som ett vi gjort.
 */

import type { CanonicalCondition, ConditionGrade, FurnitureIdentity } from "../types.js";

export type ProductSource = "loopa" | "tradera";

/**
 * Livscykeln för EN unik möbel.
 *
 * Möbeln finns i ett exemplar och ligger uppe på två ställen samtidigt — Butiken och Tradera. Därför
 * är det här inte en statusflagga per kanal utan ETT tillstånd som båda kanalerna läser och skriver.
 * Dubbelförsäljningen förhindras inte av att kanalerna är snälla mot varandra, utan av att övergången
 * till `sold` bara kan vinnas en gång; se `claimForSale` i store.ts.
 *
 * `reserved` är inte "någon tittar på den" utan "någon står i kassan": den håller möbeln i X minuter
 * och släpper den av sig själv om betalningen aldrig kommer. Utan tidsgränsen hade en avbruten
 * utcheckning låst möbeln för alltid.
 */
export type ProductState = "draft" | "live" | "reserved" | "sold" | "delivered" | "returned";

/**
 * Vad som får hända härnäst. Uppslagen och inte en if-kedja, för att listan ÄR regeln — den läses av
 * både servern och testerna, och en övergång som inte står här kan inte ske av misstag någonstans.
 *
 * Två rader förtjänar en förklaring:
 *
 * `live -> sold` finns för att en försäljning på Tradera aldrig passerar vår kassa. Den möbeln gick
 * från att ligga uppe till att vara borta utan att någon reserverade den hos oss.
 *
 * `reserved -> sold` är den farliga: den nås BÅDE från vår kassa och från Tradera-pollningen, och det
 * är precis det fallet dubbelförsäljningen består av — en köpare i vår kassa medan en annan trycker
 * Köp Nu på Tradera. Övergången är tillåten från båda hållen, och det som skiljer dem åt är vem som
 * hinner först. Se `claimForSale`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProductState, readonly ProductState[]>> = {
  draft: ["live"],
  live: ["reserved", "sold", "draft"],
  reserved: ["sold", "live"],
  sold: ["delivered"],
  delivered: ["returned"],
  returned: [],
};

export function canTransition(from: ProductState, to: ProductState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Tillstånd där möbeln syns i rutnätet. `reserved` syns kvar — den är inte såld, bara upptagen. */
export const BROWSABLE_STATES: readonly ProductState[] = ["live", "reserved"];

/** Tillstånd där möbeln går att lägga i kassan. Bara ett. */
export function isBuyable(state: ProductState): boolean {
  return state === "live";
}

/**
 * Varför övergången skedde. Sparas på varje händelse, för att "möbeln blev såld" inte är samma sak
 * som "möbeln blev såld PÅ TRADERA MEDAN någon stod i vår kassa" — och det är den andra meningen man
 * vill läsa i loggen dagen då en köpare hör av sig.
 */
export type TransitionActor =
  | { kind: "seller"; userId: string | null }
  | { kind: "buyer"; userId: string | null; orderId?: string }
  | { kind: "system"; job: string }
  | { kind: "tradera"; itemId: number | null }
  | { kind: "admin"; userId: string | null };

/** En genomförd tillståndsändring. Aldrig uppdaterad, bara tillagd — loggen är en huvudbok. */
export interface ProductEvent {
  id: string;
  productId: string;
  from: ProductState | null;
  to: ProductState;
  at: string;
  actor: TransitionActor;
  /** Fri text för människan som läser loggen, t.ex. "Reservationen gick ut efter 15 min". */
  note: string | null;
}

/** Måtten, i millimeter och normaliserade ur en fritextsoppa. Se normalize.ts. */
export interface Dimensions {
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  seatHeightMm: number | null;
  /**
   * Sant när minst ett mått är en uppskattning för möbeltypen och inte en uppgift om just den här
   * möbeln (`estimated` på ListingAttribute). "Får den plats?" måste kunna säga det rakt ut — ett
   * dörrmått jämfört med ett gissat möbelmått är inte ett svar man ska agera på.
   */
  estimated: boolean;
}

/** Skickskalan som den VISAS i butiken. Härledd ur betyget, aldrig påhittad för Tradera-varor. */
export interface ProductCondition {
  grade: ConditionGrade;
  canonical: CanonicalCondition;
  /** Loopas egen etikett, t.ex. "Gott begagnat skick". */
  label: string;
  /** En mening säljaren och köparen kan läsa. */
  rationale: string;
  /** Antal kvarstående fynd på kortet. 0 betyder granskad utan anmärkning, inte "ogranskad". */
  defectCount: number;
  /** När besiktningen gjordes — "AI-granskad [datum]" på kortet. */
  inspectedAt: string;
  /** Om andrabesiktningen kördes. Kortet ska kunna säga om det bygger på en eller två granskningar. */
  reviewed: boolean;
}

/** Auktionsdata. Bara Tradera-varor har det — vi driver inga egna auktioner. */
export interface AuctionInfo {
  /** Sant för budgivning, falskt för rena Köp Nu-annonser. */
  isAuction: boolean;
  currentBidSek: number | null;
  bidCount: number | null;
  endsAt: string | null;
  buyNowSek: number | null;
}

/**
 * En vara i butiken, oavsett varifrån den kommer.
 *
 * Fälten som bara den ena källan kan fylla står som null för den andra i stället för att ligga i en
 * union: rutnätet renderar samma kort för båda, och ett kort som måste smalna av typen för att läsa
 * en titel blir ett kort med två kodvägar genom varje rad.
 */
export interface Product {
  /** Loopa: jobbets Loopa-ID (LP-XXXX-XXXX). Tradera: "tradera:<itemId>". Stabil, publik, i adressen. */
  id: string;
  source: ProductSource;
  title: string;
  brand: string | null;
  model: string | null;
  /** Nyckeln ur CATEGORIES, aldrig generatorns fritext. Se normalize.ts. */
  categorySlug: string;
  color: string | null;
  material: string | null;
  dimensions: Dimensions;
  priceSek: number | null;
  /** Nypris när prismotorn eller annonsen känner det — stryks över, och besparingen räknas ur det. */
  retailPriceSek: number | null;
  imageUrl: string | null;
  /** Loopa-varor: alltid satt. Tradera: alltid null — vi har inte granskat dem. */
  condition: ProductCondition | null;
  /**
   * Säljarens EGEN skickuppgift på en Tradera-annons ("Gott skick", attribut 121 hos dem).
   *
   * Skild från `condition` med flit, och det är inte en teknikalitet. `condition` är vad VI granskat
   * och kan svara för; det här är vad någon annan har skrivit om sin egen möbel. Visas den någonsin
   * som ett betyg har butiken börjat gå i god för påståenden den inte prövat — och då är
   * "Loopa-granskad" inte längre värt något. Null för Loopa-varor, där vårt eget betyg gäller.
   */
  sellerCondition?: string | null;
  state: ProductState;
  /** Sätts när möbeln lades i butiken, inte när jobbet skapades. Driver "Nyinkommet". */
  listedAt: string;
  /**
   * Om `listedAt` är en RIKTIG uppgift eller bara det bästa vi har.
   *
   * Traderas sökresultat säger inte när en annons lades upp — bara när den slutar. Sattes `listedAt`
   * till hämtningstiden blev varje Tradera-annons nyinkommen vid varje uppdatering, och
   * "Nyinkommet" fylldes helt av dem medan våra egna möbler trängdes ut. Fältet finns för att
   * sorteringen ska kunna säga "vet inte" i stället för "nyss".
   */
  listedAtKnown: boolean;
  /** Bara Tradera. Deep link till deras annons — vi proxar aldrig deras kassa. */
  externalUrl: string | null;
  auction: AuctionInfo | null;
  /** Stockholm så länge. Bärs på varan för att leveranslogiken ska läsa den, inte gissa. */
  region: string;
  /** Loopa-varor kan hemlevereras; Tradera-varor sköter sin egen frakt. */
  homeDeliveryAvailable: boolean;
  /**
   * Om varan går att lämna tillbaka till OSS.
   *
   * Sant för det vi själva granskat och säljer, falskt för Tradera. Bar tidigare ett löfte om
   * "14 dagars öppet köp"; den tidsgränsen är borta ur produkten och står därför inte här heller —
   * fältet säger vem som tar emot en retur, inte inom hur lång tid.
   */
  returnsAccepted: boolean;
  /** Loopa: jobbets id, så PDP:n kan hämta hela sanningskortet. Tradera: null. */
  jobId: string | null;
  identity: FurnitureIdentity | null;
}

/** Sorteringen, med Relevans som förval. */
export type SortKey = "relevans" | "nyinkommet" | "pris_upp" | "pris_ner";

/** Filtren, som de kommer från rutnätet. Alla frivilliga; utelämnat = filtrera inte på det. */
export interface ProductFilter {
  q?: string | null;
  categorySlug?: string | null;
  brands?: string[] | null;
  /** "Endast Loopa-granskade". Förval av, men Loopa sorteras ändå först inom relevans. */
  onlyLoopa?: boolean;
  minPriceSek?: number | null;
  maxPriceSek?: number | null;
  /** Betyg som får vara med. Gäller bara Loopa-varor — Tradera har inget betyg att filtrera på. */
  grades?: ConditionGrade[] | null;
  maxWidthMm?: number | null;
  maxDepthMm?: number | null;
  maxHeightMm?: number | null;
  colors?: string[] | null;
  materials?: string[] | null;
  homeDeliveryOnly?: boolean;
  sort?: SortKey;
  limit?: number;
  offset?: number;
}

/**
 * Ett svar på en sökning i rutnätet.
 *
 * `traderaDegraded` finns för att ett trasigt Tradera-anrop inte får ge ett trasigt rutnät: då visas
 * våra egna varor med en notis, och notisen behöver veta att den ska visas. Se browse.ts.
 */
export interface BrowseResult {
  items: Product[];
  total: number;
  offset: number;
  limit: number;
  traderaDegraded: boolean;
  /**
   * Varor som föll bort för att de saknar mått, när ett måttfilter var satt. Rutnätet säger det rakt
   * ut i stället för att tyst visa färre träffar — de flesta Tradera-annonser saknar mått, och en
   * tom sida utan förklaring läser som att lagret är tomt.
   */
  excludedForMissingDimensions: number;
  /**
   * Varor som föll bort för att de saknar NÅGOT filtrerat fält — mått, färg eller material.
   *
   * Vidare än raden ovan med flit: färg och material kommer bara från våra egna besiktningar, så ett
   * sådant filter tömmer hela Tradera-halvan utan att någon sagt det. Se applyFilter.
   */
  excludedForMissingData: number;
}
