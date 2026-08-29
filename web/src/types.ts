// Mirrors experiments/condition-grading/server/src/types.ts.
// Kept as a plain duplicate (no shared package) since this whole engine is an isolated experiment.

export type DamageType =
  | "scratch" | "scuff" | "abrasion" | "chip" | "dent" | "crack" | "tear" | "hole"
  | "stain" | "discoloration" | "fading" | "rust" | "corrosion"
  | "pilling" | "worn_material" | "fraying" | "compressed_upholstery" | "peeling_flaking"
  | "deformation" | "loose_component" | "broken_component" | "missing_part" | "sagging" | "structural_damage"
  | "general_wear" | "other";

export type Severity = "S1" | "S2" | "S3" | "S4";
export type Impact = "cosmetic" | "functional" | "structural";
/**
 * `NOT_RUN` betyder att andrabesiktningen aldrig kördes — inte att fyndet underkändes och inte att det
 * godkändes. Kortet är ett attest och får inte antyda en kontroll som inte gjorts.
 *
 * Fyndet STÅR ändå: det rapporterades av inspektionen och räknas i betyg och pris precis som förut.
 * Se effectiveVerification i grade.ts och isPriceable i pricing.ts — båda filtrerade tidigare på
 * `=== "CONFIRMED"` och hade tyst tömt både betyget och prisunderlaget på varje fynd.
 */
export type VerificationState = "CONFIRMED" | "REJECTED" | "UNCERTAIN" | "NOT_RUN";
export type CoverageState = "INSPECTED_CLEAR" | "INSPECTED_DAMAGE" | "NOT_SUFFICIENTLY_VISIBLE";
export type ConditionGrade = "A" | "B" | "C" | "D" | "E" | "F";
export type CanonicalCondition = "Nyskick" | "Mycket bra skick" | "Bra skick" | "Okej skick";
export type WearLevel = "minimal" | "light" | "moderate" | "heavy" | "severe";
export type AffectedExtent = "isolated" | "moderate" | "widespread";

export interface CapturedImage {
  id: string;
  viewLabel: string | null;
  source: "video" | "manual";
  width: number;
  height: number;
  path: string;
  capturedAt: string;
}

export interface EvidenceMark {
  kind: "box" | "line";
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
}

export interface DamageEvidence {
  imageId: string;
  mark: EvidenceMark;
  cropPath?: string;
}

export interface Damage {
  id: string;
  type: DamageType;
  part: string;
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
  confidence: number;
  verification: VerificationState;
  verificationReason: string;
  evidence: DamageEvidence[];
  recaptureRequested: boolean;
  sellerAction: "confirmed" | "rejected" | "corrected" | null;
  sellerAdded: boolean;
}

export interface OverallCondition {
  overallWearLevel: WearLevel;
  affectedExtent: AffectedExtent;
  functionalityAffected: boolean;
  structuralIntegrityOk: boolean;
  clearlyUsedAppearance: boolean;
  observations: string[];
}

export interface GradeExplanation {
  grade: ConditionGrade;
  canonicalCondition: CanonicalCondition;
  label: string;
  rationale: string;
  reasons: string[];
}

/** What the seller typed before filming — the price engine searches the corpus on this. */
export interface FurnitureIdentity {
  brand: string | null;
  model: string;
}

/** One damage as the price engine valued it — its category, not ours, and what it cost. */
export interface PriceDamageLine {
  category: string | null;
  grade: number | null;
  /** share of the undamaged base price, 0-1 */
  deduction: number;
  /** "table" | "estimated_repair" | "below_materiality" | "no_valuation" */
  source: string | null;
  description: string | null;
  location: string | null;
  count?: number;
}

export interface PriceEstimate {
  status: "ok" | "no_data" | "unavailable";
  low: number | null;
  default: number | null;
  high: number | null;
  currency: "SEK";
  confidence: string | null;
  note: string | null;
  matchCount: number;
  variant: string[] | null;
  variantMethod: string | null;
  damageDeduction: number | null;
  damageLines: PriceDamageLine[];
  unavailableReason: string | null;
  requestedAt: string;
  latencyMs: number;
}

/** En egenskap generatorn hittat och kunnat belägga — mått, material, färg, årsmodell. */
export interface ListingAttribute {
  key: string;
  label: string;
  value: string;
  sourceUrl?: string | null;
}

export interface ListingSource {
  title: string;
  url: string;
  qualityTier?: 1 | 2 | 3;
}

/**
 * Annonsgeneratorns svar, som det kommer ur loopa-landing-page-main. Bara de fält truth-cardet visar
 * är typade här — resten följer med orört i `raw` för den som vill gräva.
 */
