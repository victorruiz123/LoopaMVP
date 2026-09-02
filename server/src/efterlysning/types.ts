/**
 * Efterlysningen: vad en köpare letar efter, skrivet en gång och bevakat tills det dyker upp.
 *
 * EN MODELL, TVÅ INGÅNGAR. Butikens `bevakningar` var samma sak i mindre — en sparad sökning som
 * hörde av sig — och ersätts av den här. Skälet att slå ihop dem är inte städning: en efterlysning
 * är ett PÅSTÅENDE OM EFTERFRÅGAN, och två register över samma efterfrågan hade betytt att
 * efterfrågeväggen, säljarkroken och annonsutkasten alla räknar olika.
 *
 * SPECEN ÄR ETT `ProductFilter` PLUS FYRA FÄLT, och inte en egen vokabulär. Butikens filter kan
 * redan kategori, märken, maxpris, max B/D/H, färger, material och betyg — samma ord som rutnätet,
 * AI-sökningen och Tradera-poolen talar. Att uppfinna `maxWidth` bredvid `maxWidthMm` hade gett två
 * sätt att säga samma sak och en dag där de sa olika. De fyra som saknas är sådant en SÖKNING inte
 * behöver men en BEVAKNING gör: stil, deadline, brådska och köparens egen anteckning.
 */

import type { ProductFilter } from "../butik/types.js";

/** Var en träff kom ifrån. Ordningen ÄR rangordningen — se match.ts. */
export type MatchSource = "loopa_live" | "loopa_incoming" | "tradera" | "own_find";

export const SOURCE_RANK: Readonly<Record<MatchSource, number>> = {
  loopa_live: 0,
  loopa_incoming: 1,
  tradera: 2,
  own_find: 3,
};

/**
 * Hur väl en träff sitter.
 *
 * `exact` uppfyller hela specen. `near` bryter mot en MJUK önskan — stil, färg, märke — men aldrig
 * mot en hård gräns. Skillnaden styr två saker: nära-träffar visas i direktsvepet och i veckans
 * digest, men utlöser aldrig en notis. Se `notifiable` nedan.
 */
export type MatchKind = "exact" | "near";

export type EfterlysningState = "active" | "paused" | "fulfilled" | "expired";

/**
 * Stil- och epoktaggar. Fri text från tolkningen, normaliserad till gemener.
 *
 * Medvetet OSTRUKTURERAT: "60-tal", "funkis", "skandinaviskt" är ord köpare faktiskt skriver, och en
 * uppräkning hade tvingat tolkningen att välja närmaste låda i stället för att skriva vad som sades.
 * Taggarna är mjuka önskemål och kan aldrig fälla en träff — bara ranka den.
 */
export type StyleTag = string;

export interface Efterlysning {
  id: string;
  /** Null för en efterlysning som ännu inte sparats. Sparande kräver konto — se routes.ts. */
  userId: string | null;
  email: string | null;
  state: EfterlysningState;

  /** Specen. Kategori är obligatorisk; resten är önskemål av olika hårdhet (se HARD_FIELDS). */
  filter: ProductFilter;

  /** Stil och epok, som köparen sa det. Mjukt. */
  styleTags: StyleTag[];
  /** ISO-datum. Efter det är möbeln inte längre till nytta — driver deadline-ventilen. */
  deadline: string | null;
  urgency: "none" | "soon" | "urgent";
  /** Köparens egen anteckning. Visas aldrig för en säljare — se wall.ts. */
  note: string | null;

  /** "Soffor & fåtöljer · max 5 000 kr · grön" — meningen köparen bekräftade. */
  summary: string;
  /** Hur specen blev till. Skiljer chattolkning från ifyllt formulär i analysen. */
  parseMethod: "chat" | "form" | "butik_filter";

  createdAt: string;
  updatedAt: string;
  /** 90 dagar från skapandet, förnybart med ett klick. */
  expiresAt: string;

  /** Grovt område, för efterfrågeväggen. Aldrig mer exakt än så. */
  area: string | null;

  /** Produkt-ID:n vi redan hört av oss om, så samma möbel inte notifieras två gånger. */
  notifiedProductIds: string[];
  /** Hur många objekt vi läst igenom åt den här efterlysningen. Pulsens siffra — måste vara sann. */
  scannedCount: number;
  /** Hur många tömningar som gåtts igenom. Andra halvan av pulsens mening. */
  scannedClearances: number;
  lastSweptAt: string | null;
}

/**
 * En träff, som den loggas och visas.
 *
 * `productId` räcker inte som nyckel: samma möbel kan matcha två efterlysningar, och en Tradera-vara
 * kan komma tillbaka i en senare sökning. Loggen är därför per (efterlysning, produkt).
 */
export interface Match {
  id: string;
  efterlysningId: string;
  productId: string;
  source: MatchSource;
  kind: MatchKind;
  /**
   * Vad som stämmer och vad som inte gör det, i klartext: "Rätt modell och pris — men blå, inte grön."
   * Byggs i kod ur jämförelsen, aldrig av en modell: en mening om varför något visas får inte kunna
   * hitta på ett skäl.
   */
  fitNote: string;
  foundAt: string;
  /** Sattes när köparen faktiskt köpte den här möbeln ur den här efterlysningen. */
  purchasedAt: string | null;
}

/**
 * Fälten som ALDRIG får brytas, ens i en generös nära-träff.
 *
 * En soffa som är 30 cm för bred passar inte in genom dörren hur snygg den än är, och ett pris över
 * taket är inte ett kompromissförslag utan ett annat objekt. Mjukheten i "generös matchning" gäller
 * stil, färg och märke — aldrig de här fyra.
 */
export const HARD_FIELDS = ["categorySlug", "maxPriceSek", "maxWidthMm", "maxDepthMm", "maxHeightMm"] as const;

/** Dagar innan en efterlysning somnar av sig själv. Förnyas med ett klick ur påminnelsen. */
export const EXPIRY_DAYS = 90;

/**
 * Går den här personen att nå?
 *
 * KRAVET ÄR INTE ETT KONTO — det är en väg att höra av sig. En bevakning åt någon vi inte kan nå är
 * ett löfte vi inte kan hålla, och det motivet uppfylls lika bra av en e-postadress som av ett
 * konto. Fångaren på /kop tar just en adress och inget mer.
 *
 * Läses av sveparen, pulsen, väggen, panelen och tömningarna — alla ställen som förut frågade efter
 * `userId` och därmed hade tigit ihjäl varje e-postefterlysning.
 */
export function nabar(e: Pick<Efterlysning, "userId" | "email">): boolean {
  return !!e.userId || !!e.email?.trim();
}

/** Bara `exact` får väcka en notis. Nära-träffar samlas till veckans digest. */
export function notifiable(kind: MatchKind): boolean {
  return kind === "exact";
}
