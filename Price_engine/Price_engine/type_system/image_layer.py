"""L2 — bilden, grovt. Bara `base`, aldrig undertyp och aldrig funktion.

Mätningen i BILDROLL_RAPPORT.md avgjorde vad bilden får göra. Platt över 14 typer
träffade den 54,5 %. Kollapsad till familjenivå träffade soffamiljen 87,2 %. Den
ser alltså **form tillförlitligt och funktion inte alls** — en bäddsoffa är en
soffa tills någon fäller ut den, och ett hörn ligger ofta utanför bild.

Därför gör det här lagret en enda sak: sätter `base`. Undertyperna (`corner`,
`convertible`, `sub`, `storage_kind`) rör det aldrig, hur säkra grannarna än ser
ut. Det är inte försiktighet utan mätning: 87 % av alla bäddsoffor kallades
"soffa" av grannröstningen, och att låta den skriva `convertible=False` vore att
bygga in det felet.

**Tar en lista bilder, inte en.** Ett hörn syns inte från alla vinklar men syns
från någon, så rösterna summeras över samtliga bilder. Vips skickvideo ger flera
vinklar av samma möbel; med den här signaturen är videostödet en konfigändring
senare i stället för en ombyggnad.
"""

from __future__ import annotations

import logging
from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from price_engine import config

from .attributes import Attributes
from .text_layer import extract

log = logging.getLogger(__name__)

#: rad i vektorlagret -> bastyp. Byggs en gång per process.
_ROW_BASE: Optional[np.ndarray] = None

#: Under så här stor röstandel svarar lagret "vet inte" och lämnar `base` tomt.
#:
#: Vald på HUVUDMÅTTET (väntevärdet av prisfelet i kronor), inte på träffsäkerhet.
#: Mätt mot korpusfacit i measure_type_system.py över 3 200 annonser med
#: läckagespärr — aldrig mot benchmarkmöblerna, som är frysta som bevis.
#:
#:   tröskel   täckning   bas rätt   väntevärde
#:     0,55      89,6 %     78,1 %       375 kr
#:     0,65      83,6 %     80,5 %       346 kr
#:     0,70      80,8 %     81,7 %       342 kr   <- valt
#:     0,75      77,6 %     81,8 %       353 kr
#:     0,90      62,3 %     83,3 %       390 kr
#:
#: Valet ligger på en platå (346/342/353), inte på en spik — träffsäkerheten
#: fortsätter stiga över 0,70 men täckningen faller snabbare än nyttan.
ABSTAIN_BELOW = 0.70

#: Minsta antal grannar över likhetsgolvet för att ett svar alls ges.
MIN_VOTES = config.VISUAL_VARIANT_MIN_VOTES


def row_bases(store, listings: pd.DataFrame) -> np.ndarray:
    """Bastypen bakom varje vektorrad, enligt L0 på annonstexten.

    Bastypen läses ur samma `extract` som allt annat i systemet i stället för ur
    den gamla `variant`-kolumnen. Skälet är att definitionen då bara finns på ett
    ställe: ändras lexikonet följer bildlagrets facit med automatiskt.
    """
    global _ROW_BASE
    if _ROW_BASE is not None:
        return _ROW_BASE

    rows = store.rows_for(listings)
    known = rows >= 0
    bases = [
        extract(blob, prenormalized=True).get("base")
        for blob in listings["search_blob"].to_numpy()[known]
    ]
    table = pd.DataFrame({"row": rows[known], "base": bases})
    table = table[table["base"].notna()]
    # Flera annonser kan dela vektorrad (tradera har 65 % dubblettbilder).
    # Delar de rad men inte bastyp vinner den vanligaste.
    modal = table.groupby("row")["base"].agg(
        lambda values: values.mode().iloc[0] if len(values.mode()) else None)
    out = np.full(len(store.embeddings), None, dtype=object)
    if len(modal):
        out[modal.index.to_numpy()] = modal.to_numpy()
    log.info("Baskarta byggd: %d av %d vektorrader har en bastyp",
             int(modal.notna().sum()) if len(modal) else 0, len(out))
    _ROW_BASE = out
    return out


