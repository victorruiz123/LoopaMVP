/**
 * Rutnätet: Loopas egna varor och Traderas annonser i EN lista.
 *
 * De två källorna möts här och ingen annanstans. Allt nedströms — filter, sortering, paginering —
 * arbetar på `Product[]` och behöver aldrig veta vilken källa en vara kom ur. Det är hela poängen
 * med `source` som fält i stället för två modeller: köparen bläddrar i ett lager, inte i två flikar.
 *
 * TRADERA FÅR ALDRIG FÄLLA RUTNÄTET. Deras API ligger nere, svarar långsamt eller stängs av — och i
 * varje sådant läge ska butiken visa Loopas varor med en notis. `traderaDegraded` är den notisen,
 * och den är därför ett fält i svaret och inte ett undantag som kastas.
 */

import { allProducts, applyFilter, brandFacets } from "./inventory.js";
import { fetchStockholmFurniture, searchTradera, traderaSourceEnabled } from "../integrations/tradera/search.js";
import type { BrowseResult, Product, ProductFilter } from "./types.js";

/**
 * Märken vi känner igen i en Tradera-rubrik.
 *
 * Byggs ur VÅRT eget lager och inte ur en handskriven lista: märkesfiltret ska kunna korsa källorna,
 * och det kan det bara för de märken butiken faktiskt har egna varor av. En Tradera-soffa av ett
 * märke vi aldrig sett får inget märke satt, vilket är korrekt — vi har ingen märkessida att lägga
 * den på.
 */
async function knownBrands(): Promise<string[]> {
  return (await brandFacets()).map((b) => b.brand);
}

/**
 * Hämtar Tradera-varor för den här sökningen, eller ingenting.
 *
 * Returnerar `degraded: true` när källan är på men inte svarade. Skillnaden mot en avstängd källa är
 * viktig: avstängd är ett beslut och behöver ingen ursäkt, nere är ett fel och köparen ska få veta
 * att listan är kortare än vanligt.
 */
async function traderaSide(
  filter: ProductFilter,
  fetchers: TraderaFetchers,
): Promise<{ items: Product[]; degraded: boolean }> {
  if (filter.onlyLoopa || !fetchers.enabled()) return { items: [], degraded: false };
  try {
    const brands = await knownBrands();
    const items = filter.q?.trim() ? await fetchers.search(filter.q, brands) : await fetchers.pool(brands);
    return { items, degraded: false };
  } catch (err) {
    console.warn("[butik] Tradera-källan svarade inte:", err instanceof Error ? err.message : err);
    return { items: [], degraded: true };
  }
}

/**
 * Hämtarna som en parameter, med det riktiga API:t som förval.
 *
 * Sömmen finns för att degraderingen är ett LÖFTE och inte en detalj: rutnätet ska överleva att
 * Tradera ligger nere. Det löftet går inte att pröva mot det skarpa API:t — ett test som förutsätter
 * att någon annans tjänst är trasig kan inte köras — så felet måste gå att mata in här.
 */
export interface TraderaFetchers {
  enabled: () => boolean;
  pool: (brands: string[]) => Promise<Product[]>;
  search: (words: string, brands: string[]) => Promise<Product[]>;
}

const LIVE: TraderaFetchers = {
  enabled: traderaSourceEnabled,
  pool: (brands) => fetchStockholmFurniture(brands),
  search: (words, brands) => searchTradera(words, brands),
};

/**
 * Rutnätets svar.
 *
 * Skickfiltret och måttfiltret sållar bort Tradera-varor av sig själva — de har varken betyg eller
 * mått — och det sker i applyFilter, som är samma kod för båda källorna. Ingen särbehandling här.
 */
export async function browse(filter: ProductFilter, fetchers: TraderaFetchers = LIVE): Promise<BrowseResult> {
  const { items, degraded } = await mergedItems(filter, fetchers);
  return { ...applyFilter(items, filter), traderaDegraded: degraded };
}

/**
 * Hela lagret från båda källorna, ofiltrerat.
 *
 * Finns för räknarna: kategoribrickorna på landningssidan ska visa samma antal som rutnätet bakom
 * dem innehåller, och det går bara om de räknar på samma lista.
 */
export async function mergedItems(
  filter: ProductFilter = {},
  fetchers: TraderaFetchers = LIVE,
): Promise<{ items: Product[]; degraded: boolean }> {
  const [loopa, tradera] = await Promise.all([allProducts(), traderaSide(filter, fetchers)]);
  return { items: [...loopa, ...tradera.items], degraded: tradera.degraded };
}
