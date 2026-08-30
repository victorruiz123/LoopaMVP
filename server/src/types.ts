// Condition Grading engine — public contract.
// Kept deliberately independent: no imports from Visual Discovery / Pricing / matcher code.

export type DamageType =
  // surface damage
  | "scratch"
  | "scuff"
  | "abrasion"
  | "chip"
  | "dent"
  | "crack"
  | "tear"
  | "hole"
  // color / contamination
  | "stain"
  | "discoloration"
  | "fading"
  | "rust"
  | "corrosion"
  // material wear
  | "pilling"
  | "worn_material"
  | "fraying"
  | "compressed_upholstery"
  | "peeling_flaking"
  // shape / structure
  | "deformation"
  | "loose_component"
  | "broken_component"
  | "missing_part"
  | "sagging"
  | "structural_damage"
  // catch-all for a locally visible but non-specific worn patch
  | "general_wear"
  | "other";

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

/** One image sent into the inspection: either a client-selected video frame or a manually captured/uploaded photo. */
export interface CapturedImage {
  id: string;
  /** client-assigned, for display only (e.g. "Framifrån", "Höger sida", "Närbild") — never used for grading logic */
  viewLabel: string | null;
  source: "video" | "manual";
  width: number;
  height: number;
  /** relative path under the job's data dir, e.g. "originals/img_0.jpg" */
  path: string;
  capturedAt: string;
}

/** A region of interest on one evidence image, normalized to [0,1] against that image's natural size. */
export interface EvidenceMark {
  kind: "box" | "line";
  /** box: x,y,w,h normalized 0-1. line: x1,y1,x2,y2 normalized 0-1 (box fields unused). */
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
  /** relative path to a high-res crop generated from the ORIGINAL image, if produced during verification */
  cropPath?: string;
}

/** One PHYSICAL defect — may carry multiple evidence entries if seen in more than one supplied image. */
export interface Damage {
  id: string;
  type: DamageType;
  part: string;
  /** finer-grained location within the part, used to tell two distinct defects on the same part apart */
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
  /** 0-100 */
  confidence: number;
  verification: VerificationState;
  verificationReason: string;
  evidence: DamageEvidence[];
  recaptureRequested: boolean;
  /** seller review state, mutated via correction endpoints; null = untouched */
  sellerAction: "confirmed" | "rejected" | "corrected" | null;
  /** true if this entry was added manually by the seller rather than detected */
  sellerAdded: boolean;
}

export type WearLevel = "minimal" | "light" | "moderate" | "heavy" | "severe";
export type AffectedExtent = "isolated" | "moderate" | "widespread";

/** Holistic, non-localized visible-condition read, produced by the SAME main inspection call. */
export interface OverallCondition {
  overallWearLevel: WearLevel;
  affectedExtent: AffectedExtent;
  functionalityAffected: boolean;
  structuralIntegrityOk: boolean;
  clearlyUsedAppearance: boolean;
  observations: string[];
}

/** One row of the inspection sweep: the model must account for every part, damaged or not. */
export interface PartInspection {
  part: string;
  visible: boolean;
  defectsFound: number;
}

export type AnalysisStage = "queued" | "preparing" | "inspecting" | "verifying" | "grading" | "pricing" | "done" | "error";

export interface JobProgress {
  stage: AnalysisStage;
  message: string;
}

/** Vips' canonical public-facing condition strings — must match CLAUDE.md exactly. */
export type CanonicalCondition = "Nyskick" | "Mycket bra skick" | "Bra skick" | "Okej skick";

export interface GradeExplanation {
  grade: ConditionGrade;
  canonicalCondition: CanonicalCondition;
  /** Loopa's own richer label, e.g. "Gott begagnat skick" — shown big in the seller report */
  label: string;
  /** ONE short, seller-facing sentence (max ~2) explaining the grade. This is what the UI shows. */
  rationale: string;
  /** longer bullet trace, debug-only, never shown in the seller report */
  reasons: string[];
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
  /**
   * Måtten och materialet som stod på den sidan, lästa ur dess HTML.
   *
   * Hämtningen är redan gjord för bildens skull och sidan är redan kontrollerad mot modellnamnet, så
   * de här värdena kostar varken ett anrop eller en sekund. De fyller annonsens luckor när den
   * grundade sökningen kom tillbaka utan källor — mätt på 78 skarpa annonser hade 26 noll källor, och
   * 25 av dem saknade mått helt. Se specHarvest.ts.
   */
  pageSpecs?: ListingAttribute[] | null;
}

/**
 * Var identifieringen står.
 *
 * `needs_selection` är inte ett fel utan hela poängen: tvetydighet mellan VERKLIGA produkter lämnas
 * till säljaren i stället för att slås ut med fler modellanrop. Bryggan behandlade det tidigare som
 * ett misslyckande, så just det fall kandidatflödet finns för visade "Annonsen kunde inte skapas".
 */
