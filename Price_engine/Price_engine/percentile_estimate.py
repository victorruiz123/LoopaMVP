"""Fas 2 — säljpercentil per grupp, budspärr, kanalgap.

Aggregerar percentilrangerna från fas 1 till en säljpercentil per grupp, med
budspärr som trappas ned per grupp, bootstrap-intervall, budstratifiering och
kanalgapet Tradera–Auctionet skattat PER MÄRKESKLASS.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

import study_config as S

log = logging.getLogger("percentilstudie.estimate")


# --------------------------------------------------------------------------
# Budspärr
# --------------------------------------------------------------------------
def choose_bid_threshold(bids: pd.Series) -> tuple:
    """Högsta budtröskel som ger tillräckligt underlag. Aldrig under 3.

    Ett ensamt bud är en likvidation, inte prisupptäckt — någon fick objektet
    till utropspriset och priset säger mer om säljarens otålighet än om
    marknaden. Kravet mjukas därför upp bara när det måste, och den valda
    tröskeln följer med ut i exporten så att en grupp på 3 bud aldrig kan
    förväxlas med en på 5.
    """
    for threshold in S.BID_THRESHOLDS:
        n = int((bids >= threshold).sum())
        if n >= S.BID_STEPDOWN_BELOW:
            return threshold, n
    lowest = S.BID_THRESHOLDS[-1]
    return lowest, int((bids >= lowest).sum())


# --------------------------------------------------------------------------
# Statistik
# --------------------------------------------------------------------------
def bootstrap_ci(values: np.ndarray, rng: np.random.Generator) -> tuple:
    """Percentilintervall för medianen, via ombootstrapping."""
    if len(values) < 2:
        return (float("nan"), float("nan"))
    draws = rng.choice(values, size=(S.BOOTSTRAP_ITERATIONS, len(values)), replace=True)
    medians = np.median(draws, axis=1)
    alpha = (1 - S.BOOTSTRAP_CI) / 2
    return (
        float(np.quantile(medians, alpha)),
        float(np.quantile(medians, 1 - alpha)),
    )


def summarise(ranks: np.ndarray, rng: np.random.Generator) -> dict:
    low, high = bootstrap_ci(ranks, rng)
    return {
        "sell_percentile": round(float(np.median(ranks)), 4),
        "p25": round(float(np.percentile(ranks, 25)), 4),
        "p75": round(float(np.percentile(ranks, 75)), 4),
        "ci_low": round(low, 4),
        "ci_high": round(high, 4),
        "n": int(len(ranks)),
    }


def bid_terciles(group: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Säljpercentil per budtercil.

    Hypotesen: hög budaktivitet betyder att objektet var attraktivt, alltså
    att det gick att sätta ett högre pris. Hög-tercilens percentil blir då
    en kandidat för intervallets vänsterkant (säljs snabbt) och låg-tercilens
    för högerkanten.
    """
    if len(group) < 9 or group["aux_bid_count"].nunique() < 3:
        return {}
    try:
        tercile = pd.qcut(group["aux_bid_count"], 3,
                          labels=["låg", "mellan", "hög"], duplicates="drop")
    except ValueError:
        return {}
    out = {}
    for name, rows in group.groupby(tercile, observed=True):
        if len(rows) < 5:
            continue
        out[str(name)] = {
            **summarise(rows["rank"].to_numpy(), rng),
            "median_bids": float(rows["aux_bid_count"].median()),
        }
    return out


# --------------------------------------------------------------------------
# Kanalgap — per märkesklass, aldrig globalt
# --------------------------------------------------------------------------
def channel_gaps(matched: pd.DataFrame, keys: list, rng: np.random.Generator) -> dict:
    """Tradera-rang minus Auctionet-rang, skattat per märkesklass.

    Ett globalt gap skattas i praktiken på mid- och high-grupperna, där
    Auctionet har volym. Auktionsrabatten mot konsumentmarknaden är dock
    nästan säkert störst för low end — fas 0 visade att budkonkurrensen
    faller monotont med märkesklass (median 15 bud för high, 9 för low), och
    en tunn auktionspublik pressar priset. Ett globalt gap underkorrigerar
    därför precis de möbler användarna har mest av.
    """
    rows = []
    for key, group in matched.groupby(keys, observed=True):
        tradera = group[group["source"] == "tradera"]["rank"].to_numpy()
        auctionet = group[group["source"] == "auctionet"]["rank"].to_numpy()
        if len(tradera) < S.MIN_TRADERA_SALES or len(auctionet) < S.MIN_TRADERA_SALES:
            continue
        rows.append({
            "key": key if isinstance(key, tuple) else (key,),
            "gap": float(np.median(tradera) - np.median(auctionet)),
            "n_tradera": len(tradera),
            "n_auctionet": len(auctionet),
        })
    return {"pairs": rows}