export interface GeneratedListing {
  identity: {
    brand: string | null;
    exactProduct: string | null;
    variant: string | null;
    category: string | null;
    confidence: "high" | "medium" | "low";
    uncertain: boolean;
    uncertaintyNote: string | null;
  };
  attributes: ListingAttribute[];
  pricing: {
    retailPriceSek: number | null;
    suggestedPriceSek: number | null;
    priceRangeMinSek: number | null;
    priceRangeMaxSek: number | null;
    rationale: string | null;
  };
  listing: { title: string; description: string; conditionText: string };
  sources: ListingSource[];
  /** "full" | "partial" | "fallback" — hur mycket generatorn kunde belägga. */
  status?: string;
  missingFields?: string[];
  missingNotes?: string[];
}

/** Truth-cardets halva av rapporten. Alltid satt när ett märke fanns, även när den inte gick att nå. */
export interface ListingResult {
  /** "pending" medan generatorn fortfarande kör — den startar samtidigt som besiktningen. */
  status: "pending" | "ok" | "unavailable";
  unavailableReason: string | null;
  result: GeneratedListing | null;
  /**
   * Generatorns egen stegtidtagning, vidarebefordrad i stället för slängd.
   *
   * `generate.ts` räknar redan ut det här och returnerar det; bryggan läste bara `result` och
   * `provenance`, så den enda siffra som gick att se utifrån var hela anropets längd. Med research och
   * strukturering isärhållna går det att säga VILKET steg som drog tiden i en enskild körning i stället
   * för att gissa ur budgetarna.
   */
  timings?: {
    researchMs: number;
    structureMs: number;
    researchRetried: boolean;
    structureRetried: boolean;
    /** Alla Gemini-anrop i körningen; `groundedCalls` är de som bar googleSearch. */
    geminiCalls: number;
    groundedCalls: number;
    totalServerMs: number;
  };
  /**
   * Fler försök kan ännu förbättra den här annonsen.
   *
   * Fas 2 publicerar FÖRSTA svaret direkt och fortsätter söka i bakgrunden — utan det här fältet vet
   * klienten inte skillnad på "det här är svaret" och "det här är svaret så här långt", och slutar
   * därför polla på det första. Mätt på ett skarpt jobb: säljaren fick "Kunde inte beläggas mot
   * källor" på skärmen medan servern en stund senare hade fem källor och alla fyra måtten sparade i
   * jobbet. Rätt svar fanns, det nådde bara aldrig fram.
   */
  improving?: boolean;
  /**
   * Var specifikationernas underlag kom ifrån.
   *
   * `reusedPrior` betyder att fas 2:s egen sökning gav noll och att identifieringens källor trädde in
   * i stället. Utan det här går det inte att skilja "hittade själv" från "ärvde", och då går det
   * heller inte att mäta om återanvändningen hjälper.
   */
  provenance?: {
    researchForm: "full" | "plain";
    researchFormHit: "full" | "plain" | "none";
    reusedPrior: boolean;
    priorSources: number;
    sources: number;
  } | null;
  latencyMs: number;
}

/** En modellkandidat ur identifieringen. Samma form som landningssidans SellerProductCandidate. */
export interface ModelCandidate {
  brand: string;
  model: string;
  variant: string | null;
  productType: string | null;
  confidence: "strong" | "likely" | "possible";
  /** Kort text som skiljer kandidaterna åt, t.ex. "hög rygg, teakstomme". */
  distinguishingDetail: string | null;
  /**
   * Produktbild, hämtad ur den källa den grundade sökningen pekade ut.
   *
   * `undefined` = letar fortfarande, `null` = ingen bild hittades. Fylls i EFTER att kandidaterna
   * redan visats, så väljarskärmen dyker upp lika snabbt som förut och bilderna tonar in.
   */
  /** Produktsida modellen påstår sig ha sett. Verifieras genom hämtning, aldrig betrodd rakt av. */
  sourceUrl?: string | null;
  imageUrl?: string | null;
  /** Sidan bilden kom från, så påståendet går att kontrollera. */
  imageSource?: string | null;
}

/**
 * Var identifieringen står.
 *
 * `needs_selection` är inte ett fel utan hela poängen: tvetydighet mellan VERKLIGA produkter lämnas
 * till säljaren i stället för att slås ut med fler modellanrop. Bryggan behandlade det tidigare som
 * ett misslyckande, så just det fall kandidatflödet finns för visade "Annonsen kunde inte skapas".
 */
export type IdentityStatus = "identifying" | "needs_selection" | "resolved" | "unavailable";

