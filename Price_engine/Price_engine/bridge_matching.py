"""Del A — kvalificering och matchning på MOTORNS nivå.

Percentilstudien mätte rangen mot en bred jämförelsemängd (median ~11 800
annonser). Motorn matchar smalt: märke + modellnamn, ~100 annonser.
Överföringstestet visade att nivåbytet flyttar medianrangen från p67 till p43
och att bara 38 % av rangerna överlever inom 10 enheter. Siffran på motorns
egen nivå var alltså okänd — och det är den enda nivå som spelar roll.

Skillnaden mot percentilstudien, i tre punkter:

  1. HÅRT KRAV på både märke och modellnamn. Ingen fallback-breddning.
  2. Jämförelsemängden är samma specifika möbel ("IKEA Landskrona"), inte
     samma möbeltyp ("IKEA soffa").
  3. Bildomsortering ovanpå, precis som i produktion, för att skilja varianter.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

import study_config as S
from price_engine.data_loader import normalize_text
from price_engine.pricing import find_listings
from price_engine.variant import PART

log = logging.getLogger("brygga.match")


def _normalized_models() -> dict:
    """Modellnamnen normaliserade en gång, med märket normaliserat med."""
    return {
        normalize_text(brand): tuple(normalize_text(m) for m in models)
        for brand, models in S.MODEL_NAMES.items()
    }


MODELS = _normalized_models()

#: Modellnamn som är för generella för att bära en sökning på egen hand.
#: "string" är både märke och modell, "aalto" är en upphovsman, "egg" och
#: "shell" är vanliga ord. De kräver att märket också står i titeln.
AMBIGUOUS = {"string", "aalto", "egg", "shell", "standard", "eames", "montana",
             "aj", "non", "spin", "happy", "tank", "result", "fly", "sam"}


def qualify(sales: pd.DataFrame) -> pd.DataFrame:
    """Märker varje försäljning med (märke, modell) där båda går att fastställa.

    Kravet är hårt med avsikt. En försäljning utan igenkänt modellnamn
    exkluderas hellre än späder ut mätningen — hela poängen med Del A är att
    jämförelsemängden ska vara rätt, inte stor.
    """
    blob = sales["search_blob"].fillna("")
    model = pd.Series(None, index=sales.index, dtype="object")

    for brand_key, names in MODELS.items():
        # Märket måste stå i texten. Utan det vet vi inte om "kivik" är en
        # IKEA-soffa eller ett ortsnamn.
        has_brand = blob.str.contains(rf"\b{brand_key}\b", regex=True, na=False)
        if not has_brand.any():
            continue
        for name in names:
            if len(name) < 3:
                continue
            hit = has_brand & blob.str.contains(rf"\b{name}\b", regex=True, na=False)
            model[hit & model.isna()] = name

    out = sales.copy()
    out["model"] = model
    return out


class ModelMatcher:
    """Jämförelsemängd per (märke, modell, månad) — samma möbel, samma tid.

    Ingen uppmjukningsordning. Ger modellsökningen färre än
    BRIDGE_MIN_ASKING annonser exkluderas försäljningen och räknas i
    bortfallet. Att bredda till "alla soffor" hade räddat mätpunkten men
    förstört mätningen.
    """

    def __init__(self, pool: pd.DataFrame):
        self.pool = pool
        self._model_pools: dict = {}
        self._cache: dict = {}
        self.hits = 0
        self.misses = 0

    def _model_pool(self, brand: str, model: str) -> pd.DataFrame:
        key = (brand, model)
        if key not in self._model_pools:
            # Motorns egen sökkod: märke som brand, modellnamn som name.
            self._model_pools[key] = find_listings(
                self.pool, name=model, brand=brand, price_kind=None
            )
        return self._model_pools[key]

    def candidates(self, brand: str, model: str, month: pd.Period) -> pd.DataFrame:
        """Annonser för samma modell inom tidsfönstret."""
        key = (brand, model, month)
        if key in self._cache:
            self.hits += 1
            return self._cache[key]
        self.misses += 1

        subset = self._model_pool(brand, model)
        if subset.empty:
            self._cache[key] = subset
            return subset

        start = (month - S.TIME_WINDOW_MONTHS).start_time.tz_localize("UTC")
        stop = (month + S.TIME_WINDOW_MONTHS).end_time.tz_localize("UTC")
        window = subset[
            (subset["listed_at"] >= start) & (subset["listed_at"] <= stop)
        ]
        self._cache[key] = window
        return window


def build_pool(frame: pd.DataFrame) -> pd.DataFrame:
    """Utropsannonserna, dubblettkollapsade precis som i percentilstudien."""
    pool = frame[
        (frame["price_kind"] == "asking")
        & frame["listed_at"].notna()
        & (frame["variant"] != PART)
    ].copy()
    return pool.drop_duplicates(subset=["name_norm", "price"], keep="first")


def image_rerank(candidates: pd.DataFrame, query_vector, query_color, store):
    """Motorns bildomsortering, oförändrad — se pricing._apply_image.

    Returnerar (delmängd, metod). Metoden speglar produktionens egna lägen så
    att andelen omsorterade går att rapportera.
    """
    from price_engine import config

    if query_vector is None or store is None or not store.ready:
        return candidates, "none"

    rows = store.rows_for(candidates)
    known = rows >= 0
    if known.sum() < config.IMAGE_MIN_LISTINGS:
        return candidates, "too_few_vectors"

    vectors = store.embeddings[rows[known]]
    scores = vectors @ query_vector
    if store.colors is not None and query_color is not None:
        colors = store.colors[rows[known]]
        colour_scores = colors @ query_color
        scores = ((1 - config.COLOR_WEIGHT) * scores
                  + config.COLOR_WEIGHT * colour_scores)

    subset = candidates[known]
    for threshold in (config.IMAGE_SIMILARITY_MIN, *config.IMAGE_LOOSEN_STEPS):
        keep = scores >= threshold
        if keep.sum() >= config.IMAGE_MIN_LISTINGS:
            method = ("filtered" if threshold == config.IMAGE_SIMILARITY_MIN
                      else "loosened")
            return subset[keep], method

    order = np.argsort(scores)[::-1][:config.IMAGE_TOP_K]
    return subset.iloc[order], "top_k"
