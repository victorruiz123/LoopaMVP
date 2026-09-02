/**
 * Trygg affär — affärsrummet mellan en köpare och en säljare.
 *
 * VAD DET ÄR: en köpare har hittat en möbel någon annanstans (Blocket, Facebook, en kompis) och vill
 * göra affären genom oss i stället för att mötas med kontanter. De tar med sig annonsen hit, får en
 * preliminär bedömning, och bjuder in säljaren. Säljaren filmar möbeln, vi granskar den på riktigt,
 * båda godkänner priset, köparen betalar, vi hämtar och kör hem, köparen kvitterar och säljaren får
 * betalt.
 *
 * VAD DET INTE ÄR: en marknadsplats. Affärsrummet är privat mellan två parter, det går inte att
 * bläddra i, och listningen som skapas i det ska ALDRIG hamna i Butik eller på Tradera. Se
 * `excludedFromButik` nedan — det är inte en inställning utan en konstruktionsregel, och den finns
 * för att butikens egen `syncFromJobs` annars plockar upp varje besiktigat jobb med pris och märke.
 *
 * VEM SOM KONTAKTAR VEM: vi kontaktar aldrig säljaren. Köparen får en färdig text att klistra in
 * själv i Blockets chatt. Allt vi gör är att äga länken de skickar.
 */

import type { ConditionGrade } from "../types.js";

/**
 * Affärens gång, från köparens första klick till säljarens utbetalning.
 *
 * Ordningen är inte en uppräkning utan ett kontrakt: varje steg har någon som väntar på något, och
 * det är därför övergångarna står i en tabell och inte i en if-kedja utspridd i sju filer.
 */
export type DealState =
  /** Köparen har en preliminär bedömning och ett affärsrum, men har inte bjudit in någon än. */
  | "created"
  /** Inbjudan är hämtad av köparen. Klockan börjar ticka — se EXPIRY. */
  | "invited"
  /** Säljaren har öppnat länken OCH skapat konto. Att bara öppna räknas inte. */
  | "seller_joined"
  /** Säljaren har filmat och besiktningen är klar. Nu finns ett verifierat skickkort. */
  | "scanned"
  /** Ett pris ligger på bordet och väntar på motpartens svar. */
  | "price_pending"
  /** Båda har accepterat. Priset är låst. */
  | "price_agreed"
  /** Köparen har betalat. Pengarna hålls — se checkout i steg 6. */
  | "paid"
  | "pickup_booked"
  | "picked_up"
  | "delivered"
  /** Köparen har kvitterat, eller 24 timmar har gått. */
  | "approved"
  /** Säljaren har fått sina pengar. Slutstation. */
  | "paid_out"
  /** Någon av parterna backade ur. Slutstation. */
  | "declined"
  /** Tiden gick ut utan svar. Slutstation. */
  | "expired";

/**
 * Vad som får hända härnäst.
 *
 * `declined` och `expired` går att nå från varje läge FÖRE betalningen och från inget efter den:
 * när pengar bytt händer räcker det inte att någon ändrar sig, då är det en tvist och den går genom
 * ops. Se `CANCELLABLE`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DealState, readonly DealState[]>> = {
  created: ["invited", "declined", "expired"],
  invited: ["seller_joined", "declined", "expired"],
  seller_joined: ["scanned", "declined", "expired"],
  scanned: ["price_pending", "declined", "expired"],
  price_pending: ["price_agreed", "price_pending", "declined", "expired"],
  price_agreed: ["paid", "declined", "expired"],
  paid: ["pickup_booked"],
  pickup_booked: ["picked_up"],
  picked_up: ["delivered"],
  delivered: ["approved"],
  approved: ["paid_out"],
  paid_out: [],
  declined: [],
  expired: [],
};

export function canTransition(from: DealState, to: DealState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * `price_pending -> price_pending` är inte ett stavfel.
 *
 * Ett motbud byter inte tillstånd — det byter VEM som väntar. Briefen tillåter exakt en runda, och
 * det räknas i `Deal.counterRounds` snarare än i tillståndet, för annars hade maskinen behövt ett
 * läge per runda och regeln "en runda" hade legat i formen i stället för i en siffra man kan läsa.
 */
export const MAX_COUNTER_ROUNDS = 1;

/** Lägen där affären fortfarande går att avbryta utan att pengar är inblandade. */
export const CANCELLABLE: readonly DealState[] = [
  "created", "invited", "seller_joined", "scanned", "price_pending", "price_agreed",
];

