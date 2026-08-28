/**
 * Traderas id-nummer, hämtade ur v4-referensdatan 2026-08-28 (kör reference-lookup.ts för att göra om
 * uppslaget). Inget här är gissat — kategorierna kommer ur GET /categories, skickattributet ur
 * GET /categories/{id}/attribute-definitions och fraktsättet ur reference-data/item-field-values.
 */

import type { ConditionGrade } from "../../types.js";

/** "Avhämtning" — shippingTypes id 8. Möbler hämtas; frakt är inte vår affär. */
export const TRADERA_SHIPPING_PICKUP_ID = 8;

/**
 * "Skick"-attributet. Samma id (121) på alla möbelkategorier vi använder — kontrollerat mot Soffor,
 * Fåtöljer, Soffbord, Sängar, Matsal och Övriga möbler. Ett nytt kategoriträd kan ha ett annat id, så
 * kör om uppslaget innan ni lägger till kategorier utanför Hem & Hushåll > Möbler.
 */
export const TRADERA_SKICK_ATTRIBUTE_ID = 121;

/** De enda fem värden attributet tar. Skickas ett annat avvisas hela annonsen. */
export const TRADERA_SKICK_VALUES = ["Oanvänt", "Mycket gott skick", "Gott skick", "Okej skick", "Defekt"] as const;

/**
 * Loopas betyg -> Traderas skickterm.
 *
 * A mappas till "Mycket gott skick", inte "Oanvänt", med flit. "Oanvänt" är ett påstående om möbelns
 * historia — att den aldrig använts — och det kan en besiktning av bilder aldrig belägga. Kortet är
 * ett attest och får inte påstå mer än det mätt. Annonsen märks dessutom som Begagnad (itemAttributes
 * [2]), så "Oanvänt" hade motsagt sin egen annons.
 */
export const TRADERA_CONDITION: Record<ConditionGrade, string> = {
  A: "Mycket gott skick",
  B: "Mycket gott skick",
  C: "Gott skick",
  D: "Okej skick",
  E: "Okej skick",
  F: "Defekt",
};

/** Fallback: Hem & Hushåll > Möbler > Övriga möbler. Alltid en giltig möbelkategori. */
export const TRADERA_CATEGORY_FALLBACK = 160402;

/**
 * Nyckelord -> kategori, mest specifik först.
 *
 * Ordningen ÄR regeln: "soffbord" måste testas före "bord" och före "soffa", annars hamnar soffbordet
 * bland sofforna. Matchningen görs på kategori, produkttyp och annonsrubrik tillsammans, för
 * annonsgeneratorns `category` är fritext och ibland tom.
 */
const CATEGORY_RULES: Array<{ pattern: RegExp; id: number; name: string }> = [
  { pattern: /soffbord|salongsbord/, id: 302540, name: "Vardagsrum > Soffbord" },
  { pattern: /nattduksbord|sängbord/, id: 302545, name: "Sovrum > Nattduksbord" },
  { pattern: /skrivbord|kontorsstol|kontorsmöbel|arbetsbord/, id: 160407, name: "Kontor" },
  { pattern: /matbord|matgrupp|matsal|matstol|köksbord/, id: 302532, name: "Matsal" },
  { pattern: /soffgrupp|sofflgrupp/, id: 302539, name: "Vardagsrum > Soffgrupper" },
  { pattern: /bäddsoffa|hörnsoffa|divan|soffa|schäslong/, id: 302537, name: "Vardagsrum > Soffor" },
  { pattern: /fåtölj|länstol|loungestol|öronlappsfåtölj|vilstol/, id: 302538, name: "Vardagsrum > Fåtöljer" },
  { pattern: /bokhylla|bokhyllor/, id: 302542, name: "Vardagsrum > Bokhyllor" },
  { pattern: /vitrinskåp|vitrin/, id: 302552, name: "Vardagsrum > Vitrinskåp" },
  { pattern: /garderob|klädskåp/, id: 302548, name: "Förvaring > Garderober" },
  { pattern: /byrå|sideboard|skänk|kommod|skåp|highboard/, id: 302547, name: "Förvaring > Byråer & skåp" },
  { pattern: /hylla|hyllsystem|vägghylla|hyllplan/, id: 302551, name: "Förvaring > Hyllor" },
  { pattern: /madrass|bäddmadrass/, id: 302544, name: "Sovrum > Madrasser" },
  { pattern: /säng|sängram|sänggavel|våningssäng/, id: 302543, name: "Sovrum > Sängar" },
  { pattern: /tv-bänk|tv-bord|mediamöbel|mediabänk/, id: 302536, name: "Mediamöbler" },
  { pattern: /hatthylla|skohylla|hallmöbel|hallbänk|hall\b/, id: 160401, name: "Hall" },
  { pattern: /utemöbel|trädgårdsmöbel|uteplats|balkongmöbel|solstol/, id: 342532, name: "Utemöbler" },
  { pattern: /badrumsskåp|badrumsmöbel|tvättställ/, id: 302533, name: "Badrum" },
  { pattern: /köksmöbel|köksö/, id: 160403, name: "Kök" },
  // Efter allt sammansatt: en ensam stol hör hemma i Matsal, som är Traderas enda stolkategori
  // utanför antikavdelningen. Pallar och barstolar med.
  { pattern: /\bstol\b|stolar|pall\b|barstol|taburett/, id: 302532, name: "Matsal" },
  { pattern: /\bbord\b|sidobord|avlastningsbord|konsolbord/, id: 160402, name: "Övriga möbler" },
];

/**
 * Väljer Tradera-kategori ur den text vi har om möbeln.
 *
 * Två omgångar, och ordningen mellan dem är poängen. `strong` är fält som ÄR möbeltypen — generatorns
 * kategori, produkttypen ur modellvalet, annonsrubriken. `weak` är löpande text som bara NÄMNER den,
 * och den läses först när de starka fälten inte gav något: annonsgeneratorn skriver ibland bara
 * modellnamnet ("IKEA Söderhamn"), och då är brödtexten det enda som vet att det är en soffa. Att
 * väga in brödtexten alltid vore sämre — en soffbeskrivning som nämner ett soffbord skulle flytta
 * annonsen dit — men mot alternativet "Övriga möbler" är den en förbättring.
 *
 * Träffar ingenting hamnar annonsen i Övriga möbler. Fel möbelkategori är sämre än den breda, men en
 * annons som avvisas för ogiltig kategori är sämst.
 */
export function traderaCategoryFor(signals: {
  strong: Array<string | null | undefined>;
  weak?: Array<string | null | undefined>;
}): { id: number; name: string } {
  const match = (texts: Array<string | null | undefined>) => {
    const haystack = texts.filter(Boolean).join(" ").toLowerCase();
    return CATEGORY_RULES.find((rule) => rule.pattern.test(haystack)) ?? null;
  };
  const hit = match(signals.strong) ?? match(signals.weak ?? []);
  return hit ? { id: hit.id, name: hit.name } : { id: TRADERA_CATEGORY_FALLBACK, name: "Övriga möbler" };
}

/**
 * Betalsätt. Kontot har i dag exakt ett aktiverat alternativ — "Swish / Kort / PayPal" (id 16384,
 * Braintree) — och det är det Tradera själv listar på GET /users/me/payment-options. Överstyrs med
 * TRADERA_PAYMENT_OPTION_IDS="16384,32" den dagen kontot har fler.
 */
export function traderaPaymentOptionIds(): number[] {
  const raw = process.env.TRADERA_PAYMENT_OPTION_IDS?.trim();
  if (!raw) return [16384];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