export type IdentityStatus = "identifying" | "needs_selection" | "resolved" | "unavailable";

/** What the seller typed before filming. The price engine needs a name to search the corpus for. */
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
  /** "table" | "estimated_repair" | "below_materiality" | "no_valuation" — how it was valued, or why it was not */
  source: string | null;
  description: string | null;
  location: string | null;
  count?: number;
}

/**
 * The price half of the report. Always present once an identity was given, even when there is no
 * number: `status` says which of the three cases this is, and the seller-facing text explains it.
 */
export interface PriceEstimate {
  /** ok = a range; no_data = engine ran but found nothing comparable; unavailable = engine not reached */
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
  /** total deduction actually applied for the findings, as a share of the undamaged base */
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
  /**
   * Sant när värdet är UPPSKATTAT och inte en uppgift om just den här möbeln.
   *
   * Sätts bara för mått, och bara när ingen källa gav några: annonsgeneratorn fyller på med typiska
   * mått för möbeltypen hellre än att lämna annonsen utan ett enda tal (se
   * loopa-landing-page-main/functions/api/_shared/seller-typical-dimensions.ts). Ett uppskattat mått
   * räknas aldrig som belagt — det skrivs med "ca", håller statusen kvar på "delvis belagt" och
   * ersätts av det första riktiga måttet som dyker upp, till exempel ur sidskörden.
   */
  estimated?: boolean;
}

export interface ListingSource {
  title: string;
  url: string;
  qualityTier?: 1 | 2 | 3;
}

/**
 * Annonsgeneratorns svar, som det kommer ur loopa-landing-page-main. Bara de fält annonsen visar
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
  /**
   * Generatorns egna markeringar för steg som föll: "research_failed", "structure_failed",
   * "model_overloaded", "research_ungrounded". Inte till för säljaren att läsa — de är skillnaden
   * mellan "vi sökte och hittade inget" och "ingen sökning blev av", och det är en skillnad säljaren
   * måste få veta. Se runIdentify i pipeline/identify.ts.
   */
  warnings?: string[];
}

/** Annonsens halva av rapporten. Alltid satt när ett märke fanns, även när den inte gick att nå. */
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

/**
 * Tillverkarens produktbild av modellen — annonsens omslag.
 *
 * Hämtas ur samma källor som kandidatbilderna (se candidateImages.ts): en produktsida vars titel
 * eller adress nämner modellen, och dess og:image. Sådana bilder är nästan undantagslöst möbeln
 * framifrån mot vit bakgrund, vilket är precis vad ett omslag ska vara.
 *
 * Den visar en NY exemplar av modellen, inte den som säljs — därför står den som omslag och aldrig
 * som underlag för skicket. Skadorna sitter kvar på renderingen i skickrapporten, där de hör hemma.
 */
export interface ProductImage {
  url: string;
  /** Sidan bilden hämtades från, så påståendet går att kontrollera. */
  sourceUrl: string | null;
}

/**
 * Omslaget: säljarens egen bildruta, urklippt och lagd på vitt.
 *
 * Filen ligger som `cover/cover.jpg` i jobbmappen och serveras på /api/jobs/:id/cover — posten här
 * säger bara ATT den finns, och ur vilken bildruta. Se pipeline/cutout.ts för hur den byggs och
 * varför den hellre uteblir än blir halv.
 */
export interface CoverCutout {
  /** Bildrutan urklippet är gjort ur — samma som `coverImageId` när det gick. */
  sourceImageId: string;
  /** Vad modellen kallade möbeln när den pekade ut den. Bara för loggen. */
  label: string | null;
  createdAt: string;
}