/**
 * Tillverkarens produktbild av modellen — truth-cardets omslag.
 *
 * Möbeln framifrån mot vit bakgrund, hämtad ur en produktsida som nämner modellen vid namn. Den visar
 * en NY exemplar av modellen, inte den som säljs: därför är den omslag och aldrig underlag för
 * skicket, som har sin egen bild i renderingen och i skickrapporten.
 */
export interface ProductImage {
  url: string;
  /** Sidan bilden hämtades från, så påståendet går att kontrollera. */
  sourceUrl: string | null;
}

export interface ConditionResult {
  jobId: string;
  createdAt: string;
  identity: FurnitureIdentity | null;
  price: PriceEstimate | null;
  /**
   * true medan andrabesiktningen fortfarande kör. Resultatet är giltigt och visas — fynden står som
   * de rapporterades — men listan kan ännu ändras när granskningen landar.
   */
  reviewPending: boolean;
  /**
   * Om andrabesiktningen faktiskt kördes. Kortet är ett attest och ska kunna säga vad det bygger på —
   * en (1) besiktning eller två — i stället för att låta läsaren anta det starkare alternativet.
   */
  reviewed: boolean;
  /** modell, specifikationer och annonstext — null bara när inget märke angavs */
  listing: ListingResult | null;
  coverage: CoverageState;
  coverageNote: string | null;
  grade: GradeExplanation | null;
  damages: Damage[];
  overallCondition: OverallCondition | null;
  images: CapturedImage[];
  /**
   * Vilken bild som representerar möbeln — omslag på Tradera, miniatyr på startsidan, typunderlag
   * till prismotorn. Aldrig bara `images[0]`: bildrutorna ligger i filmningsordning och den första
   * är ofta kameran innan den exponerat. Se pipeline/cover.ts.
   */
  coverImageId: string | null;
  /**
   * Omslaget: produktbilden av modellen, mot vit bakgrund och framifrån. null när ingen källa gick
   * att belägga — då får renderingen stå som kortets bild i stället.
   */
  productImage: ProductImage | null;
  modelUsed: string;
  tokensUsed: number;
  costUsd: number;
  geminiCallCount: number;
  latencyMs: number;
}

export type AnalysisStage = "queued" | "preparing" | "inspecting" | "verifying" | "grading" | "pricing" | "done" | "error";

export interface JobProgress {
  stage: AnalysisStage;
  message: string;
}

/**
 * En genomförd sänkning. `at` är när den faktiskt gick igenom hos Tradera, inte när den var planerad.
 */
export interface PriceDrop {
  at: string;
  from: number;
  to: number;
}

/**
 * Prisstegen: säljarens spann, och vandringen ner genom det.
 *
 * Prismotorn svarar med tre tal — säljs snabbt, förslag, säljs långsamt. Vilket av dem som är RÄTT
 * beror på något motorn inte kan veta: hur bråttom säljaren har. Stegen låter dem svara på det i
 * stället. De sätter ett startpris och ett golv, och annonsen går själv ner genom spannet med
 * `weeklyDropPct` i veckan tills den når golvet, där den stannar.
 *
 * `currentPrice` är sanningen om vad som ligger uppe just nu, INTE en härledning ur startpris och
 * antal veckor: en sänkning som Tradera avvisade får inte se ut som om den gick igenom.
 */
export interface PriceLadder {
  /** Vad annonsen läggs upp med. */
  startPrice: number;
  /** Golvet. Sänkningen stannar här och går aldrig under. */
  floorPrice: number;
  /** Andel av priset som faller varje vecka. 0.15 = 15 %. */
  weeklyDropPct: number;
  /** Priset som ligger på Tradera nu. Före publiceringen är det startpriset. */
  currentPrice: number;
  /** När nästa sänkning ska ske. null innan annonsen är publicerad och när golvet är nått. */
  nextDropAt: string | null;
  drops: PriceDrop[];
  /** Sätts när golvet nåtts. Då är stegen färdig och priset ligger kvar. */
  floorReachedAt: string | null;
  /** Senaste sänkningen Tradera avvisade — sparad för att kunna säga varför priset står stilla. */
  lastError: string | null;
  chosenAt: string;
  /**
   * Annonstypen sänkningen ska adressera: utropspris eller Köp Nu. Sätts vid publiceringen och läses
   * inte ur miljön vid sänkningen — TRADERA_LISTING_MODE kan ha ändrats sedan annonsen lades upp, och
   * då hade vi skrivit fel fält på en annons som redan ligger uppe.
   */
  listingMode: "auction" | "fixed" | null;
}