def _vote_one(query: np.ndarray, store, bases: np.ndarray, k: int) -> dict:
    """Viktade röster från en enda bilds k närmaste grannar."""
    scores = store.embeddings @ query
    if len(scores) <= k:
        top = np.argsort(scores)[::-1]
    else:
        top = np.argpartition(scores, -k)[-k:]
        top = top[np.argsort(scores[top])[::-1]]
    top = top[scores[top] >= config.VISUAL_VARIANT_MIN_SIM]
    if not len(top):
        return {}
    votes: dict = {}
    for row, score in zip(top, scores[top]):
        base = bases[row]
        if base is None:
            continue
        votes[base] = votes.get(base, 0.0) + float(score)
    return votes


def classify(
    queries: Sequence[np.ndarray],
    store,
    listings: pd.DataFrame,
    k: Optional[int] = None,
    abstain_below: float = ABSTAIN_BELOW,
) -> Tuple[Optional[str], dict]:
    """Röstar fram bastypen över samtliga bilder. (bastyp, diagnostik).

    Returnerar None som bastyp när röstenigheten ligger under `abstain_below` —
    att svara "vet inte" är hela poängen med lagret, och den platta
    klassificeraren gjorde det i 0,6 % av fallen när den borde gjort det i
    majoriteten.
    """
    if store is None or not getattr(store, "ready", False):
        return None, {"method": "no_store"}
    queries = [q for q in (queries or ()) if q is not None]
    if not queries:
        return None, {"method": "no_image"}

    k = k or config.VISUAL_VARIANT_K
    bases = row_bases(store, listings)

    total: dict = {}
    per_image: List[dict] = []
    for query in queries:
        votes = _vote_one(np.asarray(query), store, bases, k)
        per_image.append({str(b): round(v, 2) for b, v in votes.items()})
        for base, weight in votes.items():
            total[base] = total.get(base, 0.0) + weight

    if not total:
        return None, {"method": "no_neighbours", "images": len(queries)}

    grand = sum(total.values())
    ranked = sorted(total.items(), key=lambda kv: -kv[1])
    winner, weight = ranked[0]
    share = weight / grand if grand else 0.0
    diagnostics = {
        "method": "knn_family",
        "images": len(queries),
        "share": round(share, 3),
        "votes": {str(b): round(w / grand, 3) for b, w in ranked[:4]},
        "per_image": per_image,
    }
    if share < abstain_below:
        diagnostics["method"] = "abstained"
        return None, diagnostics
    return str(winner), diagnostics


def apply(
    queries: Sequence[np.ndarray],
    store,
    listings: pd.DataFrame,
    attrs: Attributes,
    prior=None,
    prior_text: str = "",
    k: Optional[int] = None,
    abstain_below: float = ABSTAIN_BELOW,
) -> dict:
    """Fyller i `base` om — och bara om — inget billigare lager redan gjort det.

    `prior` används som spärr: säger bilden "bord" men modellordet är Lamino,
    avvisas bilden. Det är den enda mekanismen som kan underkänna ett bildsvar
    på annan grund än bildens egen konfidens.
    """
    base, diagnostics = classify(queries, store, listings, k, abstain_below)
    if base is None:
        return diagnostics
    if prior is not None and prior_text and prior.contradicts(prior_text, "base", base):
        diagnostics["method"] = "rejected_by_prior"
        diagnostics["rejected"] = base
        return diagnostics
    written = attrs.set("base", base, "image", diagnostics.get("share", 0.0),
                        f"{diagnostics['images']} bild(er), "
                        f"{diagnostics.get('share', 0):.0%} röstenighet")
    diagnostics["written"] = bool(written)
    return diagnostics


def reset_cache() -> None:
    """För tester och för mätningar som byter lexikon mellan körningar."""
    global _ROW_BASE
    _ROW_BASE = None