export interface ConditionResult {
  jobId: string;
  createdAt: string;
  /** brand + model as the seller typed them; null when the scan was started without them */
  identity: FurnitureIdentity | null;
  /** null only when no identity was given — otherwise always set, possibly to a status that has no number */
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
   * Omslaget: tillverkarens produktbild av modellen, mot vit bakgrund och framifrån.
   *
   * Skild från `coverImageId`, som pekar ut en av säljarens EGNA bildrutor. Den bilden är fortfarande
   * det som representerar möbeln där skicket är poängen — miniatyr, Tradera, prismotorn. Omslaget är
   * det som representerar MODELLEN, och är null när ingen källa gick att belägga.
   */
  productImage: ProductImage | null;
  /**
   * Säljarens egen möbel, urklippt mot vitt — kortets omslag när den finns.
   *
   * Går före `productImage`: katalogbilden visar en ny exemplar av modellen, den här visar möbeln
   * som faktiskt säljs. Null betyder att urklippet inte gjordes eller inte dög, och då visar kortet
   * bildrutan som den är.
   */
  coverCutout: CoverCutout | null;
  modelUsed: string;
  tokensUsed: number;
  costUsd: number;
  geminiCallCount: number;
  latencyMs: number;
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
 * Var publiceringen till Tradera står. Sätts först när säljaren tryckt på knappen — ett jobb utan
 * `tradera` har aldrig publicerats och ska inte se ut som ett misslyckat försök.
 */
export interface TraderaPublication {
  status: "publishing" | "published" | "error";
  /** Traderas kö-id. Finns bara i loggen och i felsökning — annonsen adresseras med itemId. */
  requestId: number | null;
  itemId: number | null;
  url: string | null;
  error: string | null;
  startedAt: string;
  publishedAt: string | null;
}

export interface ConditionJob {
  id: string;
  createdAt: string;
  /**
   * Supabase-användaren som skapade jobbet — profilen annonsen sparas i.
   *
   * Sätts EN gång, när filmningen laddas upp, och läses bara av listningen. Pipelinen ser den aldrig.
   * Valfri: jobb från före inloggningen saknar den, och de ska fortsätta gå att öppna.
   */
  ownerId?: string | null;
  progress: JobProgress;
  result: ConditionResult | null;
  error: string | null;
  /** optional free-text product context (name/category) the caller may supply; grading must work without it */
  productContext: string | null;
  /** what the seller typed on the start screen — carried so a re-price after a correction has it */
  identity: FurnitureIdentity | null;
  /**
   * The curated frames, stored at CREATION time rather than only in the finished result.
   *
   * A run that dies upstream — Gemini 503/504 — used to take the walkaround with it: the files stayed
   * on disk but nothing recorded which they were, so the only way forward was to film again. They are
   * what a retry replays.
   */
  images?: CapturedImage[];
  /** Var modellidentifieringen står. Driver kandidatskärmen. */
  identityStatus?: IdentityStatus;
  /** Upp till fyra troliga modeller av märket, bäst först. */
  candidates?: ModelCandidate[];
  /**
   * Förslagen säljaren redan sett och tackat nej till.
   *
   * Sparas på jobbet och inte i webbläsaren av två skäl: det är den här listan sökningen får med sig
   * som förbudslista vid nästa "hitta nya", och en säljare som laddar om sidan mitt i valet ska inte
   * få tillbaka de fyra de nyss avfärdat.
   */
  rejectedCandidates?: ModelCandidate[];
  /** Hur många gånger säljaren bett om nya förslag. 0 (eller osatt) = den första omgången. */
  candidateRound?: number;
  /** Den säljaren valde, eller den identifieringen kunde avgöra själv. */
  selected?: ModelCandidate | null;
  /**
   * Omslagsbilden, buren på jobbet därför att den kan landa innan skickresultatet finns.
   *
   * Samma skäl som `pendingListing`: identifieringen och besiktningen kör parallellt, och den som
   * blir klar först får inte tappa sitt arbete för att den andra inte är framme. completeJob flyttar
   * in den i resultatet.
   */
  productImage?: ProductImage | null;
  /** Urklippet, buret på jobbet av samma skäl: det blir klart medan säljaren väljer modell. */
  coverCutout?: CoverCutout | null;
  identityError?: string | null;
  /** Grundat underlag från identifieringen, återanvänt av specifikationssteget. */
  identityResearch?: { researchText: string; sources: Array<{ title: string; url: string; qualityTier?: 1 | 2 | 3 }> } | null;
  /** När nuvarande fas började — för fasloggningen. */
  phaseStartedAt?: number;
  /** Annonsen när den blev klar före skickresultatet — flyttas in i resultatet när det finns. */
  pendingListing?: ListingResult | null;
  /**
   * Annonsen, när besiktningen föll men generatorn hann bli klar.
   *
   * De två grenarna är oberoende: annonsgeneratorn behöver bara bildrutorna och märket. Att låta ett
   * Gemini-avbrott i besiktningen kasta en färdig annons vore att slänga arbete som redan är
   * betalt och som säljaren fortfarande har nytta av.
   */
  listing?: ListingResult | null;
  /** Annonsen på Tradera, när säljaren valt att publicera den dit. */
  tradera?: TraderaPublication | null;
  /**
   * Säljarens prisspann och den veckovisa sänkningen genom det. Saknas fältet är priset fast: ett
   * jobb från före stegen ska inte börja sjunka av sig självt.
   */
  priceLadder?: PriceLadder | null;
}

// ---- debug trace (never sent to the normal seller UI; see GET /api/jobs/:id/debug) ----

export interface CallMeta {
  purpose: string;
  tokensUsed: number;
  cached: boolean;
  modelUsed: string;
  latencyMs: number;
}

export interface DebugTrace {
  jobId: string;
  defectFamiliesChecked: DamageType[];
  rawDefects: Damage[];
  /** The model's own account of which parts it swept — a part missing here was never inspected. */
  partsInspected: PartInspection[];
  /** Post-verification, pre-dedup — exactly what dedupeDamages received. This is the freeze point a
   *  recorded test fixture replays from, so it has to be the full list, not just a count. */
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