/**
 * Var publiceringen till Tradera står. Saknas fältet har jobbet aldrig publicerats — det är inte
 * samma sak som ett misslyckat försök, och knappen ska se olika ut i de två fallen.
 */
export interface TraderaPublication {
  status: "publishing" | "published" | "error";
  requestId: number | null;
  itemId: number | null;
  url: string | null;
  error: string | null;
  startedAt: string;
  publishedAt: string | null;
}

/** Vad som KOMMER att publiceras. Visas i bekräftelsesteget så säljaren ser det innan de trycker. */
export interface TraderaPlan {
  title: string;
  /** Truth-cardets publika ID. Står i annonstexten och är köparens väg tillbaka till kortet. */
  loopaId: string;
  categoryId: number;
  categoryName: string;
  /** Vad KÖPAREN betalar: möbeln plus hemleveransen. Inget tillkommer i Traderas kassa. */
  price: number;
  /** Möbelns andel av priset — den prisstegen sänker. */
  itemPrice: number;
  /** Fraktens andel. Står stilla hela vägen ner; kommer från servern så beloppet bara finns på ett ställe. */
  shippingSek: number;
  priceSource: "seller" | "condition" | "listing";
  condition: string | null;
  imageCount: number;
  /** "fixed" = Endast Köp Nu till `price`. "auction" = utropspris `price`, inget Köp Nu. */
  mode: "auction" | "fixed";
  /** Bara satt för auktion — Traderas Köp Nu-annonser får sin längd av Tradera, inte av oss. */
  durationDays: number | null;
}

/** Svaret från GET/POST /api/jobs/:id/tradera. */
export interface TraderaState {
  configured: boolean;
  missingEnv: string[];
  publication: TraderaPublication | null;
  plan: TraderaPlan | null;
  blockedReason: string | null;
  /** Säljarens prisspann, när det är satt. Driver både bekräftelsesteget och den publicerade vyn. */
  ladder: PriceLadder | null;
}

export interface ConditionJob {
  id: string;
  /**
   * Truth-cardets publika ID, LP-XXXX-XXXX. Sätts av servern i svaret, inte i jobbet: det är härlett
   * ur id:t. Saknas i äldre svar och i jobb klienten byggt själv.
   */
  loopaId?: string;
  createdAt: string;
  progress: JobProgress;
  result: ConditionResult | null;
  error: string | null;
  productContext: string | null;
  identity: FurnitureIdentity | null;
  /** bildrutorna jobbet skapades med — det ett omtag spelar upp igen */
  images?: CapturedImage[];
  /** Var modellidentifieringen står. Driver kandidatskärmen. */
  identityStatus?: IdentityStatus;
  /** Upp till fyra troliga modeller av märket, bäst först. */
  candidates?: ModelCandidate[];
  /** Den säljaren valde, eller den identifieringen kunde avgöra själv. */
  selected?: ModelCandidate | null;
  identityError?: string | null;
  /** Grundat underlag från identifieringen, återanvänt av specifikationssteget. */
  identityResearch?: { researchText: string; sources: Array<{ title: string; url: string; qualityTier?: 1 | 2 | 3 }> } | null;
  /** När nuvarande fas började — för fasloggningen. */
  phaseStartedAt?: number;
  /** Annonsen när den blev klar före skickresultatet — flyttas in i resultatet när det finns. */
  pendingListing?: ListingResult | null;
  /** Annonsen på Tradera, när säljaren valt att publicera den dit. */
  tradera?: TraderaPublication | null;
  /**
   * Säljarens prisspann och den veckovisa sänkningen genom det. Saknas fältet är priset fast: ett
   * jobb från före stegen ska inte börja sjunka av sig självt.
   */
  priceLadder?: PriceLadder | null;
  /** Supabase-användaren som skapade jobbet. Det är den profilen truth-cardet sparas i. */
  ownerId?: string | null;
}

export interface JobSummary {
  id: string;
  /** Truth-cardets publika ID, LP-XXXX-XXXX. */
  loopaId: string;
  createdAt: string;
  progress: JobProgress;
  grade: GradeExplanation | null;
  identity: FurnitureIdentity | null;
  price: PriceEstimate | null;
  thumbnailImageId: string | null;
  /** Kortets omslag, samma produktbild som ligger överst på truth-cardet. Miniatyren faller tillbaka
      på `thumbnailImageId` när den saknas. */
  coverImageUrl: string | null;
  error: string | null;
  /** Om annonsgeneratorn hann bli klar — det är det som gör jobbet till ett truth-card. */
  hasTruthCard: boolean;
  /** Den genererade annonsrubriken, som den står på kortet. Bättre listrad än märke + modell. */
  listingTitle: string | null;
}

