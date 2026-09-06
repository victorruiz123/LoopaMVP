/**
 * Butikens typer på klientsidan.
 *
 * Speglar server/src/butik/types.ts för hand, precis som web/src/types.ts speglar serverns modell.
 * De två projekten delar inget tsconfig och importerar aldrig varandra — se `include` i respektive
 * tsconfig.json. Ändras serverns modell ska den här följa med i samma ändring.
 */

export type ProductSource = "loopa" | "tradera";
export type ProductState = "draft" | "live" | "reserved" | "sold" | "delivered" | "returned";
export type ConditionGrade = "A" | "B" | "C" | "D" | "E" | "F";
export type SortKey = "relevans" | "nyinkommet" | "pris_upp" | "pris_ner";

export interface Dimensions {
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  seatHeightMm: number | null;
  estimated: boolean;
}

export interface ProductCondition {
  grade: ConditionGrade;
  canonical: string;
  label: string;
  rationale: string;
  defectCount: number;
  inspectedAt: string;
  reviewed: boolean;
}

export interface AuctionInfo {
  isAuction: boolean;
  currentBidSek: number | null;
  bidCount: number | null;
  endsAt: string | null;
  buyNowSek: number | null;
}

export interface Product {
  id: string;
  source: ProductSource;
  title: string;
  brand: string | null;
  model: string | null;
  categorySlug: string;
  color: string | null;
  material: string | null;
  dimensions: Dimensions;
  priceSek: number | null;
  retailPriceSek: number | null;
  /**
   * Prismotorns uppskattning av vad möbeln är värd BEGAGNAD — inte nypriset.
   *
   * Rabatten på kortet räknas mot `retailPriceSek` (vad en ny kostar, det köparen känner igen),
   * medan sorteringens fyndpoäng räknas mot den här (vad just den här är värd). Två olika frågor,
   * och att blanda ihop dem gör antingen varje begagnad möbel till ett jättefynd eller inget till.
   */
  estimatedValueSek: number | null;
  /** Genomförda prissänkningar, äldst först. Kommer ur säljarens prisstege. */
  priceHistory: Array<{ at: string; from: number; to: number }>;
  /** När priset senast sänktes. Driver etiketten "Prissänkt" på kortet. */
  priceDroppedAt: string | null;
  imageCount: number;
  hasMeasurements: boolean;
  imageUrl: string | null;
  /** Null för Tradera-varor. Det är den skillnaden kortet visar som "ej granskad". */
  condition: ProductCondition | null;
  /** Säljarens eget ord om skicket på Tradera. Ett påstående, aldrig ett betyg. */
  sellerCondition?: string | null;
  state: ProductState;
  listedAt: string;
  /** Falskt för Tradera: deras svar säger inte när annonsen lades upp, bara när den slutar. */
  listedAtKnown: boolean;
  externalUrl: string | null;
  auction: AuctionInfo | null;
  region: string;
  homeDeliveryAvailable: boolean;
  /** Om varan går att lämna tillbaka till oss. Ingen utlovad tidsgräns — se serverns types.ts. */
  returnsAccepted: boolean;
  jobId: string | null;
}

export interface BrowseResult {
  items: Product[];
  total: number;
  offset: number;
  limit: number;
  /** Tradera svarade inte. Rutnätet visar Loopas varor och en notis. */
  traderaDegraded: boolean;
  /** Varor som föll bort ur ett måttfilter för att de saknar mått. */
  excludedForMissingDimensions: number;
  /** Varor som föll bort för att de saknar något filtrerat fält: mått, färg eller material. */
  excludedForMissingData: number;
}

export interface Category {
  slug: string;
  label: string;
  blurb: string;
  count: number;
}

export interface BrandFacet {
  brand: string;
  count: number;
  /** Granskade möbler hos oss. Går att köpa i dag, med hemleverans. */
  loopa?: number;
  /** Annonser via Tradera. Någon annans möbel, som vi kan analysera och leverera. */
  tradera?: number;
  /** Adressens form av namnet. Serversatt, så klienten inte behöver upprepa slugreglerna. */
  slug?: string;
}
