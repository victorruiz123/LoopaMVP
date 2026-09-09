// Utvecklingsvy: annonskortet och "Sälj med Loopa" med påhittad data, utan inloggning, utan server
// och utan att någon möbel behöver filmas. Ingår inte i appen — samma sorts fil som dim-preview.tsx.
//
// VARFÖR DEN BEHÖVS. De två skärmarna ligger sist i säljflödet: för att nå dem på riktigt måste man
// logga in, filma ett varv, vänta på identifiering, besiktning och prismotor. Det är rätt ordning
// för en säljare och helt fel för den som ska titta på formen. Här ritas samma komponenter som
// appen använder, med data som liknar en riktig möbel.
//
// INGENTING HÄR ÄR EN KOPIA AV APPENS MARKUP. Både ListingView och SellWithLoopa importeras som de
// är — ändras de ändras den här sidan med dem. Det enda som fejkas är DATAN, och för säljrutans del
// serverns svar (se `fetch`-stubben nedan), eftersom den annars pollar ett jobb som inte finns.

import { createRoot } from "react-dom/client";
import { supabase } from "../lib/supabase";
import ListingView from "../components/ListingView";
import SellWithLoopa from "../components/SellWithLoopa";
import type { CardDamage, GeneratedListing, TraderaState } from "../types";

/* ── bilder ────────────────────────────────────────────────────────────────
   Ritade som SVG i en data-URI: förhandsvyn ska fungera utan nät och utan att någon lägger
   JPEG-filer i repot. Formerna är grova med flit — det som granskas här är layouten runt bilden. */

function svgBild(inner: string, w = 1200, h = 900): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${inner}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const soffa = (fyllning: string, vinkel = 0) =>
  svgBild(
    `<g transform="rotate(${vinkel} 600 450)">
       <rect x="210" y="380" width="780" height="230" rx="34" fill="${fyllning}"/>
       <rect x="240" y="300" width="720" height="150" rx="30" fill="${fyllning}" opacity="0.82"/>
       <rect x="180" y="360" width="90" height="250" rx="34" fill="${fyllning}" opacity="0.92"/>
       <rect x="930" y="360" width="90" height="250" rx="34" fill="${fyllning}" opacity="0.92"/>
       <rect x="290" y="608" width="26" height="70" rx="10" fill="#8a7a63"/>
       <rect x="884" y="608" width="26" height="70" rx="10" fill="#8a7a63"/>
     </g>`,
  );

const narbild = (etikett: string) =>
  svgBild(
    `<rect width="1200" height="900" fill="#cfc6b6"/>
     <rect x="120" y="180" width="960" height="560" rx="18" fill="#6f7f6a"/>
     <path d="M300 480 q120 -70 260 -10 t300 40" stroke="#54604f" stroke-width="16" fill="none" stroke-linecap="round"/>
     <text x="60" y="840" font-family="system-ui" font-size="44" fill="#3d3831">${etikett}</text>`,
  );

/* ── möbeln ───────────────────────────────────────────────────────────────── */

const attribut = [
  { key: "bredd", label: "Bredd", value: "212 cm" },
  { key: "djup", label: "Djup", value: "92 cm" },
  { key: "hojd", label: "Höjd", value: "77 cm" },
  { key: "sitthojd", label: "Sitthöjd", value: "44 cm", estimated: true },
  { key: "material", label: "Klädsel", value: "Sammet, mossgrön" },
  { key: "stomme", label: "Stomme", value: "Massiv furu" },
];

const card: GeneratedListing = {
  identity: {
    brand: "Ire Möbel",
    exactProduct: "Kingsley 3-sits",
    variant: "Mossgrön sammet",
    category: "Soffa",
    confidence: "high",
    uncertain: false,
    uncertaintyNote: null,
  },
  attributes: attribut,
  pricing: {
    retailPriceSek: 24900,
    suggestedPriceSek: 8400,
    priceRangeMinSek: 7200,
    priceRangeMaxSek: 9600,
    rationale: null,
  },
  listing: {
    title: "Ire Kingsley 3-sits i mossgrön sammet",
    description:
      "Rymlig tresitssoffa från Ire Möbel, klädd i mossgrön sammet på en stomme av massiv furu. " +
      "Sitsen är fast men mjuk, och ryggkuddarna är löstagbara.\n\n" +
      "Soffan har stått i ett vardagsrum utan husdjur och har använts dagligen i tre år. " +
      "Den är hämtad och besiktigad av Loopa, och varje anmärkning står med bild längre ned.",
    conditionText: "Använd men hel. Sammeten är nedsutten på högra sitsdynan och har en ljusare fläck vid vänstra armstödet.",
  },
  sources: [],
  status: "full",
};

