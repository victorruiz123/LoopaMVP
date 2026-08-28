#!/usr/bin/env python
"""Percentilstudie — vilken percentil av utropspriserna säljer faktiskt?

    python run_percentile_study.py profile   # Fas 0: profilering
    python run_percentile_study.py all       # Fas 1-4: hela studien

Prismotorn föreslår priser som percentiler av utropsfördelningen, men
percentilerna är VALDA, inte uppmätta. Studien mäter dem mot auktionernas
slutpriser och budantal.

Studien är en kund till motorns sökkod. All inläsning, städning, märkes- och
variantmatchning återanvänds från price_engine — ingenting återimplementeras,
eftersom percentiler kalibrerade mot en annan matchning än produktionens
skulle kalibrera fel fråga.

Trösklar och märkesklasser ligger i study_config.py. Slumpfröet är fixerat,
så en omkörning ger samma resultat.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

import percentile_estimate as E
import percentile_matching as M
import study_config as S
from price_engine import config
from price_engine.data_loader import load_listings
from price_engine.variant import PART, UNKNOWN

log = logging.getLogger("percentilstudie")

#: Kolumner som utfallsmåtten bor i. De ingår inte i motorns kanoniska schema
#: — motorn prissätter, den utvärderar inte — så studien hämtar dem själv.
AUCTION_COLUMNS = ("dedup_key", "aux_bid_count", "aux_estimate", "channel")

#: Kvantilrutnätet som sparas per försäljning, så att fas 3 kan prediktera
#: pris vid en godtycklig percentil utan att söka om.
QUANTILE_GRID = np.round(np.arange(0, 1.0001, 0.05), 2)
QUANTILE_COLUMNS = [f"q{int(q * 100):03d}" for q in QUANTILE_GRID]


# --------------------------------------------------------------------------
# Inläsning
# --------------------------------------------------------------------------
def load_enriched() -> pd.DataFrame:
    """Motorns städade tabell + auktionsutfallen (bud, värdering, kanal)."""
    listings = load_listings()
    available = set(pq.ParquetFile(config.DATA_DIR / "master.parquet").schema.names)
    columns = [c for c in AUCTION_COLUMNS if c in available]
    extra = pq.read_table(
        config.DATA_DIR / "master.parquet", columns=columns
    ).to_pandas().drop_duplicates("dedup_key")
    merged = listings.merge(extra, on="dedup_key", how="left")
    log.info("Berikade %d rader med %s", len(merged), columns[1:])
    return merged


# --------------------------------------------------------------------------
# Märkesklass
# --------------------------------------------------------------------------
def _tier_regex(brands: tuple) -> str:
    ordered = sorted(brands, key=len, reverse=True)
    return r"\b(" + "|".join(re.escape(b) for b in ordered) + r")\b"


def detect_brand(blob: pd.Series) -> pd.DataFrame:
    """Märke och märkesklass ur annonstexten, dyrast klass först.

    Söker i search_blob, inte i brand-kolumnen: den är ifylld på 3,3 % av
    utropsraderna, medan titeln och designer-fältet nästan alltid bär
    märkes- eller upphovsmannanamnet.

    Dyrast först är avsiktligt: "Fritz Hansen-stol såld via Mio" ska klassas
    som high end — det är objektet som prissätts, inte återförsäljaren.
    """
    out = pd.DataFrame(index=blob.index, columns=["brand", "brand_tier"], dtype="object")
    for tier in reversed(S.TIER_ORDER):  # high -> mid -> low
        hit = blob.str.extract(_tier_regex(S.BRAND_TIERS[tier]), expand=False)
        fill = hit.notna() & out["brand"].isna()
        out.loc[fill, "brand"] = hit[fill]
        out.loc[fill, "brand_tier"] = tier
    return out


# --------------------------------------------------------------------------
# Fas 0 — profilering
# --------------------------------------------------------------------------
def _bid_table(frame: pd.DataFrame, by: str) -> pd.DataFrame:
    rows = []
    for key, g in frame.groupby(by, observed=True, dropna=False):
        bids = g["aux_bid_count"]
        known = bids.notna().sum()
        if not known:
            continue
        rows.append({
            by: key if key is not None else "(saknas)",
            "rader": len(g), "med budantal": int(known),
            "0 bud %": round(float((bids == 0).sum() / known * 100), 1),
            "1-2 bud %": round(float(bids.between(1, 2).sum() / known * 100), 1),
            ">=3 %": round(float((bids >= 3).sum() / known * 100), 1),
            ">=4 %": round(float((bids >= 4).sum() / known * 100), 1),
            ">=5 %": round(float((bids >= 5).sum() / known * 100), 1),
            "n>=5": int((bids >= 5).sum()),
            "medianbud": float(bids.median()),
        })
    return pd.DataFrame(rows)


def profile(frame: pd.DataFrame) -> None:
    sold = frame[frame["price_kind"] == "realized"].copy()
    asking = frame[frame["price_kind"] == "asking"]
    print("=" * 92 + "\nFAS 0 — PROFILERING\n" + "=" * 92)
    print(f"\nHela datan: {len(frame):,} rader   utrop {len(asking):,}"
          f"   slutpriser {len(sold):,}")

    print("\n1. aux_bid_count — budkonkurrens\n" + "-" * 92)
    print(_bid_table(sold, "source").to_string(index=False))
    print("\nkanal per källa:")
    print(pd.crosstab(sold["channel"], sold["source"]).to_string())
    print("\nper möbeltyp:")
    print(_bid_table(sold, "variant").sort_values("n>=5", ascending=False).to_string(index=False))

    brands = detect_brand(sold["search_blob"])
    sold[["brand", "brand_tier"]] = brands
    print("\nper märkesklass:")
    print(_bid_table(sold[sold.brand_tier.notna()], "brand_tier").to_string(index=False))

    print("\n2. aux_estimate\n" + "-" * 92)
    for src, g in sold.groupby("source"):
        filled = g["aux_estimate"].notna().sum()
        print(f"{src}: ifylld på {filled:,} av {len(g):,} ({filled/len(g)*100:.1f} %)")
        if filled:
            valid = g[(g["aux_estimate"] > 0)]
            ratio = valid["price"] / valid["aux_estimate"]
            print(f"   slutpris/värdering median {ratio.median():.2f}"
                  f"   under värdering {(ratio < 1).mean()*100:.1f} %")

    print("\n3. Möbelvolym\n" + "-" * 92)
    furniture = sold[~sold["variant"].isin([UNKNOWN, PART])]
    print(f"{len(furniture):,} av {len(sold):,} slutpriser är möbler")
    print(f"märkesklass ur text: {furniture['brand_tier'].notna().mean()*100:.1f} %")

    print("\n4. Tidsöverlapp\n" + "-" * 92)
    print(asking.groupby("source")["listed_at"].agg(["min", "max", "size"]).to_string())


# --------------------------------------------------------------------------
# Fas 1 — matchning
# --------------------------------------------------------------------------
def prepare_sales(frame: pd.DataFrame) -> tuple:
    """Försäljningarna studien mäter på, plus bortfallstratten på vägen dit."""
    funnel = []

    def step(name: str, f: pd.DataFrame) -> pd.DataFrame:
        funnel.append({
            "steg": name,
            "tradera": int((f["source"] == "tradera").sum()),
            "auctionet": int((f["source"] == "auctionet").sum()),
            "totalt": len(f),
        })
        return f

    sold = step("slutpriser i datan", frame[frame["price_kind"] == "realized"].copy())
    # Traderas marketplace_fixed är fastprisköp, inte auktioner: de har per
    # definition noll bud och kan aldrig passera budspärren. De rapporteras
    # separat i stället för att dras med som "osålda".
    sold = step("auktionskanal (ej fastpris)", sold[sold["channel"] == "auction"])
    sold = step("är en möbel (ej okänd/del)",
                sold[~sold["variant"].isin([UNKNOWN, PART])])
    sold = step("har datum och budantal",
                sold[sold["listed_at"].notna() & sold["aux_bid_count"].notna()])

    sold[["brand", "brand_tier"]] = detect_brand(sold["search_blob"])
    sold["brand"] = sold["brand"].fillna("")
    return sold.reset_index(drop=True), funnel


def phase1(frame: pd.DataFrame) -> pd.DataFrame:
    sales, funnel = prepare_sales(frame)
    pool = M.build_asking_pool(frame)
    brand_pools = M._brand_pools(pool, set(sales["brand"]) - {""})
    cache = M.MatchCache(pool, brand_pools)

    log.info("Matchar %d försäljningar ...", len(sales))
    matched = M.match_sales(sales, cache)
    log.info("Cache: %d träffar, %d missar", cache.hits, cache.misses)

    # Kvantilrutnät per försäljning, så att fas 3 kan prediktera pris vid en
    # godtycklig percentil utan att söka om.
    months = matched["listed_at"].dt.to_period("M")
    grids = np.full((len(matched), len(QUANTILE_GRID)), np.nan)
    for i, ((_, sale), month) in enumerate(zip(matched.iterrows(), months)):
        if sale["match_level"] is None or not sale["match_count"]:
            continue
        prices = cache.prices(sale["match_level"], sale["brand"], sale["variant"], month)
        if len(prices):
            grids[i] = np.quantile(prices, QUANTILE_GRID)
    matched[QUANTILE_COLUMNS] = grids

    before = len(matched)
    matched = matched[matched["rank"].notna()
                      & (matched["match_count"] >= S.MIN_ASKING_PER_MATCH)]
    funnel.append({
        "steg": f"matchad mot >= {S.MIN_ASKING_PER_MATCH} samtida utrop",
        "tradera": int((matched["source"] == "tradera").sum()),
        "auctionet": int((matched["source"] == "auctionet").sum()),
        "totalt": len(matched),
    })
    log.info("Matchade: %d av %d försäljningar", len(matched), before)

    matched["price_tier"] = M.assign_price_tier(matched)
    for threshold in S.BID_THRESHOLDS:
        q = matched[matched["aux_bid_count"] >= threshold]
        funnel.append({
            "steg": f"  ... och >= {threshold} bud",
            "tradera": int((q["source"] == "tradera").sum()),
            "auctionet": int((q["source"] == "auctionet").sum()),
            "totalt": len(q),
        })

    S.STUDY_DIR.mkdir(parents=True, exist_ok=True)
    keep = ["source", "price", "variant", "brand", "brand_tier", "price_tier",
            "rank", "rank_broad", "match_level", "match_count", "matched_median",
            "aux_bid_count", "aux_estimate", "listed_at", "name"] + QUANTILE_COLUMNS
    matched[keep].to_parquet(S.STUDY_DIR / "ranks.parquet", index=False)
    pd.DataFrame(funnel).to_json(S.STUDY_DIR / "funnel.json", orient="records", indent=2)
    return matched


# --------------------------------------------------------------------------
# Fas 2 — aggregering
# --------------------------------------------------------------------------
def _group_result(group: pd.DataFrame, resolve_gap, rng) -> dict:
    threshold, n = E.choose_bid_threshold(group["aux_bid_count"])
    qualified = group[group["aux_bid_count"] >= threshold]
    base = {
        "bid_threshold": threshold,
        "n_qualified": int(len(qualified)),
        "n_total": int(len(group)),
        "median_bids": float(group["aux_bid_count"].median()),
        "low_bid_share": round(float((group["aux_bid_count"] <= 2).mean()), 4),
        "tier_source": ("brand" if group["brand_tier"].notna().all() else "unbranded"),
    }
    if len(qualified) < S.MIN_SALES_PER_GROUP:
        return {**base, "status": "insufficient_data"}

    tradera = qualified[qualified["source"] == "tradera"]["rank"].to_numpy()
    auctionet = qualified[qualified["source"] == "auctionet"]["rank"].to_numpy()

    if len(tradera) >= S.MIN_TRADERA_SALES:
        stats = E.summarise(tradera, rng)
        source, correction = "tradera", 0.0
    elif len(auctionet) >= S.MIN_SALES_PER_GROUP:
        gap, gap_status = resolve_gap(group)
        if gap is None:
            return {**base, "status": "insufficient_market",
                    "reason": "kanalgap går inte att skatta för segmentet",
                    "auctionet_raw": E.summarise(auctionet, rng)}
        stats = E.summarise(auctionet, rng)
        stats["sell_percentile"] = round(min(max(stats["sell_percentile"] + gap, 0), 1), 4)
        stats["ci_low"] = round(min(max(stats["ci_low"] + gap, 0), 1), 4)
        stats["ci_high"] = round(min(max(stats["ci_high"] + gap, 0), 1), 4)
        source = "auctionet_corrected" if gap_status == "gap_measured" else gap_status
        correction = gap
    else:
        return {**base, "status": "insufficient_data"}

    return {
        **base, **stats, "status": "ok", "source": source,
        "channel_gap_applied": round(correction, 4),
        "n_tradera": int(len(tradera)), "n_auctionet": int(len(auctionet)),
        "bid_terciles": E.bid_terciles(qualified, rng),
    }


def phase2(matched: pd.DataFrame) -> dict:
    rng = np.random.default_rng(S.RANDOM_SEED)
    branded = matched[matched["brand_tier"].notna()]
    unbranded = matched[matched["brand_tier"].isna()]

    tier_table = E.tier_gap_table(branded, rng)
    low_gap, low_status = E.extrapolate_low_gap(tier_table)
    brand_gaps = {
        "high": (tier_table.get("high", {}).get("gap"), "gap_measured"),
        "mid": (tier_table.get("mid", {}).get("gap"), "gap_measured"),
        "low": (low_gap, low_status),
    }
    for tier in ("high", "mid"):
        if brand_gaps[tier][0] is None:
            brand_gaps[tier] = (None, "insufficient_market")

    def resolve_a(group: pd.DataFrame) -> tuple:
        tier = group["brand_tier"].dropna()
        tier = tier.iloc[0] if len(tier) else None
        return brand_gaps.get(tier, (None, "insufficient_market"))

    # Spår B saknar märkesklass, så gapet hämtas på möbeltyp × prisnivå med
    # prisnivån som fallback — samma logik, annan nyckel.
    b_table = E.price_tier_gap_table(unbranded, rng)

    def resolve_b(group: pd.DataFrame) -> tuple:
        variant = str(group["variant"].iloc[0])
        tier = str(group["price_tier"].iloc[0])
        pair = b_table["per_pair"].get(f"{variant}|{tier}")
        if pair:
            return pair["gap"], "gap_measured"
        per_tier = b_table["per_tier"].get(tier)
        if per_tier:
            return per_tier["gap"], "gap_measured"
        return None, "insufficient_market"

    results = {"track_a": {}, "track_b": {}, "channel_gaps": tier_table,
               "channel_gaps_unbranded": b_table, "low_end_gap_status": low_status}

    for key, group in branded.groupby(["variant", "brand_tier", "price_tier"],
                                      observed=True):
        if any(k is None or (isinstance(k, float) and np.isnan(k)) for k in key):
            continue
        results["track_a"]["|".join(map(str, key))] = _group_result(group, resolve_a, rng)

    for key, group in unbranded.groupby(["variant", "price_tier"], observed=True):
        if any(k is None or (isinstance(k, float) and np.isnan(k)) for k in key):
            continue
        results["track_b"]["|".join(map(str, key))] = _group_result(group, resolve_b, rng)

    # Känslighet för budtröskeln, för de största grupperna.
    sensitivity = []
    sizes = branded.groupby(["variant", "brand_tier", "price_tier"], observed=True).size()
    for key in sizes.sort_values(ascending=False).head(8).index:
        group = branded
        for column, value in zip(("variant", "brand_tier", "price_tier"), key):
            group = group[group[column] == value]
        row = {"grupp": "|".join(map(str, key))}
        for threshold in S.BID_THRESHOLDS:
            q = group[group["aux_bid_count"] >= threshold]["rank"]
            row[f">={threshold}"] = round(float(q.median()), 4) if len(q) >= 10 else None
            row[f"n>={threshold}"] = int(len(q))
        sensitivity.append(row)
    results["bid_sensitivity"] = sensitivity
    return results


# --------------------------------------------------------------------------
# Fas 3 — validering
# --------------------------------------------------------------------------
def _predict(rows: pd.DataFrame, percentile: float) -> np.ndarray:
    """Pris vid en given percentil av varje rads matchade utropsfördelning."""
    grid = rows[QUANTILE_COLUMNS].to_numpy(float)
    return np.array([
        np.interp(percentile, QUANTILE_GRID, row) if not np.isnan(row).all() else np.nan
        for row in grid
    ])


def _errors(predicted: np.ndarray, actual: np.ndarray) -> dict:
    ok = np.isfinite(predicted) & np.isfinite(actual) & (predicted > 0) & (actual > 0)
    if ok.sum() < 10:
        return {"n": int(ok.sum())}
    logerr = np.abs(np.log(predicted[ok] / actual[ok]))
    signed = np.log(predicted[ok] / actual[ok])
    return {
        "n": int(ok.sum()),
        "median_abs_log_error": round(float(np.median(logerr)), 4),
        "median_abs_pct": round(float(np.exp(np.median(logerr)) - 1) * 100, 1),
        "within_25pct": round(float((logerr <= np.log(1.25)).mean()), 4),
        "median_bias_pct": round((float(np.exp(np.median(signed))) - 1) * 100, 1),
    }


def phase3(matched: pd.DataFrame, groups: dict) -> dict:
    rng = np.random.default_rng(S.RANDOM_SEED)
    qualified = matched[matched["aux_bid_count"] >= S.BID_THRESHOLDS[-1]].copy()
    shuffled = qualified.sample(frac=1.0, random_state=S.RANDOM_SEED)
    half = len(shuffled) // 2
    train, test = shuffled.iloc[:half], shuffled.iloc[half:]

    global_percentile = float(train["rank"].median())
    key_columns = ["variant", "brand_tier", "price_tier"]
    trained = (train.dropna(subset=key_columns)
               .groupby(key_columns, observed=True)["rank"]
               .agg(["median", "size"]))
    trained = trained[trained["size"] >= 20]["median"].to_dict()

    per_group = np.full(len(test), global_percentile)
    covered = np.zeros(len(test), dtype=bool)
    for i, (_, row) in enumerate(test.iterrows()):
        key = (row["variant"], row["brand_tier"], row["price_tier"])
        if key in trained:
            per_group[i] = trained[key]
            covered[i] = True

    actual = test["price"].to_numpy(float)
    predictions = {
        "gruppspecifik säljpercentil": np.array([
            np.interp(p, QUANTILE_GRID, r) if not np.isnan(r).all() else np.nan
            for p, r in zip(per_group, test[QUANTILE_COLUMNS].to_numpy(float))
        ]),
        "baslinje: global säljpercentil": _predict(test, global_percentile),
        "baslinje: alltid p50": _predict(test, 0.50),
        "baslinje: aux_estimate": test["aux_estimate"].to_numpy(float),
    }
    result = {
        "n_train": len(train), "n_test": len(test),
        "global_sell_percentile": round(global_percentile, 4),
        "group_coverage": round(float(covered.mean()), 4),
        "models": {name: _errors(pred, actual) for name, pred in predictions.items()},
    }

    # Samma jämförelse men bara på de rader där en gruppspecifik percentil
    # fanns — annars jämförs gruppmodellen delvis mot sig själv.
    if covered.sum() >= 50:
        result["models_covered_only"] = {
            name: _errors(pred[covered], actual[covered])
            for name, pred in predictions.items()
        }

    # Smalhetskänslighet: överförs percentilen från en bred fördelning till
    # en smal? Motorn matchar i produktion på märke OCH modell, medan studien
    # oftast bara kan matcha på möbeltyp. För de försäljningar där båda
    # nivåerna fanns mäts samma objekt mot båda fördelningarna.
    both = matched[matched["rank_broad"].notna() & matched["rank"].notna()]
    if len(both) >= 100:
        diff = (both["rank"] - both["rank_broad"]).abs()
        result["narrowness"] = {
            "n": int(len(both)),
            "median_rank_narrow": round(float(both["rank"].median()), 4),
            "median_rank_broad": round(float(both["rank_broad"].median()), 4),
            "median_abs_diff": round(float(diff.median()), 4),
            "p90_abs_diff": round(float(diff.quantile(0.90)), 4),
            "correlation": round(float(both["rank"].corr(both["rank_broad"])), 4),
            "within_010": round(float((diff <= 0.10).mean()), 4),
        }

    # Percentiler mätta på den SMALA matchningen (märke + möbeltyp). Det är
    # den enda matchningsnivån som liknar produktionens fråga, och därmed den
    # enda vars percentil kan överföras till motorn utan omräkning. Underlaget
    # är mindre, men jämförbarheten är hela poängen.
    narrow_rows = matched[
        (matched["match_level"] == "brand+variant")
        & (matched["aux_bid_count"] >= S.BID_THRESHOLDS[-1])
    ].copy()

    # Kanalkorrigering även här. Den smala matchningen domineras av Auctionet,
    # och hela studiens premiss är att Tradera speglar konsumentmarknaden.
    # Utan korrigering blev low end p78 mot mid p33 — inte för att billiga
    # möbler säljs dyrt, utan för att auktionerad IKEA är samlarvintage medan
    # utropsannonserna är vardagsmöbler. Efter korrigering konvergerar de.
    gap_by_tier = {
        tier: (groups["channel_gaps"].get(tier, {}).get("gap") or 0.0)
        for tier in S.TIER_ORDER
    }
    correction = narrow_rows["brand_tier"].map(gap_by_tier).fillna(0.0)
    correction = correction.where(narrow_rows["source"] == "auctionet", 0.0)
    narrow_rows["rank_adjusted"] = (narrow_rows["rank"] + correction).clip(0, 1)

    recommendation = {"n": int(len(narrow_rows)), "per_segment": {},
                      "channel_gap_applied": gap_by_tier}
    if len(narrow_rows) >= 100:
        recommendation["overall_raw"] = round(float(narrow_rows["rank"].median()), 4)
        recommendation["overall"] = round(float(narrow_rows["rank_adjusted"].median()), 4)
        for keys, label in ((["brand_tier"], "märkesklass"),
                            (["brand_tier", "price_tier"], "märkesklass × prisnivå")):
            for key, rows in narrow_rows.dropna(subset=keys).groupby(keys, observed=True):
                if len(rows) < S.MIN_SALES_PER_GROUP:
                    continue
                name = " · ".join(map(str, key if isinstance(key, tuple) else (key,)))
                recommendation["per_segment"][name] = {
                    "sell_percentile": round(float(rows["rank_adjusted"].median()), 4),
                    "sell_percentile_raw": round(float(rows["rank"].median()), 4),
                    "p25": round(float(rows["rank_adjusted"].quantile(0.25)), 4),
                    "p75": round(float(rows["rank_adjusted"].quantile(0.75)), 4),
                    "n": int(len(rows)),
                    "dimension": label,
                }
    result["narrow_recommendation"] = recommendation

    # Stabilitet per år. Tidsöverlappet mot utropsdatan medger 2024-2026,
    # inte Auctionets 15 år.
    years = {}
    for year, rows in qualified.groupby(qualified["listed_at"].dt.year):
        if len(rows) >= 100:
            years[int(year)] = {
                "sell_percentile": round(float(rows["rank"].median()), 4),
                "n": int(len(rows)),
            }
    result["stability_by_year"] = years
    return result


# --------------------------------------------------------------------------
# Fas 4 — figurer och leverabler
# --------------------------------------------------------------------------
def figures(matched: pd.DataFrame, groups: dict, validation: dict) -> list:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    S.FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    written = []

    # 1. Rangfördelningar per källa.
    fig, ax = plt.subplots(figsize=(9, 5))
    for src, rows in matched.groupby("source"):
        ax.hist(rows["rank"], bins=40, alpha=0.55, density=True, label=f"{src} (n={len(rows):,})")
    ax.axvline(0.5, color="black", ls="--", lw=1, label="p50")
    ax.set_xlabel("percentilrang i den matchade utropsfördelningen")
    ax.set_ylabel("täthet")
    ax.set_title("Var i utropsfördelningen sker affärerna?")
    ax.legend()
    fig.tight_layout()
    path = S.FIGURE_DIR / "1_rangfordelning.png"
    fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    # 2. Kanalgapet per märkesklass.
    tiers = [t for t in S.TIER_ORDER if groups["channel_gaps"].get(t, {}).get("gap") is not None]
    if tiers:
        fig, ax = plt.subplots(figsize=(7, 4.5))
        values = [groups["channel_gaps"][t]["gap"] for t in tiers]
        ax.bar(tiers, values, color=["#4c72b0", "#dd8452", "#55a868"][:len(tiers)])
        ax.axhline(0, color="black", lw=1)
        ax.set_ylabel("Tradera-rang minus Auctionet-rang")
        ax.set_title("Kanalgap per märkesklass")
        for i, v in enumerate(values):
            ax.text(i, v, f"{v:+.3f}", ha="center",
                    va="bottom" if v >= 0 else "top")
        fig.tight_layout()
        path = S.FIGURE_DIR / "2_kanalgap.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    # 3. Budtercilens effekt.
    rows = []
    for track in ("track_a", "track_b"):
        for name, g in groups[track].items():
            for tercile, stats in (g.get("bid_terciles") or {}).items():
                rows.append({"tercile": tercile, "percentile": stats["sell_percentile"]})
    if rows:
        df = pd.DataFrame(rows)
        fig, ax = plt.subplots(figsize=(7, 4.5))
        order = [t for t in ("låg", "mellan", "hög") if t in set(df["tercile"])]
        ax.boxplot([df[df.tercile == t]["percentile"] for t in order], labels=order)
        ax.set_xlabel("budtercil"); ax.set_ylabel("säljpercentil")
        ax.set_title("Högre budaktivitet <-> högre percentil?")
        fig.tight_layout()
        path = S.FIGURE_DIR / "3_budtercil.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    # 4. Tidsdrift.
    years = validation.get("stability_by_year") or {}
    if len(years) >= 2:
        fig, ax = plt.subplots(figsize=(7, 4.5))
        xs = sorted(years)
        ax.plot(xs, [years[y]["sell_percentile"] for y in xs], "o-")
        for y in xs:
            ax.annotate(f"n={years[y]['n']:,}", (y, years[y]["sell_percentile"]),
                        textcoords="offset points", xytext=(0, 8), ha="center")
        ax.set_xticks(xs); ax.set_ylabel("säljpercentil")
        ax.set_title("Driftar säljpercentilen över tid?")
        fig.tight_layout()
        path = S.FIGURE_DIR / "4_tidsdrift.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    return written


def write_json(groups: dict, validation: dict, matched: pd.DataFrame) -> None:
    payload = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "random_seed": S.RANDOM_SEED,
        "thresholds": {
            "bid": list(S.BID_THRESHOLDS),
            "min_sales_per_group": S.MIN_SALES_PER_GROUP,
            "min_asking_per_match": S.MIN_ASKING_PER_MATCH,
            "min_tradera_sales": S.MIN_TRADERA_SALES,
            "time_window_months": S.TIME_WINDOW_MONTHS,
        },
        "channel_gaps": groups["channel_gaps"],
        "channel_gaps_unbranded": groups["channel_gaps_unbranded"],
        "low_end_gap_status": groups["low_end_gap_status"],
        "global_sell_percentile": validation["global_sell_percentile"],
        "track_a_brand_tier": groups["track_a"],
        "track_b_unbranded": groups["track_b"],
        "bid_sensitivity": groups["bid_sensitivity"],
        "recommended_percentiles": validation.get("narrow_recommendation"),
        "validation": validation,
    }
    S.OUTPUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    log.info("Skrev %s", S.OUTPUT_JSON)


def progress(phase: str, note: str) -> None:
    path = S.STUDY_DIR / "PROGRESS.md"
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    existing = path.read_text() if path.is_file() else "# Framsteg\n\n"
    path.write_text(f"{existing}- **{phase}** klar {stamp} — {note}\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="run_percentile_study.py")
    parser.add_argument("fas", choices=["profile", "all"])
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    np.random.seed(S.RANDOM_SEED)

    frame = load_enriched()
    if args.fas == "profile":
        profile(frame)
        return 0

    S.STUDY_DIR.mkdir(parents=True, exist_ok=True)
    (S.STUDY_DIR / "PROGRESS.md").unlink(missing_ok=True)

    matched = phase1(frame)
    progress("Fas 1", f"{len(matched):,} försäljningar matchade, ranks.parquet skriven")

    groups = phase2(matched)
    n_ok = sum(1 for t in ("track_a", "track_b")
               for g in groups[t].values() if g.get("status") == "ok")
    progress("Fas 2", f"{n_ok} grupper med exporterbart värde")

    validation = phase3(matched, groups)
    progress("Fas 3", f"holdout {validation['n_test']:,} rader")

    written = figures(matched, groups, validation)
    write_json(groups, validation, matched)
    from percentile_report import write_report
    write_report(matched, groups, validation, written)
    progress("Fas 4", f"{len(written)} figurer, JSON och rapport skrivna")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
