"""Uppslagning i priscellerna, med krympningshierarki.

Motorns textsökning hittar annonser vars TITEL innehåller sökorden. Cellerna
grupperar i stället på vad annonsen ÄR: märke, produkttyp, modell, konfiguration.
Skillnaden är mätt — under namnet "Madison" låg fyra produkter i fyra
prisklasser, från en matta på 200 kr till en Swedese-soffa på 73 000.

Krympningen sker när cellen är för tunn, och den redovisas alltid:

    full                märke x typ x modell x konfiguration
    utan_konfiguration  märke x typ x modell
    marke_x_typ         märke x typ
    typ_x_kategori      typ

Buntar krymper aldrig förbi modellnivån — "Madison med fotpall" och "Kivik med
schäslong" är olika produkter.

Nycklarna ligger som kolumner på `listings` (se `data_loader`), inte i en
sidofil. Skälet är mätbart: färskhetsfiltret läser `listed_at`, skickfiltret
`condition_tier` och storleksnivån `size` — kolumner en cellfil inte bär. En
join tillbaka på (rubrik, pris) är inte unik i den här korpusen.
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

import pandas as pd

from price_engine import config

log = logging.getLogger(__name__)

LEVELS = (("full", "cell_full"),
          ("utan_konfiguration", "cell_no_config"),
          ("marke_x_typ", "cell_brand_type"),
          ("typ_x_kategori", "cell_type_only"))


def available(listings: pd.DataFrame) -> bool:
    """True när korpusen bär cellnycklarna (CACHE_VERSION >= 17)."""
    return "cell_no_config" in listings.columns


def keys_for(name: str, brand: Optional[str] = None,
             product_type: Optional[str] = None) -> dict:
    """Cellnycklarna för en FRÅGA, byggda exakt som korpusens.

    Frågan går genom samma `grouping.classify` som annonserna. Skulle den gå
    genom en egen väg skulle nycklarna kunna sluta matcha utan att något test
    märkte det.
    """
    from type_system import grouping

    guess = grouping.classify(name or "")
    found_brand = grouping.brand_of(guess.tokens) or (
        grouping.brand_of(grouping.tokens(brand or "")) if brand else None)
    pairs, brandless = grouping.model_names()
    allowed = set(brandless) | set(pairs.get(found_brand or "", ()))
    model = grouping.model_key(guess.tokens, allowed)

    kind = product_type or guess.product_type
    cell_type = (f"bunt:{kind}" if kind else "bunt:okand_bastyp") \
        if guess.is_bundle else (kind or "okand")
    config_key = grouping.config_key(guess.seats, guess.size)

    brand_part = found_brand or ""
    no_config = f"{brand_part}|{cell_type}|{model}"
    return {
        "cell_full": f"{no_config}|{config_key}",
        "cell_no_config": no_config,
        # Buntar krymper aldrig förbi modellnivån.
        "cell_brand_type": no_config if guess.is_bundle else f"{brand_part}|{cell_type}",
        "cell_type_only": no_config if guess.is_bundle else cell_type,
    }


def lookup(listings: pd.DataFrame, name: str, brand: Optional[str] = None,
           product_type: Optional[str] = None,
           minimum: Optional[int] = None) -> Tuple[Optional[pd.DataFrame], str, str]:
    """Jämförelsemängden för en fråga. (rader, nivå, nyckel).

    Returnerar den FINASTE nivå som har tillräckligt underlag. Nivån följer
    alltid med, eftersom ett svar från `typ_x_kategori` betyder något helt annat
    än ett från `full` — det första är "möbler av den här sorten", det andra
    "just den här modellen i just den här storleken".

    Uteslutna rader (tillbehör, jämförelseannonser, lösa sektioner) är borta ur
    alla nivåer. De finns kvar i korpusen och går att granska.
    """
    if not available(listings):
        return None, "inga_celler", ""
    minimum = minimum or config.MIN_COMPARISON_SET
    pool = listings[~listings["cell_excluded"].fillna(False)]

    keys = keys_for(name, brand, product_type)
    if product_type is None:
        keys = _by_majority(pool, name, brand) or keys

    thin = None
    for level, column in LEVELS:
        hit = pool[pool[column] == keys[column]]
        if len(hit) >= minimum:
            return hit, level, keys[column]
        if thin is None and len(hit):
            thin = (hit, f"{level}_tunn", keys[column])
    if thin is not None:
        return thin
    return None, "ingen_traff", keys["cell_no_config"]


def _by_majority(pool: pd.DataFrame, name: str,
                 brand: Optional[str]) -> Optional[dict]:
    """Typen som korpusens rader med samma modellnyckel faktiskt fick.

    Korpusen typades med majoritetstilldelning: "Mio Madison" utan möbelord i
    rubriken blev soffa för att modellens andra annonser är soffor. En FRÅGA är
    en ensam rad och kan inte rösta — "Madison" ensamt ger `okand` och skulle
    slå upp cellen `mio|okand|madison`, som är nästan tom.

    Rösten hämtas därför ur korpusen vid uppslaget i stället för att frysas i en
    sidofil, så att den aldrig kan bli inaktuell mot datan den beskriver.
    """
    from type_system import grouping

    keys = keys_for(name, brand)
    if pool[pool["cell_no_config"] == keys["cell_no_config"]].shape[0]:
        return None                       # frågans egen nyckel duger

    guess = grouping.classify(name or "")
    found_brand = grouping.brand_of(guess.tokens) or (
        grouping.brand_of(grouping.tokens(brand or "")) if brand else None)
    pairs, brandless = grouping.model_names()
    allowed = set(brandless) | set(pairs.get(found_brand or "", ()))
    model = grouping.model_key(guess.tokens, allowed)
    if not model:
        return None

    same = pool[(pool["model_key"] == model)
                & (pool["brand_key"] == (found_brand or ""))]
    if len(same) < 3:
        return None
    kind = same["cell_type"].value_counts().index[0]
    if kind.startswith("bunt:") and not guess.is_bundle:
        return None                       # frågan är ingen bunt
    return keys_for(name, brand, kind.split(":", 1)[-1] if ":" in kind else kind)