/** Lägen som är slut. Ingenting händer mer av sig självt. */
export const TERMINAL: readonly DealState[] = ["paid_out", "declined", "expired"];

/**
 * När ett läge går ut av sig självt.
 *
 * Bara två lägen har en klocka, och båda är lägen där NÅGON ANNAN förväntas göra något: en inbjudan
 * som ingen svarat på, och ett pris ingen tagit ställning till. Övriga lägen väntar på oss eller på
 * en leverans, och en affär ska inte dö för att budfirman var sen.
 */
export const EXPIRY: Partial<Record<DealState, number>> = {
  invited: 7 * 24 * 60 * 60 * 1000,
  price_pending: 72 * 60 * 60 * 1000,
};

/** Vem som utlöste en övergång. Loggas på varje händelse — se DealEvent. */
export type DealActor =
  | { kind: "buyer"; userId: string }
  | { kind: "seller"; userId: string | null }
  | { kind: "system"; job: string }
  | { kind: "ops"; userId: string | null };

export interface DealEvent {
  id: string;
  dealId: string;
  from: DealState | null;
  to: DealState;
  at: string;
  actor: DealActor;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Köparens annonsunderlag
// ---------------------------------------------------------------------------

/**
 * Varifrån annonsinnehållet kom.
 *
 * Två adaptrar bakom ETT gränssnitt, och allt nedströms ska vara omedvetet om vilken som svarade.
 * Det är inte en abstraktion för sakens skull: `LINK_FETCH` hämtar en främmande sida på vår server,
 * vilket är ett helt annat rättsligt och tekniskt läge än att en köpare laddar upp sina egna
 * skärmbilder. Skillnaden ska gå att slå av och på utan att bedömningen nedströms ändrar form.
 */
export type AdSourceKind = "MANUAL_CONTENT" | "LINK_FETCH";

/**
 * Det köparen lämnade in, normaliserat.
 *
 * PERSONUPPGIFTER ÄR REDAN BORTA när ett värde av den här typen finns. Maskningen sker vid intaget,
 * före lagring, inte vid visning — se `maskPersonalData`. En annons innehåller säljarens namn och
 * ofta ett telefonnummer, och de har ingenting i vår analys att göra.
 */
export interface AdSubmission {
  source: AdSourceKind;
  /**
   * Adressen till annonsen. REFERENS, inte en resurs att hämta.
   *
   * Med MANUAL_CONTENT rör servern den aldrig — den är köparens egen anteckning om var möbeln stod,
   * och det som gör att de känner igen sin affär. Att lagra den är inte samma sak som att besöka den.
   */
  adUrl: string | null;
  /** Bilder köparen laddat upp, som relativa sökvägar i affärens egen mapp. Aldrig i jobbmappen. */
  imagePaths: string[];
  /** Annonstexten, maskad. */
  description: string | null;
  /** Vad säljaren begär. Null när köparen inte angav något. */
  askingPriceSek: number | null;
  submittedAt: string;
}

/**
 * Vår slutsats om annonsen — det ENDA vi sparar långsiktigt.
 *
 * Briefen är tydlig: köparens uppladdade annonsinnehåll ska inte bevaras utöver vad köparen själv
 * behöver se. Det här är alltså inte en kopia av annonsen utan vad vi kom fram till om den, och det
 * är den skillnaden som gör att bilderna kan städas bort utan att affären tappar sitt underlag.
 */
export interface PreliminaryAssessment {
  /** Vad vi tror att det är. Null när bilderna inte räckte. */
  brand: string | null;
  model: string | null;
  categorySlug: string | null;
  /**
   * Möbeln i ETT ord, som modellen själv beskrev den: "soffa", "matbord", "barstol".
   *
   * Skilt från `categorySlug`, som är en av åtta hyllor. Slugen duger till att filtrera på men inte
   * att skriva i en mening: köparens meddelande till säljaren blev "Jag vill gärna köpa din soffor
   * & fåtöljer". Det här är ordet som ska stå i texten.
   */
  categoryNoun: string | null;
  /** Uppskattat skick. ALLTID med förbehåll — se `confidence`. */
  grade: ConditionGrade | null;
  /** Kort, läsbar sammanfattning av skicket som det ser ut på annonsens bilder. */
  gradeNote: string | null;
  /** Synliga fel vi tycker oss se. Formulerade som iakttagelser, aldrig som fynd. */
  observations: string[];
  /** Hur säkert det här är. Styr hur bedömningen får formuleras i gränssnittet. */
  confidence: "low" | "medium" | "high";
  /** Prismotorns spann för modellen i det uppskattade skicket. */
  marketLowSek: number | null;
  marketHighSek: number | null;
  /** Frågor köparen bör ställa säljaren, härledda ur det vi INTE kunde se. */
  questions: string[];
  /** Varningar: katalogbilder, pris som är för bra, kategorier med känd risk. */
  redFlags: string[];
  assessedAt: string;
}

// ---------------------------------------------------------------------------
// Affären
// ---------------------------------------------------------------------------

/**
 * Ett prisförslag och vem som lade det.
 *
 * `loopa` är inte en tredje part i affären utan prismotorns förslag, och det är med flit det FÖRSTA
 * som ligger på bordet. Alternativet vore att någon av parterna måste namnge en siffra först, och den
 * som gör det i en förhandling förlorar — köparen som säger för mycket, säljaren som säger för lite.
 * Ett räknat utgångsbud som båda kan säga ja eller nej till tar bort det taktiska momentet ur en
 * affär som inte handlar om att förhandla.
 */
export interface PriceProposal {
  amountSek: number;
  by: "buyer" | "seller" | "loopa";
  at: string;
  /** Varför beloppet ser ut som det gör. Skrivs ut för båda parter — se price.ts. */
  rationale: string | null;
}

export interface Deal {
  id: string;
  /**
   * Inbjudningslänkens hemlighet. Den ENDA nyckeln till säljarens vy.
   *
   * Måste vara ogissbar: den ger tillgång utan inloggning, vilket är hela poängen — säljaren ska
   * kunna titta innan de bestämmer sig för att skapa konto. Se `makeInviteToken`.
   */
  inviteToken: string;
  state: DealState;