def tier_gap_table(matched: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Kanalgapet per märkesklass, redovisat high/mid/low sida vid sida."""
    out = {}
    for tier in S.TIER_ORDER:
        subset = matched[matched["brand_tier"] == tier]
        pairs = channel_gaps(subset, ["variant"], rng)["pairs"]
        if not pairs:
            out[tier] = {"gap": None, "groups": 0, "n_tradera": 0}
            continue
        weights = np.array([p["n_tradera"] for p in pairs], dtype=float)
        gaps = np.array([p["gap"] for p in pairs], dtype=float)
        order = np.argsort(gaps)
        cumulative = np.cumsum(weights[order])
        weighted_median = float(gaps[order][np.searchsorted(cumulative, cumulative[-1] / 2)])
        out[tier] = {
            "gap": round(weighted_median, 4),
            "groups": len(pairs),
            "n_tradera": int(weights.sum()),
            "per_variant": {str(p["key"][0]): round(p["gap"], 4) for p in pairs},
        }
    return out


def price_tier_gap_table(matched: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Kanalgapet för spår B: per möbeltyp × prisnivå, och per prisnivå.

    Spår B saknar märkesklass — det är hela poängen med spåret — så gapet kan
    inte hämtas därifrån. Prisnivån bär samma logik: den tunna
    auktionspubliken finns i den billiga änden, oavsett om vi känner märket
    eller inte. Den finare nyckeln försöks först, prisnivån är fallback.
    """
    out = {"per_pair": {}, "per_tier": {}}
    for key, group in matched.groupby(["variant", "price_tier"], observed=True):
        tradera = group[group["source"] == "tradera"]["rank"].to_numpy()
        auctionet = group[group["source"] == "auctionet"]["rank"].to_numpy()
        if len(tradera) >= S.MIN_TRADERA_SALES and len(auctionet) >= S.MIN_TRADERA_SALES:
            out["per_pair"]["|".join(map(str, key))] = {
                "gap": round(float(np.median(tradera) - np.median(auctionet)), 4),
                "n_tradera": int(len(tradera)),
            }
    for tier, group in matched.groupby("price_tier", observed=True):
        tradera = group[group["source"] == "tradera"]["rank"].to_numpy()
        auctionet = group[group["source"] == "auctionet"]["rank"].to_numpy()
        if len(tradera) >= S.MIN_TRADERA_SALES and len(auctionet) >= S.MIN_TRADERA_SALES:
            out["per_tier"][str(tier)] = {
                "gap": round(float(np.median(tradera) - np.median(auctionet)), 4),
                "n_tradera": int(len(tradera)),
            }
    return out


def extrapolate_low_gap(table: dict) -> tuple:
    """Låg-end ärver ALDRIG mid-gapet.

    Går gapet inte att skatta direkt för low end extrapoleras trenden
    high -> mid -> low. Är trenden brant eller motsägelsefull exporteras
    gruppen som insufficient_market i stället — ett underkorrigerat
    low-end-värde är farligare än inget värde, eftersom det ser ut som ett
    svar och används som ett.
    """
    high, mid, low = (table.get(t, {}).get("gap") for t in ("high", "mid", "low"))
    if low is not None:
        return low, "gap_measured"
    if high is None or mid is None:
        return None, "insufficient_market"
    step = mid - high
    if abs(step) > 0.15:
        # Brant trend: extrapolationen blir en gissning med stor hävstång.
        return None, "insufficient_market"
    return round(mid + step, 4), "gap_extrapolated"