// ---- adminpanelen (GET /api/admin/users) ----

/** Ett konto som det står i adminpanelen: vem det är, och vad de har lagt upp. */
export interface AdminUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Allt kontot startat, inklusive det som föll. */
  jobCount: number;
  /** Så många av dem som blev truth-cards — de som går att öppna. */
  cardCount: number;
  totalValue: number;
  lastActivity: string | null;
  /** När kontot registrerades. Null när varken Supabase eller jobben kan säga det. */
  signedUpAt: string | null;
  /** true = datumet är kontots första jobb och inte registreringen. Panelen skriver ut skillnaden. */
  signupApproximate: boolean;
}

/**
 * Varifrån namnen kom, och därmed hur fullständig listan är.
 *
 * `service` = hela användarlistan ur Supabase. `profiles` = de profiler adminens egen token får läsa.
 * `jobs` = ingendera gick att nå, så bara konton som syns i jobben finns med. Panelen skriver ut
 * skillnaden i stället för att låta en ofullständig lista se komplett ut.
 */
export type AdminDirectory = "service" | "profiles" | "jobs";

export interface AdminUsers {
  /** Bara konton som registrerade sig idag eller igår — det panelen finns för att visa. */
  users: AdminUser[];
  directory: AdminDirectory;
  /** Hur många konton som finns totalt, så vyn kan säga vad urvalet döljer. */
  total: number;
  /** Fönstrets början: igår 00:00, serverns lokala tid. */
  since: string;
}

// ---- publikt truth-card (GET /api/cards/:loopaId) ----

/**
 * Skadan som den står på ett publikt kort: platsen, allvaret och beskrivningen — inte bevisbilderna
 * och inte säljarens granskningsläge. Ett eget, smalare snitt av `Damage`, så vyn kan rita både det
 * inloggade kortet och det publika ur samma props.
 */
export type CardDamage = Pick<
  Damage,
  "id" | "type" | "part" | "semanticLocation" | "severity" | "impact" | "description"
>;

/** Priset som kortet visar det. `PriceEstimate` passar in här som den är. */
export interface CardPrice {
  status: "ok" | "no_data" | "unavailable";
  low: number | null;
  default: number | null;
  high: number | null;
  currency: "SEK";
  damageDeduction: number | null;
  unavailableReason: string | null;
}

/** Allt kortvyn ritar. Byggs antingen ur ett eget ConditionResult eller ur ett publikt kort. */
export interface TruthCardData {
  card: GeneratedListing;
  identity: FurnitureIdentity | null;
  grade: GradeExplanation | null;
  price: CardPrice | null;
  damages: CardDamage[];
  /** Hur många vyer besiktningen såg. Bildrutorna själva är aldrig publika. */
  imageCount: number;
  reviewed: boolean;
  productImage: ProductImage | null;
}

/** Svaret från GET /api/cards/:loopaId — truth-cardet som vem som helst med ID:t kan läsa. */
export interface PublicCard extends TruthCardData {
  loopaId: string;
  createdAt: string;
  tradera: { status: string; url: string | null } | null;
}

/**
 * Vad ett chattsvar står på.
 *
 * `card` = det står på truth-cardet. `general` = allmän möbelkunskap som INTE är besiktad för just
 * den här möbeln. Skillnaden skrivs ut i chatten: ett kort vars svar inte går att skilja åt är
 * tillbaka på att vara ett påstående. Se server/src/cardChat.ts.
 */
export type AnswerSource = "card" | "general" | "unknown";

/** Svaret från POST /api/cards/:loopaId/chat. */
export interface CardAnswer {
  answer: string;
  source: AnswerSource;
}

// ---- debug trace (GET /api/jobs/:id/debug) ----

export interface CallMeta {
  purpose: string;
  tokensUsed: number;
  cached: boolean;
  modelUsed: string;
  latencyMs: number;
}

export interface PartInspection {
  part: string;
  visible: boolean;
  defectsFound: number;
}

export interface DebugTrace {
  jobId: string;
  defectFamiliesChecked: DamageType[];
  rawDefects: Damage[];
  partsInspected?: PartInspection[];
  /** Post-verification, pre-dedup — what dedupeDamages actually received. */
  verifiedDefects: Damage[];
  verifiedIds: string[];
  rejectedByVerification: Damage[];
  confirmedFindings: Damage[];
  dedupBefore: number;
  dedupAfter: number;
  overallCondition: OverallCondition | null;
  gradeTrace: string[];
  geminiCalls: CallMeta[];
  totalLatencyMs: number;
}