  buyerId: string;
  buyerEmail: string | null;
  /** Sätts när säljaren skapat konto. Att öppna länken räcker inte. */
  sellerId: string | null;
  sellerEmail: string | null;

  /** Vad köparen lämnade in. Nollställs när bilderna städats — se retention. */
  submission: AdSubmission | null;
  assessment: PreliminaryAssessment | null;

  /**
   * Säljarens besiktning. Jobb-id i den vanliga pipelinen.
   *
   * Jobbet är märkt med affärens id (se ConditionJob.dealId) och hålls därmed UTANFÖR Butik och
   * utanför det publika kortet. Utan den märkningen hade en affärsskanning dykt upp till försäljning
   * i butiken och blivit läsbar på /c/LP-XXXX för vem som helst med id:t.
   */
  scanJobId: string | null;

  /** Priserna, i den ordning de lades. Sista posten är det som gäller just nu. */
  proposals: PriceProposal[];
  /** Vem som ännu inte svarat på det sista förslaget. Null när ingen väntar. */
  awaiting: "buyer" | "seller" | null;
  /**
   * Vilka som accepterat det SENASTE förslaget.
   *
   * Nollställs varje gång ett nytt förslag läggs: ett ja gäller ett belopp, inte en affär. Utan
   * nollställningen skulle en accept av Loopas utgångsbud räknas som en accept av motpartens motbud,
   * vilket är att låsa ett pris någon aldrig sagt ja till.
   */
  acceptedBy: Array<"buyer" | "seller">;
  counterRounds: number;
  /** Låst pris. Sätts vid `price_agreed` och ändras aldrig efter det. */
  agreedPriceSek: number | null;

  /** Postnummer för BÅDA parter. Kontrolleras vid affärens start — se delivery.ts. */
  buyerPostalCode: string | null;
  sellerPostalCode: string | null;

  orderId: string | null;

  createdAt: string;
  updatedAt: string;
  /** När nuvarande läge går ut. Null i lägen utan klocka. */
  expiresAt: string | null;
  /** Sant när köparen skickat sin enda tillåtna påminnelse. */
  reminderSent: boolean;
}

/** Affären som säljaren ser den innan de skapat konto. Inga personuppgifter om köparen. */
export interface PublicInvite {
  token: string;
  state: DealState;
  /** Vad köparen vill köpa, i klartext: "en soffa", "ett matbord". */
  what: string;
  askingPriceSek: number | null;
  /** Köparens bud, när det skiljer sig från det begärda. */
  offeredPriceSek: number | null;
  expiresAt: string | null;
  /** Sant när inbjudan inte längre går att anta. */
  closed: boolean;
}
