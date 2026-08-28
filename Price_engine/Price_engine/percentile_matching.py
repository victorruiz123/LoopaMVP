"""Fas 1 — matcha varje försäljning mot en samtida utropsfördelning.

Kärnprincipen: percentilen räknas ALDRIG mot hela databasen. För varje såld
auktionsmöbel görs en sökning bland de utropsannonser som var aktuella när
objektet såldes, och percentilrangen är andelen av dem som låg under
slutpriset.

Studien är en kund till motorns sökkod. Märkesmatchningen görs av
`price_engine.pricing.find_listings`, varianthanteringen följer motorns egen
uppmjukningsordning, och delar/tillbehör utesluts av samma `variant.PART`
som produktionen använder.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

import study_config as S
from price_engine.pricing import find_listings
from price_engine.variant import PART, UNKNOWN

log = logging.getLogger("percentilstudie.match")

#: Uppmjukningsordningen, striktast först. Speglar motorns egen kedja:
#: märke + typ -> typ -> typ inkl. omärkt typ -> alla möbler.
MATCH_LEVELS = ("brand+variant", "variant", "variant+unknown", "all")


def build_asking_pool(frame: pd.DataFrame) -> pd.DataFrame:
    """Utropsannonserna som försäljningarna jämförs mot.

    Dubbletter kollapsas på (normaliserad titel, pris). 31,7 % av
    utropsannonserna ligger i en sådan grupp och den största har 492
    identiska exemplar — utan kollaps skulle en enda omlistad annons kunna
    dominera hela fördelningen den mäts mot.
    """
    pool = frame[
        (frame["price_kind"] == "asking")
        & frame["listed_at"].notna()
        & (frame["variant"] != PART)
    ].copy()
    before = len(pool)
    pool = pool.drop_duplicates(subset=["name_norm", "price"], keep="first")
    log.info(
        "Utropspool: %d -> %d rader efter dubblettkollaps (%d borttagna)",
        before, len(pool), before - len(pool),
    )
    return pool.sort_values("listed_at").reset_index(drop=True)


def _brand_pools(pool: pd.DataFrame, brands: set) -> dict:
    """Delmängden per märke, via motorns egen märkesmatchning."""
    pools = {}
    for brand in sorted(brands):
        matched = find_listings(pool, name="", brand=brand, price_kind=None)
        if len(matched):
            pools[brand] = matched
    log.info("Märkespooler byggda för %d märken", len(pools))
    return pools


class MatchCache:
    """Sorterade prisvektorer per (nivå, nyckel, månad).

    Memoisering, inte genväg: två försäljningar av samma möbeltyp samma månad
    matchar per definition mot exakt samma utropsannonser. Att söka om per
    försäljning ger identiskt resultat men tar timmar i stället för minuter.

    Månadsupplösning på tidsfönstret är den enda approximationen: fönstret
    räknas från försäljningsmånadens början i stället för dess exakta datum.
    Med ±3 månaders fönster flyttar det kanten som mest 31 dagar av ~180.
    """

    def __init__(self, pool: pd.DataFrame, brand_pools: dict):
        self.pool = pool
        self.brand_pools = brand_pools
        self._cache: dict = {}
        self._subsets: dict = {}
        self.hits = 0
        self.misses = 0

    def _subset(self, level: str, brand, variant):
        """Delmängden före tidsfönstret. Cachas — den filtreringen går över
        1,5 miljoner rader och skulle annars köras om per månad."""
        key = (level, brand if level == "brand+variant" else None, variant)
        if key in self._subsets:
            return self._subsets[key]

        if level == "brand+variant":
            base = self.brand_pools.get(brand)
            subset = None if base is None else base[base["variant"] == variant]
        elif level == "variant":
            subset = self.pool[self.pool["variant"] == variant]
        elif level == "variant+unknown":
            subset = self.pool[self.pool["variant"].isin([variant, UNKNOWN])]
        else:
            subset = self.pool

        # Datum och pris som numpy: percentilrangen behöver bara de två, och
        # att slippa dra runt hela dataramen per uppslag är det som gör
        # matchningen körbar på ~90 000 försäljningar.
        if subset is not None:
            subset = (
                subset["listed_at"].to_numpy(),
                subset["price"].to_numpy(float),
            )
        self._subsets[key] = subset
        return subset

    def prices(self, level: str, brand, variant, month: pd.Period) -> np.ndarray:
        key = (level, brand if level == "brand+variant" else None, variant, month)
        if key in self._cache:
            self.hits += 1
            return self._cache[key]
        self.misses += 1

        subset = self._subset(level, brand, variant)
        if subset is None or not len(subset[0]):
            self._cache[key] = np.empty(0)
            return self._cache[key]

        dates, prices = subset
        start = (month - S.TIME_WINDOW_MONTHS).start_time.tz_localize("UTC")
        stop = (month + S.TIME_WINDOW_MONTHS).end_time.tz_localize("UTC")
        window = (dates >= start) & (dates <= stop)
        self._cache[key] = np.sort(prices[window])
        return self._cache[key]


def percentile_rank(prices: np.ndarray, value: float) -> float:
    """Andelen utropsannonser som ligger UNDER slutpriset.

    Mittpunkten mellan strikt under och högst lika hanterar prisklumpar:
    utropspriser klumpar hårt på jämna tal (500, 1 000, 2 500), och med
    strikt olikhet skulle en försäljning på exakt 1 000 kr få rangen från
    alla som ligger under men ingen kredit för de hundratals som ligger på
    samma tal.
    """
    if not len(prices):
        return float("nan")
    left = float(np.searchsorted(prices, value, side="left"))
    right = float(np.searchsorted(prices, value, side="right"))
    return (left + right) / 2.0 / len(prices)


def match_sales(sales: pd.DataFrame, cache: MatchCache) -> pd.DataFrame:
    """Percentilrang per försäljning, med matchningsnivån loggad."""
    months = sales["listed_at"].dt.to_period("M")
    ranks, levels, counts, medians, broad = [], [], [], [], []

    for (_, sale), month in zip(sales.iterrows(), months):
        chosen, prices = None, np.empty(0)
        for level in MATCH_LEVELS:
            if level == "brand+variant" and not sale["brand"]:
                continue
            candidate = cache.prices(level, sale["brand"], sale["variant"], month)
            if len(candidate) >= S.MIN_ASKING_PER_MATCH:
                chosen, prices = level, candidate
                break
            # Behåll den bredaste vi sett ifall ingen nivå når kravet.
            if len(candidate) > len(prices):
                chosen, prices = level, candidate

        ranks.append(percentile_rank(prices, sale["price"]))
        levels.append(chosen)
        counts.append(len(prices))
        medians.append(float(np.median(prices)) if len(prices) else float("nan"))

        # Samma försäljning mätt mot den BREDA fördelningen (bara möbeltyp).
        # Motorn matchar smalt i produktion — märke och modell — så en
        # percentil uppmätt mot en bred fördelning överförs bara om rangen är
        # ungefär densamma i båda. Det är ett antagande, och det går att
        # testa: se fas 3, "smalhetskänslighet".
        if chosen == "brand+variant":
            wide = cache.prices("variant", sale["brand"], sale["variant"], month)
            broad.append(percentile_rank(wide, sale["price"]) if len(wide) else np.nan)
        else:
            broad.append(np.nan)

    out = sales.copy()
    out["rank"] = ranks
    out["match_level"] = levels
    out["match_count"] = counts
    out["rank_broad"] = broad
    # Cirkelbrytaren: prisnivån ska sättas av vad marknaden BEGÄR för
    # liknande möbler, aldrig av vad objektet självt gick för.
    out["matched_median"] = medians
    return out


def assign_price_tier(frame: pd.DataFrame) -> pd.Series:
    """Prisnivå = tercil av den MATCHADE UTROPSMEDIANEN, inom möbeltypen.

    Detta är studiens cirkelbrytare. Klassar man på objektets slutpris blir
    resultatet matematiskt förutbestämt: dyra objekt hamnar i "hög" och får
    per konstruktion hög percentilrang. Den matchade utropsmedianen är
    däremot känd vid förfrågan — det är samma information motorn har i
    produktion — och är oberoende av vad just detta objekt betalades med.
    """
    out = pd.Series(None, index=frame.index, dtype="object")
    usable = frame["matched_median"].notna()
    low, high = S.PRICE_TIER_QUANTILES
    for _, rows in frame[usable].groupby("variant", observed=True):
        if len(rows) < 3 or rows["matched_median"].nunique() < 3:
            continue
        # Rangbaserade terciler i stället för pd.cut på kvantilkanter: den
        # matchade medianen klumpar hårt (samma sökning ger samma median för
        # hundratals försäljningar), och då kollapsar kvantilkanterna till
        # samma värde. Rangen delar alltid i tre.
        share = rows["matched_median"].rank(pct=True, method="average")
        names = S.PRICE_TIER_NAMES
        out.loc[rows.index] = np.where(
            share <= low, names[0], np.where(share <= high, names[1], names[2])
        )
    return out