const damages: CardDamage[] = [
  {
    id: "d1",
    type: "compressed_upholstery",
    part: "höger sittdyna",
    semanticLocation: "sitsens framkant",
    severity: "S2",
    impact: "cosmetic",
    description: "Sammeten är nedsutten och luggen ligger platt över ett område på cirka 30 × 20 cm.",
    bild: { url: narbild("höger sittdyna"), mark: { kind: "box", x: 0.28, y: 0.42, w: 0.34, h: 0.28 }, width: 1200, height: 900 },
  },
  {
    id: "d2",
    type: "stain",
    part: "vänster armstöd",
    semanticLocation: "armstödets ovansida",
    severity: "S1",
    impact: "cosmetic",
    description: "Ljusare fläck, cirka 6 cm, syns i motljus.",
    bild: { url: narbild("vänster armstöd"), mark: { kind: "box", x: 0.55, y: 0.3, w: 0.14, h: 0.16 }, width: 1200, height: 900 },
  },
  {
    id: "d3",
    type: "scratch",
    part: "höger bakben",
    semanticLocation: "benets utsida",
    severity: "S1",
    impact: "cosmetic",
    description: "Ytlig repa i lacken, cirka 4 cm. Ingen påverkan på stabiliteten.",
    bild: null,
  },
];

const omslag = soffa("#5f7355");
const galleri = [
  { url: omslag, kind: "cutout" as const },
  { url: soffa("#5f7355", 4), kind: "cutout" as const },
  { url: soffa("#6b8060", -3), kind: "cutout" as const },
];

/* ── serverns svar på säljrutans pollning ──────────────────────────────────
   SellWithLoopa frågar /api/jobs/:id/tradera direkt när den monteras och slutar rita helt om svaret
   säger att integrationen inte är konfigurerad. Stubben ger den ett läge att visa. Bara i den här
   filen — appen rör inte `fetch`. */

const traderaState: TraderaState = {
  configured: true,
  missingEnv: [],
  publication: null,
  blockedReason: null,
  plan: {
    title: card.listing.title,
    loopaId: "LP-7Q4M-2XKD",
    categoryId: 1606,
    categoryName: "Soffor & fåtöljer",
    price: 8900,
    itemPrice: 8400,
    shippingSek: 500,
    priceSource: "seller",
    condition: "Använd",
    imageCount: 8,
    mode: "fixed",
    durationDays: null,
  },
  ladder: {
    startPrice: 8400,
    floorPrice: 5900,
    // Samma tal som skarpt läge: DEFAULT_WEEKLY_DROP i server/src/priceLadder.ts och WEEKLY_DROP i
    // web/src/lib/priceLadder.ts står båda på 0.15. Förhandsvyn ska inte visa en annan prisplan än
    // den säljaren faktiskt får.
    weeklyDropPct: 0.15,
    currentPrice: 8400,
    nextDropAt: null,
    drops: [],
    floorReachedAt: null,
    lastError: null,
    chosenAt: new Date().toISOString(),
    listingMode: "fixed",
  },
};

/**
 * En session, så att anropet ens hinner fram till stubben nedan.
 *
 * `authFetch` i api.ts hämtar en token FÖRE fetch och kastar `AuthRequiredError` när ingen session
 * finns — alltså innan någon `fetch` sker. Utan den här raden fastnar säljrutan i sin retry-slinga
 * och ritar ingenting alls, vilket ser ut som att komponenten är trasig.
 *
 * Objektet är exporterat och muterbart, så det räcker att byta metoden. Bara i den här filen.
 */
supabase.auth.getSession = (async () => ({
  data: { session: { access_token: "preview", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
  error: null,
})) as unknown as typeof supabase.auth.getSession;

const riktigFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/tradera")) {
    return new Response(JSON.stringify(traderaState), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return riktigFetch(input as RequestInfo, init);
}) as typeof window.fetch;

/* ── sidan ─────────────────────────────────────────────────────────────────
   Samma uppställning som ListingScreen: kortet, och säljrutan direkt under. De låg förut på var sin
   flik här, och då gick det inte att se det som är hela frågan — om "Sälj med Loopa" ryms på skärmen
   utan att man scrollar. En förhandsvy som inte kan visa det den granskas för är ingen förhandsvy. */

function Preview() {
  return (
    <div className="screen screen-light card-screen" style={{ maxWidth: 520, margin: "0 auto", paddingBottom: 60 }}>
      <ListingView
        card={card}
        identity={{ brand: "Ire Möbel", model: "Kingsley" }}
        grade={{
          grade: "B",
          canonicalCondition: "Bra skick",
          label: "Gott skick",
          rationale: "Tre kosmetiska anmärkningar, inga funktionella.",
          reasons: [],
        }}
        price={{
          status: "ok",
          low: 7200,
          default: 8400,
          high: 9600,
          currency: "SEK",
          damageDeduction: 0.12,
          unavailableReason: null,
        }}
        damages={damages}
        imageCount={8}
        reviewed
        productImage={null}
        cover={{ url: omslag, kind: "cutout", backdrop: null }}
        bilder={galleri}
        collapsible
        /* I appen skriver den här till servern och byter ut kortet mot svaret. Här finns ingen
           server att skriva till — rutorna öppnas, går att fylla i och stänger sig när man sparar,
           men texten går tillbaka till den påhittade. Formen går att granska, inte att spara. */
        onSaveListing={async () => {}}
      />
      <SellWithLoopa jobId="preview" coverUrl={omslag} onMyListings={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
