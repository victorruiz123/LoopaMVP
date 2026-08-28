"""Del 2 — visuell kohort: när orden beskriver kategorin men bilden bär värdet.

Fallet som tvingade fram detta: **"Ekbord med stolar"**. Orden matchar 226
annonser vars Blocket-utrop ligger på 50–250 kr — och de priserna är äkta,
gammal brun ek är nästan värdelös. Men bilden visar en tjock massiv ekskiva där
facit är 2 000–5 000 kr.

Ingen textfix kan lösa det. Orden säger *kategori*; kvaliteten syns bara i
bilden. Motorn hade rätt om marknaden för "ekbord med stolar" och fel om just
det här bordet.

Flödet aktiveras bara när tre villkor gäller samtidigt:

  1. Förfrågan identifierar ingen produkt (varken märke, modellnamn eller
     grannröstning gav något).
  2. Det finns en bild.
  3. Ordkohortens prisspridning är stor — annars är orden tillräckliga och
     bilden skulle bara krympa underlaget i onödan.

Kohorten byggs sedan visuellt: bildens grannar i vektorlagret, filtrerade på
möbeltyp, avskurna där likhetskurvan faller mest. Priset räknas
likhetsviktat, och spridningskontrollen behålls — är även den visuella
kohorten spretig ska motorn säga "osäkert 800-3 500" hellre än gissa fel snävt.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from . import config
from .variant import PART, UNKNOWN

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Spridningsmått
# --------------------------------------------------------------------------
def dispersion(prices) -> float:
    """p90/p10 i logdomän. Priser är multiplikativa, så kvoten är rätt mått.

    Bimodalitet behöver inget eget test: två prislägen med ett glapp emellan
    ger per definition hög p90/p10. Måttet fångar båda fallen med en tröskel.
    """
    values = np.asarray([p for p in prices if p and p > 0], dtype=float)
    if len(values) < 5:
        return 0.0
    low, high = np.percentile(values, [10, 90])
    return float(high / max(low, 1.0))


def price_clusters(prices, weights=None) -> list:
    """Prislägen i kohorten, delade vid det största glappet i logdomän.

    Används för `dispersionWarning`. Två klungor räcker: syftet är att säga
    "det finns billiga och dyra exemplar och din bild avgör inte vilket", inte
    att kartlägga fördelningen.
    """
    values = np.asarray([p for p in prices if p and p > 0], dtype=float)
    if len(values) < 8:
        return []
    ordered = np.sort(values)
    logs = np.log(ordered)
    gaps = np.diff(logs)
    # Bara glapp i mitten av fördelningen — kanterna är alltid glesa.
    margin = max(2, len(ordered) // 5)
    inner = gaps[margin:-margin] if len(gaps) > 2 * margin else gaps
    if not len(inner):
        return []
    # Ett glapp räknas bara om det är tydligt större än de vanliga stegen.
    # Utan detta delar argmax även en jämn fördelning, och varningen skulle
    # rapportera två "klungor" som inte finns.
    typical = float(np.median(gaps[gaps > 0])) if (gaps > 0).any() else 0.0
    largest = float(inner.max())
    if typical <= 0 or largest < typical * config.COHORT_GAP_FACTOR:
        return []
    split = int(np.argmax(inner)) + (margin if len(gaps) > 2 * margin else 0) + 1
    left, right = ordered[:split], ordered[split:]
    if len(left) < 3 or len(right) < 3:
        return []
    return [
        {"median": round(float(np.median(left))), "n": int(len(left))},
        {"median": round(float(np.median(right))), "n": int(len(right))},
    ]


# --------------------------------------------------------------------------
# Kohorten
# --------------------------------------------------------------------------
def find_cohort(query_vector, store, listings: pd.DataFrame,
                variants: list | None = None) -> tuple:
    """Bildens grannar som jämförelsemängd. Returnerar (frame, vikter, diagnostik).

    Avskärningen är en KLIPPDETEKTERING, inte en fast tröskel: likhetskurvan
    faller olika snabbt för olika möbler, och det största fallet markerar var
    "samma sorts objekt" övergår i "något annat som råkar likna". Golvet är
    IMAGE_SIMILARITY_MIN — samma validerade tröskel som bildomsorteringen —
    och taket 200 annonser.
    """
    if query_vector is None or store is None or not store.ready:
        return None, None, {"method": "none"}

    scores = store.embeddings @ query_vector
    order = np.argsort(scores)[::-1][: config.COHORT_MAX * 4]
    order = order[scores[order] >= config.IMAGE_SIMILARITY_MIN]
    if len(order) < config.COHORT_MIN:
        return None, None, {"method": "too_few_neighbours",
                            "neighbours": int(len(order))}

    frame = _listings_for_rows(order, scores, store, listings)
    if frame is None or frame.empty:
        return None, None, {"method": "no_listings"}

    # Möbeltypen först: en fåtölj får inte prissätta ett bord bara för att
    # bakgrunden är lika.
    targets = [v for v in (variants or []) if v and v not in (UNKNOWN, PART)]
    if targets:
        typed = frame[frame["variant"].isin(targets)]
        if len(typed) >= config.COHORT_MIN:
            frame = typed

    # Dubblettgrupper bort: 31,7 % av utropsannonserna delar titel och pris,
    # och en omlistad annons får inte väga som tio.
    frame = frame.drop_duplicates(subset=["name_norm", "price"], keep="first")
    frame = frame.sort_values("similarity", ascending=False)
    if len(frame) < config.COHORT_MIN:
        return None, None, {"method": "too_few_after_dedup",
                            "neighbours": int(len(frame))}

    cut = _cliff(frame["similarity"].to_numpy())
    frame = frame.iloc[:cut]
    weights = frame["similarity"].clip(lower=0.01)

    return frame, weights, {
        "method": "visual_cohort",
        "cohort_size": int(len(frame)),
        "similarity_range": [round(float(frame["similarity"].min()), 3),
                             round(float(frame["similarity"].max()), 3)],
        "effective_n": round(float(weights.sum()), 1),
        "cut_at": int(cut),
    }


def _cliff(similarity: np.ndarray) -> int:
    """Var faller likhetskurvan mest? Returnerar antalet grannar att behålla.

    Sökningen sker bara mellan golvet och taket — det största fallet ligger
    annars alltid vid position 1, där den egna bilden slutar och alla andra
    börjar.
    """
    top = min(len(similarity), config.COHORT_MAX)
    if top <= config.COHORT_MIN:
        return top
    drops = -np.diff(similarity[:top])
    window = drops[config.COHORT_MIN - 1:]
    if not len(window):
        return top
    return int(config.COHORT_MIN + np.argmax(window))


def _listings_for_rows(rows, scores, store, listings: pd.DataFrame):
    """Annonserna bakom vektorraderna, med likheten som kolumn."""
    if "_vector_row" not in listings.columns:
        listings = listings.assign(_vector_row=store.rows_for(listings))
    wanted = pd.Series(scores[rows], index=rows)
    hit = listings[listings["_vector_row"].isin(set(rows.tolist()))].copy()
    if hit.empty:
        return None
    hit["similarity"] = hit["_vector_row"].map(wanted)
    return hit[hit["similarity"].notna()]
